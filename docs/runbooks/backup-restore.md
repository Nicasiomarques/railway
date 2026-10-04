# Runbook: data loss — backup restore

**Risk:** architecture.md §12 #9 (Critical). A volume's data is gone, corrupted, or about to be
(a bad migration, an accidental delete, a storage failure) and needs to come back from backup.

## Before an incident: what actually exists today

- **Backup:** `POST /v1/volumes/{volumeId}/backup` enqueues a `run-backup` job
  (`workers/src/backup/worker.ts`). The volume's `backup_state` goes `pending` → `completed`/
  `failed`, and `last_backup_at` is set on success.
- **Restore:** `POST /v1/volumes/{volumeId}/restore` enqueues a `restore-backup` job on the same
  worker. This is new — until this runbook's companion change, restore existed only as a provider
  method (`BackupProvider.restoreBackup`) with no route or job to actually call it. **It restores
  from the volume's most recent backup only** — there is no point-in-time or "restore to backup
  N-2" option yet.
- **No daily schedule wired up in production yet.** `scheduleDailyBackups` exists
  (`workers/src/backup/worker.ts`) but `workers/src/index.ts` doesn't call it — nothing backs up a
  volume automatically today. If you're reading this during a real incident, the practical
  consequence is: **check `last_backup_at` before assuming a recent backup exists.** `GET
  /v1/services/{instanceId}/volumes` returns it.
- **Audit log:** every backup/restore trigger writes an audit log entry
  (`volume.backup_triggered` / `volume.restore_triggered`,
  `GET /v1/organizations/{organizationId}/audit-logs`).

## Immediate steps

1. **Stop the bleeding first.** If data loss is ongoing (a migration still running, a process
   still deleting), stop the workload before restoring — a restore into a volume that's still
   being actively written/corrupted just gets overwritten again.
   ```bash
   kubectl --context <ctx> -n env-<environmentId> scale deploy <workload-name> --replicas=0
   ```
2. **Check `last_backup_at` on the affected volume** (`GET /v1/services/{instanceId}/volumes`).
   If it's null or stale, restoring loses whatever changed since then — say so explicitly before
   proceeding, this is a decision the data's owner should get to make, not one to make silently.
3. **Trigger the restore:**
   ```
   POST /v1/volumes/{volumeId}/restore
   ```
   Poll `GET /v1/services/{instanceId}/volumes` for `backup_state` to go from `pending` to
   `completed` (or `failed`).
4. **If it fails:** the job retries on its own budget (`RESTORE_BACKUP_JOB_RETRY`, 5 attempts,
   exponential backoff — same shape as backup's). On final failure the volume's `backup_state`
   becomes `failed`. At that point this is a storage-layer problem (object storage unreachable, or
   the backup itself never completed), not something another API call will fix — go to Diagnosis.
5. **Scale the workload back up** once the restore completes and you've confirmed the data looks
   right.

## Diagnosis (when restore itself fails)

- Was there ever a successful backup for this volume? (`last_backup_at` null means no.)
- Is the object storage backend reachable? (Today's implementation,
  `LocalFsObjectStorageProvider` — `OBJECT_STORAGE_DIR`, default `/tmp/railway-like-object-storage`
  — is explicitly a placeholder for a real backend per `workers/src/backup/worker.ts`; a real S3/GCS
  provider would need its own reachability check here.)
- Check the BullMQ job's failure reason directly in Redis if the API's surfaced error isn't enough
  (`jobs_total{queue="backups",job_name="restore-backup",outcome="failed"}` from the metrics added
  for Phase 3's observability slice — see `docs/slos.md` — is also where a repeated-failure pattern
  would first show up).

## Resolution

- A successful restore is the end state. If it's not possible (no backup ever completed, storage
  genuinely lost the data), that's the finding to report — don't imply data was recovered if it
  wasn't.
- `architecture.md` §6 also calls for volume *snapshots* (PVC-level), not just logical dumps — this
  implementation only has the logical-dump path. A snapshot-level restore is a bigger gap, tracked
  here rather than pretended away.

## Postmortem

Record: how the data loss happened, how old the restored backup was (i.e., how much was actually
lost), and — given there's no production daily schedule yet — whether this incident is the forcing
function to wire one up.

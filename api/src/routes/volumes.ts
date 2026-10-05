import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { VolumeSchema, listOf } from "../openapi/schemas.js";
import { requireInstanceAccess } from "../access.js";
import { ApiError } from "../errors.js";
import type { Db } from "../db/client.js";
import { auditLogs, serviceInstances, volumes } from "../db/schema.js";
import type { BackupQueue } from "../queue.js";

export const instanceParams = z.object({ instanceId: z.string().uuid() });
export const volumeParams = z.object({ volumeId: z.string().uuid() });

export const createVolumeBody = z.object({
  mountPath: z
    .string()
    .trim()
    .startsWith("/")
    .max(255)
    .refine((p) => !p.split("/").includes(".."), "mountPath cannot contain .."),
  sizeGb: z.number().int().min(1).max(10_000),
});

// Mirrors the API's `BACKUP_QUEUE` port (architecture.md §6): triggering a backup out of band
// from the daily schedule just enqueues the same `run-backup` job the scheduler would.
export const volumeRoutes: FastifyPluginAsync<{ db: Db; backupQueue?: BackupQueue }> = async (
  app,
  { db, backupQueue },
) => {
  app.post(
    "/services/:instanceId/volumes",
    {
      config: {
        openapi: {
          operationId: "createVolume",
          tags: ["Volumes"],
          summary: "Creates a volume for the instance (architecture.md §6: PVC + scheduled backup)",
          pathSchema: instanceParams,
          bodySchema: createVolumeBody,
          success: { status: 201, description: "Volume created", schema: VolumeSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { instanceId } = instanceParams.parse(request.params);
      const body = createVolumeBody.parse(request.body);
      const userId = request.auth!.userId;
      const { organizationId } = await requireInstanceAccess(db, userId, instanceId, { write: true });

      const [created] = await db
        .insert(volumes)
        .values({ serviceInstanceId: instanceId, mountPath: body.mountPath, sizeGb: body.sizeGb, backupState: "none" })
        .returning();

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "volume.create",
        target: `volume:${created.id}`,
        metadata: { mountPath: created.mountPath, sizeGb: created.sizeGb },
      });

      return reply.code(201).send(created);
    },
  );

  app.get(
    "/services/:instanceId/volumes",
    {
      config: {
        openapi: {
          operationId: "listVolumes",
          tags: ["Volumes"],
          summary: "Lists the instance's volumes",
          pathSchema: instanceParams,
          success: { status: 200, description: "Volumes", schema: listOf(VolumeSchema) },
          errors: [404],
        },
      },
    },
    async (request) => {
      const { instanceId } = instanceParams.parse(request.params);
      await requireInstanceAccess(db, request.auth!.userId, instanceId);

      const rows = await db.select().from(volumes).where(eq(volumes.serviceInstanceId, instanceId)).orderBy(asc(volumes.createdAt));
      return { data: rows };
    },
  );

  // Triggers an immediate backup, outside the daily schedule (architecture.md §6). Enqueues the
  // same `run-backup` job the scheduler would; the worker (workers/src/backup/worker.ts) does the work.
  app.post(
    "/volumes/:volumeId/backup",
    {
      config: {
        openapi: {
          operationId: "triggerVolumeBackup",
          tags: ["Volumes"],
          summary: "Triggers an immediate backup of the volume, outside the daily schedule",
          pathSchema: volumeParams,
          success: { status: 202, description: "Backup enqueued", schema: VolumeSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { volumeId } = volumeParams.parse(request.params);
      const userId = request.auth!.userId;

      const [volume] = await db.select().from(volumes).where(eq(volumes.id, volumeId));
      if (!volume) throw new ApiError(404, "volume_not_found", "Volume not found.");

      const { organizationId } = await requireInstanceAccess(db, userId, volume.serviceInstanceId, { write: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 403) throw err;
        if (err instanceof ApiError && err.status === 404) throw new ApiError(404, "volume_not_found", "Volume not found.");
        throw err;
      });

      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "volume.backup_triggered",
        target: `volume:${volume.id}`,
      });

      // Best effort: triggering the backup doesn't fail the request because the queue is unavailable.
      // Without a configured queue the volume stays in its current backup_state until the daily
      // schedule (or a retry of this endpoint) picks it up.
      if (backupQueue) {
        try {
          await backupQueue.enqueueRunBackup({ volumeId: volume.id });
        } catch {
          // Best effort, see above.
        }
      }

      return reply.code(202).send(volume);
    },
  );

  // Restores the volume from its most recent backup (architecture.md §6: "restore is an explicit,
  // audited operation" — never automatic). Phase 3 (docs/roadmap.md) gap: restore existed only as
  // a provider method with no way to actually trigger it; see docs/runbooks/backup-restore.md for
  // when to use this.
  app.post(
    "/volumes/:volumeId/restore",
    {
      config: {
        openapi: {
          operationId: "restoreVolumeBackup",
          tags: ["Volumes"],
          summary: "Restores the volume from its most recent backup. Overwrites current data.",
          pathSchema: volumeParams,
          success: { status: 202, description: "Restore enqueued", schema: VolumeSchema },
          errors: [403, 404],
        },
      },
    },
    async (request, reply) => {
      const { volumeId } = volumeParams.parse(request.params);
      const userId = request.auth!.userId;

      const [volume] = await db.select().from(volumes).where(eq(volumes.id, volumeId));
      if (!volume) throw new ApiError(404, "volume_not_found", "Volume not found.");

      const { organizationId } = await requireInstanceAccess(db, userId, volume.serviceInstanceId, { write: true }).catch((err) => {
        if (err instanceof ApiError && err.status === 403) throw err;
        if (err instanceof ApiError && err.status === 404) throw new ApiError(404, "volume_not_found", "Volume not found.");
        throw err;
      });

      // Audited unconditionally, even if the enqueue below fails: "someone asked to restore this
      // volume" is the fact worth recording, regardless of whether the job ever ran.
      await db.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: "volume.restore_triggered",
        target: `volume:${volume.id}`,
      });

      if (backupQueue) {
        try {
          await backupQueue.enqueueRestoreBackup({ volumeId: volume.id });
        } catch {
          // Best effort, same reasoning as the backup trigger route above.
        }
      }

      return reply.code(202).send(volume);
    },
  );
};

import { and, eq, inArray, isNull } from "drizzle-orm";
import { ApiError } from "../errors.js";
import { decryptValue, type Keyring } from "../crypto/envelope.js";
import type { Db } from "../db/client.js";
import { connections, serviceInstances, services, variables } from "../db/schema.js";

// Referência válida: ${{serviço.CHAVE}}. Só resolve para serviços conectados à instância
// (a origem lê o destino da conexão).
export const REFERENCE_PATTERN = /\$\{\{\s*([a-z0-9]+(?:-[a-z0-9]+)*)\.([A-Z_][A-Z0-9_]*)\s*\}\}/g;
const STRICT_REFERENCE = /^\$\{\{\s*[a-z0-9]+(?:-[a-z0-9]+)*\.[A-Z_][A-Z0-9_]*\s*\}\}$/;
const ANY_REFERENCE = /\$\{\{.*?\}\}/g;

// Rejeita ${{ ... }} mal formado já na escrita, para o erro aparecer no PUT e não no deploy.
export function validateReferences(value: string): void {
  for (const match of value.matchAll(ANY_REFERENCE)) {
    if (!STRICT_REFERENCE.test(match[0])) {
      throw new ApiError(400, "invalid_reference", `Referência mal formada: ${match[0]}`);
    }
  }
}

export type ResolvedVariable = { key: string; value: string; isSecret: boolean };

// Monta o ambiente final de uma instância: valores próprios com referências substituídas.
// Uma referência que resolve para secret torna a variável resultante secreta também.
export async function resolveInstanceEnv(db: Pick<Db, "select">, keyring: Keyring, instanceId: string): Promise<ResolvedVariable[]> {
  const own = await db
    .select()
    .from(variables)
    .where(and(eq(variables.scope, "service_instance"), eq(variables.serviceInstanceId, instanceId)));

  const owned = own.map((v) => ({
    key: v.key,
    isSecret: v.isSecret,
    value: decryptValue(keyring, v.valueEnc, `variable:${instanceId}:${v.key}`),
  }));

  const refs = new Set<string>();
  for (const v of owned) {
    for (const m of v.value.matchAll(REFERENCE_PATTERN)) refs.add(`${m[1]}.${m[2]}`);
  }
  if (refs.size === 0) return owned;

  const serviceNames = [...new Set([...refs].map((r) => r.split(".")[0]))];

  // Destinos diretamente conectados a esta instância (origem → destino).
  const targets = await db
    .select({ instanceId: serviceInstances.id, serviceName: services.name })
    .from(connections)
    .innerJoin(serviceInstances, eq(serviceInstances.id, connections.toInstanceId))
    .innerJoin(services, eq(services.id, serviceInstances.serviceId))
    .where(
      and(
        eq(connections.fromInstanceId, instanceId),
        inArray(services.name, serviceNames),
        isNull(serviceInstances.deletedAt),
        isNull(services.deletedAt),
      ),
    );

  const nameOf = new Map(targets.map((t) => [t.instanceId, t.serviceName]));
  const targetVars = nameOf.size
    ? await db
        .select()
        .from(variables)
        .where(and(eq(variables.scope, "service_instance"), inArray(variables.serviceInstanceId, [...nameOf.keys()])))
    : [];

  // Só descriptografa o que foi referenciado.
  const lookup = new Map<string, { value: string; isSecret: boolean }>();
  for (const tv of targetVars) {
    const targetId = tv.serviceInstanceId;
    if (!targetId) continue;
    const ref = `${nameOf.get(targetId)}.${tv.key}`;
    if (!refs.has(ref)) continue;
    const value = decryptValue(keyring, tv.valueEnc, `variable:${targetId}:${tv.key}`);
    if (value.includes("${{")) {
      throw new ApiError(422, "reference_not_chained", `${ref} contém uma referência; encadeamento não é suportado.`);
    }
    lookup.set(ref, { value, isSecret: tv.isSecret });
  }

  return owned.map((v) => {
    let isSecret = v.isSecret;
    const value = v.value.replace(REFERENCE_PATTERN, (_, svc: string, key: string) => {
      const ref = lookup.get(`${svc}.${key}`);
      if (!ref) {
        throw new ApiError(
          422,
          "unresolved_reference",
          `Referência ${svc}.${key} não resolvida: conecte a instância a ${svc} e confirme que a variável ${key} existe.`,
        );
      }
      if (ref.isSecret) isSecret = true;
      return ref.value;
    });
    return { key: v.key, value, isSecret };
  });
}

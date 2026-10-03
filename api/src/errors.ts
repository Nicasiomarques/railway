export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Código do Postgres para violação de unique constraint.
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = (err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } });
  const source = pgErr.code ? pgErr : pgErr.cause;
  if (source?.code !== "23505") return false;
  return constraint === undefined || source.constraint === constraint;
}

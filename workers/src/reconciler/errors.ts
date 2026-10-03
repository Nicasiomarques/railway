// An error that retrying won't fix (missing or corrupted snapshot, deployment with no image).
// Whoever catches it marks the deployment as Failed right away, without spending the retry budget.
export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly deploymentId?: string,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

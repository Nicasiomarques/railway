// Erro que re-tentar não resolve (snapshot ausente ou corrompido, deployment sem imagem).
// Quem captura marca o deployment como Failed na hora, sem gastar o orçamento de retries.
export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly deploymentId?: string,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

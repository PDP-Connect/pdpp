export class CollectorUsageError extends Error {
  constructor(message, { exitCode = 64 } = {}) {
    super(message);
    this.name = 'CollectorUsageError';
    this.exitCode = exitCode;
  }
}

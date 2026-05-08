export class OptimaiX402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimaiX402Error";
  }
}

export class OptimaiX402ApiError extends OptimaiX402Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "OptimaiX402ApiError";
  }
}

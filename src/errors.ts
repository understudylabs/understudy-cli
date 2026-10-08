export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export class MissingCapabilityError extends CliError {
  readonly code = "missing_capability";
  constructor(message: string, readonly command: string, readonly inputContract: unknown, readonly outputContract: unknown) { super(message); }
}

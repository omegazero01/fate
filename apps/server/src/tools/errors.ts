/** Explicit, sanitized diagnostics that a domain tool may expose to its caller. */
export class ToolResultError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
  }
}

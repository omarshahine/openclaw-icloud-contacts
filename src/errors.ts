export type ErrorCode =
  | "auth_failed"
  | "not_found"
  | "conflict"
  | "read_only"
  | "invalid_input"
  | "server_error"
  | "not_configured";

export class DavError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = "DavError";
    this.code = code;
    this.status = status;
  }
}

export function invalidInput(message: string): DavError {
  return new DavError("invalid_input", message);
}

/** Logical not-found (no HTTP status): does not trigger discovery refresh. */
export function notFound(message: string): DavError {
  return new DavError("not_found", message);
}

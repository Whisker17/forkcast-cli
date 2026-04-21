import type { ErrorCode } from "../types/index.js";

export const ERROR_CODES = new Set<ErrorCode>([
  "NOT_CACHED",
  "EIP_NOT_FOUND",
  "FETCH_FAILED",
  "DATA_ERROR",
  "INVALID_INPUT",
]);

export class CommandError extends Error {
  code: ErrorCode;

  constructor(message: string, code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandError";
    this.code = code;
  }
}

export function getCommandErrorCode(error: unknown): ErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODES.has(code as ErrorCode)) {
      return code as ErrorCode;
    }
  }

  return "DATA_ERROR";
}

import type { WritableLike } from "./fetcher.js";
import type { ErrorCode, ErrorOutput, OutputEnvelope } from "../types/index.js";

export function writeJsonEnvelope<T>(envelope: OutputEnvelope<T>, stdout: WritableLike = process.stdout) {
  stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function writeJsonError(
  error: ErrorOutput,
  stdout: WritableLike = process.stdout,
  stderr: WritableLike = process.stderr,
) {
  // The CLI contract keeps structured errors on stdout for agents while stderr
  // carries a human-readable copy for interactive use.
  stdout.write(`${JSON.stringify(error, null, 2)}\n`);
  stderr.write(`${error.error}\n`);
}

export function writePrettyError(message: string, stderr: WritableLike = process.stderr) {
  stderr.write(`${message}\n`);
}

export function exitCodeForErrorCode(code: ErrorCode) {
  switch (code) {
    case "DATA_ERROR":
    case "FETCH_FAILED":
    case "NOT_CACHED":
      return 2;
    case "EIP_NOT_FOUND":
    case "INVALID_INPUT":
      return 1;
    default:
      return 2;
  }
}

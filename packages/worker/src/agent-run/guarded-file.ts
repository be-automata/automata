import fs from "node:fs";

import { errnoCode } from "./node-errors";

/**
 * Read a small secret file with the same guards box-test-services.ts applies
 * to its env file: O_NOFOLLOW (a symlink is refused, and the fstat is on the
 * open fd so there is no check-then-read window), a regular file only, a size
 * cap, and never world-accessible. Throws `GuardedFileError` with a reason
 * that names the path and the guard, never the content; ENOENT surfaces as
 * `code === "ENOENT"` on the error so callers can treat "absent" apart.
 */
export class GuardedFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly code?: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "GuardedFileError";
  }
}

export function readGuardedFile(
  path: string,
  { maxBytes = 64 * 1024 }: { maxBytes?: number } = {},
): string {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = errnoCode(error) ?? "unknown";
    throw new GuardedFileError(path, `unreadable (${code})`, code);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new GuardedFileError(path, "not a regular file");
    if (stat.size > maxBytes) {
      throw new GuardedFileError(path, `larger than ${maxBytes} bytes`);
    }
    if ((stat.mode & 0o007) !== 0) {
      throw new GuardedFileError(path, "world-accessible");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

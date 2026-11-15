/**
 * Self-heal ref fence, pure half (FENCE-01, phase 9).
 *
 * A git smart-HTTP push (POST git-receive-pack, protocol v0/v1 — receive-pack
 * has no v2) opens with a pkt-line command list, then a flush-pkt, then the
 * PACK:
 *
 *   [<len>shallow <oid>]*                       (pushes from a shallow clone)
 *   <len><old-oid> <new-oid> <ref>\0<caps>[\n]  (first command carries caps)
 *   <len><old-oid> <new-oid> <ref>[\n]          (any further commands)
 *   0000
 *   PACK…
 *
 * `<len>` is 4 hex digits counting itself. This module parses that section
 * exactly as git writes it and decides whether every update targets the one
 * ref a fix run may write. No shell, no git binary: the broker calls it on the
 * buffered request prefix before a byte is forwarded to GitHub.
 *
 * Anything outside that grammar (push certificates, delim/response-end pkts,
 * a NUL on a later line, non-hex object names) is `malformed` and the push is
 * refused. Fail closed: the fix agent's git never needs any of it.
 */

/** One ref update from the command list. */
export interface ReceivePackCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export type ParseReceivePackResult =
  | {
      ok: true;
      commands: ReceivePackCommand[];
      /** Bytes up to and including the flush-pkt: the PACK starts here. */
      consumed: number;
    }
  | {
      ok: false;
      /**
       * `incomplete`: the flush-pkt has not arrived yet (read more bytes).
       * `malformed`: the bytes can never become a valid command list.
       */
      reason: "incomplete" | "malformed";
    };

export type RefFenceResult =
  | { ok: true; pushedSha: string }
  | {
      ok: false;
      reason:
        | "ref_not_allowed"
        | "delete_not_allowed"
        | "no_commands"
        | "no_ref_fence";
      /** The first offending ref (absent for `no_commands`, `no_ref_fence`). */
      ref?: string;
    };

/** The all-zeros sha1 object name git uses for "no object" (create/delete). */
export const RECEIVE_PACK_ZERO_SHA = "0".repeat(40);

const HEX_LEN = /^[0-9a-f]{4}$/;
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_NAME = /^0+$/;
const SHALLOW_PREFIX = "shallow ";

/** True for a sha1 or sha256 object name in lowercase hex. */
export function isObjectName(value: string): boolean {
  return OBJECT_NAME.test(value);
}

/** True for the all-zeros object name git uses for "no object". */
export function isZeroObjectName(value: string): boolean {
  return ZERO_NAME.test(value);
}
// ignoreBOM keeps a leading U+FEFF in the payload, as Buffer#toString does.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Decode `length` bytes at `start` as ASCII (one char per byte). */
function asciiAt(buf: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length; i++) {
    out += String.fromCharCode(buf[i] ?? 0);
  }
  return out;
}

/** One pkt-line read at an offset of a buffer. */
export type PktLine =
  | { kind: "flush"; next: number }
  | { kind: "data"; payload: Uint8Array; next: number }
  /** The header or the payload is not all in the buffer yet. */
  | { kind: "incomplete" }
  /** Not a pkt-line git writes: bad hex length, or a length below 5. */
  | { kind: "malformed" };

/**
 * Read the pkt-line that starts at `offset`: a 4-hex-digit length that counts
 * itself, then the payload. `0000` is a flush. 0001 (delim) and 0002
 * (response-end) are protocol v2 only, and 3 is impossible; a data pkt carries
 * at least one payload byte, so any length below 5 is malformed.
 */
export function readPktLine(buf: Uint8Array, offset: number): PktLine {
  if (buf.length - offset < 4) return { kind: "incomplete" };
  const lenHex = asciiAt(buf, offset, 4).toLowerCase();
  if (!HEX_LEN.test(lenHex)) return { kind: "malformed" };
  const len = Number.parseInt(lenHex, 16);
  if (len === 0) return { kind: "flush", next: offset + 4 };
  if (len < 5) return { kind: "malformed" };
  if (buf.length - offset < len) return { kind: "incomplete" };
  return {
    kind: "data",
    payload: buf.subarray(offset + 4, offset + len),
    next: offset + len,
  };
}

/**
 * Parse the receive-pack command section at the start of `buf`.
 * `incomplete` until the terminating flush-pkt is in the buffer.
 */
export function parseReceivePackCommands(
  buf: Uint8Array,
): ParseReceivePackResult {
  const commands: ReceivePackCommand[] = [];
  let offset = 0;
  let sawCommand = false;
  for (;;) {
    const pkt = readPktLine(buf, offset);
    if (pkt.kind === "incomplete" || pkt.kind === "malformed") {
      return { ok: false, reason: pkt.kind };
    }
    if (pkt.kind === "flush") {
      return { ok: true, commands, consumed: pkt.next };
    }
    let payload = UTF8.decode(pkt.payload);
    offset = pkt.next;
    if (payload.endsWith("\n")) payload = payload.slice(0, -1);

    if (payload.startsWith(SHALLOW_PREFIX)) {
      // Shallow lines are legal only before the first command.
      if (sawCommand) return { ok: false, reason: "malformed" };
      if (!OBJECT_NAME.test(payload.slice(SHALLOW_PREFIX.length))) {
        return { ok: false, reason: "malformed" };
      }
      continue;
    }

    const nul = payload.indexOf("\u0000");
    // Capabilities ride only on the first command.
    if (nul !== -1 && sawCommand) return { ok: false, reason: "malformed" };
    const command = parseCommandLine(
      nul === -1 ? payload : payload.slice(0, nul),
    );
    if (!command) return { ok: false, reason: "malformed" };
    sawCommand = true;
    commands.push(command);
  }
}

function parseCommandLine(line: string): ReceivePackCommand | null {
  const parts = line.split(" ");
  if (parts.length !== 3) return null;
  const [oldSha, newSha, ref] = parts as [string, string, string];
  if (!OBJECT_NAME.test(oldSha) || !OBJECT_NAME.test(newSha)) return null;
  if (oldSha.length !== newSha.length) return null;
  // Control characters never appear in a valid ref name (git-check-ref-format).
  if (ref.length === 0 || /[\u0000-\u001f\u007f]/.test(ref)) return null;
  return { oldSha, newSha, ref };
}

/**
 * Every update must target exactly `exactRef` and must not delete it. One bad
 * update rejects the whole push. The pushed sha is the last update's new sha.
 * A `null` fence means the step has no ref to push to: `no_ref_fence`.
 */
export function checkRefFence(
  commands: readonly ReceivePackCommand[],
  fence: { exactRef: string } | null,
): RefFenceResult {
  if (commands.length === 0) return { ok: false, reason: "no_commands" };
  if (fence === null) return { ok: false, reason: "no_ref_fence" };
  for (const command of commands) {
    if (command.ref !== fence.exactRef) {
      return { ok: false, reason: "ref_not_allowed", ref: command.ref };
    }
    if (ZERO_NAME.test(command.newSha)) {
      return { ok: false, reason: "delete_not_allowed", ref: command.ref };
    }
  }
  // Non-empty: checked above.
  const last = commands[commands.length - 1] as ReceivePackCommand;
  return { ok: true, pushedSha: last.newSha };
}

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * True when `ref` is a well-formed `refs/heads/<name>` branch ref: git's
 * check-ref-format rules, plus fail-closed extras: a name starting with `-`,
 * the name `HEAD`, and a name holding U+FFFD or a lone surrogate are refused.
 * The last one matters because the receive-pack parser decodes ref bytes
 * leniently, so any invalid UTF-8 in a pushed ref becomes U+FFFD; a fence
 * holding U+FFFD would then match refs whose raw bytes differ from it.
 */
export function isBranchRef(ref: string): boolean {
  if (!ref.startsWith(BRANCH_REF_PREFIX)) return false;
  const name = ref.slice(BRANCH_REF_PREFIX.length);
  if (name.length === 0 || name === "@" || name === "HEAD") return false;
  if (name.startsWith("-")) return false;
  if (name.endsWith(".") || name.includes("..") || name.includes("@{")) {
    return false;
  }
  // Control characters, space, DEL and git's reserved punctuation.
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  if (/[\uD800-\uDFFF\uFFFD]/u.test(name)) return false;
  return name
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
}

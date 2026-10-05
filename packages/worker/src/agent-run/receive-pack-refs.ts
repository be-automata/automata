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
      reason: "ref_not_allowed" | "delete_not_allowed" | "no_commands";
      /** The first offending ref (absent for `no_commands`). */
      ref?: string;
    };

/** The all-zeros sha1 object name git uses for "no object" (create/delete). */
export const RECEIVE_PACK_ZERO_SHA = "0".repeat(40);

const HEX_LEN = /^[0-9a-f]{4}$/;
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_NAME = /^0+$/;
const SHALLOW_PREFIX = "shallow ";

/**
 * Parse the receive-pack command section at the start of `buf`.
 * `incomplete` until the terminating flush-pkt is in the buffer.
 */
export function parseReceivePackCommands(buf: Buffer): ParseReceivePackResult {
  const commands: ReceivePackCommand[] = [];
  let offset = 0;
  let sawCommand = false;
  for (;;) {
    if (buf.length - offset < 4) return { ok: false, reason: "incomplete" };
    const lenHex = buf.toString("latin1", offset, offset + 4).toLowerCase();
    if (!HEX_LEN.test(lenHex)) return { ok: false, reason: "malformed" };
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      return { ok: true, commands, consumed: offset + 4 };
    }
    // 0001 (delim) / 0002 (response-end) are protocol v2 only, and 3 is
    // impossible; a data pkt carries at least one payload byte.
    if (len < 5) return { ok: false, reason: "malformed" };
    if (buf.length - offset < len) return { ok: false, reason: "incomplete" };
    let payload = buf.toString("utf8", offset + 4, offset + len);
    offset += len;
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
 */
export function checkRefFence(
  commands: readonly ReceivePackCommand[],
  fence: { exactRef: string },
): RefFenceResult {
  if (commands.length === 0) return { ok: false, reason: "no_commands" };
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

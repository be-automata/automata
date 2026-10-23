import { randomUUID } from "node:crypto";
import net from "node:net";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";

/**
 * Write one DaemonMessage over the daemon's unix-socket protocol and wait for its
 * ACK. The daemon's socket server (DaemonRuntime.listenToUnixSocket) expects a
 * WRAPPED envelope `{ id, data }` where `data` is the STRINGIFIED DaemonMessage —
 * it JSON.parses the frame, hands the inner `data` to the message parser, and
 * replies `{ status: "ACK"|"ERROR", id }`. Writing the raw message instead makes
 * the daemon read `payloadData: undefined` → it never runs the agent and the run
 * idles to the schedule timeout. This mirrors the daemon's own writeToUnixSocket.
 */
export function writeDaemonMessage(
  socketPath: string,
  dataStr: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const msgId = randomUUID();
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      finish(() =>
        reject(new Error(`daemon socket write timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    sock.once("connect", () => {
      sock.write(JSON.stringify({ id: msgId, data: dataStr }));
    });
    sock.on("data", (buffer) => {
      let response: { id?: string; status?: string; error?: string };
      try {
        response = JSON.parse(buffer.toString());
      } catch {
        return; // partial/other frame — keep waiting
      }
      if (response.id !== msgId) {
        return;
      }
      clearTimeout(timer);
      sock.end();
      if (response.status === "ACK") {
        finish(resolve);
      } else {
        // #6: the daemon rejecting the message is a terminal contract error (the
        // message won't parse/run), not a transient blip → NonRetryableError so it
        // routes straight to onFailure instead of burning a retry.
        finish(() =>
          reject(
            new NonRetryableError(
              `daemon rejected the message: ${response.error ?? response.status ?? "unknown"}`,
            ),
          ),
        );
      }
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.destroy();
      finish(() => reject(err));
    });
    sock.once("close", () => {
      clearTimeout(timer);
      finish(() =>
        reject(new Error("daemon socket closed before ACK was received")),
      );
    });
  });
}

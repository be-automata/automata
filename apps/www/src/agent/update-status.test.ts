import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `didUpdateStatus` is the compare-and-set result: "I won the race to move this
 * thread's status". Twelve call sites gate real work on it — the follow-up
 * queue drain, checkpointing, retry, the daemon-event finish hook (which posts
 * PR reviews), and the draft/scheduled server actions.
 *
 * It was reported unconditionally true. `updateThreadChatStatusAtomic` returns
 * `{ didUpdateStatus: boolean }`, and the caller tested the truthiness of that
 * OBJECT (`if (!!updatedThreadOrUndefined)`) rather than the field inside it —
 * a leftover from when the function returned a row-or-undefined. So every
 * caller was told it won even when the `eq(status, fromStatus)` guard matched
 * zero rows, which is the whole purpose of the CAS.
 *
 * Mocked rather than real-DB on purpose: the losing interleaving lives inside
 * the function, between its own status read and the CAS, so it cannot be
 * produced from the outside. What IS testable is that the caller propagates the
 * CAS verdict faithfully in both directions.
 */

import * as threadsModel from "@terragon/shared/model/threads";
import * as readStatus from "@terragon/shared/model/thread-read-status";

import { updateThreadChatWithTransition } from "./update-status";

function stubs({ chatStatus, cas }: { chatStatus: string; cas: boolean }) {
  vi.spyOn(threadsModel, "getThreadChat").mockResolvedValue({
    id: "chat_1",
    status: chatStatus,
    reattemptQueueAt: null,
  } as never);
  vi.spyOn(threadsModel, "updateThread").mockResolvedValue(undefined as never);
  vi.spyOn(threadsModel, "updateThreadChat").mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(readStatus, "markThreadChatAsUnread").mockResolvedValue(
    undefined as never,
  );
  return vi
    .spyOn(threadsModel, "updateThreadChatStatusAtomic")
    .mockResolvedValue({ didUpdateStatus: cas } as never);
}

const args = {
  userId: "user_1",
  threadId: "thread_1",
  threadChatId: "chat_1",
  eventType: "assistant.message_done" as const,
};

describe("updateThreadChatWithTransition — the CAS verdict is propagated, not assumed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports FALSE when the compare-and-set matched no rows", async () => {
    stubs({ chatStatus: "working", cas: false });
    const res = await updateThreadChatWithTransition(args);
    // The regression: this returned true, so every downstream race guard
    // believed it had won a race it had actually lost.
    expect(res.didUpdateStatus).toBe(false);
  });

  it("reports TRUE when the compare-and-set moved the row", async () => {
    stubs({ chatStatus: "working", cas: true });
    const res = await updateThreadChatWithTransition(args);
    expect(res.didUpdateStatus).toBe(true);
  });

  it("still reports FALSE when the state machine yields no transition at all", async () => {
    // A terminal thread has no outgoing edge for an assistant event, so the CAS
    // is never attempted and the answer must stay false.
    const casSpy = stubs({ chatStatus: "complete", cas: true });
    const res = await updateThreadChatWithTransition(args);
    expect(res.didUpdateStatus).toBe(false);
    expect(casSpy).not.toHaveBeenCalled();
  });
});

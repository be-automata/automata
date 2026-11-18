# #503: drop the post-revoke egress batch as expected, worker side

Issue: [be-automata/automata#503](https://github.com/be-automata/automata/issues/503). Decided on
2026-11-17: option 1 (worker side). Option 2 (a www grace window for a just-revoked token) was
rejected because it weakens revocation. Follows #473 / #487.

## Problem

Since #487 the worker flushes the egress audit batch before every `thread-status` read, the terminal
one included. A proxy event buffered after that final flush begins is sent only by teardown's
`close()`. By then www has served `terminal=true` and revoked the daemon token, so the post spends
three 401s and two 2 s sleeps (about 4 s of teardown) and then logs `postEgressEvents non-2xx (audit
rows lost)`. Measured on the box: 2 of 85 terminal reads (2.4%).

## Ground truth (verified at origin/main a6996533)

| Claim                                                                                                                                      | Where                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| The batcher is `createEgressEventBatcher`; its `close()` clears the timer and calls `flush()`                                              | `packages/worker/src/agent-run/workflow.ts:283`, `:339-342`                                            |
| `beforeStatusRead` flushes the batcher before each status read                                                                             | `workflow.ts:1233-1235`, called at `www-client.ts:702`                                                 |
| `pollUntilTerminal` returns `{ outcome: "completed" }` right after the read served `terminal=true`                                         | `www-client.ts:773`, called at `workflow.ts:1805`                                                      |
| www revokes the token on that read: `revokeDaemonTokenById` in `waitUntil`, which deletes the apikey row                                   | `apps/www/src/app/api/daemon/thread-status/route.ts:84-95`, `apps/www/src/lib/daemon-token.ts:119-131` |
| Teardown's last flush is `closeQuietly(egressEvents)` in the inner `finally`                                                               | `workflow.ts:1939`                                                                                     |
| `postEgressEvents` retries a refused-before-handler status (401) up to `AUTH_ERROR_CONFIRM_ATTEMPTS`, sleeping between, then logs the loss | `www-client.ts:466-506`                                                                                |
| `cancelled` and `stopped` outcomes do not come from a terminal read, so their token is live (onFailure / the typed terminal needs it)      | `www-client.ts:687-688, 703-705, 775-777`                                                              |

## Change

1. `createEgressEventBatcher` gains `markTerminal()`. After it, `add()` and `flush()` never POST: the
   buffered events and any later ones are counted. `close()` logs `[agent-run] egress events dropped
post-revoke (expected)` once with `{ threadId, count }` (`console.info`), and makes no fetch and no
   sleep.
2. `workflow.ts`, right after `pollUntilTerminal` returns: when `result.outcome === "completed"`, call
   `egressEvents?.markTerminal()`.

Not changed: www (no grace window), `postEgressEvents`, the cancelled/stopped/failed paths.

## Acceptance Criteria

- AC-1: Once marked terminal, `close()` POSTs nothing (no `postEgressEvents`, no `fetch`, no timer
  left), and logs one expected-drop line with `count: 1` for one buffered event.
- AC-2: Without the mark, `close()` still POSTs the buffer and logs no drop.
- AC-3: A `completed` run whose last event lands after the final pre-read flush posts nothing at
  teardown and logs one expected drop with its count; a `cancelled` run still posts it.
- AC-4: The gates pass: `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check` and the
  worker suite.

## Tests

- AC-1: `workflow-cleanup.test.ts` "#503: once marked terminal (token revoked), close() drops the
  buffer ...", plus "after the mark, events added later and timer ticks post nothing ...".
- AC-2: `workflow-cleanup.test.ts` "#503: without the terminal mark, close() still POSTs the buffer".
- AC-3: `workflow-cleanup.test.ts` describe "#503: a batch buffered after the terminal read is dropped
  ...", cases "completed: ..." and "cancelled: ...".

## Risks and rollback

A run that reached `completed` loses the audit rows of events after its terminal read, which it lost
before too; now it says so and saves about 4 s. Rollback: revert the commit.

## Open question

The late-starvation path (`www-client.ts:762-770`) throws after a terminal read, so its token is
revoked too, but it is a failed run and keeps the live-token path per the decision. Its leftover batch
can still log a 401 loss. Not addressed here.

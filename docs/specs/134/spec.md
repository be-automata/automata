# #134 (log part): a WebhookSkip is not logged as a webhook error

Issue: [be-automata/automata#134](https://github.com/be-automata/automata/issues/134). Decided on
2026-11-17: this PR fixes only the log. The issue's other finding, the sandbox-creation rate limiter
that fails open (`redis.evalsha is not a function`), is fixed by the operator setting
`REDIS_URL`/`REDIS_TOKEN` on automata-www. This PR does not touch the limiter and does not close #134.

## Problem

The 2026-08-23 `wrangler tail` showed `[github webhook] error — AggregateError: No org bound to
installation for be-automata/automata`. That delivery is a business rejection (WI-8): the route
already logs it as `[github webhook] skipped` and answers 2xx. But octokit first hands every handler
error to `webhooks.onError`, which logs it with `console.error` whatever it is, so every skip also
shows up as an error.

## Ground truth (verified at origin/main a6996533)

| Claim                                                                                                                         | Where                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| mirror intake throws `WebhookSkip("unmapped_installation", "No org bound to installation for …")` for an unbound installation | `apps/www/src/app/api/webhooks/github/mirror-intake.ts:294-298` |
| `findWebhookSkip` finds a WebhookSkip, unwrapping octokit's AggregateError (`.errors` / `.cause`)                             | `apps/www/src/app/api/webhooks/github/webhook-skip.ts:35-56`    |
| `webhooks.onError` logs every handler error with `console.error("[github webhook] error", error)`                             | `apps/www/src/app/api/webhooks/github/route.ts:286-288`         |
| the `receive()` catch logs a skip as `[github webhook] skipped` and answers 2xx with `skipped: true`                          | `route.ts:309-322`                                              |
| a genuine error still logs `[github webhook] error` in that catch and answers 500                                             | `route.ts:324-328`                                              |
| the mirror handlers propagate the skip without logging it themselves                                                          | `apps/www/src/app/api/webhooks/github/handlers.ts:1112-1117`    |

## Change

In `webhooks.onError`, return early when `findWebhookSkip(error)` matches. A genuine error is still
logged there and again in the catch, as today.

Not changed: the limiter, the 2xx/5xx answers, the `skipped` log, and the per-handler
`console.error("Error handling … event:")` lines in `handlers.ts` (see the open question).

## Acceptance Criteria

- AC-1: A mirror delivery that raises an `unmapped_installation` WebhookSkip gets a 2xx with
  `skipped: true`, logs `[github webhook] skipped` with its category, and calls `console.error` zero
  times.
- AC-2: The gates pass: `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check` and the
  www suite.

## Tests

- AC-1: `apps/www/src/app/api/webhooks/github/route.test.ts` "an unmapped-installation skip answers
  2xx and logs 'skipped', with no console.error" (red before the change: one `console.error`).
- The existing "should return 500 for unexpected errors" and "WI-8: fast-acks 2xx" cases keep the
  error path and the skip answer covered.

## Risks and rollback

None for behaviour: only a log line goes. Rollback: revert the commit.

## Open question

The mention lane can raise the same skip (`handle-app-mention.ts:109`). Its comment and review
handlers (`handlers.ts:469`, `:564`, `:625`) log `console.error("Error handling … event:", error)`
before rethrowing, so a mention skip still prints one error line from the handler. Out of scope here.

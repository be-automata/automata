# API Contract — 209a: credential-source attribution

Sibling of `docs/specs/209a/spec.md` §7. One new endpoint. **No existing endpoint's contract
changes.**

Every shape below was derived from code read in this worktree
(`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/209a`), not from the
ticket's prose:

- auth preamble: `apps/www/src/lib/daemon-route.ts` (`parseDaemonRequest`)
- fence: `packages/shared/src/model/threads.ts:1106-1169` (`decideThreadGeneration`, `checkThreadGeneration`)
- closest sibling route: `apps/www/src/app/api/daemon/run-terminal/route.ts`
- write helper: `packages/shared/src/model/threads.ts:917-1041` (`updateThreadChat`)
- caller: `packages/worker/src/agent-run/www-client.ts` (`headers()` at `:36-48`)

---

## `POST /api/daemon/run-credential-source`

Record which credential path an agent run actually took. Append-only; it appends exactly one
message to the thread's existing message stream and changes nothing else.

### Auth

| Header | Required | Notes |
|---|---|---|
| `X-Daemon-Token` | **Yes** | Must resolve to a context with `tokenType === "daemon"`. A general/CLI token is rejected 403. |
| `content-type` | Yes | `application/json` |
| `x-run-external-id` | No | The Hatchet run generation (#125 C1). Present on every worker call (`www-client.ts:45-47`). **Absent ⇒ the fence fails OPEN** — by design, matching every other fenced route. |
| `traceparent` | No | Forwarded by the worker when the run carries one; not read by this route's logic. |

F2 binding (enforced by `parseDaemonRequest`): if the token context carries a non-null
`threadChatId` / `threadId`, they must equal the body's. A daemon token for thread A can never
write thread B.

### Request body

```jsonc
{
  "threadId":     "string, min length 1",        // required
  "threadChatId": "string, min length 1",        // required (legacy threads send the shared sentinel)
  "source":       "user-credential" | "built-in-credits" | "box-key"   // required, closed enum
}
```

zod:

```ts
const bodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  source: z.enum(CREDENTIAL_SOURCES),
});
```

`source` is a **closed three-literal union** — it is the structural reason no free text, and
therefore no secret, can reach the persisted value. There is no optional `detail`, `reason`,
`message` or `agent` field, and none may be added (spec §18 rule 5).

There are **no** query parameters and **no** path parameters.

### Responses

| Status | Body | When |
|---|---|---|
| **200** | `{ "recorded": true }` | Accepted. Exactly one message appended. |
| **400** | `{ "error": "Invalid body" }` or `{ "error": "Invalid body", "details": ZodIssue[] }` | Unparseable JSON, missing field, or `source` outside the enum. **Nothing is written.** |
| **401** | `{ "error": "Unauthorized" }` | No `X-Daemon-Token`, or it does not resolve. |
| **403** | `{ "error": "Forbidden" }` | Token is not `tokenType === "daemon"`, **or** its F2 binding names a different `threadId` / `threadChatId`. |
| **404** | `{ "error": "Thread not found" }` | `checkThreadGeneration` → `not-found`. |
| **409** | `{ "error": "superseded", "activeRunExternalId": string \| null }` | `checkThreadGeneration` → `superseded` or `stale-generation`. A superseded run must not write into the live run's transcript. **Nothing is written.** |
| **500** | Next.js default | Unexpected server failure. |

Response bodies are `NextResponse.json(...)`, matching `run-terminal/route.ts`.

**Nullability:** `activeRunExternalId` on the 409 body is `string | null` — `null` for a thread
with no stamped generation (`threads.ts:1125-1131`). Every other field above is non-null when
present.

### Side effects

On **200**, and only on 200:

```
updateThreadChat({
  db, userId: ctx.userId, organizationId: ctx.organizationId,
  threadId, threadChatId,
  updates: { appendMessages: [{ type: "credential-source", source, timestamp: <ISO8601> }] },
})
```

- Writes `thread.messages` for a legacy thread (`threadChatId === LEGACY_THREAD_CHAT_ID`) and
  `thread_chat.messages` otherwise — handled inside `updateThreadChat` (`threads.ts:938-1032`).
- Publishes the existing realtime broadcast (`publishBroadcastUserMessage`, `threads.ts:1033-1041`)
  so an open thread view updates live.

It does **NOT**:

- change `status`, `errorMessage`, `errorMessageInfo`, `terminalCause`, `activeRunExternalId`,
  `sessionId`, `contextLength`, `bootingSubstatus`, or `updatedAt`-driven status machinery;
- call `updateThreadChatWithTransition`, `handleDaemonEvent`, `handleThreadFinish`,
  `markThreadTerminal`, `retireHatchetRun`, or `maybeRecheckOnComplete`;
- touch `hatchet_run`;
- write any schema column that does not already exist (**no migration**).

### Idempotency

Not idempotent, deliberately: the route appends. The worker sends exactly one POST per run on a
straight-line path with no retry, so a duplicate cannot be produced by this caller. A duplicate
would be cosmetic (two identical lines), never wrong and never a secret. **Do not add a
de-duplication guard** (spec §11, §18 rule 13).

### Caller contract (worker)

`postRunCredentialSource(opts, { source })` in
`packages/worker/src/agent-run/www-client.ts`:

- never throws — both a thrown `fetch` and a non-2xx are caught, logged with a `[agent-run]`
  prefix, and swallowed (the `postRunFailed` / `postEgressEvents` contract);
- never retried;
- never parses the response body — only `res.ok` is consulted;
- never passes an `AbortSignal`;
- the only values it can send for `source` are the three union members, because the parameter
  type is the union.

### Example

```http
POST /api/daemon/run-credential-source HTTP/1.1
content-type: application/json
x-daemon-token: <daemon token>
x-run-external-id: 018f…-run

{"threadId":"thr_123","threadChatId":"chat_456","source":"built-in-credits"}
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"recorded":true}
```

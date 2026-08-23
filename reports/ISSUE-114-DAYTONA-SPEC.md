# #114 — Daytona native never-resident credential injection (build spec)

Goal: make the Daytona plane never-resident, mirroring the E2B native broker
(commits `ef1318f`, `f3a797f`, `6b52349`, `272ba59` on `feat/114-e2b-native-injection`).
All three prod-reachable planes (Docker sidecar, E2B native, Daytona native) then
hold the GitHub token OUT of the guest env/argv/disk.

## Mechanism (Daytona org Secrets — `@daytonaio/sdk@0.205.1`, already pinned)

- `daytona.secret.create({ name, value, hosts })` → `{ id, name, placeholder: "dtn_secret_<id>", hosts, updatedAt, ... }`.
  Value is write-only (never returned). Real value is substituted transparently
  on outbound HTTPS requests **to the allowed `hosts`**, where the placeholder
  appears **literally** in a request header.
- `daytona.create({ ..., secrets: { GH_TOKEN: "<secretName>" }, domainAllowList })` —
  `secrets` maps ENV-VAR-NAME → an EXISTING org-Secret NAME. The guest env var is
  set to that secret's `placeholder`. **Every referenced secret name must already
  exist** ⇒ the secret is created BEFORE `daytona.create` (inverted vs E2B).
- `daytona.secret.update(secretId, { value })`, `daytona.secret.delete(secretId)`,
  `daytona.secret.get(secretId)`, `daytona.secret.list({ name })`.
- Error classes (exported from `@daytonaio/sdk`): `DaytonaConflictError` (name
  already exists → upsert), `DaytonaNotFoundError` (missing → recreate). Confirmed
  present in the installed .d.ts.
- `setup.ts` brokered branches already exist: docker at ~L186, e2b at ~L202-207
  (e2b scrubs git-credentials AND unsets the github extraheader). The
  daytona-native branch slots in right after: scrub `~/.git-credentials` BUT SET
  the verbatim `Authorization: token $GH_TOKEN` extraheader (the inverse of e2b's
  unset).

### Substitution constraint (decisive)

Daytona substitutes the placeholder ONLY where it appears **verbatim** in an
outbound HTTPS header (base64-wrapped placeholders are NOT substituted). So:

- Guest `GH_TOKEN`/`GITHUB_TOKEN` = the secret's `placeholder` (`dtn_secret_<id>`),
  a NON-secret opaque token. `gh`/Octokit send `Authorization: token <GH_TOKEN>`
  → verbatim placeholder → substituted. ✅
- git HTTPS default credential helper sends `Authorization: Basic base64(...)`
  → placeholder gets base64-wrapped → substitution DEFEATED. So `setup.ts` MUST
  write, on the daytona-native path, a verbatim-token extraheader for the GitHub
  hosts:
  `git config --global http.https://github.com/.extraheader "Authorization: token $GH_TOKEN"`
  (shell-expanded at setup time so the placeholder lands verbatim in ~/.gitconfig;
  the placeholder is non-secret, so writing it to disk keeps never-residency of the
  REAL token). Do the same for `api.github.com` if the repo tooling hits it over git.
  Do NOT base64-wrap.

### Deterministic secret name (no schema change)

The secret must exist before the sandbox, so its name CANNOT derive from the
sandboxId. Derive it from the **stable thread id** (available at create AND
resume, unique, no new storage): `gh-inst-<sanitized-threadId>` sanitized to
`^[a-zA-Z_][a-zA-Z0-9_-]*$`. Carry this name in the broker SHAPE (the resolver
has thread context; the provider stays thread-agnostic). Re-derivable on resume,
teardown, and rotation from the same thread id.

## Changes (mirror the E2B commits)

### 1. `packages/sandbox/src/types.ts`

Add a third variant to `CredentialBrokerShape`:

```ts
export type DaytonaCredentialBrokerShape = {
  kind: "daytona-native";
  installationToken: string;
  repoFullName: string;
  secretName: string; // deterministic, thread-derived; stable across resume
};
```

Union becomes Docker | E2b | Daytona. JSDoc explaining never-resident + inverted
ordering + verbatim-header. (Optional secretName on E2B shape is NOT needed —
E2B derives from sandboxId; keep them distinct.)

### 2. `packages/sandbox/src/egress.ts`

Add `DAYTONA_BROKER_GITHUB_HOSTS` (github.com, api.github.com) and
`toDaytonaBrokeredNetwork({ egressPolicy })`: like `toDaytonaNetwork` but MERGE
the GitHub hosts into `domainAllowList` (dedup; still enforce the 20-domain cap
AFTER merge — throw if exceeded). When NO egress policy: return the github hosts
as the allowlist? NO — matching unbrokered behavior, no policy ⇒ open internet
(`{}`), and github is reachable + substituted. Only when a policy EXISTS must we
ensure github isn't accidentally blocked. So: `toDaytonaBrokeredNetwork` returns
`{}` when no policy, else `toDaytonaNetwork(policy)` with github hosts merged in.
Reject unrepresentable policies exactly as `toDaytonaNetwork` does.

### 3. `packages/sandbox/src/env.ts`

Extend the brokered branch: `credentialBroker?.kind === "daytona-native"` sets
`env.GH_TOKEN = env.GITHUB_TOKEN = <placeholder>`. BUT the placeholder
(`dtn_secret_<id>`) is only known after `secret.create`. Two options — pick (a):
(a) The provider injects the env var via the `secrets` map (ENV→secretName), so
env.ts does NOT need the placeholder value; instead env.ts must RESERVE
GH_TOKEN/GITHUB_TOKEN as "brokered — do not set a resident token" and let
the provider's `secrets` map own them. Confirm getEnv is called with the
daytona-native shape so it does NOT write the raw `githubAccessToken`. The
key invariant: on the daytona-native path env.ts must NEVER set GH_TOKEN to
the real installation token. (Docker/E2B reserve to bearer/placeholder;
Daytona reserves to "unset — provided by secrets map".)
Ensure the reserve-after-userEnv ordering matches the existing brokered branch
so a user-supplied GH_TOKEN cannot shadow/undo the brokered state.

### 4. `packages/sandbox/src/setup.ts`

On the daytona-native path in `setupGitCredentials` (mirror where the docker/e2b
branches diverge): write NO `~/.git-credentials`; instead write the verbatim
`http.https://github.com/.extraheader "Authorization: token $GH_TOKEN"` git
config (and api.github.com if used). Guard on `credentialBroker?.kind === "daytona-native"`.

### 5. `packages/sandbox/src/providers/daytona-provider.ts`

- `getOrCreateSandbox` (create branch): if
  `options.credentialBroker?.kind === "daytona-native"`:
  1. `secretName = broker.secretName`. Upsert the org secret with the GitHub
     hosts: try `daytona.secret.create({ name: secretName, value: installationToken, hosts: DAYTONA_BROKER_GITHUB_HOSTS })`; on `DaytonaConflictError` (stale secret from a prior run of this thread) `list({name})`→`update(id,{value})`. Capture `secret.id` for teardown.
  2. `createWithRetry(..., { secrets: { GH_TOKEN: secretName, GITHUB_TOKEN: secretName }, ...toDaytonaBrokeredNetwork })`.
     (Extend `createWithRetry` to accept a `secrets` map + brokered network.)
  3. Mark the session brokered with the secret id/name so `shutdown()` deletes it.
  4. Fail closed: any failure after secret.create → delete the secret + (if the
     sandbox was created) stop+delete it, then rethrow. Never fall back to a
     resident raw token.
- Resume (`getOrCreateSandbox` with sandboxId, and the internal resume): if
  brokered (`options.credentialBroker?.kind === "daytona-native"` OR
  `options.credentialBrokerMode === "brokered"`), REFRESH the secret value with
  the fresh token BEFORE returning the session: `list({name})`→`update(id,{value})`
  (create if gone). Fail closed if refresh fails (do not resume on a stale token).
  Mirror E2B `resumeSandbox`. If brokered provenance but no shape → throw (refuse).
- `getSandboxOrNull(sandboxId, refresh?)` and `extendLife(sandboxId, refresh?)`:
  add the optional `BrokerRefresh` param; throttle-refresh the secret before the
  resume/keepalive (mirror `refreshBrokerSecretIfStale` — but Daytona has no
  `Secret.getInfo(name)` by name; use `list({name})`→ item.updatedAt for the
  staleness check; SKIP if younger than BROKER_SECRET_STALE_MS; else mintToken +
  update). Keep it lazy. Non-brokered/absent refresh = today's behavior.
- `shutdown()` / teardown: delete the org secret (best-effort, retry-then-WARN,
  in a `finally` so a stop/delete throw can't orphan the secret). Mirror
  `destroyBrokerSecretBestEffort`.
- `hibernateById`/`shutdownById` equivalents: if a by-id teardown exists that
  bypasses the session, ensure it also deletes the secret (derive name is NOT
  possible from sandboxId — so a by-id path can't delete the secret without the
  name; document this limit OR skip if no such path exists for Daytona).

### 6. `apps/www/src/server-lib/credential-broker/resolve-credential-broker.ts`

- `resolveCredentialBrokerForCreate`: add `sandboxProvider === "daytona"` branch
  returning a `daytona-native` shape. It needs the thread id to derive
  `secretName` — add a `threadId` param (thread context is available at the call
  sites; the E2B/Docker branches ignore it). `secretName = daytonaBrokerSecretName(threadId)`.
- `resolveCredentialBrokerForResume`: allow `daytona` (not just e2b) → return the
  `daytona-native` shape (needs threadId too).
- `resolveBrokerRefreshForConnect`: allow `daytona` in addition to `e2b`.
- Add a small exported `daytonaBrokerSecretName(threadId)` sanitizer.
- Update all call sites of these three functions to pass `threadId`
  (apps/www/src/agent/sandbox.ts create+resume; handle-daemon-event.ts;
  thread-resource.ts; admin/sandbox.ts — the admin path looks up the owning
  thread via getThreadBrokerContextBySandboxId which must also return threadId).

### 7. Tests

Mirror the E2B provider tests: fresh/stale/missing/rotation-failure/no-handle for
getSandboxOrNull + extendLife; create upsert (create + conflict→update); create
fail-closed teardown; resume refresh + fail-closed; teardown deletes secret;
non-brokered unchanged (secret API never touched); env.ts daytona-native never
sets raw token; setup.ts writes verbatim extraheader (no base64, no git-credentials);
egress toDaytonaBrokeredNetwork merges github hosts + enforces cap; resolver
daytona branches. Use a mocked `daytona.secret` + `daytona.create`.

## Gates (all must be zero-exit; report actual numbers)

- `pnpm turbo run build --filter=@terragon/bundled --filter=@terragon/sandbox-image`
- `pnpm -C packages/sandbox test`
- `pnpm -C apps/www test`
- `pnpm tsc-check`
- `pnpm format && pnpm format-check`

## Invariants (do NOT violate)

- The real installation token NEVER enters the guest env, argv, or disk on the
  daytona-native path. Guest holds only the non-secret placeholder.
- Fail closed everywhere: a secret create/update/delete/refresh failure must
  prevent the guest from running on a stale/absent/real-resident credential.
- Non-brokered and non-Daytona paths byte-identical to today (no secret API calls).
- No schema change (secret name derives from the stable thread id).
- Verify every SDK call against the installed `@daytonaio/sdk@0.205.1` .d.ts
  before relying on it (types are under node_modules/.pnpm/@daytonaio+sdk@0.205.1).

## Commit

`feat(sandbox): Daytona native never-resident credential injection (#114)` on the
same branch `feat/114-e2b-native-injection`. Trailers:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01V2nt2vTgjVskpeHSddevHp
```

Do NOT push. Do NOT set an upstream.

---

## STATUS: DELIVERED

Daytona native never-resident credential injection implemented mirroring the E2B
broker. The real installation token never reaches the guest env/argv/disk on the
daytona path (the guest holds only Daytona's opaque `dtn_secret_<id>`
placeholder); every secret create/upsert/refresh/delete failure fails closed;
non-brokered and non-Daytona paths are untouched (no secret API calls); no DB
schema change (secret name derives from the stable thread id).

### Files touched (source)

- `packages/sandbox/src/types.ts` — added `DaytonaCredentialBrokerShape`
  (`kind: "daytona-native"`, carries `secretName`) to the `CredentialBrokerShape`
  union; added optional `secretName` to `BrokerRefresh` (Daytona-only; E2B ignores).
- `packages/sandbox/src/egress.ts` — added `DAYTONA_BROKER_GITHUB_HOSTS` and
  `toDaytonaBrokeredNetwork({ egressPolicy })` (`{}` when no policy; else
  `toDaytonaNetwork` + github hosts merged into `domainAllowList`, dedup, 20-cap
  enforced AFTER merge; rejects `none`/`ip_port` as `toDaytonaNetwork` does).
- `packages/sandbox/src/env.ts` — `daytona-native` branch DELETES
  `GH_TOKEN`/`GITHUB_TOKEN` (the create-time `secrets` map owns them; nothing may
  layer over the placeholder), after the userEnv loop so a user value cannot shadow.
- `packages/sandbox/src/setup.ts` — `daytona-native` branch writes the verbatim
  `http.https://github.com/.extraheader "Authorization: token $GH_TOKEN"` (and
  `api.github.com`), no `~/.git-credentials`, no base64.
- `packages/sandbox/src/providers/daytona-provider.ts` — `BROKER_SECRET_STALE_MS`;
  `upsertDaytonaBrokerSecret` (create → conflict→list+update, returns id);
  `deleteDaytonaBrokerSecretBestEffort` (retry-then-WARN); `refreshDaytonaBrokerSecretIfStale`
  (list→updatedAt throttle, fail-closed); `createWithRetry` extended with
  `{ egressPolicy, brokerSecretName }` (secrets map + brokered network);
  `DaytonaSession` brokered id/name + `markBrokered` + `shutdown()` deletes secret
  in `finally`; brokered create (secret BEFORE create, strips GH_TOKEN from
  envVars, fail-closed teardown); `resumeSandbox` (refresh secret BEFORE resume,
  fail closed, refuse when brokered-provenance-but-no-shape); `getSandboxOrNull` /
  `extendLife` accept `BrokerRefresh` and throttle-rotate before resume.
- `apps/www/src/server-lib/credential-broker/resolve-credential-broker.ts` —
  daytona branch in `resolveCredentialBrokerForCreate`/`...ForResume`/
  `resolveBrokerRefreshForConnect`; added `threadId` param to all three; exported
  `daytonaBrokerSecretName(threadId)` sanitizer.
- Call sites threaded `threadId`: `apps/www/src/agent/sandbox.ts` (create+resume),
  `apps/www/src/server-lib/handle-daemon-event.ts`, `apps/www/src/agent/thread-resource.ts`,
  `apps/www/src/server-actions/admin/sandbox.ts` (via brokerContext),
  `apps/www/src/app/api/run-setup-script/stream/route.ts` (threadless → `environmentId`).
- `packages/shared/src/model/threads.ts` — `getThreadBrokerContextBySandboxId` now
  also returns `threadId` (`schema.thread.id`).

### Files touched (tests)

- `packages/sandbox/src/providers/daytona-provider.test.ts` — rewritten: mocked
  `daytona.secret` + `daytona.create` + `daytona.get`; create-upsert (create;
  conflict→list+update), envVars strip, create fail-closed delete, setup
  fail-closed teardown, teardown deletes (incl. stop-rejects finally + retry-WARN),
  resume refresh + conflict-update + fail-closed + no-shape refuse, non-brokered
  untouched, and the §7a throttle matrix (fresh/stale/missing/failure/ambiguous/
  no-name/no-handle) for `getSandboxOrNull` AND `extendLife`.
- `packages/sandbox/src/egress.test.ts` — `toDaytonaBrokeredNetwork`
  (no-policy `{}`, github merge+dedup, 20-cap after merge, exactly-20, rejects
  none/ip_port).
- `packages/sandbox/src/env.test.ts` — daytona-native emits no GH_TOKEN, deletes
  user-supplied, applies overrides.
- `packages/sandbox/src/setup.test.ts` — daytona-native verbatim extraheader (no
  base64, no git-credentials, both hosts).
- `apps/www/src/server-lib/credential-broker/resolve-credential-broker.test.ts` —
  daytona create/resume shapes + `daytonaBrokerSecretName` sanitizer; threadId
  threaded through helpers.

### Gate results (all zero-exit)

- `pnpm turbo run build --filter=@terragon/bundled --filter=@terragon/sandbox-image` — 4/4 tasks successful.
- `pnpm -C packages/sandbox test` — 283 passed | 124 skipped (407), 15 files passed | 5 skipped.
- `pnpm -C apps/www test` — 1215 passed | 9 skipped (1224), 107 files passed | 1 skipped (resolver suite: 26 tests).
- `pnpm tsc-check` — 18/18 tasks successful.
- `pnpm format && pnpm format-check` — all matched files use Prettier code style.

### Deviations

- `BrokerRefresh` gained an optional `secretName` field (not spelled out in the
  spec). Required because the SECONDARY connect paths (`getSandboxOrNull`/
  `extendLife`) see only a sandboxId, but the Daytona secret name derives from the
  STABLE thread id — so, unlike E2B (which re-derives from the sandboxId in the
  provider), Daytona cannot re-derive it and the control plane must supply it.
  E2B ignores the field.
- `run-setup-script/stream/route.ts` is threadless; `threadId` there is passed a
  PER-INVOCATION unique id `` `${environmentId}-${randomBytes(8).hex}` `` (see the
  P2 FIX below). The sandbox is ephemeral, never resumes, and is torn down
  by-session, so deterministic-across-resume is moot — but the name MUST be unique
  per run to avoid the concurrent-setup collision.

## P1 FIX (post-review) — by-id teardown no longer orphans the org secret

Codex adversarial review found a real P1: the by-id teardown path
(`shutdownSandboxById` → generic `getSandboxOrNull`+`session.shutdown()` fallback,
because Daytona had no `shutdownById`) ran `shutdown()` on a FRESH UNMARKED
`DaytonaSession` — it deleted the guest but SKIPPED the secret, orphaning the
org-scoped secret holding a live installation token. Triggered by a brokered
Daytona create timeout after provisioning-done, a thread-persist failure, or the
brokered-resume recreate's stale-destroy.

Fix — thread the deterministic (thread-derived) secret name into the by-id path:

- `packages/sandbox/src/types.ts` — `shutdownById?(sandboxId, brokerSecretName?)`
  with JSDoc (Daytona-only param; E2B/Docker derive from the sandboxId, ignore it).
- `packages/sandbox/src/providers/e2b-provider.ts` — `shutdownById` accepts and
  IGNORES the optional `brokerSecretName` (satisfies the interface; no behavior change).
- `packages/sandbox/src/providers/daytona-provider.ts` — IMPLEMENTED `shutdownById`:
  `daytona.get()` (does NOT start the guest) → `sandbox.delete()` (works on a
  STOPPED guest, verified in @daytonaio/sdk@0.205.1) so it never revives a paused
  brokered guest (mirrors E2B's non-revival guarantee); in a `finally`, if a
  `brokerSecretName` is given, `list({ name })` → exact match → best-effort delete.
- `packages/sandbox/src/sandbox.ts` — `shutdownSandboxById` gains `brokerSecretName?`,
  passed through to `provider.shutdownById(sandboxId, brokerSecretName)`.
- `apps/www/src/agent/sandbox.ts` — computes `daytonaBrokerSecretName` once (from
  whichever broker shape applies; undefined for E2B/Docker/non-brokered) and passes
  it at all four `shutdownSandboxById` call sites (create-timeout sweep, recreate
  stale-destroy, recreate persist-failure, initial-create persist-failure). The
  stale-destroy uses the SAME name (deterministic from threadId).
- Tests: `daytona-provider.test.ts` gained 5 `shutdownById` cases (deletes by id
  without start/resume; deletes the secret via list→matched-id when a name is given;
  no-op on the secret with no name; best-effort — does not reject when the secret
  delete throws; deletes the secret in `finally` even when the guest delete throws).

## Post-rebase review — P1 (verified already-correct) + P2 FIX

A full-branch Codex review after rebasing onto origin/main (#122 orphan reclaim)
returned two findings:

- **P1 (setup ordering) — verified already-correct, NO code change.** Codex asked
  to ensure the Daytona git extraheader is configured before the initial private
  clone. Verified: `sandbox.ts` runs `setupSandboxEveryTime` (→ `setupGitCredentials`,
  which writes the verbatim `Authorization: token $GH_TOKEN` extraheader on the
  daytona-native path) BEFORE `setupSandboxOneTime` (→ `gitCloneRepo`), and
  `gitCloneRepo` clones from `https://github.com/<repo>.git` with NO URL-embedded
  token (header-based auth). So the header is present at clone time and Daytona
  substitutes it — private clone works. Codex's own note concedes "that ordering
  is actually correct."
- **P2 (setup-script secret-name collision) — FIXED.** `run-setup-script/stream/route.ts`
  derived the Daytona secret name from `environmentId`, so two concurrent
  setup-script runs for the SAME environment shared one secret and either's
  shutdown deleted the other's live credential. Fixed by deriving the name from a
  per-invocation unique id `` `${environmentId}-${randomBytes(8).toString("hex")}` ``.
  Safe because these sandboxes are ephemeral, never resume, and are torn down
  by-session (the session captured the unique name at create).

### Gate results after the P1 fix (all zero-exit)

- `pnpm turbo run build --filter=@terragon/bundled --filter=@terragon/sandbox-image` — 4/4 tasks successful.
- `pnpm -C packages/sandbox test` — 288 passed | 124 skipped (412); daytona-provider 35, e2b-provider 31.
- `pnpm -C apps/www test` — 1215 passed | 9 skipped (1224).
- `pnpm tsc-check` — 18/18 tasks successful.
- `pnpm format && pnpm format-check` — all matched files use Prettier code style.

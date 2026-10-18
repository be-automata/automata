---
spike: 021
name: agent-memory-context-persistency
type: integration
validates: "Given a per-scope agent with session + memory on $HOME, when stopped, recreated on rev N+1 and its context compacts, then turn-1 facts are recalled after each event, memory writes are revision-checked (human wins), memory never crosses scope; and memory records can be promoted into grounded claims via the 014 queue"
verdict: VALIDATED
related: [013-long-lived-agent-wake, 015-template-boots-persistent-box, 010-grounded-knowledge-claims, 014-knowledge-self-heal-loop, 011-scoped-knowledge-mcp]
tags: [long-lived-agents, memory, sessions, compaction, scope-isolation, knowledge, promotion, integration]
---

# Spike 021: Agent memory and context persistence, then promotion into knowledge

## What This Validates
A long-lived agent has two kinds of memory:
- **The harness session.** Claude Code's JSONL conversation. It is resumed by id and can be compacted.
- **Structured scope memory.** Facts the agent proposes and humans can edit.

Phase A tests what survives stop, recreate on rev N+1 and compaction, and whether scopes stay apart. It uses **real `claude -p`** on subscription auth: haiku, 12 tiny calls per run, about $0.04.

Phase B tests whether scoped memory can become *company* knowledge (spike 010's claims) through spike 014's approval queue without leaking or bypassing a human.

## Research
| Layer | Prior art | Survives stop | Survives compaction | Scope boundary | Human edit wins |
|---|---|---|---|---|---|
| Harness session JSONL (`~/.claude/projects/<cwd-slug>/<id>.jsonl`) | Claude Code `--resume`; qm's "session tape" | yes (on `$HOME`) | **lossy** | the config dir, *not* the cwd (found here) | n/a |
| Structured memory records, rev-checked | qm memory (provenance + sensitivity, revision-checked consolidation) | yes | **yes** (re-injected at wake) | store-enforced | **yes** |
| Claude Code auto-memory (`<project>/memory/`) | built-in | yes | yes | per project dir | no revision model |
| Grounded claims | OpenWiki / spike 010 | n/a | n/a | org-wide | spike 010's rules |

**Chosen:**
- Keep the session for continuity.
- Make **structured scope memory the durable layer** that is re-injected at every wake.
- Promote memory into claims **only when a source grounds it and a human approves**.

## How to Run
```bash
cd .planning/spikes/021-agent-memory-context-persistency
node --experimental-strip-types --no-warnings run.ts   # outside the Claude sandbox: real claude -p on subscription auth
```
- `ANTHROPIC_API_KEY` is stripped from the child env.
- Calls use `--setting-sources project --strict-mcp-config`, so the user's hooks, plugins and MCP servers don't run.
- At the end the runner deletes only its own `~/.claude/projects/*spike021-scope-*` session dirs, plus `work/`.

## What to Expect
- **Output:** 19 PASS lines, then `19/19 passed; claude calls 12, cost $0.03–0.09`.
- **Variance:** model outputs vary. The checks assert what must hold. Model-judgment behaviour is recorded, not asserted.

## Observability
- **`events.jsonl`:** every `claude` turn (cwd, prompt head, resume id, ms, cost, result) and every check.
- **`results.json`:** the promotion queue with provenance, the session-only recall after compaction, and the moved-workdir resume.

## Investigation Trail
1. **Isolating auth per scope breaks it.**
   - `CLAUDE_CONFIG_DIR=<scope>/.claude` gives "Not logged in": subscription credentials are keyed per config dir in the macOS Keychain.
   - So host runs share the default config dir.
   - In a box, auth must be injected per wake (spike 015's tmpfs, e.g. `CLAUDE_CODE_OAUTH_TOKEN`), not inherited.
2. **Turn 1, real.** Given three facts, the agent emitted `MEMORY[restricted]: …PELICAN-42`, `MEMORY[internal]: …HERON-7` and `MEMORY[internal]: Free trials last 14 days`. It labelled the codeword restricted unprompted.
   - **Write path:** the records go into scope A's store with `{sessionId, turn: 1}`.
3. **Stop and recreate.**
   - `--resume <id>` recalls after the process is gone, and again after the checkout is wiped and recreated at the same path.
   - **Hypothesis falsified:** I expected a *moved* workdir (rev N+1 relocating the checkout) to break resume, because sessions are stored under a cwd slug. It doesn't: **lookup by id spans every project in the config dir.** Good for rollouts, bad for isolation (next point).
4. **Scope isolation is the config dir, not the cwd.**
   - A scope B process sharing `~/.claude` **resumed scope A's session by id and recited A's fact.** The leak is confirmed in-spike.
   - With scope B's own config dir (`$HOME/.claude` on B's volume), `--resume <A-id>` fails with `No conversation found`. That check happens before auth.
   - So the physical boundary must be one `$HOME` volume per scope, never a shared harness home.
5. **Compaction is lossy.**
   - `/compact` writes a `compact_boundary`. Recall from the session alone after compaction failed in **4 of 6 runs**; the summary simply dropped the fact.
   - The structured memory, re-injected as a turn preamble (`<scope-memory>…</scope-memory>`), restored it in **3 of 3** runs after the fix.
6. **Two traps in the injection path:**
   - `--append-system-prompt` on `--resume` was **flaky**: a probe returned `UNKNOWN` with the fact in the appended system prompt. Injecting memory in the turn itself was reliable. → Deliver wake context in the turn.
   - **I first probed recall with the restricted codeword. After compaction the model sometimes refused to reveal it, even with memory injected,** honouring "must never leave this channel". That's model judgment, not persistence. Probes now use an internal fact (`HERON-7`). **Lesson: disclosure of restricted memory must be enforced by the store (never inject it outside its scope), never trusted to the model.**
7. **Revision checks (qm-style).**
   - An agent that read rev 1 and wrote after a human edit gets `MemoryConflictError` (`expected rev 1, store has rev 2`).
   - After re-reading, its write is still refused with `HumanOwnedMemoryError`. Agents may only *propose* changes to human-edited records.
   - Two agents writing on the same rev: the second conflicts.
   - A path-traversal scope id (`../scope-a`) is rejected.
8. **Phase B: promotion.**
   - All memory records go through `proposePromotion`. A deterministic grounding stand-in checks topic tokens and value agreement against spike 010's fixtures. The outcomes:

     | Memory record | Kind | Detail |
     |---|---|---|
     | "Free trials last 14 days" (scope A, real claude session) | **promote** | evidence `repo://billing.ts#L1-L1` + `doc://pricing#trial`; provenance = memory id + session id |
     | Codeword | **restricted** | never leaves its scope |
     | "Free trials last 21 days" (scope B, a sales channel that heard it wrong) | **contradiction** | against both sources, so it's routed to the memory owner and the source owners and is not promotable |
     | Seat price | promote, then **rejected** by the human | not a claim |

   - All items start `pending`.
   - Approval yields exactly one claim. Its statement is the **human-edited** memory text, so the phase A edit flows through.
   - The page checks `fresh`.
9. **The loop closes.** When engineering later changes `TRIAL_DAYS` to 30, the promoted claim flips to **`conflict`** (code 30 vs. doc 14), just as spike 010 would. The originating memory record is *not* silently rewritten.

## Results
**VALIDATED, 19/19, stable across 3 consecutive runs.** Each run is 12 haiku calls, $0.03–0.09, with a median turn of 2.5 s (0.7–10.3 s).

| Event | Session-only recall | With scope memory re-injected |
|---|---|---|
| stop → `--resume` | ✓ | — |
| recreate, same workdir | ✓ | — |
| recreate, moved workdir | ✓ (id lookup is global per config dir) | — |
| `/compact` | ✗ in 4 of 6 runs | **✓ 3/3** |
| session lost (fresh session) | ✗ (control) | ✓ |

**Signal for the build:**
- **Two-layer memory.**
  - The harness session gives continuity and is best-effort.
  - The **structured scope memory** is the durable truth: a `memory_record` row with `rev` CAS, `sensitivity`, `humanEdited`, provenance `{sessionId, turn}` and `promotedTo`.
  - Every wake injects the scope's memory *in the turn*.
- **One `$HOME` volume per scope, including `~/.claude`.**
  - A shared harness home lets any scope resume any session by id.
  - Harness auth comes per wake via tmpfs, never from a shared config dir.
- **Session JSONL is sensitive.** It holds full request blobs, including the system context. Exclude `~/.claude` from artifact sync to R2 (spike 013).
- **Restricted memory is enforced by the store.** It is never injected outside its scope and never promotable, whatever the model would do.
- **Promotion:** memory becomes a claim only if a source grounds it (supports), a human approves it, and its text is the human-current text.
  - A contradiction goes to the memory owner and the source owners; it is never promoted.
  - Once promoted, the claim joins the 010/014 self-heal loop.
- **Not covered:**
  - Grounding by a real model. The stand-in here is token + value matching.
  - The scoped MCP read path for memory (spike 011).
  - Running inside a real box with injected harness auth (spike 018 covers that on Hetzner).

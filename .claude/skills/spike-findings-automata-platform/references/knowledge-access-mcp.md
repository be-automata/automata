# Scoped knowledge access over MCP (agent read/propose path)

## Requirements
- **Identity is a control-plane-signed launch token**, `{org, scopes, clearance, runId, exp}`, minted by the broker (#81) the way the spike 003 push token is. It is never a tool argument. The server refuses to start on a bad, expired or missing token.
- **The knowledge store is never inside the box.** The in-box MCP server is a thin client of the control plane, or the MCP is remote over HTTP with the per-run token. Otherwise Bash can simply `cat` the store.
- **Fail closed:**
  - unlabelled or unscoped records are invisible;
  - a hidden record and an absent one return identical errors (no existence oracle);
  - search filters *before* ranking;
  - grants are audited and expire, and never carry `restricted`.
- **Agent writes are proposals.** `kb_propose` creates a held draft for the spike 014 queue. It can't target a scope the principal doesn't hold, and it can't cite a record the principal can't see (no laundering).
- **Agent sessions run with an isolated Claude config dir/HOME.** `claude -p` otherwise inherits the operator's skills, hooks and plugins (spike 021 confirmed this for sessions too).
- **Every recalled record is data, not instructions:** add a wire field (`verification_required`/`untrusted`), as Entire Brain does.

## How to Build It
1. **Disclosure rule** (`sources/011-scoped-knowledge-mcp/kb.ts` `disclosure()`):
   ```ts
   if (!isSensitivity(rec.sensitivity) || !rec.scope) return { ok: false };              // fail closed
   if (p.scopes.includes(rec.scope) && RANK[rec.sensitivity] <= RANK[p.clearance]) return { ok: true, via: "scope" };
   if (rec.sensitivity === "restricted") return { ok: false };                             // never via grant
   // else: unexpired grant from rec.scope to one of p.scopes naming rec.id, within grant cap AND clearance
   ```
2. **Tools:** `kb_search(query)`, `kb_read(id)` and `kb_propose(scope, title, text, basedOn[])`. Ignore extra arguments (`scope`, `clearance`, `principal`); they are attack surface.
3. **Audit every call:** runId, scopes, clearance, the ids returned *and* the ids denied. That is the disclosure ledger.
4. **Version visibility (from the Entire Brain research):** layer git reachability on top of scope. Scope decides *who* sees a record; whether the record's anchor commit is reachable from the reader's ref decides *which version*.
5. **CI canary suite:**
   - restricted, confidential and unlabelled records each carry a unique canary;
   - a positive-control principal must see its canary;
   - 6 adversarial `claude -p` prompts (direct read, enumeration, forged authority args, planted injection, exfiltration via propose) must leak 0 canaries.

## What to Avoid
- Passing scope as a tool argument, or relying on prompt instructions ("don't reveal X"). The model is not the boundary.
  - The model refused the injection on its own, but in 021, after compaction, it sometimes disclosed or refused inconsistently.
- An error message that differs for "not allowed" and "doesn't exist".
- Trusting a first-run all-pass. Check that each refusal fails for the stated reason (`TokenError: bad signature`, `expired`, `no principal token`).
- Saving raw `claude -p` stream-json. Its init lines list the host's skills and plugins, and one leaked a customer name. Strip `type:"system"` lines.

## Constraints
- A leak test costs 6 real sessions, about 25 s each, roughly $1.9 at subscription-equivalent prices.
- The spike's store sits on disk beside the server. Production must be remote.

## Origin
Synthesized from spike 011, plus the recall-safety contract from `sources/research_entire-brain_20261018.md`.
Source files: `sources/011-scoped-knowledge-mcp/`.

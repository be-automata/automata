# Phase 2 — Headless capability spike: FINDINGS

**Date:** 2026-10-03
**CLI:** `2.1.284 (Claude Code)` (spike-transcripts/preflight.version.txt), pinned locally via
`npx -y @anthropic-ai/claude-code@2.1.284`; init `claude_code_version` = 2.1.284 in every transcript.
**Auth:<redacted> `"apiKeySource":"none"` (preflight.apikeysource.txt), i.e. the operator's subscription OAuth.
**Model:** `--model haiku` → `claude-haiku-4-5-20251001` for the lead and every sub-agent.

**Where each probe ran**
- Q1, Q2, Q3, Q4, Q5, Q7: locally on the operator's Mac. Each probe's cwd was a throwaway git repo under
  `$TMPDIR/zz-spike-raw`, and the harness is `spike-transcripts/harness.sh`.
- Q6: on the box automata-exec-1, through the real sudo spawn shape, with no model call
  (`spike-transcripts/box-probe.sh` → `box-q6.txt`). NRestarts was 0 before and 0 after, with 0 runs in flight.

**Local vs box caveats**
- `--setting-sources user` loads the operator's real user layer locally: 14 plugins, 29 MCP servers
  (826 MCP tools), 64 agents and 302 skills in the init. The box's per-run HOME is minimal. All
  verdicts below therefore look for the `zz-` names only.
- The operator has user hooks on 11 events: PreToolUse x6, PostToolUse x6, SessionStart x4, Stop x3,
  SubagentStart, SubagentStop and others (`user-hooks.txt`; event names and counts only). Every probe
  neutralised them with `--settings '{"disableAllHooks":true}'`, except the Q3 hook-marker pair, which
  used a tool-free prompt. Hooks that plugins provide cannot be listed this way.
- Trust was forced by a jq-added `hasTrustDialogAccepted` key that the harness reverts. The box seeds
  trust per run instead. **2.1.284 does not pass trust from a parent dir down to a child repo once
  project settings load.** The first q3hookscontrol run printed
  `Ignoring 4 permissions.allow entries from .claude/settings.json: this workspace has not been trusted`
  (kept as evidence in `q3hookscontrol.run1.stderr.txt`). That fired STOP_TRUST_NOT_APPLIED. Per the
  2026-10-03 amendment, every Q3 repo then got its own exact trust key (`trust_repo()` in harness.sh),
  and all four Q3 probes were re-run that way.
- haiku issued "separate" tool calls as one parallel batch (one `message.id`). This matters for Q5.
- The npm config has `ignore-scripts=true`, so the npx-cached 2.1.284 package needed its own
  `install.cjs` run once. That script only hardlinks the native binary npm had already downloaded.

## Effective argv

The production review argv (`claudeCommand()` + `reviewPolicyArgs()`, packages/daemon/src/claude.ts):

```
cat prompt | claude -p --model <m> --verbose --permission-mode default --allowedTools Read Grep Glob Bash \
  --disallowedTools 'Bash(gh:*)' 'Bash(git push:*)' --setting-sources user --output-format stream-json \
  [--mcp-config …] --append-system-prompt "<Terry>"
```

The spike argv (preflight.argv.txt, identical for q1/q2q7/q4parent/q4sub/q3tools apart from the
allowlist, and with the `Terry` prompt truncated here):

```
-p --model haiku --verbose --permission-mode default --allowedTools Read Grep Glob Bash Task Agent Skill
--disallowedTools Bash\(gh:\*\) Bash\(git\ push:\*\) --setting-sources user --settings \{\"disableAllHooks\":true\}
--output-format stream-json --append-system-prompt Your\ name\ is\ Terry\ …
```

Deviations per probe, each recorded in `<probe>.argv.txt` and in the last line of `<probe>.stderr.txt`:

| probe | allowlist | `--setting-sources user` | disableAllHooks | `--max-turns` |
|---|---|---|---|---|
| preflight, q1, q2q7, q4parent, q4sub | Read Grep Glob Bash Task Agent Skill | yes | yes | — |
| q2taskonly | Read Grep Glob Bash **Task** Skill | yes | yes | — |
| q2agentonly | Read Grep Glob Bash **Agent** Skill | yes | yes | — |
| q5parent (+ .run1) | default widened | yes | yes | **2** |
| q5sub | default widened | yes | yes | **3** |
| q3hooks | default widened | yes | **no** | — |
| q3hookscontrol | default widened | **no** | **no** | — |
| q3tools | default widened | yes | yes | — |
| q3toolscontrol | default widened | **no** | yes | — |

## Q1 — Do `~/.claude/skills/*` load, and can `Skill` invoke one under `--setting-sources user`?

**Verdict:** YES — the user-level `zz-spike-skill` is in init `skills` and `slash_commands`, the lead invoked it through the `Skill` tool, and the skill's body ran.
**Command:** `bash spike-transcripts/harness.sh q1` (argv: q1.argv.txt)
**Evidence:** spike-transcripts/q1.jsonl

```
init: {"zz_skills":["zz-spike-skill"],"zz_slash":["zz-spike-skill"],"zz_agents":["zz-spike-agent"]}
tool_use  (parent null): {"name":"Skill","input":{"skill":"zz-spike-skill"}}
tool_result:             "Launching skill: zz-spike-skill"
result: {"subtype":"success","is_error":false,"num_turns":3,"permission_denials":[],"result":"ZZ_SKILL_TOKEN_7731"}
```
There was no Read, Grep or Bash of the SKILL.md path.

## Q2 — Do `~/.claude/agents/*.md` load and can the sub-agent tool spawn one? `Task` or `Agent`?

**Verdict:** YES — `zz-spike-agent` is in init `agents` and was spawned. **The init `tools` list says `Task`, but the tool_use is named `Agent`.** Allowlisting either name alone is enough, and the sub-agent ran on `claude-haiku-4-5-20251001`.
**Command:** `bash spike-transcripts/harness.sh q2q7`, `… q2taskonly`, `… q2agentonly` (argv files of the same names)
**Evidence:** spike-transcripts/q2q7.jsonl, q2taskonly.jsonl, q2agentonly.jsonl

```
init tools (all three runs): [..."Task",...,"Skill",...]          # no entry named "Agent"
q2taskonly  lead tool_use: {"name":"Agent","input":{"subagent_type":"zz-spike-agent","prompt":"run `echo ZZ_AGENT_RAN_4412`"}}
q2agentonly lead tool_use: {"name":"Agent","input":{"subagent_type":"zz-spike-agent", ...}}
sub (parent toolu_01Ge…) model claude-haiku-4-5-20251001 tool_use Bash "echo ZZ_AGENT_RAN_4412" -> "ZZ_AGENT_RAN_4412"
lead tool_result: "Async agent launched successfully. … The agent is working in the background."
q2q7 line order: 1 init | 23 task_notification | 24 init | 29 result("Waiting for the spike agent…") | 30 result(final)
```
**Async behaviour.** In `-p` mode, 2.1.284 starts the sub-agent in the background
(`subagent_stats.started_in_background: 1`). The stream then carries **two `system/init` and two
`result` messages**. The first `result` holds the lead's interim text, for example "Waiting for the
spike agent to complete its task...". The second holds the lead's real final answer. Both `result`
lines come out together at the end of the stream, and this held in all 5 sub-agent probes
(q2q7, q2taskonly, q2agentonly, q4sub and q5sub).

## Q3 — SECURITY: do project-level `.claude/skills`, `.claude/agents`, `.claude/settings.json` hooks/permissions or `.mcp.json` load under `--setting-sources user`?

**Verdict:** NO — under `--setting-sources user` none of the attacker repo's skill, agent, MCP server, hooks, permissions.allow or CLAUDE.md took effect. The trusted positive control without the flag loaded all of them, so the difference comes from the flag.
**Command:** `bash spike-transcripts/harness.sh q3hooks`, `… q3hookscontrol`, `… q3tools`, `… q3toolscontrol` (argv files of the same names; every repo had its own trust key)
**Evidence:** spike-transcripts/q3hooks.{jsonl,checks.txt}, q3hookscontrol.*, q3tools.*, q3toolscontrol.*

| | q3hooks (`user`) | q3hookscontrol (no flag) | q3tools (`user`) | q3toolscontrol (no flag) |
|---|---|---|---|---|
| init zz_skills / zz_agents | [] / [] | zz-proj-skill / zz-proj-agent | [] / [] | zz-proj-skill / zz-proj-agent |
| init zz_mcp | [] | zz-proj-mcp (source project) | [] | zz-proj-mcp (source project) |
| markers | `[]` | `[zz-hook-sessionstart zz-hook-stop zz-hook-userpromptsubmit zz-mcp-spawned]` | `[]` | `[zz-mcp-spawned]` (hooks disabled) |
| project `allow: Write` | n/a | n/a | **denied** "…you haven't granted it yet." | **allowed** "File created successfully…" |
| proj_write_file | ABSENT | ABSENT | ABSENT | **PRESENT** |
| `gh --version` (project `allow: Bash(gh:*)`) | n/a | n/a | denied | **denied** — the CLI's `--disallowedTools` beats the project allow |
| CLAUDE.md token in assistant text | 0 | 0 (prompt said "exactly ok") | 0 | **1** (`ZZ_PROJ_CLAUDEMD_8080` led the reply) |

```
q3toolscontrol assistant: "ZZ_PROJ_CLAUDEMD_8080\n\nI'll execute these steps in order. …"
q3toolscontrol Write tool_result: "File created successfully at: …/repo.9aLlHP/zz-proj-write.txt"
q3tools        Write tool_result: "Claude requested permissions to write to …/repo.XjGC52/zz-proj-write.txt, but you haven't granted it yet."
```
CLAUDE.md is a memory file rather than a setting source, so it is a side observation. Under
`--setting-sources user` the project CLAUDE.md also had no visible effect.

## Q4 — Does a sub-agent inherit the parent's deny list (gh / git push) and allowlist?

**Verdict:** YES — the sub-agent's frontmatter has no `tools:`, yet inside it `gh --version`, `git push`, Write and WebFetch were all refused with a CLI **permission denial**. The bare remote got 0 refs and the probe file is ABSENT. The lead was refused the same four.
**Command:** `bash spike-transcripts/harness.sh q4parent`, `… q4sub` (argv files of the same names)
**Evidence:** spike-transcripts/q4parent.{jsonl,checks.txt}, q4sub.{jsonl,checks.txt}

| action | lead (q4parent, parent null) | sub-agent (q4sub, parent toolu_01DM…) |
|---|---|---|
| `gh --version` | permission denial: "Permission to use Bash with command gh --version has been denied." | permission denial: same text |
| `git push origin HEAD:refs/heads/main` | permission denial: "…git push origin HEAD:refs/heads/main has been denied." | permission denial: same text |
| Write zz-write-probe.txt | permission denial: "Claude requested permissions to write to …, but you haven't granted it yet." | permission denial: "Permission to use Write has been denied. …" |
| WebFetch https://example.com | permission denial: "Claude requested permissions to use WebFetch, but you haven't granted it yet." | permission denial: "Permission to use WebFetch has been denied. …" |
| checks | remote_refs=0, write_probe_file=ABSENT | remote_refs=0, write_probe_file=ABSENT |

None of these denials came from a hook or an untrusted workspace, since hooks were disabled and the
dir was trusted. `gh` is installed locally, so the denial blocked a binary that does exist. The
sub-agent's denials are also listed in the first `result.permission_denials`. There is no q4sub.notes.txt
because the sub-agent did run.

## Q5 — Does `--max-turns N` bound the whole run including sub-agent turns? What does the result look like when hit?

**Verdict:** PARTIAL — `--max-turns` is **not** a cumulative bound across the lead and its sub-agents. q5sub made 5 API turns in total against `--max-turns 3` and still ended `success`/`completed`, and the second `result` restarts `num_turns`. The shape of a max-turns stop was never seen, because haiku batched its tool calls and never reached the limit.
**Command:** `bash spike-transcripts/harness.sh q5parent` (run twice; first run kept as q5parent.run1.*), `… q5sub` (argv: q5parent.argv.txt `--max-turns 2`, q5sub.argv.txt `--max-turns 3`)
**Evidence:** spike-transcripts/q5parent.jsonl, q5parent.run1.jsonl, q5sub.jsonl

```
q5parent (both runs): 5 Bash tool_use in ONE message (msg_011CfgB7bA…), then 1 text message → 2 API turns
  result {"subtype":"success","num_turns":6,"terminal_reason":"completed"}      # num_turns 6 > 2, yet no stop
q5sub: lead msgs B4y (Agent), B5Ck (text) | sub msgs B5CJ (8 Bash, one batch), B5Zq (text) | lead B5oZ (DONE)
  sub-agent Bash tool_uses (parent non-null): 8
  result#1 {"subtype":"success","num_turns":2,"result":"Agent launched. Waiting for it to complete."}
  result#2 {"subtype":"success","num_turns":1,"result":"DONE","terminal_reason":"completed"}
```
`num_turns` counts tool round-trips (6 is greater than 2), but the limit is not enforced on that
counter. As far as can be seen, the limit is checked per agent loop against API calls. In both
results `subagent_stats.killed`/`refused` are all 0.

## Q6 — Box: PATH and `command -v` under the real sudo -E + bash -lc path; is `/usr/local/bin` on PATH?

**Verdict:** YES — `/usr/local/bin` is on the agent PATH. sudo's `secure_path` replaces PATH whatever `-E` would keep, and `claude` resolves to `/usr/local/bin/claude` at 2.1.284.
**Command:** `ssh -i ~/.ssh/automata_box_ed25519 -o BatchMode=yes root@138.201.174.63 'bash -s' < spike-transcripts/box-probe.sh` (shape: worker user `automata` → `/usr/bin/sudo -n -u automata-agent -E -- /bin/sh -c "bash -lc …"`)
**Evidence:** spike-transcripts/box-q6.txt

```
NRestarts_before=0 / inflight_runs=0 / worker_user=automata
worker_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
worker_CLAUDE_BIN=            (unset → claude_bin_dir empty, nothing prepended)
pre_sudo_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Defaults: env_reset, secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
(automata-agent) SETENV: NOPASSWD: <redacted>
inner_user=automata-agent HOME=/tmp/zz-spike-home.IaM8Je        # sudo -E kept the throwaway HOME
inner_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin   # = secure_path (+/snap/bin)
claude=/usr/local/bin/claude git=/usr/bin/git node=/usr/bin/node npm/npx=/usr/bin gh=/usr/bin/gh jq=/usr/bin/jq shellcheck=MISSING
LOCALBIN_ON_PATH=yes
claude_realpath=/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe ; claude --version = 2.1.284 (Claude Code)
NRestarts_after=0
```
The version check agrees three ways. The binary reports 2.1.284 and the package.json one level above
`bin/` says 2.1.284; it was read separately because the probe looked for package.json beside the
binary and printed UNKNOWN. The init `claude_code_version` of the local runs is also 2.1.284. Box
`/tmp/zz-spike-home.*` count after the probe: 0. `/snap/bin` in inner_PATH shows that PATH is the
sudo `secure_path` and not the worker's: any PATH the worker sets, including a CLAUDE_BIN prefix,
**does not survive sudo**.

## Q7 — Does the final `result` contain only the lead's text? Which fence would parse-review-intent pick?

**Verdict:** PARTIAL — the **last** `result` holds only the lead's final text and ends with the lead's fence when the lead writes its own. But (a) the stream has **two** `result` messages, and (b) in q4sub the lead repeated the sub-agent's report word for word, so the **last fence in the final result was the sub-agent's `ZZ_SUBAGENT_VERDICT`**.
**Command:** `bash spike-transcripts/harness.sh q2q7` (also q4sub)
**Evidence:** spike-transcripts/q2q7.jsonl, q4sub.jsonl

```
q2q7 result#1: "Waiting for the spike agent to complete its task..."                         # no fence
q2q7 result#2: "The spike agent successfully executed … ```json\n{\"verdict\":\"ZZ_LEAD_VERDICT\"}\n```"
q2q7 sub-agent assistant line (parent_tool_use_id set): "… ```json\n{\"verdict\":\"ZZ_SUBAGENT_VERDICT\"}\n```"
q2q7 system/task_notification.summary: "… ```json\n{\"verdict\":\"ZZ_SUBAGENT_VERDICT\"}\n```"
q4sub result#2 (lead, parent null): "**Outcome 1: …** … ```json\n{\"verdict\":\"ZZ_SUBAGENT_VERDICT\"}\n```"
```
Which fence parse-review-intent.ts would pick (last ```json fence wins):
- From q2q7's final `result` text: `ZZ_LEAD_VERDICT`. This is correct.
- From all assistant text joined together: still `ZZ_LEAD_VERDICT` in q2q7, because the lead's final
  message comes last. A `ZZ_SUBAGENT_VERDICT` fence still appears earlier in that text.
- From q4sub, read either way: **`ZZ_SUBAGENT_VERDICT`. This is wrong.**
- What production reads: `extractTerminalAgentText()` (review-single-writer-finish.ts) takes the **last
  DBMessage of type `agent`**. `toDBMessage` gives sub-agent assistant messages type `agent` too, with
  `parent_tool_use_id` set, and that function does not filter on parent. A sub-agent message that
  arrives after the lead's final text would therefore be picked.
- Separately, `handle-daemon-event.ts` sets `isDone` on **any** `result`. If the daemon flushes
  result#1 in its own batch, the thread could finish with "Waiting for…" as its terminal text. In
  the spike both results were adjacent, so they would normally share a batch, but this was not
  verified end to end.

## Implications for Phases 3-6

**Most important**
- **Async sub-agents produce two `init` and two `result` messages (Q2).** In `-p` mode, 2.1.284 runs the
  `Agent` tool in the background. The first `result` holds the lead's interim text ("Waiting for the
  agent…"), and the real verdict is in the second. Anything that treats the first `result` as
  completion, or reads `result.result` from it, sees no verdict. That includes `handle-daemon-event`
  `isDone`, the daemon's `isCompleted`, and cost/duration accounting, where each result carries its
  own `total_cost_usd`. **Phase 5 must be built to use the last result. Phase 6 needs a test that
  feeds two results and asserts only the second is used.**
- **A lead that echoes the sub-agent's fence makes the sub-agent's verdict the LAST fence (Q7, q4sub).**
  The last-fence rule in `parse-review-intent.ts` then returns `ZZ_SUBAGENT_VERDICT`. Phase 5 has
  three things to do. The sub-agent prompts must not emit a fenced ```json block at all; tell them
  to return plain findings. The lead prompt must forbid quoting sub-agent output word for word.
  `extractTerminalAgentText` should skip `agent` messages whose `parent_tool_use_id` is not null.
  Phase 6 should add a parser fixture where a sub-agent fence comes before the lead's, plus one where
  the lead repeats it.

**Phase 3 (host batteries / CLI install)**
- Install CLIs into `/usr/local/bin` (or `/usr/bin`). The agent's PATH is the sudo `secure_path`
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`, which includes
  `/usr/local/bin`. A PATH or CLAUDE_BIN prefix set by the worker does not survive sudo, so don't
  depend on it, and no symlink into a claude bin dir is needed. `CLAUDE_BIN` is unset on the box today.
- `shellcheck` is missing on the box. Install it if review packs expect it.
- Packs must still be cleaned of hooks, settings and `.mcp.json`, but only for packs seeded at
  **user** level. User-level settings and hooks DO load (Q1/Q2 show the user layer is live). Q3 only
  shows that the PR's **project** layer is ignored.

**Phase 4 (knobs / wallet bound)**
- `review_max_turns` is **not** a usable wallet bound. It doesn't add up turns across lead and
  sub-agent: 5 API turns against a limit of 3 still ended in success. Parallel tool batching makes it
  coarse even for the lead alone. The real bounds stay the Hatchet timeout and the idle watchdog (D2).
  If a turn knob is kept, document that it limits each agent loop only, and measure what happens
  when the limit is hit. Expect subtype `error_max_turns`; that is not observed yet.

**Phase 5 (orchestrated review argv)**
- Allowlist the sub-agent tool as `Agent` (the name in tool_use and in the JSON the model sees). `Task`
  also works as an alias, but the init `tools` list shows only `Task`. Allowlisting both costs nothing.
  Add `Skill` if packs use skills.
- The `gh` and `git push` denies, and the lack of Write/WebFetch, **carry into sub-agents** (Q4), even
  for an agent with no `tools:` frontmatter. There is no need to repeat the denies per agent. Keep the
  parent list as the only control.
- Seeding packs into the per-run HOME's `~/.claude/skills` and `~/.claude/agents` works under
  `--setting-sources user` (Q1/Q2).
- The PR checkout's project `.claude/` and `.mcp.json` do NOT need extra neutralising while
  `--setting-sources user` stays in the argv. The control shows what they do without it: a project
  `allow: Write` is granted, MCP spawns, hooks fire and CLAUDE.md is obeyed. **The flag is
  load-bearing. Pin it with a test.** The CLI's `--disallowedTools` beat a project `allow` for gh
  even without the flag. An explicit `--mcp-config` is a flag and can still load MCP servers.
- Write `{"disableAllHooks":true}` into the per-run HOME's `~/.claude/settings.json` (or pass it with
  `--settings`). User-level hooks load under `--setting-sources user`, and `SubagentStart`/`SubagentStop`
  hooks would run for every sub-agent.
- Trust the per-run checkout with its **exact** path key. Parent-dir trust does not pass down once
  project settings load. Review mode is fine because user-only sources never read the project
  `permissions.allow`.

**Phase 6 (canary / parser tests)**
- Parser test: the stream has sub-agent `agent` messages that carry a ```json fence, followed by the lead's
  final message with its own fence. Assert that the lead's verdict wins. Add a second case where
  the lead echoes the sub-agent fence; this must fail closed or be prevented by the prompt. Add a
  third case with two `result` messages.
- In the canary transcript, check that init `tools` has `Task`, `Agent` is allowed, and `agents` and
  `skills` hold the seeded pack names. Check that sub-agent lines carry a non-null `parent_tool_use_id`,
  `subagent_stats.started_in_background` is at least 1, there are exactly two `result` lines with the
  verdict in the last, and `permission_denials` is empty unless expected.

## Open questions
- Q5: the shape of a max-turns stop (expect `subtype:"error_max_turns"`) and which counter trips it.
  Needs a model that makes truly sequential calls, or a dependent-call prompt.
- Q7: whether the daemon ever flushes the first `result` in a different batch from the second.
  Production tests with a real two-result stream are needed in Phase 5/6.
- Whether foreground (synchronous) sub-agents can be forced in `-p` mode, which would remove the
  two-result shape. Nothing in 2.1.284's tool input exposed such a switch in these runs.

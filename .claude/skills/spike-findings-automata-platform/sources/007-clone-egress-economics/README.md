---
spike: 007
name: clone-egress-economics
type: comparison
validates: "Given agent sessions on real repos, when they clone full vs blob:none vs sparse vs bundle-uri vs warm-box fetch, then bytes/session are measured and the blueprint's $10/repo/mo COGS is confirmed or corrected"
verdict: "PARTIAL — $10/repo/mo holds only with warm boxes or bundle-uri, or with forge co-located / Hetzner-class bandwidth; naive full clones on AWS break it from medium repos up"
related: [002-forge-substrate, 013-long-lived-agent-wake]
tags: [egress, cost, clone, partial-clone, bundle-uri, cogs]
---

# Spike 007: Clone egress economics

## What This Validates
The blueprint assumed about **$10 per active repo per month**, with egress as the biggest cost line. This spike measures the bytes the forge actually serves per agent session, under six ways of getting the code.
Two real repos, both served by our smart-HTTP forge with a byte counter:
- **automata:** this repo. 542 commits, 1,621 files, a 4.9 MB clone.
- **vite:** vitejs/vite. 72 MB pack, 2,868 files.

## How to Run
```bash
cd .planning/spikes/007-clone-egress-economics
node egress.mjs                                                         # automata (local source)
SRC_REPO=/path/vite.git LABEL=vite SPARSE_DIR=packages/vite node egress.mjs
node render.mjs && open console.html
```
The forge runs on :3307, so this needs the sandbox off. Repos are repacked first (`repack -adq`), as production would keep them.

## Investigation Trail
1. **First automata run.**
   - `bundle create main~20` failed: a bundle needs a real ref. Fixed with a temporary `refs/heads/nightly`.
   - The sparse row reported all 1,621 files, because `ls-files` counts skip-worktree entries. Changed to count only `H` (materialized) entries; the real figure is 123.
2. **The automata repo is too small to stress anything.** A full clone is 4.9 MB, and egress is only $2.66/month on AWS even with naive clones. So I added a medium-size public repo.
3. **React (1.1 GB) was abandoned.** This machine's download speed (about 60 KB/s to GitHub) would have taken hours. The Vite results already settle the question, because costs scale linearly with pack size for full clones.
4. **Vite changes the picture.** Naive full clones cost **$39/month per repo on AWS** at 200 sessions/day. That's 4x the blueprint. A 1 GB repo would be about $540/month.
5. **But the two cheap strategies are also the architecturally natural ones:**
   - **Warm persistent box** (spike 013's `$HOME` volume): only the delta crosses the wire. 0.34 MB a session, **$0.18/month**.
   - **bundle-uri:** a nightly bundle on object storage (R2 has no egress fees). The forge serves only the 20-commit delta: 0.4 MB, **$0.22/month**.

## Results

| strategy | automata MB | vite MB | vite $/repo/mo on AWS | on Hetzner |
|---|---|---|---|---|
| full clone | 4.92 | 72.28 | **39.03** | 0.48 |
| shallow `--depth=1` | 3.78 | 12.96 | 7.00 | 0.09 |
| blobless | 4.52 | 24.37 | 13.16 | 0.16 |
| blobless + sparse (one package) | 1.30 | 12.49 | 6.74 | 0.08 |
| bundle-uri (CDN carries 72 MB) | 0.57 | **0.40** | **0.22** | 0 |
| warm box fetch (+20 commits) | 0.57 | **0.34** | **0.18** | 0 |

All costs assume 200 sessions/day. Co-located (same datacenter) egress costs $0 in every row.

**Verdict: PARTIAL.** The $10/repo/month figure is **conservative** under any of these conditions:
- the forge is co-located with agent compute;
- it runs on Hetzner-class bandwidth;
- agents use warm boxes or bundle-uri.

It **breaks** for naive full clones served from AWS once repos are medium-size or larger, and it scales linearly with pack size.

**Signal for the build:**
- **Default agent checkout is the warm box** (spike 013). A cold start uses bundle-uri from R2 plus a delta fetch. Never cold full clones from the forge.
- **Host the forge where the agents run.** Hetzner today; one region per agent fleet. Don't put the forge's origin on AWS egress.
- **Shallow clones are cheap but break agent workflows** that need history (blame, merge-base, the 004/006 range logic). Prefer blobless + sparse when cold.
- **Update the blueprint's COGS:** egress is ≤ $1 per repo per month under the default architecture. The $10 line now covers storage replicas, the verify runner and headroom, so gross margin improves.
- **Not measured:**
  - repos above 1 GB, where the CDN tier's own cost matters;
  - protocol v2 negotiation overhead at high concurrency;
  - lazy blob fetches that blobless clones trigger later in a session (on-demand), which this spike didn't exercise beyond the checkout.

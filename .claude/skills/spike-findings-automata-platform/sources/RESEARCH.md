# Research: agent-native git infrastructure (2026-10-17)

## 1. The "Scion" claim, fact-checked
- **Real, but internal.** Anthropic's own post is "Redesigning source control at Anthropic" (Oct 13, 2026): https://www.anthropic.com/engineering/redesigning-source-control. HN discussion: https://news.ycombinator.com/item?id=50073633
  - **Model:** changesets in a write-ahead log. Content-hashed blobs. Each ref is a compare-and-swap on one Spanner row. Merges and rebases run server-side, with no global-lock merge queue. Tests run post-merge and pre-deploy, and Claude fixes conflicts.
  - **Clients:** always-online. Blame, history and diff are APIs. Checkouts are sparse or virtual, through scion-daemon → scion-cache → scion-server.
  - **Numbers (self-reported):** merges went from 2.5k/day to 30k+/day (May→Sep 2026). 25M CI checkouts/day. 200x less CPU and memory than several hundred git mirrors. Cache hit rate above 99%.
  - **Review:** a tool called "Antique" uses change-aware approval rules, and humans review intent.
  - **What it is not:** Anthropic calls it "by no means a suitable replacement for git for general use". It is not a product. Anthropic wants to partner with GitHub and GitLab.
- **Name clash.** Google's "Scion" (Apr 2026) is unrelated: a multi-agent testbed with containers plus worktrees. https://infoq.com/news/2026/04/google-agent-testbed-scion
- **Secondary sources:**
  - developersdigest.tech condenses the primary post accurately.
  - pasqualepillitteri.it is a derivative content farm in seven languages, and the URL wouldn't load.
  - finance.biggo.com covers the Aug 6 nine-hour Actions outage, not Scion. It cites 257 incidents with no links.
  - labitcode.com is an opinion piece ("replace Actions with a GitHub App fleet"). Its 10x / 5–10x claims are unsourced.
  - testkube.io is vendor marketing from Sep 2025. Its evidence is anecdotal.
  - The Medium article on building git in Go returned 403; it's a tutorial and unrelated.

## 2. Is GitHub the bottleneck for agents? (evidence)
- GitHub's CTO planned for 10x capacity in Oct 2025, then 30x by Feb 2026: https://github.blog/news-insights/company-news/an-update-on-github-availability/
- GitHub's agent-scale git work (up to 35x write throughput): https://github.blog/engineering/architecture-optimization/building-git-infrastructure-for-agent-scale-development/
- Availability: 9 incidents in May 2026, and Azure carried 43% of git traffic: https://github.blog/news-insights/company-news/github-availability-report-may-2026/
- On Apr 9, a rate-limit bug delayed 84% of Copilot agent sessions (secondary source): https://www.devx.com/devx-daily-news/github-outages-2026-ai-coding-agents/
- Limits that hit agent fleets:
  - App tokens: 5k–12.5k requests/hr (15k on Enterprise Cloud).
  - Secondary limits: 80 content-creation calls/min and 500/hr; 900 REST points/min.
  - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Pushes: 6 per minute per repo recommended, 2 GB push cap, 5,000 branches: https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
- Actions:
  - Concurrency limits: 20, 40, 60 or 500 jobs depending on plan; 500 queued runs per 10 s.
  - https://docs.github.com/en/actions/reference/limits
- Webhooks time out after 10 s, and after an outage you must re-deliver missed events yourself: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- Pricing pressure:
  - A $0.002/min self-hosted runner fee was announced, then postponed: https://devclass.com/2025/12/17/github-to-charge-for-self-hosted-runners-from-march-2026/
  - Copilot review consumes Actions minutes from Jun 1, 2026: https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/
- GitHub's counter-move is Agent HQ / Mission Control, which hosts third-party agents inside GitHub: https://github.blog/news-insights/company-news/welcome-home-agents/

## 3. GitAgent / OpenGAP
- **Repos:**
  - Spec: https://github.com/open-gitagent/opengap (MIT, ~3k stars, v0.1.0 spec)
  - Runtime: https://github.com/open-gitagent/gitagent (MIT, ~700 stars, v2.2.0, effectively one maintainer at Lyzr)
- **Data model:**
  - Required: `agent.yaml` and `SOUL.md`.
  - Optional: `RULES.md`, `DUTIES.md`, `skills/*/SKILL.md`, `tools/*.yaml`, `workflows/`, `knowledge/`, `hooks/`, `compliance/`, nested `agents/`.
  - Memory lives in `memory/MEMORY.md` (200-line cap). An audit log goes to `.gitagent/audit.jsonl`.
  - `compliance` targets regulated finance: FINRA, SR 11-7, Reg S-P, separation of duties.
- **Git usage:**
  - Agent changes are commits, and dev→staging→main branches act as promotion.
  - Skill or memory updates open a PR for a human.
  - Sessions push to a `gitagent/session-xxx` branch.
  - `extends` and `dependencies` point at git URLs with semver.
- **GitHub dependency in practice:**
  - It needs a PAT (`--pat ghp_xxx`).
  - Review happens in GitHub PRs, and CI runs on GitHub Actions.
  - gitcron runs on Actions.
  - The registry is "GitHub as source of truth, no backend".
- **Self-admitted gaps** (gitagent `gaps.md`):
  - Shell injection via git commands (G1, G27).
  - Plugins and MCP servers launch without approval (G3).
  - Hooks fail open (G5), and there's no filesystem jail (G6).
  - The PAT sits in git config and shows up in `ps` (G17).
  - It isn't safe for multiple tenants (G22, G23).
  - Issues #119 and #85 track these.
- **Business:** no hosted offering and no pricing. It works as an OSS funnel into Lyzr Studio, aimed at banking and finance. https://www.lyzr.ai/gitagent

## 4. Alternatives and competitors
| Product | Layer | OSS | Self-host | Agent-native | Role for us |
|---|---|---|---|---|---|
| Entire (entire.io) | Agent sessions + distributed git network (preview) | CLI MIT; backend "planned" | No | Checkpoints on `entire/checkpoints/v1`; agent-scale clones (~570k/hr claimed) | **Main threat**, but adopt its trailer format |
| Pierre code.storage | Git storage API for AI platforms | No | No | Ephemeral branches, in-memory writes, SDKs | Threat or vendor; its pricing is our ceiling |
| Forgejo / Codeberg | Forge + Actions-compatible CI | GPLv3+ | Yes | None; Codeberg bans mostly-AI projects | Building block (substrate candidate) |
| upd.dev | Free forge (Forgejo fork + Pierre diffs) | Fork | No | Accepts AI-written code | Signal that the stack can ship fast |
| Blaze (runblaze.dev) | Flat-rate macOS/Linux runners for Actions | No | No | None | Building block |
| Blacksmith / Depot / Namespace | Faster Actions runners | No | Partial | Fast cached runners, agent sandboxes (Depot) | Building block / CI-margin benchmark |
| Tangled | AT-protocol forge, jj stacked PRs | Yes | Yes | Stacked PRs | Source of ideas |
| jj / GitButler | Client-side VCS models | Yes | n/a | Parallel branches, op log | Building block |

**Sources for this table:**
- Entire: https://entire.io/news/entire-launches-distributed-git-network-for-the-agent-era and https://docs.entire.io/cli/checkpoints.md
- Pierre: https://code.storage
- Codeberg AI ban: https://linuxiac.com/codeberg-bans-projects-mostly-written-by-generative-ai/
- upd.dev: https://upd.dev/landing
- Blaze: https://runblaze.dev/pricing
- Tangled: https://blog.tangled.org/6-months

## 5. Pricing benchmarks
- **GitHub:**
  - Team $4/user/mo; Enterprise $21/user/mo.
  - Actions per minute: Linux $0.006, macOS $0.062.
  - Copilot Business $19/seat/mo; Enterprise $39/seat/mo.
  - https://github.com/pricing and https://docs.github.com/en/billing/reference/actions-runner-pricing
- **GitLab:** Premium $29/user/mo; Ultimate is custom. https://about.gitlab.com/pricing/
- **Pierre:** hot storage $1/GB-mo × 3 replicas; egress $0.15/GB. https://code.storage/pricing
- **Runners:**
  - Blacksmith: Linux $0.004/min. https://www.blacksmith.sh/pricing
  - Depot: $0.003/vCPU-min; sandboxes $0.01/min. https://depot.dev/pricing
  - Namespace: $0.002–0.003/min. https://namespace.so/pricing
  - Blaze: €29/mo per Linux runner; €125/mo per macOS runner.
- **Seat-priced tools:**
  - Graphite: $20 or $40/user. https://graphite.com/pricing
  - Cursor Teams: $30+/user. https://cursor.com/pricing
  - Factory: $60/team plus $40/seat. https://factory.com/pricing
  - Devin: $80 plus $40/dev (secondary source).

## 6. Market size and comparables
- **GitHub:** ≥$2B ARR (Jul 2024). 180M+ developers. 43.2M PR merges a month.
  - https://rcpmag.com/articles/2024/08/02/microsoft-earnings-copilot-rollcall.aspx
  - https://github.blog/news-insights/octoverse/
- **GitLab FY26:** $955.2M revenue (+26%). Net retention 118%. 10,682 customers above $5k ARR. https://www.sec.gov/Archives/edgar/data/1653482/000162828026018731/gtlb-20260131.htm
- **Agent adoption:** about 31% of developers use AI agents; 23% use them weekly. https://survey.stackoverflow.co/2025/
- **AI coding revenue:**
  - Cursor: ~$3B ARR.
  - Claude Code: >$2.5B run-rate.
  - Cognition: ~$0.5B.
  - (secondary sources)
- **Funding:**
  - Entire: $60M seed at $300M. https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation/
  - Pierre: $23M.
  - Blacksmith: $3.5M ARR → $45M Series B at ~$550M. https://www.vcaonline.com/news/2026081204/
  - Graphite: acquired by Cursor. https://siliconangle.com/2025/12/19/cursor-acquires-ai-code-review-startup-graphite/
  - GitButler: $17M Series A.

## 7. Cost benchmarks
- **Storage and egress:** S3 $0.023/GB-mo; AWS egress $0.09/GB. Hetzner after the June 2026 increase: CX23 €5.49, CCX13 €42.99. https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/
- **Biggest cost line:** egress for agent fetches. That's why we co-locate the forge with agent compute and use partial clones. That gives an estimated $2–10 per active repo per month all-in.

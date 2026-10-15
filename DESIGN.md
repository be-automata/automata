---
# gstack: design-md-format=spec
name: Automata
description: A warm, paper-toned engineering control panel where the organization and repo you are acting in are always on screen.
colors:
  surface: "#f8f5f0"
  text: "#3e2723"
  text-muted: "#6d4c41"
  muted: "#f0e9e0"
  border: "#e0d6c9"
  primary: "#2e7d32"
  on-primary: "#ffffff"
  accent: "#c8e6c9"
  error: "#c62828"
  warning: "#b45309"
  surface-dark: "#1a1a1a"
  text-dark: "#f0ebe5"
  primary-dark: "#4caf50"
  scope-account: "#56687a"
  scope-account-tint: "#e4e9ee"
  scope-org: "#9a6410"
  scope-org-tint: "#f2e2c2"
  scope-repo: "#2e7d32"
  scope-repo-tint: "#c8e6c9"
  org-hue-1: "#2e7d32"
  org-hue-2: "#9a6410"
  org-hue-3: "#1f5f8b"
  org-hue-4: "#8e3b46"
  org-hue-5: "#56687a"
  org-hue-6: "#6b5b1e"
  org-hue-7: "#2f6f6a"
  org-hue-8: "#7a4a2a"
typography:
  body:
    fontFamily: Geist
    fontSize: 0.875rem
    lineHeight: 1.5
  label:
    fontFamily: Geist
    fontSize: 0.6875rem
    letterSpacing: 0em
  mono:
    fontFamily: Geist Mono
    fontSize: 0.78rem
    fontFeature: tnum
  brand:
    fontFamily: Cabin
    fontWeight: 600
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  org-avatar:
    rounded: "{rounded.sm}"
    size: 24px
  org-switcher:
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
  target-line:
    backgroundColor: "{colors.muted}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
---

# Automata

## Overview

**Creative North Star:** a resolved control panel. Every surface answers two
questions before anything else: *where am I acting* (organization and repo) and
*what will the agent actually get* (the resolved configuration and its source).

**Product context:** a developer platform where teams connect GitHub repos and
AI coding agents run tasks and PR reviews, started from the web app, GitHub,
Slack or automations. Users are engineering leads who administer an
organization and developers who run tasks; many belong to several
organizations plus a personal space.

**Mode per surface:** Operate (dashboard, settings, environments, task
creation). There is no Persuade surface in `apps/www` beyond the landing page,
which this document does not govern.

**Memorable thing:** "I always know which org and repo I'm acting in." When two
choices conflict, the one that makes the acting context more visible wins.

**Reference products:** GitHub (context switcher, combined org/repo secrets
page), Vercel (team URL scoping, Config vs Secret), Doppler (strike-through on
overridden keys), Linear and Devin (one external workspace binds to one org),
Clerk and WorkOS (URL slug activates the org). Full benchmark: kept locally,
not in the repo.

**Key characteristics:**
- The org avatar and name sit at the top of the sidebar on every page.
- Settings are grouped by whose they are: Account, or the named organization.
- Anything that binds or runs work names its target org before it happens.
- Resolved values come first; layers are the explanation, not the interface.

## Colors

**Strategy:** Restrained. The shipped warm paper palette stays: one green
primary, brown text, paper neutrals. Color carries meaning in exactly two new
places: **scope** (account, org, repo) and **org identity** (one hue per org).

**Light or dark:** both, as today; set by the user, not by the surface. Every
new token has a dark pair (see `apps/www/src/lib/org-identity.ts` for the org
hues) that keeps contrast on `#1a1a1a`.

- **Org hues** (`org-hue-1..8`) are assigned deterministically from the org id
  (FNV-1a mod 8), so an org keeps its color across devices and deploys. They
  only fill the org avatar. The org NAME is always printed next to it: the hue
  helps a glance, it is never the only cue (color-blind users, two orgs that
  share a hue).
- **Scope inks** mark which layer a value or setting belongs to: account
  (slate), org (ochre), repo (the primary green). Use the ink for text/icons
  and the tint for a badge background. Never as a card border.
- `error` stays reserved for destructive actions. Lock and warning states use
  `warning` or the muted brown, never red.

## Typography

The shipped faces stay: Geist for all UI, Geist Mono for anything a machine
reads (env keys, values, repo full names, workspace IDs, commit SHAs), Cabin
for the wordmark only. Geist is on the "overused" list for display voices; it
is kept because this is an Operate surface whose UI already ships it, and there
is no display voice in the app.

- Dense rows: 13–14px body. Section labels: 11px, sentence case, normal
  tracking, muted brown. No tracked uppercase micro-labels.
- Repo and workspace identifiers are always mono, so `acme/api` never reads
  like prose.

## Layout

- **Sidebar (18rem):** wordmark, then the **org switcher**, then navigation.
  Collapsed, the switcher shrinks to the org avatar.
- **Settings:** a left nav split into two groups:
  - **Account** (yours in every org): General, GitHub & Pull Requests,
    Billing, Sandbox.
  - **<org avatar> <org name>** (changes with the switcher): Agent
    credentials, PR Review, Integrations.
- **Target URL scheme (next phase):** `/o/<orgSlug>/settings`,
  `/o/<orgSlug>/repos/<owner>/<repo>`; the slug in the URL is authoritative
  and the session follows it after a membership check. Account pages stay at
  `/account` and `/settings` until then.
- Tables are compact (32px rows), left-aligned, with mono key columns.

## Elevation & Depth

Flat, as today: borders and paper tints, not shadows. Popovers and dialogs use
the component library's default shadow. No glows.

## Shapes

`--radius` is 0.5rem. Org avatars are **square-ish** (`rounded.sm`); user
avatars are round. That shape difference is the cheapest way to tell "who"
from "which org" at 16–24px.

## Components

**Org switcher** (`components/org-switcher.tsx`)
- Trigger: org avatar, a small "Organization" / "Personal" label, the org name
  (truncated), chevrons. Bordered so it reads as a control, not a nav item.
- No active org: dashed empty avatar and "Choose an organization". Never a
  dead end.
- Popover: "Switch organization" list (personal first, then oldest first),
  check on the active org, filter box past 5 orgs, a footer line saying what
  the selection governs.
- Keyboard: the trigger is a focusable button; Enter opens it and the list is
  arrow-key navigable. No global shortcut yet (⌘⇧O is taken by Chrome's
  bookmark manager on macOS).
- Mobile: choosing an org also closes the sidebar sheet.
- After a switch: mark every query stale (no refetch of the old page), go to the new org's home
  (`/dashboard`), toast "Switched to <org>". Never leave the previous org's
  page on screen with the new org's label.
- Server: the action re-checks membership before calling Better Auth's
  `setActiveOrganization`; a forged id never moves the session.
- Install and connect requests carry the org the page showed; the server
  refuses them if the session's org has changed since (another tab).

**Org avatar** (`components/org-avatar.tsx`): logo if set, else two initials
on the org hue. 24px default, 16–20px inline.

**Target line** (install receipts, run cues): `[source] → [org avatar] [org
name]` on a muted tint. Used wherever an action binds or routes something to
an org.

**Install-target confirmation** (Slack today, GitHub next)
- The install button names the org: "Install into <org>". With no active org
  it is disabled and says "Choose an organization to install".
- The dialog shows the target line (workspace → org), says what will run where
  ("mentions will start tasks in this organization, with its environment and
  credentials"), and that the binding is permanent; to bind elsewhere, switch
  org first.
- Connected workspaces show "Mentions run in <org>", and a warning when that
  org is not the one the user is acting in.

**Workspace hint** (Slack connect): an optional field that takes a workspace
ID or an `app.slack.com/client/<ID>/…` URL and sends Slack's `team` parameter,
because "Sign in with Slack" has no workspace picker of its own.

**Planned (next phases), specified here so they are built consistently:**
- *Effective configuration table* on each repo: key (mono), value or `••••
  set <when> by <who>` for secrets, source badge (System / Org / Repo / My
  override, in scope inks), audience (Agent / Server only). A value that loses
  is struck through with "overridden by <layer>".
- *Inherit control* on each per-repo setting: "Inherit from org (<value>)" vs
  "Override". A lock with "Locked by org admin" when the org forbids
  overrides; the org page shows "N repos override this".
- *Runs-in cue* above every button that starts work: "Runs in <org avatar>
  <org> · <owner/repo>", repeated on the task detail as provenance.

States for every component: loading (name placeholder "Loading…", control
disabled), empty (explicit next step), error (toast from the server action,
control re-enabled), long content (truncate names, full name in tooltip).

## Do's and Don'ts

- Do print the org name next to every org avatar.
- Do name the target org on any button that installs, binds or runs work.
- Do group settings by scope, and label the org group with the org's name.
- Do show resolved values first and the layer they came from second.
- Do check membership on the server for anything that takes an org id.
- Don't rely on hue alone to identify an org.
- Don't put org-scoped settings under an unlabeled "Settings" heading.
- Don't keep the previous org's page on screen after a switch.
- Don't use colored left borders, nested cards, or red for non-destructive
  states.
- Don't add an org-scoped surface that reads the session org without showing
  which org it is.

## Motion

- **Approach:** minimal-functional.
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms)
- **The one authored moment:** the org switch: popover closes, the page
  navigates to the new org's home and the sidebar avatar changes with it in one
  step, confirmed by a toast.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-14 | Initial design system created | /design-consultation from a codebase audit and a 22-product benchmark of multi-org UX; memorable thing "I always know which org and repo I'm acting in" |
| 2026-10-14 | Keep the shipped palette and faces | The problem is structure and context, not the look; a rebrand is out of scope |
| 2026-10-14 | Per-org hue on a square avatar, name always printed | Makes a switch visible at a glance without making color the only cue |
| 2026-10-14 | Install-target receipt before any binding | Slack workspaces were binding permanently to an invisible session org |
| 2026-10-14 | Settings nav grouped Account / <org> | Users could not tell which settings change with the org |
| 2026-10-14 | Effective configuration, inherit control and runs-in cue specified, built in later phases | Independent outside voices (Codex, Claude subagent) converged on resolved-first config and run provenance |

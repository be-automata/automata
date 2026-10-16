---
# gstack: design-md-format=spec
name: Automata
description: A quiet ops desk set in monospace, where the only color on screen is a run state or a scope, so one glance shows what every agent is doing, where, and what needs you.
colors:
  bg: "#F2F4F1"
  surface: "#FAFBF9"
  line: "#CFD6D1"
  line-soft: "#E3E8E4"
  text: "#172019"
  text-muted: "#5A6660"
  ink: "#172019"
  on-ink: "#FFFFFF"
  state-needs-you: "#B42318"
  state-waiting: "#A16207"
  state-running: "#0E7490"
  state-done: "#15803D"
  state-unverified: "#5A6660"
  scope-account: "#44505A"
  scope-org: "#2F4DB0"
  scope-repo: "#8A3D7C"
  bg-dark: "#121715"
  surface-dark: "#1A201E"
  line-dark: "#33403A"
  text-dark: "#DDE4DE"
  text-muted-dark: "#8E9A94"
  ink-dark: "#DDE4DE"
  on-ink-dark: "#121715"
  state-needs-you-dark: "#FF6B6B"
  state-waiting-dark: "#E6A93A"
  state-running-dark: "#4CC3D9"
  state-done-dark: "#5BC68A"
  scope-account-dark: "#B6C2CA"
  scope-org-dark: "#8EA6FF"
  scope-repo-dark: "#D891C9"
typography:
  title:
    fontFamily: TX-02
    fontWeight: 700
    fontSize: 1.25rem
    lineHeight: 1.2
  section:
    fontFamily: TX-02
    fontWeight: 700
    fontSize: 0.9375rem
    lineHeight: 1.333
  control:
    fontFamily: TX-02
    fontWeight: 500
    fontSize: 0.8125rem
    lineHeight: 1.385
  row:
    fontFamily: TX-02
    fontWeight: 400
    fontSize: 0.75rem
    lineHeight: 1.333
    fontFeature: tnum
  label:
    fontFamily: TX-02
    fontWeight: 400
    fontSize: 0.6875rem
    letterSpacing: 0em
  prose:
    fontFamily: IBM Plex Sans
    fontSize: 0.9375rem
    lineHeight: 1.533
  help:
    fontFamily: IBM Plex Sans
    fontSize: 0.8125rem
    lineHeight: 1.538
rounded:
  sm: 2px
  md: 4px
  lg: 6px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.md}"
  register-row:
    height: 32px
    borderColor: "{colors.line-soft}"
  org-avatar:
    rounded: "{rounded.sm}"
    size: 20px
  scope-badge:
    rounded: "{rounded.sm}"
---

# Automata

## Overview

**Creative North Star:** an ops desk, an instrument rather than a feed. Monospace chrome, ink actions, and color reserved for meaning, so the eye goes straight to the one run that needs you.

**Product context:** engineering leads and developers run AI coding agents across several GitHub organizations and repos. Work starts from the web, GitHub, Slack, the CLI and automations. Peers benchmarked 2026-10-16: Factory, agent37, yc-software/qm, CopilotKit/OpenBot, multica, paperclip.

**Mode per surface:** Operate: Home, Automations, Stats, Environments, Settings, task detail. Read: chat transcripts. The landing page is not governed here.

**Memorable thing:** "One glance tells me what every agent is doing, in which org and repo, and what needs me." When two choices conflict, the one that makes state, place or "needs you" more visible wins.

**Key characteristics:**
- Needs you comes first, above everything else on Home.
- Every run row names its state (as a shape and a word), trigger, org/repo and time.
- Every config value shows its effective value, then the layer it came from.
- Color only ever means a run state, a scope, or an org's identity.

## Colors

**Strategy:** Restrained. The neutrals are a cool green-grey; all actions use the ink.

**Light or dark:** the use scene is a desk next to a terminal in daylight and evening, so both themes ship and the user picks; the default is system.

- **Run states:** needs-you, waiting, running, done and unverified. Each always pairs with its glyph and a printed word, so they read in greyscale and for color-blind users.
- **Scope inks:** account, org and repo. Each pairs with a line style: account solid, org double, repo dashed.
- **Org hues:** an 8-step ring that skips red and green. They only fill the org avatar, and the org name is always printed next to it.
- **Dark mode:** surfaces step up in lightness (bg → surface → line) instead of inverting. State inks are brightened, not neon. No glow.

## Typography

**TX-02** (U.S. Graphics; Indie license with the self-hosted webfont module) sets everything an operator scans: nav, headings, buttons, table rows, states, identifiers, numbers.
- Loaded from the private R2 bucket via the same-origin `/fonts/tx-02/*` route.
- Fallback is Geist Mono.
- Never used in the in-app terminal (license).

**IBM Plex Sans** (OFL) sets sentences: chat, help text, dialog descriptions, the prompt editor. Measure is capped at 68ch.

Hierarchy comes from weight and size, never from tracking or uppercase: title 700/20, section 700/15, controls 500/13, rows 400/12, labels 400/11 in sentence case. Numbers are tabular.

## Layout

- **Rail (232px):** wordmark, org switcher, then Home (with its needs-you count), Automations and Stats; then the org group (Environments, Settings). On mobile the rail collapses to a header bar that still shows the org avatar and name.
- **Registers, not cards.** One bordered list per section, 32px rows, divided by `line-soft`.
- **Home:** activity owns the page.
  - Order: "Home in <org>", then Needs you (bold title, one-line plain reason, provenance, inline action), then Running now grouped by repo, then Recent.
  - The task composer is docked at the bottom like a terminal prompt, with its "Runs in <org> · owner/repo · branch" cue beside Start task. It is never at the top of the page.
- **Automations:** two panes.
  - Left: a health list (health, name, then trigger · target on line 2, 7-day %) with trigger filter chips.
  - Right: the selected automation's trigger, runs as, last-14 glyph strip, and a Runs feed with each run's result and reason. The selection lives in the URL.
- **Stats:** Activity / Outcomes / Where bands, then "From task to merged PR" (funnel), then "Not finished" (counts by cause).
- **Settings and Environments:** effective-value table with Account | Org | Repo lanes.
- Below 640px, register rows become two lines (state + title; then repo · trigger · time). No horizontal page scroll.

## Elevation & Depth

Flat: borders and surface steps only. Popovers and dialogs use one offset shadow (0 4px 16px at 12%). No zero-offset glows.

## Shapes

Radius sm 2px (avatars, badges), md 4px (buttons, inputs), lg 6px (outer containers). Org avatars are square-ish; user avatars are round.

## Components

- **RunState** (`components/ui/run-state.tsx`):
  - Glyph shapes: ■ needs you, ◧ waiting, ● running, ✓ done, ○ unverified.
  - The word is always printed; a reason suffix is optional ("queued · waiting for a free slot", "booting · cloning repo").
  - The state comes from the server, never inferred on the client.
- **ScopeBadge:** ink plus line style, as above. Overridden values are struck through, with "overridden by <layer>". A value the org has locked shows "locked by org" and "tighten only" in the repo lane.
- **Segmented:** one shared toggle for Mine/Everyone, People/All and ranges. The pressed state is filled with ink.
- **Org switcher:** square avatar, an "Organization" / "Personal" label, the name, chevrons. The behavior is the same as the shipped component.
- **Buttons:** the primary is ink, the secondary is surface + line. Every button has focus-visible (2px text-ink outline, 2px offset), hover and disabled (40% opacity, not-allowed cursor) states.
- **States everywhere:** loading (skeleton rows at real row height), empty (one sentence plus the next action), error (inline retry), long content (truncate, full value in a tooltip).

## Do's and Don'ts

- Do print the state word next to every glyph and the org name next to every avatar.
- Do name the trigger and org/repo on every run row.
- Do show a waiting state's reason.
- Do show an automation's next run only when it will fire.
- Do show the effective value first, and its layer second.
- Don't use color for actions, decoration or emphasis.
- Don't use cards, nested cards, colored left borders, or glowing status pills.
- Don't use tracked uppercase labels, kickers, or headings within one step of body size.
- Don't use TX-02 in the terminal or for long prose.
- Don't keep a previous org's page on screen after a switch.

## Motion

- **Approach:** minimal-functional
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms)
- **The one authored moment:** a run that starts needing you slides into the Needs you group (200ms ease-out, none under reduced motion).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-16 | Design system restarted as "Ops Desk" | /design-consultation, start fresh. Memorable thing widened to live agent activity. Six-product benchmark plus Codex and Claude-subagent directions converged on registers, needs-you first, and inline provenance |
| 2026-10-16 | TX-02 chrome + IBM Plex Sans prose | User asked for TX-02 for UI readability. Plex chosen independently by Codex and by me; OFL; condensed width axis for dense tables |
| 2026-10-16 | Ink actions; color only for state and scope | Keeps the surface quiet so a needs-you ■ is the loudest thing on screen |
| 2026-10-16 | Shape grammar for run states | Replaces the 6px blue dot; readable in greyscale and for color-blind users (from the Claude subagent) |
| 2026-10-16 | Scope by line style (solid / double / dashed) | A second cue beyond hue for account / org / repo |
| 2026-10-16 | Track-board Home and Marey-diagram Stats held | Ownable but costly; revisit after registers ship |
| 2026-10-16 | Automations = table + detail (AU2); Stats = bands + funnel + causes | /design-shotgun round 3. Automations chosen over a single reliability table and trigger groups, because the runs feed with reasons makes "degraded" actionable. The Stats funnel and not-finished causes answer "is it working and why not" |
| 2026-10-16 | Home = Register with docked composer (A1) | /design-shotgun, 2 rounds. Round 1 picked Register (A) over Split desk, Track board and Triage first; the user objected to the chat box at the top. Round 2 picked a bottom dock over a header command and a side column. Needs-you rows borrow Triage-first's reason + inline action |

/**
 * Flag-flip preflight for ADR-036 REVIEW_SINGLE_WRITER (run ON the daemon box).
 *
 * The emit-only review skill is a READABLE FILE on the execution box (the daemon's
 * `claude -p` does not auto-load skills — the review instruction points the agent to
 * Read it). www runs on Cloudflare Workers and CANNOT stat the box filesystem, so this
 * presence check is a box-side operator/deploy step, NOT a www runtime check. Run it
 * on the box BEFORE flipping REVIEW_SINGLE_WRITER=true; it FAILS CLOSED (exit 1) if the
 * skill is absent — without it, a review run can't Read the methodology (it would still
 * emit via the inlined-contract instruction, but at degraded review quality).
 *
 * The flag CONSISTENCY half (REVIEW_SINGLE_WRITER ⇒ GITHUB_SIDE_EFFECTS_ENABLED) is
 * enforced at runtime in www: handleReviewEffectAtFinish returns early when GitHub side
 * effects are off, so the single-writer path can't post while the kill-switch is off.
 * The schema-drift half (SKILL.md example ↔ parser) is covered in CI by
 * apps/www/src/server-lib/review/skill-contract-drift.test.ts.
 *
 *   Usage:  pnpm exec tsx deploy/review-single-writer-preflight.ts
 *   Env:    REVIEW_SKILL_PATH overrides the default install path.
 *
 * TODO(rev3-skill-path-portable): the default path is hardcoded to the pilot box HOME.
 * Rev-3 resolves it from the run's HOME (customer box, ADR-002) or a daemon SKILL_DIR.
 */

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SKILL_PATH = path.join(
  homedir(),
  ".claude",
  "skills",
  "github-ops",
  "SKILL.md",
);

function fail(msg: string): never {
  console.error(`[review-single-writer-preflight] FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  const skillPath = process.env.REVIEW_SKILL_PATH || DEFAULT_SKILL_PATH;

  let stat;
  try {
    stat = statSync(skillPath);
  } catch {
    fail(
      `emit-only review skill not found at ${skillPath}. Install it (copy deploy/skills/github-ops/SKILL.md there) before flipping REVIEW_SINGLE_WRITER on.`,
    );
  }
  if (!stat.isFile()) {
    fail(`${skillPath} exists but is not a file.`);
  }

  const contents = readFileSync(skillPath, "utf8");
  if (!/```json[\s\S]*"verdict"[\s\S]*```/.test(contents)) {
    fail(
      `${skillPath} is present but has no fenced-json verdict contract — it looks like the wrong file or a stale skill.`,
    );
  }

  console.log(
    `[review-single-writer-preflight] PASS: emit-only review skill present + carries the verdict contract at ${skillPath}.`,
  );
  console.log(
    "[review-single-writer-preflight] Reminders: REVIEW_SINGLE_WRITER requires GITHUB_SIDE_EFFECTS_ENABLED=true to post (enforced in www); land the box skill + daemon policy BEFORE flipping the www flag (policy-first ordering).",
  );
}

main();

/**
 * Flag-flip preflight for ADR-036 REVIEW_SINGLE_WRITER.
 *
 * The review methodology is INLINED into the automation instruction by
 * deploy/seed-pilot-mirror.ts, read at seed time from the tracked
 * deploy/skills/github-ops/SKILL.md. The agent therefore needs NO box-local
 * skill file, and there is exactly one copy to keep correct — so this check now
 * validates the TRACKED file, which makes it portable to any box or CI runner.
 *
 * (Previously it required an installed copy under the operator's HOME. That
 * default was pilot-box specific — the rev3-skill-path-portable TODO — and it
 * kept a second copy alive that could silently drift from the tracked one.
 * Operators who still keep an installed copy can point REVIEW_SKILL_PATH at it.)
 *
 * The flag CONSISTENCY half (REVIEW_SINGLE_WRITER ⇒ GITHUB_SIDE_EFFECTS_ENABLED) is
 * enforced at runtime in www: handleReviewEffectAtFinish returns early when GitHub side
 * effects are off, so the single-writer path can't post while the kill-switch is off.
 * The schema-drift half (SKILL.md example ↔ parser) and the no-box-path guard are
 * covered in CI by apps/www/src/server-lib/review/skill-contract-drift.test.ts.
 *
 *   Usage:  pnpm exec tsx deploy/review-single-writer-preflight.ts
 *   Env:    REVIEW_SKILL_PATH overrides the file to validate.
 */

import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_SKILL_PATH = fileURLToPath(
  new URL("./skills/github-ops/SKILL.md", import.meta.url),
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
      `emit-only review skill not found at ${skillPath}. It is tracked in-repo at deploy/skills/github-ops/SKILL.md — a missing file means an incomplete checkout, or REVIEW_SKILL_PATH points somewhere stale.`,
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
    "[review-single-writer-preflight] Reminders: REVIEW_SINGLE_WRITER requires GITHUB_SIDE_EFFECTS_ENABLED=true to post (enforced in www); land the daemon policy BEFORE flipping the www flag (policy-first ordering). The methodology is inlined into the automation at seed time, so after editing the skill re-run deploy/seed-pilot-mirror.ts to push it to onboarded repos — no box-local copy to install.",
  );
}

main();

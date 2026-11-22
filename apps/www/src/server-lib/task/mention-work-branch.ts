import type { Octokit } from "octokit";

import type { MentionLaneStamp } from "@terragon/shared/db/types";
import { isBranchRef } from "@terragon/utils/receive-pack-refs";

/**
 * The convention branch an issue mention's run pushes (#752):
 * `<type>/<KEY>[-<slug>]`, e.g. `feat/ACME-123-add-request-logging`. Pure
 * name rules plus the intake check that picks the bare or the taken form.
 */

const COMMIT_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "ci",
] as const;
type CommitType = (typeof COMMIT_TYPES)[number];

const DEFAULT_TYPE: CommitType = "feat";
const SLUG_MAX = 40;
const BRANCH_MAX = 128;

/**
 * Prefixes that look like a ticket key but name a standard, a spec label or a
 * version (`UTF-8`, `AC-1`, `GPT-4`, `COVID-19`).
 */
const MENTION_KEY_DENYLIST: readonly string[] = [
  "UTF",
  "SHA",
  "ISO",
  "RFC",
  "CVE",
  "GHSA",
  "AC",
  "OD",
  "OQ",
  "RF",
  "G",
  "ES",
  "GPT",
  "COVID",
];

const TYPE_PREFIX = new RegExp(
  `^\\s*(${COMMIT_TYPES.join("|")})(?:\\([^)]*\\))?!?:\\s*`,
  "i",
);
const TICKET_KEY =
  /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,31})-(\d{1,12})(?![A-Za-z0-9])/g;
const KEY_SOURCE = "([A-Za-z][A-Za-z0-9]{1,31})-(\\d{1,12})";
/** The only forms a key may take in an issue body: a bare key never counts. */
const BODY_KEY_MARKERS: readonly RegExp[] = [
  new RegExp(`\\[${KEY_SOURCE}\\]`, "gi"),
  new RegExp(
    `(?<![A-Za-z0-9])(?:jira|ticket)\\s*:\\s*${KEY_SOURCE}(?![A-Za-z0-9])`,
    "gi",
  ),
  new RegExp(`/browse/${KEY_SOURCE}(?![A-Za-z0-9])`, "gi"),
];
const BRANCH_SHAPE = new RegExp(
  `^(?:${COMMIT_TYPES.join("|")})/[A-Z][A-Z0-9]{1,31}-\\d{1,12}(?:-[a-z0-9]+)*$`,
);

interface KeyMatch {
  key: string;
  start: number;
  end: number;
}

function findKey(text: string): KeyMatch | null {
  for (const match of text.matchAll(TICKET_KEY)) {
    const [whole, project] = match;
    if (project === undefined || MENTION_KEY_DENYLIST.includes(project)) {
      continue;
    }
    return {
      key: whole,
      start: match.index,
      end: match.index + whole.length,
    };
  }
  return null;
}

function findBodyKey(body: string): KeyMatch | null {
  let best: KeyMatch | null = null;
  for (const marker of BODY_KEY_MARKERS) {
    for (const match of body.matchAll(marker)) {
      const [whole, project, digits] = match;
      if (project === undefined || digits === undefined) continue;
      const upper = project.toUpperCase();
      if (MENTION_KEY_DENYLIST.includes(upper)) continue;
      if (best === null || match.index < best.start) {
        best = {
          key: `${upper}-${digits}`,
          start: match.index,
          end: match.index + whole.length,
        };
      }
      break;
    }
  }
  return best;
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const wordEnd = slug.slice(0, SLUG_MAX + 1).lastIndexOf("-");
  return slug.slice(0, wordEnd > 0 ? wordEnd : SLUG_MAX).replace(/-+$/g, "");
}

/**
 * True for a name this feature may push: a valid git branch, ASCII only, at
 * most 128 characters, shaped `<type>/<KEY>[-<slug>]`. The shape means it can
 * never be a base branch such as `main` or `develop`.
 */
export function isMentionWorkBranch(name: string): boolean {
  return (
    name.length <= BRANCH_MAX &&
    /^[\x21-\x7e]+$/.test(name) &&
    BRANCH_SHAPE.test(name) &&
    isBranchRef(`refs/heads/${name}`)
  );
}

/**
 * The convention branch for an issue (the first ticket key in the title, then
 * the first explicitly marked one in the body: `[KEY-1]`, `Jira: KEY-1`,
 * `Ticket: KEY-1` or a `/browse/KEY-1` URL), without the taken-suffix. Null when no key is found or the result
 * would fail `isMentionWorkBranch`.
 */
export function mentionWorkBranchName({
  title,
  body,
}: {
  title: string;
  body: string | null | undefined;
}): string | null {
  const prefix = TYPE_PREFIX.exec(title);
  const type: CommitType =
    (prefix?.[1]?.toLowerCase() as CommitType | undefined) ?? DEFAULT_TYPE;
  const prefixLength = prefix?.[0].length ?? 0;
  const titleWithoutPrefix = title.slice(prefixLength);

  let key: string;
  let slug: string;
  const inTitle = findKey(title);
  if (inTitle) {
    key = inTitle.key;
    const afterStart = Math.max(inTitle.end, prefixLength);
    slug = slugify(title.slice(afterStart));
    if (slug === "" && inTitle.start >= prefixLength) {
      slug = slugify(title.slice(prefixLength, inTitle.start));
    }
  } else {
    const inBody = findBodyKey(body ?? "");
    if (!inBody) return null;
    key = inBody.key;
    slug = slugify(titleWithoutPrefix);
  }

  const name = `${type}/${key}${slug === "" ? "" : `-${slug}`}`;
  return isMentionWorkBranch(name) ? name : null;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Picks the stamp fields for an issue mention at intake. Never throws and
 * fails open to the suffixed name, never to the bare one: the bare name is
 * written only when GitHub answers 404 for the exact ref AND no thread of the
 * repo already claims it (a run that has not pushed yet is invisible to
 * GitHub). `{}` when the issue names no ticket.
 */
export async function chooseMentionWorkBranch({
  octokit,
  owner,
  repo,
  title,
  body,
  isClaimed,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  title: string;
  body: string | null | undefined;
  isClaimed: (name: string) => Promise<boolean>;
}): Promise<Pick<MentionLaneStamp, "workBranch" | "workBranchTaken">> {
  const workBranch = mentionWorkBranchName({ title, body });
  if (workBranch === null) return {};

  const isFreeOnRemote = async (): Promise<boolean> => {
    try {
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${workBranch}`,
      });
      return false;
    } catch (error) {
      return isNotFound(error);
    }
  };
  const isClaimedSafe = async (): Promise<boolean> => {
    try {
      return await isClaimed(workBranch);
    } catch {
      return true;
    }
  };
  const [free, claimed] = await Promise.all([
    isFreeOnRemote(),
    isClaimedSafe(),
  ]);
  return free && !claimed
    ? { workBranch }
    : { workBranch, workBranchTaken: true };
}

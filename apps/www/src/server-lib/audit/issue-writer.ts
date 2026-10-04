import type { Octokit } from "octokit";

import { GH_CREATE_SIGNAL } from "@terragon/shared/model/self-heal-breaker";

import { FINDING_LABELS, FINDING_MARKER_RE } from "./render-issue";
import {
  withSelfHealCall,
  type CallKind,
  type GithubResponse,
  type SelfHealCallDeps,
  type SelfHealCallResult,
} from "./with-self-heal-call";

/**
 * The self-heal issue write surface (OUTBOX-01, LIST-01). Built only from the
 * client createSelfHealOctokit returns, so every write is bot-authored
 * (Pitfall 7). Every Octokit call goes through withSelfHealCall. It only
 * touches issues and issue comments: it never opens or changes a pull request
 * and never lists with an unbounded state filter.
 */

export interface FindingIssue {
  number: number;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  fingerprint: string;
  createdAt: string;
}

export type IssueStateMap = ReadonlyMap<
  number,
  Pick<FindingIssue, "state" | "stateReason" | "labels">
>;

export interface IssueWriter {
  /** LIST-01. null = issues_unknown (a cap was exceeded or a call failed). */
  readIssueStates(ledgerIssueNumbers: number[]): Promise<IssueStateMap | null>;
  /** Reconcile before a re-create: bot issue carrying the fingerprint marker. */
  findByMarkerSince(
    fingerprint: string,
    since: Date,
  ): Promise<number | "unknown" | null>;
  ensureLabels(names: string[]): Promise<SelfHealCallResult<void>>;
  createIssue(i: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<SelfHealCallResult<number>>;
  updateIssue(i: {
    number: number;
    title?: string;
    body?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
  }): Promise<SelfHealCallResult<void>>;
  setIssueState(i: {
    number: number;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned";
  }): Promise<SelfHealCallResult<void>>;
  upsertComment(i: {
    number: number;
    marker: string;
    body: string;
  }): Promise<SelfHealCallResult<"created" | "updated">>;
  isPrivateRepo(): Promise<boolean | null>;
}

export const ISSUE_LIST_PAGE_SIZE = 100;
export const ISSUE_LIST_MAX_PAGES = 5;
export const ISSUE_GET_MAX = 20;
export const COMMENT_LIST_MAX_PAGES = 2;

interface RawLabel {
  name?: string | null;
}

interface RawIssue {
  number: number;
  state: string;
  state_reason?: string | null;
  labels: Array<string | RawLabel>;
  body?: string | null;
  created_at: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
}

interface RawComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

function labelNames(labels: RawIssue["labels"]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const name = typeof label === "string" ? label : label.name;
    if (name) out.push(name);
  }
  return out;
}

function firstLine(body: string | null | undefined): string {
  return (body ?? "").split("\n", 1)[0] ?? "";
}

export function createIssueWriter({
  octokit,
  owner,
  repo,
  botLogin,
  organizationId,
  installationKey,
  deadlineAt,
  deps,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  botLogin: string;
  organizationId: string;
  installationKey: string;
  deadlineAt: Date;
  deps: SelfHealCallDeps;
}): IssueWriter {
  const bot = botLogin.toLowerCase();

  function run<T>(
    kind: CallKind,
    signalName: string,
    call: (signal: AbortSignal) => Promise<GithubResponse<T>>,
  ): Promise<SelfHealCallResult<T>> {
    return withSelfHealCall<T>({
      kind,
      organizationId,
      installationKey,
      signalName,
      deadlineAt,
      call,
      deps,
    });
  }

  function isTrustedFinding(issue: RawIssue): FindingIssue | null {
    if (issue.pull_request) return null;
    if (issue.user?.login?.toLowerCase() !== bot) return null;
    const match = FINDING_MARKER_RE.exec(firstLine(issue.body));
    if (!match?.[1]) return null;
    return {
      number: issue.number,
      state: issue.state === "closed" ? "closed" : "open",
      stateReason: issue.state_reason ?? null,
      labels: labelNames(issue.labels),
      fingerprint: match[1],
      createdAt: issue.created_at,
    };
  }

  /** Bounded listing of automata:finding issues; null = a cap or a call failed. */
  async function listFindingIssues(
    since?: Date,
  ): Promise<FindingIssue[] | null> {
    const found: FindingIssue[] = [];
    for (let page = 1; page <= ISSUE_LIST_MAX_PAGES; page++) {
      const res = await run("read", "gh_read", (signal) =>
        octokit.rest.issues.listForRepo({
          owner,
          repo,
          labels: FINDING_LABELS.finding,
          state: "open",
          per_page: ISSUE_LIST_PAGE_SIZE,
          page,
          ...(since ? { since: since.toISOString() } : {}),
          request: { signal },
        }),
      );
      if (!res.ok) return null;
      const items = res.data as unknown as RawIssue[];
      for (const item of items) {
        const issue = isTrustedFinding(item);
        if (issue) found.push(issue);
      }
      if (items.length < ISSUE_LIST_PAGE_SIZE) return found;
    }
    // The last allowed page was full: more pages exist than the cap allows.
    return null;
  }

  async function readIssueStates(
    ledgerIssueNumbers: number[],
  ): Promise<IssueStateMap | null> {
    const listed = await listFindingIssues();
    if (listed === null) return null;
    const map = new Map<
      number,
      Pick<FindingIssue, "state" | "stateReason" | "labels">
    >();
    for (const issue of listed) {
      map.set(issue.number, {
        state: issue.state,
        stateReason: issue.stateReason,
        labels: issue.labels,
      });
    }
    const missing = [...new Set(ledgerIssueNumbers)].filter((n) => !map.has(n));
    if (missing.length > ISSUE_GET_MAX) return null;
    for (const number of missing) {
      const res = await run("read", "gh_read", (signal) =>
        octokit.rest.issues.get({
          owner,
          repo,
          issue_number: number,
          request: { signal },
        }),
      );
      if (!res.ok) {
        // A deleted or transferred issue is simply absent from the map; any
        // other failure leaves the state unknown.
        if (res.outcome === "not_found") continue;
        return null;
      }
      const issue = isTrustedFinding(res.data as unknown as RawIssue);
      if (issue) {
        map.set(issue.number, {
          state: issue.state,
          stateReason: issue.stateReason,
          labels: issue.labels,
        });
      }
    }
    return map;
  }

  async function findByMarkerSince(
    fingerprint: string,
    since: Date,
  ): Promise<number | "unknown" | null> {
    const listed = await listFindingIssues(since);
    if (listed === null) return "unknown";
    const hit = listed.find((i) => i.fingerprint === fingerprint);
    return hit ? hit.number : null;
  }

  async function ensureLabels(
    names: string[],
  ): Promise<SelfHealCallResult<void>> {
    let status = 200;
    for (const name of names) {
      const res = await run("write", "gh_write", (signal) =>
        octokit.rest.issues.createLabel({
          owner,
          repo,
          name,
          request: { signal },
        }),
      );
      // 422 already_exists is the idempotent success.
      if (!res.ok && res.outcome !== "unprocessable") return res;
      if (res.ok) status = res.status;
    }
    return { ok: true, data: undefined, status };
  }

  async function createIssue(i: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<SelfHealCallResult<number>> {
    const res = await run("create", GH_CREATE_SIGNAL, (signal) =>
      octokit.rest.issues.create({
        owner,
        repo,
        title: i.title,
        body: i.body,
        labels: i.labels,
        request: { signal },
      }),
    );
    if (!res.ok) return res;
    return { ...res, data: res.data.number };
  }

  async function getIssue(
    number: number,
  ): Promise<SelfHealCallResult<RawIssue>> {
    const res = await run("read", "gh_read", (signal) =>
      octokit.rest.issues.get({
        owner,
        repo,
        issue_number: number,
        request: { signal },
      }),
    );
    if (!res.ok) return res;
    return { ...res, data: res.data as unknown as RawIssue };
  }

  async function updateIssue(i: {
    number: number;
    title?: string;
    body?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
  }): Promise<SelfHealCallResult<void>> {
    let status = 200;
    if (i.title !== undefined || i.body !== undefined) {
      const res = await run("write", "gh_write", (signal) =>
        octokit.rest.issues.update({
          owner,
          repo,
          issue_number: i.number,
          ...(i.title !== undefined ? { title: i.title } : {}),
          ...(i.body !== undefined ? { body: i.body } : {}),
          request: { signal },
        }),
      );
      if (!res.ok) return res;
      status = res.status;
    }
    const wantAdd = i.labelsAdd ?? [];
    const wantRemove = i.labelsRemove ?? [];
    if (wantAdd.length > 0 || wantRemove.length > 0) {
      // Set-based: read the current labels and apply only the difference, so a
      // repeated effect issues no calls and never flaps a label.
      const current = await getIssue(i.number);
      if (!current.ok) return current;
      const have = new Set(labelNames(current.data.labels));
      const toAdd = wantAdd.filter((l) => !have.has(l));
      const toRemove = wantRemove.filter((l) => have.has(l));
      if (toAdd.length > 0) {
        const res = await run("write", "gh_write", (signal) =>
          octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: i.number,
            labels: toAdd,
            request: { signal },
          }),
        );
        if (!res.ok) return res;
        status = res.status;
      }
      for (const name of toRemove) {
        const res = await run("write", "gh_write", (signal) =>
          octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: i.number,
            name,
            request: { signal },
          }),
        );
        // Already gone is the desired end state.
        if (!res.ok && res.outcome !== "not_found") return res;
        if (res.ok) status = res.status;
      }
    }
    return { ok: true, data: undefined, status };
  }

  async function setIssueState(i: {
    number: number;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned";
  }): Promise<SelfHealCallResult<void>> {
    const current = await getIssue(i.number);
    if (!current.ok) return current;
    if ((current.data.state === "closed" ? "closed" : "open") === i.state) {
      return { ok: true, data: undefined, status: current.status };
    }
    const res = await run("write", "gh_write", (signal) =>
      octokit.rest.issues.update({
        owner,
        repo,
        issue_number: i.number,
        state: i.state,
        ...(i.state === "closed" && i.stateReason
          ? { state_reason: i.stateReason }
          : {}),
        request: { signal },
      }),
    );
    if (!res.ok) return res;
    return { ...res, data: undefined };
  }

  async function upsertComment(i: {
    number: number;
    marker: string;
    body: string;
  }): Promise<SelfHealCallResult<"created" | "updated">> {
    let existing: RawComment | undefined;
    for (let page = 1; page <= COMMENT_LIST_MAX_PAGES && !existing; page++) {
      const res = await run("read", "gh_read", (signal) =>
        octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: i.number,
          per_page: ISSUE_LIST_PAGE_SIZE,
          page,
          request: { signal },
        }),
      );
      if (!res.ok) return res;
      const items = res.data as unknown as RawComment[];
      existing = items.find(
        (c) =>
          c.user?.login?.toLowerCase() === bot &&
          firstLine(c.body) === i.marker,
      );
      if (!existing && items.length < ISSUE_LIST_PAGE_SIZE) break;
      if (!existing && page === COMMENT_LIST_MAX_PAGES) {
        // Cannot prove the marker comment is absent: fail closed, never append.
        return { ok: false, outcome: "other" };
      }
    }
    if (existing) {
      if ((existing.body ?? "") === i.body) {
        return { ok: true, data: "updated", status: 200 };
      }
      const commentId = existing.id;
      const res = await run("write", "gh_write", (signal) =>
        octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body: i.body,
          request: { signal },
        }),
      );
      if (!res.ok) return res;
      return { ...res, data: "updated" };
    }
    const res = await run("create", GH_CREATE_SIGNAL, (signal) =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: i.number,
        body: i.body,
        request: { signal },
      }),
    );
    if (!res.ok) return res;
    return { ...res, data: "created" };
  }

  async function isPrivateRepo(): Promise<boolean | null> {
    const res = await run("read", "gh_read", (signal) =>
      octokit.rest.repos.get({ owner, repo, request: { signal } }),
    );
    return res.ok ? res.data.private : null;
  }

  return {
    readIssueStates,
    findByMarkerSince,
    ensureLabels,
    createIssue,
    updateIssue,
    setIssueState,
    upsertComment,
    isPrivateRepo,
  };
}

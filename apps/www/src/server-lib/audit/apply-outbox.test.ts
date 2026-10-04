import { describe, expect, it, vi } from "vitest";

import type { AuditEffectRow } from "@terragon/shared/model/audit-findings";
import type { EffectInput } from "@terragon/shared/model/self-heal-outbox";

import {
  applyOutboxEffects,
  SELF_HEAL_WRITE_BUDGET,
  type ApplyOutboxDeps,
} from "./apply-outbox";
import {
  createFakeBreakerStore,
  createFakeIssueWriter,
  createInMemoryOutbox,
  FAKE_DB,
  FAKE_ORG,
} from "./__fixtures__/in-memory-self-heal";

const REPO = "acme/widgets";
const RUN = "run-1";
const KEY = "42";
const marker = (fp: string) => `<!-- automata-finding:v1 fp=${fp} -->`;

function createEffect(fp: string): EffectInput {
  return {
    fingerprint: fp,
    action: "create_issue",
    payload: { title: `t-${fp}`, body: `${marker(fp)}\nbody`, labels: [] },
  };
}

function harness(startMs = Date.UTC(2026, 9, 4, 12, 0, 0)) {
  let t = startMs;
  const clock = () => new Date(t);
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  });
  const writer = createFakeIssueWriter({ now: clock });
  const outbox = createInMemoryOutbox(clock);
  const breakers = createFakeBreakerStore(clock);
  const onIssueCreated = vi.fn(
    async (_e: AuditEffectRow, _n: number) => undefined,
  );
  const deps: ApplyOutboxDeps = {
    db: FAKE_DB,
    installationKey: KEY,
    outbox,
    breakers,
    now: clock,
    sleep,
    rand: () => 0,
    log: () => undefined,
    onIssueCreated,
  };

  async function enqueue(effects: EffectInput[]) {
    await outbox.enqueueEffects({
      organizationId: FAKE_ORG,
      repoFullName: REPO,
      runId: RUN,
      effects,
      now: clock(),
    });
  }
  async function claim() {
    return outbox.claimDueEffectsForRun({
      organizationId: FAKE_ORG,
      runId: RUN,
      now: clock(),
    });
  }
  async function apply(effects: AuditEffectRow[], deadlineMs = 25_000) {
    return applyOutboxEffects({
      effects,
      writer,
      deadlineAt: new Date(t + deadlineMs),
      mode: "on",
      deps,
    });
  }
  return {
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
    sleep,
    writer,
    outbox,
    breakers,
    onIssueCreated,
    enqueue,
    claim,
    apply,
    deps,
  };
}

function statuses(h: ReturnType<typeof harness>) {
  return [...h.outbox.rows.values()].map((r) => r.status);
}

describe("applyOutboxEffects", () => {
  it("RES-02: an ambiguous create is adopted on the next apply with zero second creates", async () => {
    const h = harness();
    await h.enqueue([createEffect("a")]);
    h.writer.failNextCreateAfterCommit("timeout");
    const first = await h.apply(await h.claim());
    expect(first).toMatchObject({ applied: 0, pending: 1, failed: 0 });
    const row = [...h.outbox.rows.values()][0];
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe("pending");

    h.advance(10 * 60_000);
    const second = await h.apply(await h.claim());
    expect(second).toMatchObject({ applied: 1, pending: 0 });
    expect(h.writer.createCount()).toBe(1);
    expect(h.onIssueCreated).toHaveBeenCalledTimes(1);
    expect(h.onIssueCreated.mock.calls[0]?.[1]).toBe(1);
    expect(statuses(h)).toEqual(["applied"]);
  });

  it("does not create while the marker listing is unknown", async () => {
    const h = harness();
    await h.enqueue([createEffect("a")]);
    h.writer.failNextCreateAfterCommit("server_error");
    await h.apply(await h.claim());
    h.advance(10 * 60_000);
    h.writer.setListingUnknown(true);
    const summary = await h.apply(await h.claim());
    expect(summary).toMatchObject({ applied: 0, pending: 1 });
    expect(h.writer.createCount()).toBe(1);
    expect(statuses(h)).toEqual(["pending"]);
  });

  it("caps content-creating writes at 10 per run and leaves the rest pending", async () => {
    const h = harness();
    await h.enqueue(
      Array.from({ length: 11 }, (_, i) => createEffect(`f${i}`)),
    );
    const summary = await h.apply(await h.claim(), 600_000);
    expect(summary).toMatchObject({
      applied: SELF_HEAL_WRITE_BUDGET.perRunCreates,
      pending: 1,
      stoppedBy: "write_budget",
    });
    expect(h.writer.createCount()).toBe(10);
    expect(h.onIssueCreated).toHaveBeenCalledTimes(10);
  });

  it("RES-19: 20 creates already recorded this hour block all creates", async () => {
    const h = harness();
    h.breakers.seedEvents(SELF_HEAL_WRITE_BUDGET.perHourCreates, {
      organizationId: FAKE_ORG,
      scopeKind: "github_write",
      scopeKey: KEY,
      signal: "gh_create",
      createdAt: new Date(Date.UTC(2026, 9, 4, 11, 40, 0)),
    });
    await h.enqueue([createEffect("a"), createEffect("b")]);
    const summary = await h.apply(await h.claim());
    expect(summary).toMatchObject({
      applied: 0,
      pending: 2,
      stoppedBy: "write_budget",
    });
    expect(h.writer.createCount()).toBe(0);
  });

  it("spaces creates by 3 s and stops when the next one cannot fit the deadline", async () => {
    const h = harness();
    await h.enqueue(["a", "b", "c", "d"].map(createEffect));
    const summary = await h.apply(await h.claim(), 6_500);
    expect(h.sleeps).toEqual([SELF_HEAL_WRITE_BUDGET.minCreateSpacingMs]);
    expect(summary).toMatchObject({
      applied: 2,
      pending: 2,
      stoppedBy: "deadline",
    });
    expect(h.writer.createCount()).toBe(2);
  });

  it("stops on rate_limited, leaves the rest pending and schedules no sleep", async () => {
    const h = harness();
    await h.enqueue(["a", "b", "c"].map(createEffect));
    h.writer.failNext("createIssue", "rate_limited");
    const summary = await h.apply(await h.claim());
    expect(summary).toMatchObject({
      applied: 0,
      pending: 3,
      failed: 0,
      stoppedBy: "rate_limited",
    });
    expect(h.sleep).not.toHaveBeenCalled();
    expect(statuses(h)).toEqual(["pending", "pending", "pending"]);
    expect(
      [...h.outbox.rows.values()].every((r) => r.leaseUntil === null),
    ).toBe(true);
  });

  it("fails a permission-denied effect and leaves the run's other effects pending", async () => {
    const h = harness();
    await h.enqueue(["a", "b"].map(createEffect));
    h.writer.failNext("createIssue", "permission");
    const summary = await h.apply(await h.claim());
    expect(summary).toMatchObject({
      applied: 0,
      failed: 1,
      pending: 1,
      stoppedBy: "permission",
    });
    expect(statuses(h).sort()).toEqual(["failed", "pending"]);
    expect(h.writer.createCount()).toBe(0);
  });

  it("applies set_labels, set_issue_state and upsert_comment idempotently, updates before comments", async () => {
    const h = harness();
    h.writer.seedIssue({
      number: 5,
      fingerprint: "x",
      labels: new Set(["old"]),
    });
    const m = "<!-- automata-finding-comment:v1 fp=x kind=k run=r -->";
    const effects: EffectInput[] = [
      {
        fingerprint: "x",
        action: "upsert_comment",
        payload: { issueNumber: 5, marker: m, body: `${m}\nhello` },
      },
      {
        fingerprint: "x",
        action: "set_issue_state",
        payload: { issueNumber: 5, state: "closed", stateReason: "completed" },
      },
      {
        fingerprint: "x",
        action: "set_labels",
        payload: { issueNumber: 5, add: ["new"], remove: ["old"] },
      },
    ];
    await h.enqueue(effects);
    const claimed = await h.claim();
    const first = await h.apply(claimed);
    expect(first.applied).toBe(3);
    expect(h.writer.calls.map((c) => c.op)).toEqual([
      "setIssueState",
      "updateIssue",
      "upsertComment",
    ]);
    const second = await h.apply(claimed);
    expect(second.applied).toBe(3);
    expect(h.writer.comments).toHaveLength(1);
    const issue = h.writer.issues.get(5);
    expect(issue?.state).toBe("closed");
    expect([...(issue?.labels ?? [])]).toEqual(["new"]);
  });

  it("resolves a comment on a just-created issue from the batch and via issueNumberFor otherwise", async () => {
    const h = harness();
    const m = "<!-- automata-finding-comment:v1 fp=a kind=k run=r -->";
    await h.enqueue([
      createEffect("a"),
      {
        fingerprint: "a",
        action: "upsert_comment",
        payload: { marker: m, body: `${m}\nhi` },
      },
    ]);
    const summary = await h.apply(await h.claim());
    expect(summary.applied).toBe(2);
    expect(h.writer.comments[0]?.issueNumber).toBe(1);
  });

  it("calls onIssueCreated exactly once per applied create", async () => {
    const h = harness();
    await h.enqueue(["a", "b"].map(createEffect));
    await h.apply(await h.claim());
    expect(h.onIssueCreated).toHaveBeenCalledTimes(2);
  });
});

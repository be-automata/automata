import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "../../db/types";
import {
  authorizeSend,
  busStateOf,
  capabilitiesForLane,
  LANE_DEFAULT_MAX_DEPTH,
  narrowForChild,
  type AgentBusLane,
  type AgentBusState,
  type AgentCapabilities,
  type AgentRunView,
} from "./capabilities";

const LANES: AgentBusLane[] = ["task", "review"];
const REPOS = ["Acme/App", "acme/lib", "acme/docs", "other/x"];
const SKILLS = ["a", "b", "c", "d"];

/** mulberry32: a tiny seeded PRNG so the property loop is deterministic. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function subset<T>(rand: () => number, items: T[]): T[] {
  return items.filter(() => rand() < 0.5);
}

function reviewCaps(): AgentCapabilities {
  return capabilitiesForLane("review", { repoGrant: [], skills: null });
}

function view(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    threadId: "t1",
    organizationId: "org1",
    parentThreadId: null,
    rootThreadId: "root",
    lane: "task",
    capabilities: capabilitiesForLane("task", {
      repoGrant: [{ repo: "acme/app", access: "write" }],
      skills: null,
    }),
    depth: 0,
    status: "working",
    terminal: false,
    blockedAt: null,
    ...overrides,
  };
}

describe("capabilitiesForLane", () => {
  it("gives task spawn and sendTo to both lanes and review to none", () => {
    const grant = {
      repoGrant: [{ repo: "a/b", access: "write" as const }],
      skills: null,
    };
    const task = capabilitiesForLane("task", grant);
    expect(task.spawn).toEqual(["task", "review"]);
    expect(task.sendTo).toEqual(["task", "review"]);
    expect(task.maxDepth).toBe(LANE_DEFAULT_MAX_DEPTH);
    const review = capabilitiesForLane("review", grant);
    expect(review.spawn).toEqual([]);
    expect(review.sendTo).toEqual([]);
  });

  it("copies its inputs", () => {
    const repoGrant = [{ repo: "a/b", access: "write" as const }];
    const skills = ["x"];
    const caps = capabilitiesForLane("task", { repoGrant, skills });
    caps.repoGrant[0]!.access = "read";
    caps.skills!.push("y");
    expect(repoGrant[0]!.access).toBe("write");
    expect(skills).toEqual(["x"]);
  });
});

describe("narrowForChild", () => {
  const parent = {
    lane: "task" as const,
    capabilities: capabilitiesForLane("task", {
      repoGrant: [{ repo: "Acme/App", access: "write" }],
      skills: ["a", "b"],
    }),
    depth: 0,
  };

  it("defaults the repo to the parent's first grant, read-only, and inherits skills", () => {
    expect(narrowForChild(parent, { lane: "review" })).toEqual({
      ok: true,
      depth: 1,
      capabilities: {
        spawn: [],
        sendTo: [],
        repoGrant: [{ repo: "Acme/App", access: "read" }],
        skills: ["a", "b"],
        maxDepth: 3,
      },
    });
  });

  it("matches repos case-insensitively and keeps the parent's spelling", () => {
    const res = narrowForChild(parent, { lane: "task", repo: "acme/app" });
    expect(res.ok && res.capabilities.repoGrant).toEqual([
      { repo: "Acme/App", access: "read" },
    ]);
  });

  it("refuses a review parent spawning anything", () => {
    const reviewParent = {
      lane: "review" as const,
      capabilities: reviewCaps(),
      depth: 1,
    };
    expect(narrowForChild(reviewParent, { lane: "task" })).toEqual({
      ok: false,
      error: "lane_pair_not_allowed:review->task",
    });
    expect(narrowForChild(reviewParent, { lane: "review" })).toEqual({
      ok: false,
      error: "lane_pair_not_allowed:review->review",
    });
  });

  it("refuses a repo outside the grant, and an empty grant", () => {
    expect(narrowForChild(parent, { lane: "task", repo: "x/y" })).toEqual({
      ok: false,
      error: "repo_not_granted",
    });
    const empty = {
      ...parent,
      capabilities: { ...parent.capabilities, repoGrant: [] },
    };
    expect(narrowForChild(empty, { lane: "task" })).toEqual({
      ok: false,
      error: "repo_not_granted",
    });
  });

  it("refuses a skill outside the parent's set; any list passes for a null parent", () => {
    expect(
      narrowForChild(parent, { lane: "task", skills: ["a", "z"] }),
    ).toEqual({ ok: false, error: "skill_not_granted" });
    const open = {
      ...parent,
      capabilities: { ...parent.capabilities, skills: null },
    };
    const res = narrowForChild(open, { lane: "task", skills: ["z"] });
    expect(res.ok && res.capabilities.skills).toEqual(["z"]);
  });

  it("refuses depth above maxDepth and allows the last level", () => {
    expect(narrowForChild({ ...parent, depth: 2 }, { lane: "task" }).ok).toBe(
      true,
    );
    expect(narrowForChild({ ...parent, depth: 3 }, { lane: "task" })).toEqual({
      ok: false,
      error: "depth_exceeded",
    });
  });

  it("caps maxDepth by the parent's", () => {
    const low = {
      ...parent,
      capabilities: { ...parent.capabilities, maxDepth: 1 },
    };
    const res = narrowForChild(low, { lane: "task" });
    expect(res.ok && res.capabilities.maxDepth).toBe(1);
    expect(narrowForChild({ ...low, depth: 1 }, { lane: "task" })).toEqual({
      ok: false,
      error: "depth_exceeded",
    });
  });

  it("property: a permitted child is never wider than its parent (seeded, 1000 cases)", () => {
    const rand = seeded(659);
    const errors = new Set<string>();
    let okCount = 0;
    for (let i = 0; i < 1000; i++) {
      const lane = pick(rand, LANES);
      const parentCaps: AgentCapabilities = {
        spawn: subset(rand, LANES),
        sendTo: subset(rand, LANES),
        repoGrant: subset(rand, REPOS).map((repo) => ({
          repo: rand() < 0.3 ? repo.toUpperCase() : repo,
          access: pick(rand, ["read", "write"] as const),
        })),
        skills: rand() < 0.3 ? null : subset(rand, SKILLS),
        maxDepth: Math.floor(rand() * 6),
      };
      const p = {
        lane,
        capabilities: parentCaps,
        depth: Math.floor(rand() * 6),
      };
      const request = {
        lane: pick(rand, LANES),
        repo: rand() < 0.5 ? undefined : pick(rand, REPOS),
        skills: rand() < 0.5 ? undefined : subset(rand, [...SKILLS, "z"]),
      };
      const res = narrowForChild(p, request);

      if (!res.ok) {
        errors.add(res.error.split(":")[0] as string);
        if (!parentCaps.spawn.includes(request.lane)) {
          expect(res.error).toBe(
            `lane_pair_not_allowed:${lane}->${request.lane}`,
          );
        } else {
          expect([
            "repo_not_granted",
            "skill_not_granted",
            "depth_exceeded",
          ]).toContain(res.error);
        }
        continue;
      }
      okCount++;
      const c = res.capabilities;
      expect(c.spawn.every((x) => parentCaps.spawn.includes(x))).toBe(true);
      expect(c.sendTo.every((x) => parentCaps.sendTo.includes(x))).toBe(true);
      expect(c.maxDepth).toBeLessThanOrEqual(parentCaps.maxDepth);
      expect(c.maxDepth).toBeLessThanOrEqual(LANE_DEFAULT_MAX_DEPTH);
      expect(res.depth).toBe(p.depth + 1);
      expect(res.depth).toBeLessThanOrEqual(c.maxDepth);
      for (const g of c.repoGrant) {
        expect(parentCaps.repoGrant.some((x) => x.repo === g.repo)).toBe(true);
        expect(g.access).toBe("read");
      }
      if (parentCaps.skills !== null) {
        expect(c.skills).not.toBeNull();
        expect(c.skills!.every((s) => parentCaps.skills!.includes(s))).toBe(
          true,
        );
      }
      if (request.skills === undefined) {
        expect(c.skills).toEqual(parentCaps.skills);
      }
    }
    expect(okCount).toBeGreaterThan(50);
    expect(errors).toEqual(
      new Set([
        "lane_pair_not_allowed",
        "repo_not_granted",
        "skill_not_granted",
        "depth_exceeded",
      ]),
    );
  });
});

describe("authorizeSend", () => {
  it("is ok for a task sending to a same-tree task run", () => {
    expect(authorizeSend(view(), view({ threadId: "t2" }))).toBe("ok");
  });

  it("1: absent, other org and other tree are not_found", () => {
    expect(authorizeSend(view(), null)).toBe("not_found");
    expect(
      authorizeSend(view(), view({ threadId: "t2", organizationId: "org2" })),
    ).toBe("not_found");
    expect(
      authorizeSend(view(), view({ threadId: "t2", rootThreadId: "other" })),
    ).toBe("not_found");
  });

  it("1: another tree of the same org is deep-equal to an absent id (AC7)", () => {
    const other = authorizeSend(
      view(),
      view({ threadId: "t2", rootThreadId: "other-root" }),
    );
    expect(other).toStrictEqual(authorizeSend(view(), null));
  });

  it("1 before 2: a terminal sender to another tree is not_found", () => {
    expect(
      authorizeSend(
        view({ terminal: true }),
        view({ threadId: "t2", rootThreadId: "other" }),
      ),
    ).toBe("not_found");
  });

  it("2: a terminal sender gets sender_not_running", () => {
    expect(
      authorizeSend(view({ terminal: true }), view({ threadId: "t2" })),
    ).toBe("sender_not_running");
  });

  it("2: a blocked sender gets agent_blocked", () => {
    expect(
      authorizeSend(view({ blockedAt: new Date() }), view({ threadId: "t2" })),
    ).toBe("agent_blocked");
  });

  it("2 before 4: a blocked sender to a terminal target gets agent_blocked", () => {
    expect(
      authorizeSend(
        view({ blockedAt: new Date() }),
        view({ threadId: "t2", terminal: true }),
      ),
    ).toBe("agent_blocked");
  });

  it("2 before 3: a terminal sender outranks the lane pair", () => {
    const review = view({
      lane: "review",
      terminal: true,
      capabilities: reviewCaps(),
    });
    expect(authorizeSend(review, view({ threadId: "t2" }))).toBe(
      "sender_not_running",
    );
  });

  it("3: a review run may send to its parent and to nobody else", () => {
    const review = view({
      threadId: "r1",
      lane: "review",
      parentThreadId: "p1",
      depth: 1,
      capabilities: reviewCaps(),
    });
    expect(authorizeSend(review, view({ threadId: "p1" }))).toBe("ok");
    expect(authorizeSend(review, view({ threadId: "sib", lane: "task" }))).toBe(
      "lane_pair_not_allowed:review->task",
    );
    expect(
      authorizeSend(review, view({ threadId: "sib", lane: "review" })),
    ).toBe("lane_pair_not_allowed:review->review");
  });

  it("3 before 4: a lane-pair refusal outranks a terminal target", () => {
    const review = view({ lane: "review", capabilities: reviewCaps() });
    expect(
      authorizeSend(review, view({ threadId: "t2", terminal: true })),
    ).toBe("lane_pair_not_allowed:review->task");
  });

  it("4: a terminal target gets target_not_running", () => {
    expect(
      authorizeSend(view(), view({ threadId: "t2", terminal: true })),
    ).toBe("target_not_running");
  });

  it("4 before 5: a terminal and blocked target gets target_not_running", () => {
    expect(
      authorizeSend(
        view(),
        view({ threadId: "t2", terminal: true, blockedAt: new Date() }),
      ),
    ).toBe("target_not_running");
  });

  it("5: a blocked target gets agent_blocked", () => {
    expect(
      authorizeSend(view(), view({ threadId: "t2", blockedAt: new Date() })),
    ).toBe("agent_blocked");
  });
});

describe("busStateOf", () => {
  const EXPECTED: Record<ThreadStatus, AgentBusState> = {
    "queued-blocked": "starting",
    error: "failed",
    stopped: "cancelled",
    "working-stopped": "cancelled",
    draft: "starting",
    scheduled: "starting",
    queued: "starting",
    "queued-tasks-concurrency": "starting",
    "queued-sandbox-creation-rate-limit": "starting",
    "queued-agent-rate-limit": "starting",
    booting: "starting",
    working: "running",
    stopping: "running",
    "working-error": "running",
    "working-done": "running",
    checkpointing: "running",
    complete: "done",
  };

  it.each(Object.entries(EXPECTED))("maps %s to %s", (status, state) => {
    expect(busStateOf(status as ThreadStatus, null, false)).toBe(state);
  });

  it("blocked wins over a running or starting status", () => {
    expect(busStateOf("working", new Date(), false)).toBe("blocked");
    expect(busStateOf("booting", new Date(), false)).toBe("blocked");
  });

  it("a settled status keeps its state even when blockedAt is set", () => {
    expect(busStateOf("complete", new Date(), true)).toBe("done");
    expect(busStateOf("error", new Date(), true)).toBe("failed");
    expect(busStateOf("stopped", new Date(), true)).toBe("cancelled");
  });

  it("the terminal flag turns a live status into failed, ahead of blocked", () => {
    expect(busStateOf("working", null, true)).toBe("failed");
    expect(busStateOf("working", new Date(), true)).toBe("failed");
  });

  it("throws on a status outside the union", () => {
    expect(() => busStateOf("bogus" as ThreadStatus, null, false)).toThrow(
      "Unmapped thread status: bogus",
    );
  });
});

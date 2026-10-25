import type { Octokit } from "octokit";
import { describe, expect, it } from "vitest";

import { readDeliveryHeadCi } from "./head-ci";

const NOW = new Date("2026-10-26T12:00:00Z");
const LONG_DONE = "2026-10-26T11:50:00Z";

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface Fake {
  branch?: unknown | Error;
  rules?: unknown | Error;
  runs?: unknown[] | Error;
  statuses?: unknown[] | Error;
}

function octokitOf(fake: Fake): Octokit {
  const reply = async (value: unknown) => {
    if (value instanceof Error) throw value;
    return { data: value, status: 200, headers: {} };
  };
  return {
    rest: {
      repos: {
        getBranch: async () => reply(fake.branch ?? {}),
        getBranchRules: async () => reply(fake.rules ?? []),
        getCombinedStatusForRef: async () =>
          fake.statuses instanceof Error
            ? reply(fake.statuses)
            : reply({ statuses: fake.statuses ?? [] }),
      },
      checks: {
        listForRef: async () =>
          fake.runs instanceof Error
            ? reply(fake.runs)
            : reply({ check_runs: fake.runs ?? [] }),
      },
    },
  } as unknown as Octokit;
}

function read(fake: Fake, pushedAt = new Date(NOW.getTime() - 60_000)) {
  return readDeliveryHeadCi({
    octokit: octokitOf(fake),
    owner: "acme",
    repo: "widgets",
    sha: "H",
    baseRef: "main",
    pushedAt,
    now: NOW,
  });
}

const run = (
  name: string,
  conclusion: string | null,
  status = "completed",
) => ({
  name,
  status,
  conclusion,
  completed_at: conclusion === null ? null : LONG_DONE,
});

describe("#509 readDeliveryHeadCi", () => {
  it("every check on an unprotected base must pass (all-checks)", async () => {
    expect(await read({ runs: [run("test", "success")] })).toEqual({
      state: "success",
      gateSource: "all-checks",
      failing: [],
      noCi: false,
    });
    expect(
      await read({ runs: [run("test", "success"), run("lint", "failure")] }),
    ).toMatchObject({ state: "failure", failing: ["lint"] });
  });

  it("required checks decide alone on a protected base", async () => {
    const branch = {
      protection: { required_status_checks: { contexts: ["test"] } },
    };
    expect(
      await read({
        branch,
        runs: [run("test", "success"), run("optional", "failure")],
      }),
    ).toMatchObject({ state: "success", gateSource: "protection" });
  });

  it("a running check is pending", async () => {
    expect(await read({ runs: [run("test", null, "in_progress")] })).toEqual({
      state: "pending",
      gateSource: "all-checks",
    });
  });

  it("no CI at all: pending inside the 10-minute window, then success with noCi", async () => {
    expect(await read({})).toEqual({ state: "pending", gateSource: null });
    expect(await read({}, new Date(NOW.getTime() - 11 * 60_000))).toEqual({
      state: "success",
      gateSource: "finding-check-only",
      failing: [],
      noCi: true,
    });
  });

  it("403/404 on protection reads means no required checks", async () => {
    expect(
      await read({
        branch: httpError(403),
        rules: httpError(404),
        runs: [run("test", "success")],
      }),
    ).toMatchObject({ state: "success", gateSource: "all-checks" });
  });

  it("any other read failure propagates to the evaluator", async () => {
    await expect(read({ runs: httpError(502) })).rejects.toThrow("HTTP 502");
    await expect(read({ branch: httpError(500) })).rejects.toThrow("HTTP 500");
  });
});

import { describe, expect, it } from "vitest";

import { ORG_DEFAULT_REPO_SENTINEL } from "@terragon/shared/model/repo-review-settings";

import { resolveTaskAgentFromRows } from "./resolve-task-agent";

/**
 * Task-run packs (phase 7): repo row → '*' row → none. Never throws: an
 * invalid stored value resolves to no packs with an `invalid` detail.
 */

const ORG = "org-1";
const REPO = "acme/widgets";

function row(taskBatteries: string[] | null, repoFullName = REPO) {
  return { repoFullName, taskBatteries };
}

function orgRow(taskBatteries: string[] | null) {
  return row(taskBatteries, ORG_DEFAULT_REPO_SENTINEL);
}

describe("resolveTaskAgentFromRows", () => {
  it("uses the repo row's list", () => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo: row(["somnio-skills"]),
        orgDefault: orgRow(null),
      }),
    ).toEqual({ taskAgent: { batteries: ["somnio-skills"] } });
  });

  it("inherits the '*' row when the repo row is null", () => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo: row(null),
        orgDefault: orgRow(["somnio-skills"]),
      }),
    ).toEqual({ taskAgent: { batteries: ["somnio-skills"] } });
  });

  it("inherits the '*' row when there is no repo row", () => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo: undefined,
        orgDefault: orgRow(["somnio-skills"]),
      }),
    ).toEqual({ taskAgent: { batteries: ["somnio-skills"] } });
  });

  it("an explicit empty repo list wins over the '*' list (none)", () => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo: row([]),
        orgDefault: orgRow(["somnio-skills"]),
      }),
    ).toEqual({ taskAgent: undefined });
  });

  it.each<[string, ReturnType<typeof row> | undefined]>([
    ["both rows null", row(null)],
    ["no rows at all", undefined],
  ])("resolves to none with %s", (_name, repo) => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo,
        orgDefault: repo === undefined ? undefined : orgRow(null),
      }),
    ).toEqual({ taskAgent: undefined });
  });

  it("degrades an invalid winning value to none with a detail, without throwing", () => {
    const resolution = resolveTaskAgentFromRows({
      organizationId: ORG,
      repo: row(["nope"]),
      orgDefault: orgRow(["somnio-skills"]),
    });
    expect(resolution.taskAgent).toBeUndefined();
    expect("invalid" in resolution && resolution.invalid).toEqual(
      expect.stringContaining("taskBatteries"),
    );
    expect("invalid" in resolution && resolution.invalid).toEqual(
      expect.stringContaining(`(${ORG}, ${REPO})`),
    );
  });

  it("never reads an invalid value on the losing row", () => {
    expect(
      resolveTaskAgentFromRows({
        organizationId: ORG,
        repo: row(["somnio-skills"]),
        orgDefault: orgRow(["nope"]),
      }),
    ).toEqual({ taskAgent: { batteries: ["somnio-skills"] } });
  });

  it("returns a copy: mutating the result leaves the row alone", () => {
    const repo = row(["somnio-skills"]);
    const resolution = resolveTaskAgentFromRows({
      organizationId: ORG,
      repo,
      orgDefault: undefined,
    });
    resolution.taskAgent?.batteries.push("gsd-reviewers");
    expect(repo.taskBatteries).toEqual(["somnio-skills"]);
  });
});

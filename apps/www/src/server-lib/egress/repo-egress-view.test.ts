import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoReviewSetting } from "@terragon/shared/db/types";

import { getRepoEgressView } from "./repo-egress-view";

const ORG = { id: "org_1", slug: "acme" };
const REPO = "acme/widgets";
const UPDATED = new Date("2026-11-20T10:00:00.000Z");

/** A row with only the fields the view reads; the rest of the table is irrelevant here. */
function row(
  fields: Partial<
    Pick<
      RepoReviewSetting,
      "egressPolicy" | "egressAllowlist" | "cellEgressRegistries"
    >
  >,
): RepoReviewSetting {
  return {
    egressPolicy: null,
    egressAllowlist: null,
    cellEgressRegistries: null,
    updatedAt: UPDATED,
    updatedByUserId: "user_1",
    ...fields,
  } as RepoReviewSetting;
}

const view = (r: RepoReviewSetting | undefined) =>
  getRepoEgressView({
    org: ORG,
    repoFullName: REPO,
    row: r,
    canEdit: true,
    readOnlyReason: null,
  });

describe("getRepoEgressView", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("no row: nothing stored, the box open, the cell platform-only", () => {
    const v = view(undefined);
    expect(v.stored).toEqual({
      level: null,
      allowlist: [],
      registries: null,
      updatedAt: null,
      updatedByUserId: null,
    });
    expect(v.box).toEqual({ enforced: false, allowlist: [], error: null });
    expect(v.cell).toMatchObject({
      ok: true,
      entries: [
        { host: "api.anthropic.com", layer: "platform" },
        { host: "app.example.test", layer: "platform" },
      ],
    });
    expect(v.warnings).toEqual([{ code: "no_policy_box_open", entry: null }]);
    expect(v.budget).toEqual({ used: 2, max: 100 });
    expect(v.org).toEqual(ORG);
    expect(v.repo).toBe(REPO);
  });

  it("domain: the box carries system and repo hosts, the cell the repo's", () => {
    const v = view(
      row({
        egressPolicy: "domain",
        egressAllowlist: ["registry.npmjs.org", "storage.googleapis.com"],
      }),
    );
    expect(v.stored.updatedAt).toBe(UPDATED.toISOString());
    expect(v.box.enforced).toBe(true);
    expect(v.box.allowlist).toEqual(
      expect.arrayContaining([
        { host: "app.example.test", layer: "system" },
        { host: "api.anthropic.com", layer: "system" },
        { host: "registry.npmjs.org", layer: "repo" },
      ]),
    );
    expect(v.cell).toMatchObject({ ok: true });
    if (v.cell.ok) {
      expect(v.cell.entries).toContainEqual({
        host: "registry.npmjs.org",
        layer: "repo",
      });
    }
    expect(v.warnings.map((w) => w.code)).toEqual([
      "multi_tenant_upload_host",
      "domain_governs_box",
    ]);
    expect(v.budget.used).toBe(4);
  });

  it("registries opt-in tags its 17 hosts and counts them in the budget", () => {
    const v = view(
      row({
        egressPolicy: "domain",
        egressAllowlist: ["example.org"],
        cellEgressRegistries: true,
      }),
    );
    expect(v.cell.ok).toBe(true);
    if (v.cell.ok) {
      const registries = v.cell.entries.filter((e) => e.layer === "registries");
      expect(registries).toHaveLength(17);
      expect(v.cell.bundles).toContain("automata/registries@1");
    }
    expect(v.budget.used).toBe(2 + 17 + 1);
  });

  it("ip_port: the cell refuses the level", () => {
    const v = view(
      row({ egressPolicy: "ip_port", egressAllowlist: ["10.0.0.1"] }),
    );
    expect(v.cell).toEqual({
      ok: false,
      code: "egress_level_unsupported",
      reason: null,
    });
    expect(v.box.enforced).toBe(true);
  });

  it("a stored value the box builder throws on is invalid_policy, not a 500", () => {
    const v = view(
      row({ egressPolicy: "domain", egressAllowlist: ["not a host"] }),
    );
    expect(v.box).toEqual({
      enforced: true,
      allowlist: [],
      error: "invalid_policy",
    });
    expect(v.cell).toMatchObject({ ok: false, code: "egress_compile_failed" });
  });

  it("a legacy stored wildcard is a cell refusal with a warning", () => {
    const v = view(
      row({ egressPolicy: "domain", egressAllowlist: ["*.example.org"] }),
    );
    expect(v.cell).toMatchObject({ ok: false, code: "egress_compile_failed" });
    expect(v.warnings.map((w) => w.code)).toContain("cell_refuses_wildcard");
  });

  it("a broker host that cannot be one is cell broker_host_unavailable, never a throw", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://localhost");
    const v = view(row({ egressPolicy: "domain", egressAllowlist: [] }));
    expect(v.cell).toEqual({
      ok: false,
      code: "broker_host_unavailable",
      reason: null,
    });
    expect(v.budget.max).toBe(100);
  });

  it("passes canEdit and its reason through", () => {
    const v = getRepoEgressView({
      org: ORG,
      repoFullName: REPO,
      row: undefined,
      canEdit: false,
      readOnlyReason: "permission_unverified",
    });
    expect(v).toMatchObject({
      canEdit: false,
      readOnlyReason: "permission_unverified",
    });
  });
});

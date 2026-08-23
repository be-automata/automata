import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  setRepoReviewSetting,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { repoReviewSettings } from "@terragon/shared/db/schema";
import { resolveEgressPolicy } from "./resolve-egress-policy";

/**
 * The dispatch-snapshot seam for the egress shape (#66, mirroring
 * resolve-approve-floor.test.ts): proves resolveEgressPolicy reads the LIVE
 * (org, repo) row, builds the FINAL shape (system hosts merged in
 * control-plane-side), and returns null — no enforcement — whenever the org or
 * the policy is absent.
 */

const db = createDb(env.DATABASE_URL!);

// The test env's callback host (nonLocalhostPublicAppUrl → NEXT_PUBLIC_APP_URL).
const callbackHost = new URL(process.env.NEXT_PUBLIC_APP_URL!).host;
// Worker plane drops the github hosts (agent reaches GitHub via loopback
// brokers, #66 AC4 / #81); sandbox plane keeps them (resident token, #114).
const workerSystemHosts = [callbackHost, "api.anthropic.com"];
const sandboxSystemHosts = [
  callbackHost,
  "github.com",
  "api.github.com",
  "api.anthropic.com",
];

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("resolveEgressPolicy (dispatch snapshot)", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
  });

  it("no org (legacy/unfenced thread) → null, never a DB read of another org", async () => {
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: null,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toBeNull();
  });

  it("org present, no row → null (no enforcement, today's behavior)", async () => {
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toBeNull();
  });

  it("row present but egressPolicy unset → null", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toBeNull();
  });

  it("stored 'domain' policy → final shape with system hosts merged (read live), cleared on null", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: {
        egressPolicy: "domain",
        egressAllowlist: ["registry.npmjs.org"],
      },
    });
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toEqual({
      level: "domain",
      allowlist: ["registry.npmjs.org", ...workerSystemHosts],
    });

    // A dashboard clear applies on the NEXT resolution (rollback, spec §7).
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: null },
    });
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toBeNull();
  });

  it("'none' (sandbox plane) → full system hosts (callback + github hosts + api.anthropic.com)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none", egressAllowlist: ["ignored.example.com"] },
    });
    // The sandbox plane holds the resident token and pushes directly (#114), so
    // it keeps github.com / api.github.com in the system-host list.
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "sandbox",
      }),
    ).toEqual({ level: "none", allowlist: sandboxSystemHosts });
  });

  it("'none' (worker plane) → github hosts DROPPED, callback + api.anthropic.com KEPT (#66 AC4)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none", egressAllowlist: ["ignored.example.com"] },
    });
    // #66 AC4: the worker plane reaches GitHub only through loopback brokers
    // (#81), so github.com / api.github.com are dropped from the allowlist,
    // while the callback host and api.anthropic.com remain.
    const shape = await resolveEgressPolicy({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      plane: "worker",
    });
    expect(shape).toEqual({ level: "none", allowlist: workerSystemHosts });
    expect(shape?.allowlist).not.toContain("github.com");
    expect(shape?.allowlist).not.toContain("api.github.com");
    expect(shape?.allowlist).toContain("api.anthropic.com");
    expect(shape?.allowlist).toContain(callbackHost);
  });

  it("an INVALID stored entry throws at resolve time (fail loud, never a wrong policy)", async () => {
    // The upsert now rejects invalid entries at the write boundary, so seed the
    // bad row DIRECTLY — resolve-time validation is exactly the backstop for
    // rows that bypassed (or predate) the model's write validation.
    await db.insert(repoReviewSettings).values({
      organizationId: orgId,
      repoFullName: "acme/widgets",
      egressPolicy: "ip_port",
      egressAllowlist: ["not-an-ip"],
    });
    await expect(
      resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).rejects.toThrow(/expected an IP or IP:port/);
  });

  it("org fence: another org's policy never leaks", async () => {
    const otherOrg = await makeOrg();
    await upsertRepoReviewSetting({
      db,
      organizationId: otherOrg,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "domain", egressAllowlist: ["leak.example.com"] },
    });
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
        plane: "worker",
      }),
    ).toBeNull();
  });
});

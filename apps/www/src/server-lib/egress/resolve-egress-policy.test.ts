import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  setRepoReviewSetting,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
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
const systemHosts = [callbackHost, "github.com", "api.anthropic.com"];

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
      }),
    ).toBeNull();
  });

  it("org present, no row → null (no enforcement, today's behavior)", async () => {
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
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
      }),
    ).toEqual({
      level: "domain",
      allowlist: ["registry.npmjs.org", ...systemHosts],
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
      }),
    ).toBeNull();
  });

  it("'none' → system hosts only (callback + github.com + api.anthropic.com)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "none", egressAllowlist: ["ignored.example.com"] },
    });
    expect(
      await resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual({ level: "none", allowlist: systemHosts });
  });

  it("an INVALID stored entry throws at resolve time (fail loud, never a wrong policy)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "ip_port", egressAllowlist: ["not-an-ip"] },
    });
    await expect(
      resolveEgressPolicy({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
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
      }),
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import {
  bindGithubInstallationToOrg,
  bindRepoToOrg,
  getGithubInstallation,
  getInstallationOrgAndMode,
  getOrganizationIdForInstallation,
  getOrganizationInstallationMode,
  getRepoOrgAndMode,
  getRepoOrgBinding,
  unbindRepoFromOrg,
} from "./github-installation";

const db = createDb(env.DATABASE_URL!);

function installationId() {
  return String(Math.floor(Math.random() * 1_000_000_000));
}

describe("github-installation", () => {
  let orgId: string;

  beforeEach(async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  it("binds an installation to an org and resolves the org", async () => {
    const instId = installationId();
    const bound = await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: orgId,
      accountLogin: "acme-inc",
      accountType: "Organization",
    });
    expect(bound.installationId).toBe(instId);
    expect(bound.organizationId).toBe(orgId);

    const resolved = await getOrganizationIdForInstallation({
      db,
      installationId: instId,
    });
    expect(resolved).toBe(orgId);

    // Accepts a numeric installation id (the webhook payload shape).
    const resolvedNumeric = await getOrganizationIdForInstallation({
      db,
      installationId: Number(instId),
    });
    expect(resolvedNumeric).toBe(orgId);
  });

  it("resolves null for an unmapped or absent installation", async () => {
    expect(
      await getOrganizationIdForInstallation({
        db,
        installationId: installationId(),
      }),
    ).toBeNull();
    expect(
      await getOrganizationIdForInstallation({ db, installationId: null }),
    ).toBeNull();
    expect(
      await getOrganizationIdForInstallation({ db, installationId: undefined }),
    ).toBeNull();
  });

  it("rebinds an existing installation (upsert on the unique installationId)", async () => {
    const instId = installationId();
    await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: orgId,
    });
    const other = await createOrganization({
      db,
      name: "Other",
      slug: `other-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: other.id,
    });

    const row = await getGithubInstallation({ db, installationId: instId });
    expect(row?.organizationId).toBe(other.id);
    // Still a single row for that installation.
    expect(
      await getOrganizationIdForInstallation({ db, installationId: instId }),
    ).toBe(other.id);
  });

  describe("mode (Somnio pilot shadow/active)", () => {
    it("a new binding defaults to shadow mode", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
      });
      const row = await getGithubInstallation({ db, installationId: instId });
      expect(row?.mode).toBe("shadow");

      const resolved = await getInstallationOrgAndMode({
        db,
        installationId: instId,
      });
      expect(resolved).toEqual({ organizationId: orgId, mode: "shadow" });
    });

    it("an explicit mode is honored, and a rebind can flip shadow -> active", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "shadow",
      });
      expect(
        (await getInstallationOrgAndMode({ db, installationId: instId })).mode,
      ).toBe("shadow");

      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "active",
      });
      expect(
        (await getInstallationOrgAndMode({ db, installationId: instId })).mode,
      ).toBe("active");
    });

    it("a rebind without a mode leaves the existing mode unchanged (no accidental revert)", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "active",
      });
      // Rebind (e.g. account metadata refresh) without passing mode.
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        accountLogin: "acme-inc",
      });
      expect(
        (await getInstallationOrgAndMode({ db, installationId: instId })).mode,
      ).toBe("active");
    });

    it("an unmapped or absent installation resolves to active (migration-safe: never suppress an unknown install)", async () => {
      expect(
        await getInstallationOrgAndMode({
          db,
          installationId: installationId(),
        }),
      ).toEqual({ organizationId: null, mode: "active" });
      expect(
        await getInstallationOrgAndMode({ db, installationId: null }),
      ).toEqual({ organizationId: null, mode: "active" });
    });

    it("reverse org→mode: shadow only when every binding is shadow; active on any active binding or none", async () => {
      // No binding → active (migration-safe).
      expect(
        await getOrganizationInstallationMode({ db, organizationId: orgId }),
      ).toBe("active");
      expect(
        await getOrganizationInstallationMode({ db, organizationId: null }),
      ).toBe("active");

      // One shadow binding → shadow.
      await bindGithubInstallationToOrg({
        db,
        installationId: installationId(),
        organizationId: orgId,
        mode: "shadow",
      });
      expect(
        await getOrganizationInstallationMode({ db, organizationId: orgId }),
      ).toBe("shadow");

      // Add an active binding for the same org → active wins (someone went live).
      await bindGithubInstallationToOrg({
        db,
        installationId: installationId(),
        organizationId: orgId,
        mode: "active",
      });
      expect(
        await getOrganizationInstallationMode({ db, organizationId: orgId }),
      ).toBe("active");
    });
  });

  describe("per-repo org override (shared installation)", () => {
    function repo() {
      return `shared-owner/repo-${nanoid(6).toLowerCase()}`;
    }

    async function clientOrg() {
      return await createOrganization({
        db,
        name: "Client",
        slug: `client-${nanoid(8).toLowerCase()}`,
      });
    }

    it("no binding: falls back to the installation's org and mode, unchanged", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "active",
      });
      expect(
        await getRepoOrgAndMode({
          db,
          installationId: instId,
          repoFullName: repo(),
        }),
      ).toEqual({
        organizationId: orgId,
        mode: "active",
        source: "installation",
        boundOrganizationId: null,
      });
      expect(
        await getRepoOrgAndMode({
          db,
          installationId: null,
          repoFullName: repo(),
        }),
      ).toEqual({
        organizationId: null,
        mode: "active",
        source: "installation",
        boundOrganizationId: null,
      });
    });

    it("a binding wins over the installation's org; the mode still comes from the installation", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "shadow",
      });
      const client = await clientOrg();
      const name = repo();
      await bindRepoToOrg({
        db,
        repoFullName: name,
        organizationId: client.id,
      });
      expect(
        await getRepoOrgAndMode({
          db,
          installationId: instId,
          repoFullName: name,
        }),
      ).toEqual({
        organizationId: client.id,
        mode: "shadow",
        source: "repo_binding",
        boundOrganizationId: client.id,
      });
    });

    it("a binding never applies to a null or unmapped installation", async () => {
      const client = await clientOrg();
      const name = repo();
      await bindRepoToOrg({
        db,
        repoFullName: name,
        organizationId: client.id,
      });
      // Not applied, but still reported: a lane can see the repo is claimed.
      const unmapped = {
        organizationId: null,
        mode: "active",
        source: "installation",
        boundOrganizationId: client.id,
      };
      expect(
        await getRepoOrgAndMode({
          db,
          installationId: null,
          repoFullName: name,
        }),
      ).toEqual(unmapped);
      expect(
        await getRepoOrgAndMode({
          db,
          installationId: installationId(),
          repoFullName: name,
        }),
      ).toEqual(unmapped);
    });

    it("matches the repo case-insensitively and stores it lower-cased", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "active",
      });
      const client = await clientOrg();
      const name = repo();
      const bound = await bindRepoToOrg({
        db,
        repoFullName: ` ${name.toUpperCase()} `,
        organizationId: client.id,
      });
      expect(bound.repoFullName).toBe(name);
      const mixed = name.replace("shared-owner", "Shared-Owner");
      expect((await getRepoOrgBinding({ db, repoFullName: mixed }))?.id).toBe(
        bound.id,
      );
      expect(
        (
          await getRepoOrgAndMode({
            db,
            installationId: instId,
            repoFullName: mixed,
          })
        ).organizationId,
      ).toBe(client.id);
    });

    it("rebinding upserts; unbinding restores the installation's org", async () => {
      const instId = installationId();
      await bindGithubInstallationToOrg({
        db,
        installationId: instId,
        organizationId: orgId,
        mode: "active",
      });
      const first = await clientOrg();
      const second = await clientOrg();
      const name = repo();
      const a = await bindRepoToOrg({
        db,
        repoFullName: name,
        organizationId: first.id,
      });
      const b = await bindRepoToOrg({
        db,
        repoFullName: name,
        organizationId: second.id,
      });
      expect(b.id).toBe(a.id);
      expect(b.organizationId).toBe(second.id);

      expect(await unbindRepoFromOrg({ db, repoFullName: name })).toBe(true);
      expect(await unbindRepoFromOrg({ db, repoFullName: name })).toBe(false);
      expect(
        (
          await getRepoOrgAndMode({
            db,
            installationId: instId,
            repoFullName: name,
          })
        ).organizationId,
      ).toBe(orgId);
    });

    it("refuses a name that is not owner/repo", async () => {
      const client = await clientOrg();
      await expect(
        bindRepoToOrg({
          db,
          repoFullName: "no-slash",
          organizationId: client.id,
        }),
      ).rejects.toThrow(/owner\/repo/);
    });
  });
});

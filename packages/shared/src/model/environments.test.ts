import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  getEnvironment,
  updateEnvironment,
  getOrCreateEnvironment,
  getOrCreateGlobalEnvironment,
} from "./environments";
import { createOrganization } from "./organizations";
import { createTestUser } from "./test-helpers";

describe("environments", () => {
  let db: DB;
  let userId: string;
  let environmentId: string;

  beforeEach(async () => {
    // Use the test database URL from environment (set by test setup)
    const testDbUrl = process.env.DATABASE_URL!;
    db = createDb(testDbUrl);

    // Create a test user
    const { user } = await createTestUser({ db });
    userId = user.id;

    // Create a test environment
    const [environment] = await db
      .insert(schema.environment)
      .values({
        userId,
        repoFullName: "test-org/test-repo",
      })
      .returning();
    environmentId = environment!.id;
  });

  describe("setup script functionality", () => {
    it("should save setup script to environment", async () => {
      const setupScript = `#!/bin/bash
echo "Running custom environment setup"
npm install
npm run build
echo "Setup complete!"`;

      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment).toBeDefined();
      expect(updatedEnvironment?.setupScript).toBe(setupScript);
    });

    it("should allow null setup script to remove it", async () => {
      // First add a setup script
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'test'",
        },
      });

      // Then remove it
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: null,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment?.setupScript).toBeNull();
    });

    it("should not affect other environment fields when updating setup script", async () => {
      // Add some environment variables first
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          environmentVariables: [
            { key: "API_KEY", valueEncrypted: "encrypted_value" },
          ],
        },
      });

      // Update only the setup script
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'new setup script'",
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      // Environment variables should remain unchanged
      expect(updatedEnvironment?.environmentVariables).toHaveLength(1);
      expect(updatedEnvironment?.environmentVariables?.[0]?.key).toBe(
        "API_KEY",
      );
      expect(updatedEnvironment?.setupScript).toBe("echo 'new setup script'");
    });

    it("should handle multi-line setup scripts with special characters", async () => {
      const complexScript = `#!/bin/bash
set -e

# Setup environment variables
export NODE_ENV="production"
export API_URL="https://api.example.com"

# Install dependencies
echo "Installing dependencies..."
npm ci --production

# Run database migrations
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Running migrations..."
  npm run db:migrate
fi

# Build the application
npm run build

# Special characters test
echo 'Testing "quotes" and $variables'
echo "Path: \${PWD}"

# Exit successfully
exit 0`;

      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: complexScript,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment?.setupScript).toBe(complexScript);
    });

    it("should only allow user to update their own environment", async () => {
      const otherUserId = "other-user-456";

      // Should return null when trying to get another user's environment
      const environment = await getEnvironment({
        db,
        userId: otherUserId,
        environmentId,
      });

      expect(environment).toBeUndefined();

      // Update should not affect the environment
      await updateEnvironment({
        db,
        userId: otherUserId,
        environmentId,
        updates: {
          setupScript: "malicious script",
        },
      });

      // Original user should still see unchanged environment
      const originalEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(originalEnvironment?.setupScript).toBeNull();
    });
  });

  describe("getOrCreateEnvironment", () => {
    it("should create environment with null setup script by default", async () => {
      const newRepoFullName = "test-org/new-repo";

      const environment = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: newRepoFullName,
      });

      expect(environment).toBeDefined();
      expect(environment.userId).toBe(userId);
      expect(environment.repoFullName).toBe(newRepoFullName);
      expect(environment.setupScript).toBeNull();
    });

    it("should return existing environment with setup script", async () => {
      // Add setup script to existing environment
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'existing script'",
        },
      });

      // Get or create should return the existing one
      const environment = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: "test-org/test-repo",
      });

      expect(environment.id).toBe(environmentId);
      expect(environment.setupScript).toBe("echo 'existing script'");
    });
  });

  describe("per-org uniqueness (environment_org_user_repo_unique)", () => {
    const repo = "acme/shared-repo";
    async function makeOrg(prefix: string) {
      return await createOrganization({
        db,
        name: prefix,
        slug: `${prefix}-${userId.slice(0, 8).toLowerCase()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      });
    }

    // The bug: under the old (user_id, repo_full_name) unique index, a row
    // for this repo in another org (or with organization_id NULL) made the
    // fenced lookup miss, the insert DO NOTHING, and the re-read throw
    // "Failed to get or create environment".
    it("creates a distinct row in org B when the repo already has a row in org A", async () => {
      const orgA = await makeOrg("a");
      const orgB = await makeOrg("b");
      const inA = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
        organizationId: orgA.id,
      });
      const inB = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
        organizationId: orgB.id,
      });
      expect(inB.id).not.toBe(inA.id);
      expect(inA.organizationId).toBe(orgA.id);
      expect(inB.organizationId).toBe(orgB.id);
    });

    it("creates an org row when the repo already has a legacy NULL-org row", async () => {
      const [legacy] = await db
        .insert(schema.environment)
        .values({ userId, repoFullName: repo })
        .returning();
      const org = await makeOrg("c");
      const inOrg = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
        organizationId: org.id,
      });
      expect(inOrg.id).not.toBe(legacy!.id);
      expect(inOrg.organizationId).toBe(org.id);
    });

    it("returns the same row for the same org", async () => {
      const org = await makeOrg("d");
      const first = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
        organizationId: org.id,
      });
      const second = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
        organizationId: org.id,
      });
      expect(second.id).toBe(first.id);
    });

    it("dedupes the no-org case (NULLS NOT DISTINCT)", async () => {
      const first = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
      });
      const second = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: repo,
      });
      expect(second.id).toBe(first.id);
      // The index itself rejects a second NULL-org row for user + repo.
      const dup = await db
        .insert(schema.environment)
        .values({ userId, repoFullName: repo })
        .onConflictDoNothing()
        .returning();
      expect(dup).toHaveLength(0);
    });

    it("keeps one global environment per user across orgs", async () => {
      const orgA = await makeOrg("e");
      const orgB = await makeOrg("f");
      const fromA = await getOrCreateGlobalEnvironment({
        db,
        userId,
        organizationId: orgA.id,
      });
      const fromB = await getOrCreateGlobalEnvironment({
        db,
        userId,
        organizationId: orgB.id,
      });
      expect(fromB.id).toBe(fromA.id);
      const dup = await db
        .insert(schema.environment)
        .values({
          userId,
          repoFullName: "",
          isGlobal: true,
          organizationId: orgB.id,
        })
        .onConflictDoNothing()
        .returning();
      expect(dup).toHaveLength(0);
    });
  });

  describe("global environment and the org fence", () => {
    // A user has exactly one global row (environment_user_global_unique), created
    // before org scoping with organization_id NULL. The global page finds it
    // by user alone; saving from inside an org must reach the same row.
    it("an org-scoped read and write reach the user's legacy global row", async () => {
      const [global] = await db
        .insert(schema.environment)
        .values({ userId, repoFullName: "", isGlobal: true })
        .returning();
      const org = await createOrganization({
        db,
        name: "Org",
        slug: `org-${userId.slice(0, 8).toLowerCase()}`,
      });

      expect(
        await getEnvironment({
          db,
          userId,
          environmentId: global!.id,
          organizationId: org.id,
        }),
      ).toBeDefined();
      expect(
        (
          await getOrCreateGlobalEnvironment({
            db,
            userId,
            organizationId: org.id,
          })
        ).id,
      ).toBe(global!.id);

      await updateEnvironment({
        db,
        userId,
        environmentId: global!.id,
        organizationId: org.id,
        updates: { setupScript: "echo saved" },
      });
      const saved = await getEnvironment({
        db,
        userId,
        environmentId: global!.id,
      });
      expect(saved?.setupScript).toBe("echo saved");
    });

    it("an org-scoped read still hides another org's repo environment", async () => {
      const orgA = await createOrganization({
        db,
        name: "A",
        slug: `a-${userId.slice(0, 8).toLowerCase()}`,
      });
      const orgB = await createOrganization({
        db,
        name: "B",
        slug: `b-${userId.slice(0, 8).toLowerCase()}`,
      });
      const [inA] = await db
        .insert(schema.environment)
        .values({ userId, organizationId: orgA.id, repoFullName: "acme/a" })
        .returning();
      expect(
        await getEnvironment({
          db,
          userId,
          environmentId: inA!.id,
          organizationId: orgB.id,
        }),
      ).toBeUndefined();
    });
  });
});

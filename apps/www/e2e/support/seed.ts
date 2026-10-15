import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import { seedFeatureFlags } from "@terragon/shared/model/feature-flags";
import { encryptToken, encryptValue } from "@terragon/utils/encryption";

import { E2E_ENCRYPTION_MASTER_KEY } from "../e2e-env";
import { WORLD, type WorldState } from "./world";

/** The fixture token the GitHub account rows hold (encrypted at rest). */
export const OWNER_GITHUB_TOKEN = "gho_e2e_owner_placeholder_token";

const SECRETS = {
  global: {
    E2E_SHARED_KEY: "e2e-global-value-shared",
    E2E_ORG_AND_GLOBAL_KEY: "e2e-global-value-org-and-global",
    E2E_GLOBAL_ONLY_KEY: "e2e-global-value-global-only",
  },
  organization: {
    E2E_SHARED_KEY: "e2e-org-value-shared",
    E2E_ORG_AND_GLOBAL_KEY: "e2e-org-value-org-and-global",
  },
  repository: {
    E2E_SHARED_KEY: "e2e-repo-value-shared",
  },
} as const;

function encryptVariables(
  variables: Record<string, string>,
): Array<{ key: string; valueEncrypted: string }> {
  return Object.entries(variables).map(([key, value]) => ({
    key,
    valueEncrypted: encryptValue(value, E2E_ENCRYPTION_MASTER_KEY),
  }));
}

export type SeededWorld = Pick<
  WorldState,
  "effectiveEnvironmentId" | "seededSecretValues"
>;

/**
 * Seeds the two-org world described in ./world.ts into an empty, freshly
 * pushed database. Not idempotent on purpose: it runs once per throwaway
 * database.
 */
export async function seedTwoOrgWorld(db: DB): Promise<SeededWorld> {
  await seedFeatureFlags({ db });

  const base = Date.now() - 60 * 60 * 1000;
  const at = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000);
  const { owner, cueWatcher, outsider } = WORLD.users;
  const { personal, alpha, beta, gamma } = WORLD.orgs;

  await db.insert(schema.user).values(
    [owner, cueWatcher, outsider].map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: true,
      createdAt: at(0),
      updatedAt: at(0),
    })),
  );

  // Oldest first: personal, Alpha, Beta, then N's Gamma.
  await db.insert(schema.organization).values(
    [personal, alpha, beta, gamma].map((org, index) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      isPersonal: org.isPersonal,
      createdAt: at(index + 1),
    })),
  );

  await db.insert(schema.member).values([
    ...[personal, alpha, beta].map((org, index) => ({
      id: `e2e-member-owner-${org.slug}`,
      organizationId: org.id,
      userId: owner.id,
      role: "owner",
      createdAt: at(10 + index),
    })),
    ...[alpha, beta].map((org, index) => ({
      id: `e2e-member-cue-${org.slug}`,
      organizationId: org.id,
      userId: cueWatcher.id,
      role: "owner",
      createdAt: at(15 + index),
    })),
    {
      id: "e2e-member-outsider-gamma",
      organizationId: gamma.id,
      userId: outsider.id,
      role: "owner",
      createdAt: at(20),
    },
  ]);

  // Skip onboarding; the stored repo is Alpha's, so the dashboard has to
  // ignore it while Beta is active (#344).
  await db.insert(schema.userFlags).values([
    {
      userId: owner.id,
      hasSeenOnboarding: true,
      selectedRepo: WORLD.github.alphaRepo,
      selectedBranch: "main",
    },
    {
      userId: cueWatcher.id,
      hasSeenOnboarding: true,
      selectedRepo: WORLD.github.alphaRepo,
      selectedBranch: "main",
    },
    { userId: outsider.id, hasSeenOnboarding: true },
  ]);

  // U signed in with GitHub: the token is encrypted the way auth.ts's
  // account.create hook stores it. No expiry, so no refresh is attempted.
  await db.insert(schema.account).values(
    [
      { user: owner, githubId: "424242" },
      { user: cueWatcher, githubId: "424243" },
    ].map(({ user, githubId }) => ({
      id: `e2e-account-${user.id}-github`,
      accountId: githubId,
      providerId: "github",
      userId: user.id,
      accessToken: encryptToken(OWNER_GITHUB_TOKEN, E2E_ENCRYPTION_MASTER_KEY),
      scope: "read:user,user:email",
      createdAt: at(0),
      updatedAt: at(0),
    })),
  );

  await db.insert(schema.githubInstallation).values([
    {
      installationId: WORLD.github.alphaInstallationId,
      organizationId: alpha.id,
      accountLogin: "e2e-alpha-gh",
      accountType: "Organization",
    },
    {
      installationId: WORLD.github.betaInstallationId,
      organizationId: beta.id,
      accountLogin: "e2e-beta-gh",
      accountType: "Organization",
    },
  ]);

  // A linked Slack account whose workspace has no installation yet: the
  // integrations page offers "Install into <org>".
  await db.insert(schema.slackAccount).values({
    userId: owner.id,
    teamId: WORLD.slack.teamId,
    slackUserId: "U0E2E0001",
    slackTeamName: WORLD.slack.teamName,
    slackTeamDomain: "e2e-workspace",
    accessTokenEncrypted: encryptValue(
      "xoxp-e2e-placeholder",
      E2E_ENCRYPTION_MASTER_KEY,
    ),
  });

  // Effective configuration: the same keys at all three layers.
  await db.insert(schema.environment).values({
    userId: owner.id,
    organizationId: null,
    isGlobal: true,
    repoFullName: "",
    environmentVariables: encryptVariables(SECRETS.global),
  });
  await db.insert(schema.organizationEnvironment).values({
    organizationId: beta.id,
    environmentVariables: encryptVariables(SECRETS.organization),
    updatedByUserId: owner.id,
  });
  const [effectiveEnvironment] = await db
    .insert(schema.environment)
    .values({
      userId: owner.id,
      organizationId: beta.id,
      repoFullName: WORLD.environments.effectiveRepo,
      environmentVariables: encryptVariables(SECRETS.repository),
    })
    .returning({ id: schema.environment.id });
  if (!effectiveEnvironment) {
    throw new Error("Failed to seed the effective-configuration environment");
  }

  // #340: Beta's repo already has an environment in Alpha. Creating one in
  // Beta must not collide with it.
  await db.insert(schema.environment).values({
    userId: owner.id,
    organizationId: alpha.id,
    repoFullName: WORLD.github.betaRepo,
  });

  return {
    effectiveEnvironmentId: effectiveEnvironment.id,
    seededSecretValues: {
      global: Object.values(SECRETS.global),
      organization: Object.values(SECRETS.organization),
      repository: Object.values(SECRETS.repository),
    },
  };
}

import { and, asc, eq, sql } from "drizzle-orm";
import { DB } from "../db";
import * as schema from "../db/schema";
import { FeatureFlag, FeatureFlagDB, UserFeatureFlag } from "../db/types";
import {
  FeatureFlagDefinition,
  FeatureFlagName,
  featureFlagsDefinitions,
} from "./feature-flags-definitions";

function dbToFeatureFlag(flag: FeatureFlagDB): FeatureFlag {
  const def = featureFlagsDefinitions[flag.name as FeatureFlagName] as
    | FeatureFlagDefinition
    | undefined;
  return {
    ...flag,
    inCodebase: !!def,
    enabledForPreview: def?.enabledForPreview ?? false,
  };
}

/**
 * Get all global feature flags
 */
export async function getFeatureFlags({
  db,
}: {
  db: DB;
}): Promise<FeatureFlag[]> {
  if (process.env.NODE_ENV === "test") {
    const flags = await db.query.featureFlags.findMany({
      orderBy: [asc(schema.featureFlags.name)],
    });
    return flags.map(dbToFeatureFlag);
  }
  const existingFlags = await db.query.featureFlags.findMany({
    orderBy: [asc(schema.featureFlags.name)],
  });
  const existingFlagsByName: Record<string, FeatureFlagDB> = {};
  for (const flag of existingFlags) {
    existingFlagsByName[flag.name] = flag;
  }
  const flagsToCreate = Object.entries(featureFlagsDefinitions)
    .filter(([name]) => {
      const existingFlag = existingFlagsByName[name];
      if (!existingFlag) {
        return true;
      }
      const definition = featureFlagsDefinitions[name as FeatureFlagName];
      return (
        existingFlag.defaultValue !== definition.defaultValue ||
        existingFlag.description !== definition.description
      );
    })
    .map(([name, { defaultValue, description }]) => ({
      name,
      defaultValue,
      description,
    }));
  if (flagsToCreate.length === 0) {
    return existingFlags.map(dbToFeatureFlag);
  }
  await db
    .insert(schema.featureFlags)
    .values(flagsToCreate)
    .onConflictDoUpdate({
      target: [schema.featureFlags.name],
      set: {
        defaultValue: sql`excluded.default_value`,
        description: sql`excluded.description`,
      },
    });

  return (
    await db.query.featureFlags.findMany({
      orderBy: [asc(schema.featureFlags.name)],
    })
  ).map(dbToFeatureFlag);
}

/**
 * Seed every feature flag defined in code into the database.
 *
 * In test mode `getFeatureFlags` intentionally does NOT auto-create missing
 * flags (unlike production), so the test database must be seeded up front —
 * otherwise any code path that reads a flag by name (e.g.
 * `setUserFeatureFlagOverride`, which throws `Feature flag "X" does not exist`)
 * fails against a schema-only database. Call this once after the schema is
 * pushed so the baseline flag rows exist for the whole suite.
 */
export async function seedFeatureFlags({ db }: { db: DB }): Promise<void> {
  const values = Object.entries(featureFlagsDefinitions).map(
    ([name, { defaultValue, description }]) => ({
      name,
      defaultValue,
      description,
    }),
  );
  if (values.length === 0) {
    return;
  }
  await db
    .insert(schema.featureFlags)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.featureFlags.name],
      set: {
        defaultValue: sql`excluded.default_value`,
        description: sql`excluded.description`,
      },
    });
}

/**
 * Get a specific feature flag by name
 */
export async function getFeatureFlag({
  db,
  name,
}: {
  db: DB;
  name: FeatureFlagName;
}): Promise<FeatureFlag | undefined> {
  const flag = await db.query.featureFlags.findFirst({
    where: eq(schema.featureFlags.name, name),
  });
  if (!flag) {
    return undefined;
  }
  return dbToFeatureFlag(flag);
}

export async function getFeatureFlagGlobalOverride({
  db,
  name,
}: {
  db: DB;
  name: FeatureFlagName;
}): Promise<boolean> {
  const flag = await getFeatureFlag({ db, name });
  return !!flag?.globalOverride;
}

/**
 * Create or update a global feature flag
 */
export async function upsertFeatureFlag({
  db,
  name,
  updates,
}: {
  db: DB;
  name: string;
  updates: {
    defaultValue?: boolean;
    globalOverride?: boolean | null;
    description?: string | null;
  };
}): Promise<FeatureFlagDB> {
  const result = await db
    .insert(schema.featureFlags)
    .values({
      name,
      defaultValue: updates.defaultValue ?? false,
      globalOverride: updates.globalOverride ?? null,
      description: updates.description ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.featureFlags.name],
      set: {
        defaultValue: updates.defaultValue ?? false,
        globalOverride: updates.globalOverride ?? null,
        description: updates.description ?? null,
      },
    })
    .returning();
  if (!result) {
    throw new Error("Failed to create feature flag");
  }
  return result[0]!;
}

/**
 * Delete a feature flag
 */
export async function deleteFeatureFlag({
  db,
  flagId,
}: {
  db: DB;
  flagId: string;
}): Promise<void> {
  await db
    .delete(schema.featureFlags)
    .where(eq(schema.featureFlags.id, flagId));
}

/**
 * Get user-specific feature flag overrides
 */
export async function getUserFeatureFlagOverrides({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<UserFeatureFlag[]> {
  return await db.query.userFeatureFlags.findMany({
    where: eq(schema.userFeatureFlags.userId, userId),
  });
}

/**
 * Set a user-specific feature flag override
 */
export async function setUserFeatureFlagOverride({
  db,
  userId,
  name,
  value,
}: {
  db: DB;
  userId: string;
  name: string;
  value: boolean;
}): Promise<void> {
  // Ensure the global feature flag exists
  const globalFlag = await getFeatureFlag({
    db,
    name: name as FeatureFlagName,
  });
  if (!globalFlag) {
    throw new Error(`Feature flag "${name}" does not exist`);
  }
  await db
    .insert(schema.userFeatureFlags)
    .values({
      userId,
      featureFlagId: globalFlag.id,
      value,
    })
    .onConflictDoUpdate({
      target: [
        schema.userFeatureFlags.userId,
        schema.userFeatureFlags.featureFlagId,
      ],
      set: { value },
    })
    .returning();
}

/**
 * Remove a user-specific feature flag override
 */
export async function removeUserFeatureFlagOverride({
  db,
  userId,
  name,
}: {
  db: DB;
  userId: string;
  name: string;
}): Promise<void> {
  const globalFlag = await getFeatureFlag({
    db,
    name: name as FeatureFlagName,
  });
  if (!globalFlag) {
    return;
  }
  await db
    .delete(schema.userFeatureFlags)
    .where(
      and(
        eq(schema.userFeatureFlags.userId, userId),
        eq(schema.userFeatureFlags.featureFlagId, globalFlag.id),
      ),
    );
}

export async function getFeatureFlagsGlobal({
  db,
}: {
  db: DB;
}): Promise<Record<FeatureFlagName, boolean>> {
  const flags = await getFeatureFlags({ db });
  const result: Record<string, boolean> = {};
  for (const flag of flags) {
    result[flag.name] = flag.globalOverride ?? flag.defaultValue;
  }
  return result;
}

/**
 * Get all effective feature flags for a user
 * Combines global flags with user overrides
 */
export async function getFeatureFlagsForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<Record<FeatureFlagName, boolean>> {
  const [globalFlags, userOverrides, userSettings] = await Promise.all([
    getFeatureFlags({ db }),
    getUserFeatureFlagOverrides({ db, userId }),
    db.query.userSettings.findFirst({
      where: eq(schema.userSettings.userId, userId),
      columns: { previewFeaturesOptIn: true },
    }),
  ]);
  const userFeatureFlagsByFlagId: Record<string, boolean> = {};
  for (const override of userOverrides) {
    userFeatureFlagsByFlagId[override.featureFlagId] = override.value;
  }
  const result: Record<string, boolean> = {};
  for (const flag of globalFlags) {
    const def = featureFlagsDefinitions[
      flag.name as FeatureFlagName
    ] as FeatureFlagDefinition;
    const previewDefault =
      !!def?.enabledForPreview && !!userSettings?.previewFeaturesOptIn;
    const defaultWithPreview = flag.defaultValue || previewDefault;
    result[flag.name] =
      userFeatureFlagsByFlagId[flag.id] ??
      flag.globalOverride ??
      defaultWithPreview;
  }
  return result;
}

export async function getFeatureFlagForUser({
  db,
  userId,
  flagName,
}: {
  db: DB;
  userId: string;
  flagName: FeatureFlagName;
}): Promise<boolean> {
  const [globalFlag, userOverrides, userSettings] = await Promise.all([
    getFeatureFlag({ db, name: flagName }),
    getUserFeatureFlagOverrides({ db, userId }),
    db.query.userSettings.findFirst({
      where: eq(schema.userSettings.userId, userId),
      columns: { previewFeaturesOptIn: true },
    }),
  ]);
  const userOverride = userOverrides.find(
    (override) => override.featureFlagId === globalFlag?.id,
  )?.value;
  const def = globalFlag
    ? (featureFlagsDefinitions[
        globalFlag.name as FeatureFlagName
      ] as FeatureFlagDefinition)
    : undefined;
  const previewDefault =
    !!def?.enabledForPreview && !!userSettings?.previewFeaturesOptIn;
  const defaultWithPreview =
    (globalFlag?.defaultValue ?? false) || previewDefault;
  return !!(userOverride ?? globalFlag?.globalOverride ?? defaultWithPreview);
}

export async function getUserOverridesForFeatureFlag({
  db,
  flagId,
}: {
  db: DB;
  flagId: string;
}): Promise<
  {
    user: { id: string; name: string; email: string; role: string | null };
    value: boolean;
  }[]
> {
  return await db
    .select({
      user: {
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.user.role,
      },
      value: schema.userFeatureFlags.value,
    })
    .from(schema.userFeatureFlags)
    .where(eq(schema.userFeatureFlags.featureFlagId, flagId))
    .innerJoin(schema.user, eq(schema.userFeatureFlags.userId, schema.user.id))
    .orderBy(
      sql`CASE WHEN ${schema.user.role} = 'admin' THEN 1 ELSE 0 END DESC`,
      asc(schema.user.name),
    );
}

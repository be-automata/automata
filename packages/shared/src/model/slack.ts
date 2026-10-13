import { and, eq, getTableColumns, desc, isNull, or, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DB } from "../db";
import type {
  SlackInstallation,
  SlackInstallationInsert,
  SlackAccount,
  SlackAccountInsert,
  SlackSettingsInsert,
  SlackAccountWithMetadata,
  SlackSettings,
} from "../db/types";
import { publishBroadcastUserMessage } from "../broadcast-server";

export class SlackWorkspaceBoundElsewhereError extends Error {
  constructor(public readonly teamId: string) {
    super(
      `Slack workspace ${teamId} is already installed for another organization`,
    );
    this.name = "SlackWorkspaceBoundElsewhereError";
  }
}

export async function getSlackAccounts({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<SlackAccountWithMetadata[]> {
  const result = await db
    .select({
      ...getTableColumns(schema.slackAccount),
      installation: schema.slackInstallation,
      settings: schema.slackSettings,
    })
    .from(schema.slackAccount)
    .leftJoin(
      schema.slackInstallation,
      eq(schema.slackAccount.teamId, schema.slackInstallation.teamId),
    )
    .leftJoin(
      schema.slackSettings,
      and(
        eq(schema.slackAccount.userId, schema.slackSettings.userId),
        eq(schema.slackAccount.teamId, schema.slackSettings.teamId),
      ),
    )
    .where(eq(schema.slackAccount.userId, userId));
  return result;
}

export async function getSlackAccountForSlackUserId({
  db,
  teamId,
  slackUserId,
}: {
  db: DB;
  teamId: string;
  slackUserId: string;
}): Promise<SlackAccount | null> {
  const result = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.slackUserId, slackUserId),
      eq(schema.slackAccount.teamId, teamId),
    ),
  });
  return result || null;
}

export async function getSlackAccountForTeam({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}): Promise<SlackAccount | null> {
  const result = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.userId, userId),
      eq(schema.slackAccount.teamId, teamId),
    ),
  });
  return result || null;
}

export async function getSlackSettingsForTeam({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}): Promise<SlackSettings | null> {
  const result = await db.query.slackSettings.findFirst({
    where: and(
      eq(schema.slackSettings.userId, userId),
      eq(schema.slackSettings.teamId, teamId),
    ),
  });
  return result || null;
}

export async function upsertSlackAccount({
  db,
  userId,
  teamId,
  account,
}: {
  db: DB;
  userId: string;
  teamId: string;
  account: Omit<SlackAccountInsert, "userId" | "teamId">;
}) {
  await db
    .insert(schema.slackAccount)
    .values({
      ...account,
      userId,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackAccount.userId, schema.slackAccount.teamId],
      set: {
        ...account,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function deleteSlackAccount({
  db,
  userId,
  teamId,
}: {
  db: DB;
  userId: string;
  teamId: string;
}) {
  await db
    .delete(schema.slackAccount)
    .where(
      and(
        eq(schema.slackAccount.userId, userId),
        eq(schema.slackAccount.teamId, teamId),
      ),
    );
}

export async function getSlackInstallationForTeam({
  db,
  teamId,
}: {
  db: DB;
  teamId: string;
}): Promise<SlackInstallation | null> {
  const installation = await db.query.slackInstallation.findFirst({
    where: eq(schema.slackInstallation.teamId, teamId),
  });
  return installation || null;
}

export async function upsertSlackInstallation({
  db,
  userId,
  teamId,
  installation,
}: {
  db: DB;
  userId: string;
  teamId: string;
  installation: Omit<SlackInstallationInsert, "teamId">;
}) {
  // Make sure the user is part of this team
  const account = await getSlackAccountForTeam({ db, userId, teamId });
  if (!account) {
    throw new Error("User is not part of this team");
  }
  // A workspace belongs to one org (teamId is unique). Reinstalling may bind
  // an unbound workspace or refresh the same org's install, but never move a
  // workspace another org already holds.
  const rows = await db
    .insert(schema.slackInstallation)
    .values({
      ...installation,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackInstallation.teamId],
      set: {
        ...installation,
        updatedAt: new Date(),
      },
      setWhere: or(
        isNull(schema.slackInstallation.organizationId),
        eq(
          schema.slackInstallation.organizationId,
          sql.raw(`excluded."organization_id"`),
        ),
      ),
    })
    .returning({ id: schema.slackInstallation.id });
  if (rows.length === 0) {
    throw new SlackWorkspaceBoundElsewhereError(teamId);
  }
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function upsertSlackSettings({
  db,
  userId,
  teamId,
  settings,
}: {
  db: DB;
  userId: string;
  teamId: string;
  settings: Omit<SlackSettingsInsert, "userId" | "teamId">;
}) {
  await db
    .insert(schema.slackSettings)
    .values({
      ...settings,
      userId,
      teamId,
    })
    .onConflictDoUpdate({
      target: [schema.slackSettings.userId, schema.slackSettings.teamId],
      set: {
        ...settings,
        updatedAt: new Date(),
      },
    });
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: { slack: true },
  });
}

export async function getSlackAccountAndInstallationForWorkspace({
  db,
  userId,
  workspaceDomain,
}: {
  db: DB;
  userId: string;
  workspaceDomain: string;
}): Promise<{
  slackAccount: SlackAccount | null;
  slackInstallation: SlackInstallation | null;
}> {
  const slackAccount = await db.query.slackAccount.findFirst({
    where: and(
      eq(schema.slackAccount.userId, userId),
      eq(schema.slackAccount.slackTeamDomain, workspaceDomain),
    ),
  });
  if (!slackAccount) {
    return { slackAccount: null, slackInstallation: null };
  }
  const slackInstallation = await getSlackInstallationForTeam({
    db,
    teamId: slackAccount.teamId,
  });
  return { slackAccount, slackInstallation: slackInstallation || null };
}

export async function getSlackInstallationsForAdmin({
  db,
}: {
  db: DB;
}): Promise<SlackInstallation[]> {
  return await db.query.slackInstallation.findMany({
    orderBy: desc(schema.slackInstallation.createdAt),
  });
}

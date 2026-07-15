import { ThreadVisibility } from "../db/types";
import { DB } from "../db";
import * as schema from "../db/schema";
import { and, eq } from "drizzle-orm";

export async function updateThreadVisibility({
  db,
  userId,
  threadId,
  visibility,
  organizationId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  visibility: ThreadVisibility;
  // Tenant fence (WI-5). Optional during the nullable phase; the forTenant
  // accessor always supplies it. drizzle's and() drops undefined.
  organizationId?: string | null;
}) {
  // Make sure the user is the owner of the thread (within the org, when scoped)
  const thread = await db.query.thread.findFirst({
    where: and(
      eq(schema.thread.id, threadId),
      eq(schema.thread.userId, userId),
      organizationId
        ? eq(schema.thread.organizationId, organizationId)
        : undefined,
    ),
    columns: {
      userId: true,
      organizationId: true,
    },
  });
  if (!thread) {
    throw new Error("Thread not found");
  }
  await db
    .insert(schema.threadVisibility)
    .values({
      threadId,
      visibility,
      // The visibility row inherits its thread's tenant (unambiguous).
      organizationId: thread.organizationId,
    })
    .onConflictDoUpdate({
      target: [schema.threadVisibility.threadId],
      set: {
        visibility,
        organizationId: thread.organizationId,
        updatedAt: new Date(),
      },
    });
}

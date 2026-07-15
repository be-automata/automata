"use server";

import { updateThreadVisibility } from "@terragon/shared/model/thread-visibility";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ThreadVisibility } from "@terragon/shared/db/types";

export const updateThreadVisibilityAction = userOnlyAction(
  async function updateThreadVisibilityAction(
    userId: string,
    {
      threadId,
      visibility,
    }: {
      threadId: string;
      visibility: ThreadVisibility;
    },
  ) {
    const tenant = await getTenantContextOrNull();
    await updateThreadVisibility({
      db,
      userId,
      threadId,
      visibility,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to update task visibility" },
);

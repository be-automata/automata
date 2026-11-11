import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import type { Session, User } from "@terragon/shared";
import {
  getUserSettings,
  updateUserSettings,
} from "@terragon/shared/model/user";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { unwrapResult } from "@/lib/server-actions";
import { updateUserSettingsAction } from "./user-settings";

describe("updateUserSettingsAction: the sandbox provider is not a setting", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
  });

  it("drops a client-sent sandboxProvider and still applies the other fields", async () => {
    await mockLoggedInUser(session);
    unwrapResult(
      await updateUserSettingsAction({
        prType: "ready",
        // A stale client or a hand-crafted call: the type no longer allows it.
        ...({ sandboxProvider: "daytona" } as object),
      }),
    );
    const settings = await getUserSettings({ db, userId: user.id });
    expect(settings.prType).toBe("ready");
    expect(settings.sandboxProvider).toBe("default");
  });

  it("leaves a stored legacy value untouched (column kept for existing rows)", async () => {
    await updateUserSettings({
      db,
      userId: user.id,
      updates: { sandboxProvider: "e2b" },
    });
    await mockLoggedInUser(session);
    unwrapResult(
      await updateUserSettingsAction({
        ...({ sandboxProvider: "daytona" } as object),
      }),
    );
    const settings = await getUserSettings({ db, userId: user.id });
    expect(settings.sandboxProvider).toBe("e2b");
  });
});

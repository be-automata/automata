import { describe, it, vi, beforeEach, beforeAll, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import {
  thread as threadTable,
  session as sessionTable,
  apikey as apikeyTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User, Session } from "@terragon/shared";

// The global test-setup mocks @/agent/daemon; import the REAL module here so we
// exercise the actual mint. Only the sandbox I/O is stubbed.
vi.mock("./sandbox-resource", () => ({ setActiveThreadChat: vi.fn() }));
vi.mock("@terragon/sandbox/daemon", () => ({ sendMessage: vi.fn() }));

let sendDaemonMessage: typeof import("./daemon").sendDaemonMessage;

beforeAll(async () => {
  ({ sendDaemonMessage } = await vi.importActual<typeof import("./daemon")>(
    "./daemon",
  ));
});

function slug() {
  return `org-${nanoid(8).toLowerCase()}`;
}

async function createOrg(userId: string) {
  const org = await createOrganization({ db, name: "Org", slug: slug() });
  await addOrganizationMember({ db, organizationId: org.id, userId });
  return org.id;
}

/** Read the organizationId persisted in the minted key's metadata. */
async function mintedOrgId(sandboxId: string): Promise<string | null> {
  const [row] = await db
    .select({ metadata: apikeyTable.metadata })
    .from(apikeyTable)
    .where(eq(apikeyTable.name, sandboxId))
    .limit(1);
  if (!row?.metadata) return null;
  // better-auth persists metadata double-JSON-encoded (a JSON string whose
  // content is the stringified object), so parse until we get an object.
  let parsed: unknown = JSON.parse(row.metadata);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  return (parsed as { organizationId?: string }).organizationId ?? null;
}

describe("sendDaemonMessage — proxy token org derivation (WI-5)", () => {
  let user: User;
  let session: Session;
  let orgX: string;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    orgX = await createOrg(user.id);

    const t = await createTestThread({ db, userId: user.id });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    await db
      .update(threadTable)
      .set({ organizationId: orgX })
      .where(eq(threadTable.id, threadId));
  });

  async function invoke(sandboxId: string) {
    await sendDaemonMessage({
      message: { type: "stop" } as never,
      userId: user.id,
      threadId,
      threadChatId,
      sandboxId,
      session: {} as never,
    });
  }

  it("stamps the thread's org into the minted proxy-token metadata", async () => {
    const sandboxId = `sbx-${nanoid(8)}`;
    await invoke(sandboxId);
    expect(await mintedOrgId(sandboxId)).toBe(orgX);
  });

  it("carries the THREAD's org even when the user's active org differs (no-drift pin)", async () => {
    // Give the user a DIFFERENT active org. daemon.ts reads no session, so the
    // token must still carry the thread's org — this pins the temporal
    // decoupling so a refactor can't silently reintroduce session drift.
    const orgY = await createOrg(user.id);
    expect(orgY).not.toBe(orgX);
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgY })
      .where(eq(sessionTable.id, session.id));

    const sandboxId = `sbx-${nanoid(8)}`;
    await invoke(sandboxId);

    const minted = await mintedOrgId(sandboxId);
    expect(minted).toBe(orgX);
    expect(minted).not.toBe(orgY);
  });
});

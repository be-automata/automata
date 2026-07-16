import { describe, it, vi, beforeEach, expect } from "vitest";
import { createMirrorTask } from "./mirror-intake";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { nanoid } from "nanoid";

// Kill-switch OFF: forces shadow for ALL GitHub processing regardless of the
// per-installation mode. Mock the helper so this file exercises the switch-off
// branch without touching the deployment env (the real folding logic is unit-
// tested in lib/github-side-effects.test.ts).
vi.mock("@/lib/github-side-effects", () => ({
  githubSideEffectsEnabled: () => false,
  effectiveShadow: () => true,
}));

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi
    .fn()
    .mockResolvedValue({ threadId: "t", threadChatId: "c" }),
}));

describe("mirror-intake with side-effects kill-switch OFF", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an ACTIVE-bound installation still creates a shadow task (no boot, no side effects)", async () => {
    const { user } = await createTestUser({ db });
    const org = await createOrganization({
      db,
      name: "Live Org",
      slug: `live-${nanoid(8).toLowerCase()}`,
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
    });
    const installationId = Math.floor(Math.random() * 1_000_000_000);
    // Bound ACTIVE — yet the deployment kill-switch must still force shadow.
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: org.id,
      mode: "active",
    });

    await createMirrorTask({
      repoFullName: "be-automata/automata",
      installationId,
      intent: { kind: "pr-merged", prNumber: 3, baseBranch: "main" },
    });

    const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
    expect(args.organizationId).toBe(org.id);
    expect(args.shadow).toBe(true);
  });
});

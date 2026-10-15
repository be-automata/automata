import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The seeded two-org world. Fixed ids so specs and GitHub fixtures agree;
 * e2e/.state/world.json carries the run-specific parts (database URL, files).
 *
 * - U owns E2E Alpha and E2E Beta (team orgs) plus a personal org; the cue
 *   watcher is a second owner of Alpha and Beta.
 * - N is not a member of any of U's orgs and owns E2E Gamma.
 * - GitHub: installation 9001 (account e2e-alpha-gh) is bound to Alpha and
 *   9002 (account e2e-beta-gh) to Beta; U's token sees both.
 */
export const WORLD = {
  users: {
    owner: {
      id: "e2e-user-owner",
      name: "E2E Owner",
      email: "owner@e2e.invalid",
    },
    /**
     * Same memberships and GitHub view as the owner, used only by the
     * runs-in-cue spec: the server caches GitHub listings per user (Redis,
     * 120 s), so a user no earlier spec touched is the only way to observe
     * the loading window.
     */
    cueWatcher: {
      id: "e2e-user-cue",
      name: "E2E Cue Watcher",
      email: "cue@e2e.invalid",
    },
    outsider: {
      id: "e2e-user-outsider",
      name: "E2E Outsider",
      email: "outsider@e2e.invalid",
    },
  },
  orgs: {
    personal: {
      id: "e2e-org-personal",
      name: "E2E Personal",
      slug: "e2e-personal",
      isPersonal: true,
    },
    alpha: {
      id: "e2e-org-alpha",
      name: "E2E Alpha",
      slug: "e2e-alpha",
      isPersonal: false,
    },
    beta: {
      id: "e2e-org-beta",
      name: "E2E Beta",
      slug: "e2e-beta",
      isPersonal: false,
    },
    gamma: {
      id: "e2e-org-gamma",
      name: "E2E Gamma",
      slug: "e2e-gamma",
      isPersonal: false,
    },
  },
  github: {
    alphaInstallationId: "9001",
    betaInstallationId: "9002",
    alphaRepo: "e2e-alpha-gh/alpha-api",
    betaRepo: "e2e-beta-gh/beta-api",
  },
  slack: {
    teamId: "T0E2E0001",
    teamName: "E2E Workspace",
  },
  environments: {
    /** Repo environment in Beta behind the effective-configuration spec. */
    effectiveRepo: "e2e-beta-gh/beta-web",
  },
} as const;

/** What e2e/run.ts writes after seeding, for specs to read. */
export interface WorldState {
  databaseUrl: string;
  controlFile: string;
  egressLog: string;
  effectiveEnvironmentId: string;
  /** Plaintext of every seeded secret, to prove none reaches the browser. */
  seededSecretValues: {
    global: string[];
    organization: string[];
    repository: string[];
  };
}

export const E2E_DIR = path.resolve(__dirname, "..");
export const STATE_DIR = path.join(E2E_DIR, ".state");
export const AUTH_DIR = path.join(E2E_DIR, ".auth");
export const WORLD_STATE_FILE = path.join(STATE_DIR, "world.json");

export function readWorldState(): WorldState {
  return JSON.parse(readFileSync(WORLD_STATE_FILE, "utf8")) as WorldState;
}

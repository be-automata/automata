import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { controlEffects } from "../db/schema";
import { effectKey } from "./control-effects";
import { createTestOrg } from "./test-helpers";

// Non-null: set by the shared globalSetup.
const db = createDb(env.DATABASE_URL!);
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CHILD = "src/model/__fixtures__/control-effects-crash-child.ts";
const SPAWN_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

type KillPoint = "before-apply" | "after-apply";

interface Delivery {
  killed: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Scenario {
  dir: string;
  organizationId: string;
  mission: string;
}

const dirs: string[] = [];
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

async function newScenario(): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), "control-effects-"));
  dirs.push(dir);
  const organizationId = await createTestOrg({ db });
  return { dir, organizationId, mission: `run-${randomUUID()}` };
}

/** Spawn the child once; SIGKILL (or exit 137) counts as "killed, redeliver". */
function deliver(
  s: Scenario,
  opts: { digest?: string; killPoint?: KillPoint; noReconcile?: boolean } = {},
): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], {
      cwd: PACKAGE_DIR,
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        // Non-null: set by the shared globalSetup.
        DATABASE_URL: env.DATABASE_URL!,
        CRASH_DIR: s.dir,
        ORG_ID: s.organizationId,
        MISSION: s.mission,
        OUTPUT_DIGEST: opts.digest ?? "d1",
        KILL_POINT: opts.killPoint ?? "",
        NO_RECONCILE: opts.noReconcile ? "1" : "",
      },
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      children.delete(child);
      resolve({
        killed: signal === "SIGKILL" || code === 137,
        code,
        stdout,
        stderr,
      });
    });
  });
}

function outcomeOf(d: Delivery): string {
  if (d.code !== 0) throw new Error(`child failed: ${d.stderr}`);
  return (JSON.parse(d.stdout) as { outcome: string }).outcome;
}

const markerCount = (s: Scenario) => readdirSync(s.dir).length;

async function readRow(s: Scenario) {
  const key = effectKey({
    mission: s.mission,
    step: "summary",
    effect: "post",
    outputDigest: "d1",
  });
  const rows = await db
    .select()
    .from(controlEffects)
    .where(eq(controlEffects.key, key));
  return rows[0];
}

/** One delivery killed at `killPoint`, leaving `markers` files behind. */
async function crashAt(s: Scenario, killPoint: KillPoint, markers: number) {
  const d = await deliver(s, { killPoint });
  expect(d.killed, d.stderr).toBe(true);
  expect(d.stderr).toContain(`killing at ${killPoint}`);
  expect(markerCount(s)).toBe(markers);
}

describe("control effects crash drill (#652, SIGKILL at the boundaries)", () => {
  it(
    "AC1: killed after the intent, before the upload: uploaded exactly once after the restart",
    async () => {
      const s = await newScenario();
      await crashAt(s, "before-apply", 0);
      expect((await readRow(s))?.doneAt).toBeNull();
      expect(outcomeOf(await deliver(s))).toBe("applied");
      expect(markerCount(s)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC2: killed after the upload, before effect_done: reconciled by marker, nothing uploaded again",
    async () => {
      const s = await newScenario();
      await crashAt(s, "after-apply", 1);
      expect((await readRow(s))?.doneAt).toBeNull();
      expect(outcomeOf(await deliver(s))).toBe("reconciled");
      expect(markerCount(s)).toBe(1);
      const row = await readRow(s);
      expect(row?.reconciled).toBe(true);
      expect(row?.doneAt).toBeInstanceOf(Date);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC5: with reconcile disabled the same crash uploads a second copy",
    async () => {
      const s = await newScenario();
      await crashAt(s, "after-apply", 1);
      expect(outcomeOf(await deliver(s, { noReconcile: true }))).toBe(
        "applied",
      );
      expect(markerCount(s)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC3: two clean deliveries of the same output leave one file",
    async () => {
      const s = await newScenario();
      expect(outcomeOf(await deliver(s))).toBe("applied");
      expect(outcomeOf(await deliver(s))).toBe("already_done");
      expect(markerCount(s)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC4: a changed output digest produces a second effect",
    async () => {
      const s = await newScenario();
      expect(outcomeOf(await deliver(s, { digest: "d1" }))).toBe("applied");
      expect(outcomeOf(await deliver(s, { digest: "d2" }))).toBe("applied");
      expect(markerCount(s)).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

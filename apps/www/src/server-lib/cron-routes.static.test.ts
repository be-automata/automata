import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = join(HERE, "../..");

// On Workers, scheduled() in worker-entry.ts fetches one route per cron pattern.
// runScheduledCron composes the self-heal stage onto the hourly and 10-minute
// runners, so those routes must call it; a route that calls the base runner alone
// silently skips self-heal in production (the dispatcher and the backstops never run).
const SELF_HEAL_PATTERNS = ["0 * * * *", "*/10 * * * *"];

function cronToPath(): Record<string, string> {
  const source = readFileSync(join(WWW, "worker-entry.ts"), "utf8");
  const block = /CRON_TO_PATH[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
}

describe("Workers cron routes reach the self-heal stage", () => {
  const mapping = cronToPath();

  it("worker-entry maps every self-heal cron pattern to a route", () => {
    for (const pattern of SELF_HEAL_PATTERNS) {
      expect(mapping[pattern], pattern).toMatch(/^\/api\/internal\/cron\//);
    }
  });

  it.each(SELF_HEAL_PATTERNS)(
    "the route for %s runs runScheduledCron with that pattern",
    (pattern) => {
      const route = mapping[pattern] ?? "";
      const file = join(WWW, "src/app", route, "route.ts");
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`runScheduledCron(${JSON.stringify(pattern)})`);
    },
  );
});

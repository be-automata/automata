/**
 * Create a tenant on this box's engine and mint an API token scoped to it
 * (#374 part B). Run as root on the box, over ssh — never through the tunnel:
 *
 *   pnpm -s --filter @terragon/worker provision:tenant --name <name> --slug <slug> \
 *     [--token-name www] [--expires-in 8760h]
 *   pnpm -s --filter @terragon/worker provision:tenant --tenant-id <uuid> --token-name <name> \
 *     [--expires-in 8760h]          # mint only, into an existing tenant (#375 worker tokens)
 *
 * (`-s`: without it pnpm prints its own script header on stdout, ahead of the JSON.)
 *
 * Env: HATCHET_ENGINE_URL (default http://127.0.0.1:8888, loopback only),
 * HATCHET_ADMIN_EMAIL (default ops@beautomata.com), HATCHET_ADMIN_PASS_FILE
 * (default /root/.automata/hatchet-admin.pass, owner-only), HATCHET_ENGINE_CONTAINER
 * (default automata-hatchet-hatchet-lite-1).
 *
 * Stdout: exactly one JSON line {"tenantId":…,"token":…,"expiresAt":…} — pipe it, never paste it
 * into a log. Progress goes to stderr and never carries the token.
 *
 * Exit: 0 provisioned; 1 refused or failed; 2 usage.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ProvisionError,
  provisionTenant,
  tokenCreateArgv,
} from "../src/provision/hatchet-tenant";
import type { ProvisionOptions } from "../src/provision/hatchet-tenant";

const execFileAsync = promisify(execFile);

function usage(message: string): never {
  console.error(`provision:tenant: ${message}`);
  console.error(
    "usage: provision:tenant (--name <n> --slug <s> | --tenant-id <uuid>) [--token-name <n>] [--expires-in <hours>h]",
  );
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${name} needs a value`);
  return v;
}

const name = flag("--name");
const slug = flag("--slug");
const tenantId = flag("--tenant-id");

let tenant: ProvisionOptions["tenant"];
if (tenantId !== undefined) {
  if (name !== undefined || slug !== undefined) {
    usage("--tenant-id mints into an existing tenant; drop --name/--slug");
  }
  tenant = { tenantId };
} else {
  if (name === undefined || slug === undefined) {
    usage("--name and --slug are both required to create a tenant");
  }
  tenant = { name, slug };
}

const container =
  process.env.HATCHET_ENGINE_CONTAINER ?? "automata-hatchet-hatchet-lite-1";
const uid = process.getuid?.();
if (uid === undefined) usage("needs a POSIX host (process.getuid)");

try {
  const result = await provisionTenant(
    {
      apiUrl: process.env.HATCHET_ENGINE_URL ?? "http://127.0.0.1:8888",
      adminEmail: process.env.HATCHET_ADMIN_EMAIL ?? "ops@beautomata.com",
      passwordFile:
        process.env.HATCHET_ADMIN_PASS_FILE ??
        "/root/.automata/hatchet-admin.pass",
      tokenName: flag("--token-name") ?? "www",
      expiresIn: flag("--expires-in") ?? "8760h",
      tenant,
    },
    {
      fetch,
      uid,
      now: () => new Date(),
      runAdmin: async (adminArgs) => {
        const argv = tokenCreateArgv({ container, adminArgs });
        const { stdout } = await execFileAsync("docker", argv);
        return stdout;
      },
    },
  );
  console.error(
    `provision:tenant: tenant ${result.tenantId} ready; token minted, expires ${result.expiresAt}`,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (e) {
  // execFile's error text carries the argv and stderr, never stdout (the token).
  const message = e instanceof Error ? e.message : String(e);
  console.error(
    `provision:tenant: ${e instanceof ProvisionError ? "refused" : "failed"}: ${message}`,
  );
  process.exit(1);
}

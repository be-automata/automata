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
 * Env: HATCHET_ENGINE_URL (default http://127.0.0.1:8888; 127.0.0.1 or [::1] only),
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
import { parseArgs, promisify } from "node:util";

import {
  ProvisionError,
  describeAdminFailure,
  provisionTenant,
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

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      "tenant-id": { type: "string" },
      "token-name": { type: "string" },
      "expires-in": { type: "string" },
    },
  }));
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
const { name, slug, "tenant-id": tenantId } = values;

let tenant: ProvisionOptions["tenant"];
if (tenantId !== undefined) {
  if (name !== undefined || slug !== undefined) {
    usage("--tenant-id mints into an existing tenant; drop --name/--slug");
  }
  // A second token in a tenant is a worker's or a box's: name it, never default it to www.
  if (values["token-name"] === undefined) {
    usage("--tenant-id needs --token-name");
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
      // An empty value is as unusable as an unset one.
      adminEmail: process.env.HATCHET_ADMIN_EMAIL || "ops@beautomata.com",
      passwordFile:
        process.env.HATCHET_ADMIN_PASS_FILE ??
        "/root/.automata/hatchet-admin.pass",
      tokenName: values["token-name"] ?? "www",
      expiresIn: values["expires-in"] ?? "8760h",
      tenant,
    },
    {
      fetch,
      uid,
      now: () => new Date(),
      onTenantCreated: (id) =>
        console.error(`provision:tenant: tenant ${id} created; minting`),
      runAdmin: async (adminArgs) => {
        try {
          const { stdout } = await execFileAsync(
            "docker",
            ["exec", container, ...adminArgs],
            {
              timeout: 60_000,
              maxBuffer: 64 * 1024,
            },
          );
          return stdout;
        } catch (e) {
          throw describeAdminFailure(e);
        }
      },
    },
  );
  console.error(
    `provision:tenant: tenant ${result.tenantId} ready; token minted, expires ${result.expiresAt}`,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(
    `provision:tenant: ${e instanceof ProvisionError ? "refused" : "failed"}: ${message}`,
  );
  process.exit(1);
}

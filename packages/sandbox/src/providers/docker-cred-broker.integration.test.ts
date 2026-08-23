import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CRED_BROKER_ALIAS,
  CRED_BROKER_GIT_PORT,
  buildCredBrokerSecretsFileContent,
  buildCredBrokerSidecarRunCommand,
  buildGuestCredBrokerGitConfig,
} from "./docker-cred-broker";
import { CRED_BROKER_SCRIPT } from "../cred-broker-standalone.generated";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BASE_IMAGE = "ghcr.io/terragon-labs/containers-test";

// Opt-in (like the provider suites): needs a docker daemon + the test base
// image. Run with:
//   SANDBOX_PROVIDER=docker pnpm -C packages/sandbox vitest docker-cred-broker.integration
//
// This slice is UNWIRED — docker-provider.ts does not stand up a cred-broker
// sidecar. So, unlike docker-egress.integration.test.ts (which drives the
// provider), this test exercises the MECHANISM directly: it stands up the
// sidecar from the pure builders on an internal network, has a guest container
// reach it, git ls-remote / push through it with ONLY a per-run bearer, and
// asserts the installation token is ABSENT from the guest.
describe(
  "docker cred-broker sidecar mechanism (integration)",
  { skip: process.env.SANDBOX_PROVIDER !== "docker", timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS });

    // The broker ALWAYS injects the credential server-side; GitHub 401s on an
    // invalid token (it does not fall back to anonymous when creds are
    // present). So the "reaches github" assertion needs a REAL token to inject
    // — sourced from GITHUB_TOKEN / GH_TOKEN / `gh auth token`. When absent,
    // that single test is skipped; every fence/absence assertion still runs
    // with the sentinel below. Whatever token is injected, we assert it is
    // ABSENT from the guest — that is the whole point of the broker.
    const realToken = (() => {
      const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (fromEnv) return fromEnv;
      try {
        return execSync("gh auth token", { encoding: "utf8" }).trim() || null;
      } catch {
        return null;
      }
    })();
    const SENTINEL_TOKEN = `ghs_sentinel_${randomBytes(8).toString("hex")}`;
    const INJECTED_TOKEN = realToken ?? SENTINEL_TOKEN;
    const RUN_BEARER = randomBytes(32).toString("hex");
    const REPO = "octocat/Hello-World";

    const id = randomBytes(4).toString("hex");
    const networkName = `automata-cred-broker-test-${id}`;
    const sidecarName = `terragon-sandbox-test-cred-broker-${id}`;
    const guestName = `terragon-sandbox-test-guest-${id}`;
    let tmp: string;

    const sh = (cmd: string, opts: { allowFail?: boolean } = {}) => {
      try {
        return execSync(cmd, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        if (opts.allowFail) return "";
        throw err;
      }
    };

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "cred-broker-it-"));
      const scriptHostPath = join(tmp, "cred-broker.cjs");
      const secretsHostPath = join(tmp, "secrets.json");
      writeFileSync(scriptHostPath, CRED_BROKER_SCRIPT, { mode: 0o444 });
      writeFileSync(
        secretsHostPath,
        buildCredBrokerSecretsFileContent({
          installationToken: INJECTED_TOKEN,
          runBearer: RUN_BEARER,
        }),
        { mode: 0o400 },
      );

      // Internal (no route out) network for the guest ↔ sidecar hop.
      sh(`docker network create --internal ${networkName}`);
      // Sidecar on the internal network under the alias.
      sh(
        buildCredBrokerSidecarRunCommand({
          sidecarName,
          networkName,
          baseImage: BASE_IMAGE,
          scriptHostPath,
          secretsHostPath,
          repoFullName: REPO,
        }),
      );
      // Only the sidecar reaches github.com (attach it to the default bridge).
      sh(`docker network connect bridge ${sidecarName}`);
      // Guest: internal network only, no route out except via the broker.
      sh(
        `docker run -d --name ${guestName} --network ${networkName} ` +
          `-e GH_TOKEN=${RUN_BEARER} -e GITHUB_TOKEN=${RUN_BEARER} ` +
          `${BASE_IMAGE} tail -f /dev/null`,
      );

      // Readiness barrier: wait for the sidecar's git listener to accept.
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline) {
        const probe = sh(
          `docker exec ${guestName} bash -lc ` +
            `"timeout 2 bash -c '</dev/tcp/${CRED_BROKER_ALIAS}/${CRED_BROKER_GIT_PORT}' && echo READY || echo WAIT"`,
          { allowFail: true },
        );
        if (probe.includes("READY")) {
          ready = true;
          break;
        }
        execSync("sleep 1");
      }
      expect(ready, "cred-broker sidecar never bound its listener").toBe(true);

      // Wire the guest's git through the broker (bearer only, no token).
      const gitConfig = buildGuestCredBrokerGitConfig({
        alias: CRED_BROKER_ALIAS,
        port: CRED_BROKER_GIT_PORT,
        bearer: RUN_BEARER,
      }).join(" && ");
      sh(`docker exec ${guestName} bash -lc ${JSON.stringify(gitConfig)}`);
    }, TIMEOUT_MS);

    afterAll(() => {
      sh(`docker rm -f ${guestName}`, { allowFail: true });
      sh(`docker rm -f ${sidecarName}`, { allowFail: true });
      sh(`docker network rm ${networkName}`, { allowFail: true });
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it.skipIf(!realToken)(
      "guest reaches github.com through the broker with only a bearer",
      () => {
        const out = sh(
          `docker exec ${guestName} bash -lc ` +
            `"git ls-remote https://github.com/${REPO}.git HEAD"`,
        );
        expect(out).toContain("HEAD");
      },
    );

    it("the installation token is ABSENT from the guest (env, git-credentials, config)", () => {
      // No ~/.git-credentials written in brokered mode.
      const creds = sh(
        `docker exec ${guestName} bash -lc "cat ~/.git-credentials 2>&1 || true"`,
        { allowFail: true },
      );
      expect(creds).not.toContain(INJECTED_TOKEN);
      expect(creds).not.toContain("x-access-token");

      // Guest env carries only the bearer, never the injected token. Single
      // quotes so $GH_TOKEN expands INSIDE the guest, not on the host shell.
      const env = sh(`docker exec ${guestName} bash -lc 'echo $GH_TOKEN'`);
      expect(env.trim()).toBe(RUN_BEARER);
      const allEnv = sh(`docker exec ${guestName} env`);
      expect(allEnv).not.toContain(INJECTED_TOKEN);

      // Git config carries only the Bearer, never the injected Basic auth.
      const config = sh(
        `docker exec ${guestName} bash -lc "git config --global --list"`,
      );
      expect(config).toContain(`Authorization: Bearer ${RUN_BEARER}`);
      expect(config).not.toContain(INJECTED_TOKEN);
      expect(config).not.toContain("x-access-token");
    });

    it("the token is NOT visible via docker inspect of the sidecar (.Config.Env)", () => {
      const inspected = sh(
        `docker inspect --format '{{json .Config.Env}}' ${sidecarName}`,
      );
      expect(inspected).not.toContain(INJECTED_TOKEN);
      expect(inspected).not.toContain(RUN_BEARER);
    });

    it("has no direct route out from the guest (internal network) except via the broker", () => {
      // A host NOT rewritten to the broker (gitlab.com) has no path out on the
      // internal network — the guest cannot reach the internet directly, only
      // github.com via the broker alias.
      let threw = false;
      try {
        sh(
          `docker exec ${guestName} bash -lc ` +
            `"git ls-remote https://gitlab.com/gitlab-org/gitlab.git HEAD"`,
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("a wrong bearer is rejected (401) by the broker fence", () => {
      // Point a throwaway git config at the broker with a bad bearer.
      const badConfig = [
        `git config --global url.'http://${CRED_BROKER_ALIAS}:${CRED_BROKER_GIT_PORT}/'.insteadOf https://github.com/`,
        `git config --global http.'http://${CRED_BROKER_ALIAS}:${CRED_BROKER_GIT_PORT}/'.extraheader 'Authorization: Bearer WRONG-BEARER'`,
      ].join(" && ");
      let threw = false;
      try {
        sh(
          `docker exec ${guestName} bash -lc ${JSON.stringify(
            `${badConfig} && git ls-remote https://github.com/${REPO}.git HEAD`,
          )}`,
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  },
);

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const UP_SH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../opensandbox-it/up.sh",
);

function readUpScript(): string {
  return readFileSync(UP_SH, "utf8");
}

function extractFunction(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = script.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`function ${name} is not closed`);
  return script.slice(start, end + 2);
}

describe("opensandbox-it/up.sh", () => {
  const script = readUpScript();
  const body = extractFunction(script, "run_dind");

  it("run_dind carries only the allowed outer-run flags", () => {
    expect(body).toContain("--privileged");
    expect(body).toContain("--name osbit-dind");
    expect(body).toContain("--label osbit=1");
    expect(body).toContain("-p 127.0.0.1:18091:8090");
    expect(body).toContain("-e DOCKER_TLS_CERTDIR=");
  });

  it("run_dind has no host mount, host socket or env passthrough", () => {
    expect(body).not.toMatch(/(^|\s)-v(\s|=)/);
    expect(body).not.toMatch(/--volume/);
    expect(body).not.toMatch(/--mount/);
    expect(body).not.toMatch(/--env-file/);
    expect(body).not.toContain("docker.sock:");
    // Every -e must carry an explicit value (NAME=value), never a bare NAME.
    for (const match of body.matchAll(/(?:^|\s)-e\s+(\S+)/g)) {
      expect(match[1]).toMatch(/^[A-Z_]+=/);
    }
  });

  it("never enables shell tracing", () => {
    expect(script).not.toMatch(/set\s+-[a-z]*x/);
    expect(script).not.toMatch(/set\s+.*-o\s+xtrace/);
  });

  it("generates the key under umask 077 and never echoes it", () => {
    expect(script).toMatch(/umask 077/);
    expect(script).not.toMatch(/echo[^\n]*\$KEY/);
  });
});

import { describe, expect, it } from "vitest";

import { matchEgress } from "@terragon/worker/agent-run/egress-proxy";

import {
  compileCellEgress,
  toAgent37Network,
  toProxyShape,
} from "./cell-egress";
import { BROKER, CATALOG } from "./cell-egress.fixtures";

// AC5: the worker proxy and the cell plane (Agent37) must agree on every probe.

const SET = compileCellEgress(["test/npm@1", "test/wild@1"], {
  brokerHost: BROKER,
  catalog: CATALOG,
});

/**
 * Test-local model of Agent37's documented `{allow}` semantics: SNI on 443
 * only, `*.x` covers the apex, exact otherwise, an IP never matches a name,
 * lowercase, one trailing dot stripped. Not a live call.
 */
function agent37Decide(
  allow: readonly string[],
  host: string,
  port: number | null,
): boolean {
  if (port !== 443) return false;
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0 || /^[0-9.]+$/.test(h)) return false;
  return allow.some((entry) =>
    entry.startsWith("*.")
      ? h === entry.slice(2) || h.endsWith(entry.slice(1))
      : h === entry,
  );
}

const PROBES: [number, string, number | null, boolean][] = [
  [1, BROKER, 443, true],
  [2, BROKER, 80, false],
  [3, "api.anthropic.com", 443, true],
  [4, "registry.npmjs.org", 443, true],
  [5, "registry.npmjs.org", 80, false],
  [6, "example.org", 443, true],
  [7, "a.example.org", 443, true],
  [8, "a.b.example.org", 443, true],
  [9, "badexample.org", 443, false],
  [10, "example.org", 8443, false],
  [11, "REGISTRY.NPMJS.ORG.", 443, true],
  [12, "example.com", 443, false],
  [13, "104.16.0.1", 443, false],
  [14, "169.254.169.254", 80, false],
  [15, "localhost", 443, false],
  [16, "registry.npmjs.org", null, false],
];

describe("cell egress parity: proxy shape vs Agent37 model", () => {
  const shape = toProxyShape(SET);
  const { allow } = toAgent37Network(SET);

  it.each(PROBES)("row %i: %s:%s", (_row, host, port, expected) => {
    expect(matchEgress(shape, host, port)).toBe(expected);
    expect(agent37Decide(allow, host, port)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import {
  DRIVER_B_CAPABILITIES,
  DRIVER_B_PROFILE_ID,
  driverBEvidenceRows,
  driverBMeasuredAtIsCurrent,
  judgeDriverBReport,
  parseProbeLines,
} from "./box-evidence";

const NAMES: Record<number, string> = {
  2: "engine-unreachable",
  3: "userns-mapping",
  4: "no-capabilities",
  5: "readonly-rootfs",
  6: "review-no-write",
  7: "run-isolation",
};

function output(overrides: Record<number, string | null> = {}): string {
  return [2, 3, 4, 5, 6, 7]
    .map((n) => {
      const status = n in overrides ? overrides[n] : "PASS";
      return status === null
        ? null
        : `${status} ${n} ${NAMES[n]!.padEnd(20)} detail for ${n}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

describe("parseProbeLines", () => {
  it("reads verdict lines and ignores everything else", () => {
    expect(
      parseProbeLines(
        "noise\nPASS 2 engine-unreachable   ok\nFAIL 7 run-isolation peer seen\n",
      ),
    ).toEqual([
      { status: "PASS", probe: 2, name: "engine-unreachable" },
      { status: "FAIL", probe: 7, name: "run-isolation" },
    ]);
  });
});

describe("judgeDriverBReport", () => {
  it("accepts two containers with one PASS for each of probes 2 to 7", () => {
    expect(judgeDriverBReport([output(), `preamble\n${output()}`])).toEqual({
      ok: true,
    });
  });

  it("refuses anything but two containers", () => {
    expect(judgeDriverBReport([output()])).toMatchObject({
      ok: false,
      reason: "wrong_container_count",
    });
    expect(judgeDriverBReport([output(), output(), output()])).toMatchObject({
      ok: false,
      reason: "wrong_container_count",
    });
  });

  it("refuses a FAIL and names the container and probe only", () => {
    expect(judgeDriverBReport([output(), output({ 7: "FAIL" })])).toEqual({
      ok: false,
      reason: "probe_failed",
      detail: "container=1 probe=7",
    });
  });

  it("refuses a SKIP: driver B runs the review lane, where probe 6 applies", () => {
    expect(judgeDriverBReport([output({ 6: "SKIP" }), output()])).toMatchObject(
      { ok: false, reason: "probe_skipped" },
    );
  });

  it("refuses an inconclusive container (missing probe, empty output)", () => {
    expect(judgeDriverBReport([output({ 3: null }), output()])).toEqual({
      ok: false,
      reason: "probe_missing",
      detail: "container=0 probe=3",
    });
    expect(judgeDriverBReport(["", output()])).toMatchObject({
      ok: false,
      reason: "probe_missing",
    });
  });

  it("refuses probe 1 and repeated lines", () => {
    expect(
      judgeDriverBReport([`PASS 1 egress-denied ok\n${output()}`, output()]),
    ).toMatchObject({ ok: false, reason: "unexpected_probe" });
    expect(
      judgeDriverBReport([`${output()}\nPASS 4 no-capabilities ok`, output()]),
    ).toMatchObject({ ok: false, reason: "probe_repeated" });
  });
});

describe("driverBMeasuredAtIsCurrent", () => {
  const now = new Date("2026-11-15T04:10:00Z");
  it("accepts a fresh report and a small clock skew", () => {
    expect(
      driverBMeasuredAtIsCurrent(new Date("2026-11-15T04:00:00Z"), now),
    ).toBe(true);
    expect(
      driverBMeasuredAtIsCurrent(new Date("2026-11-15T04:14:00Z"), now),
    ).toBe(true);
  });
  it("refuses a backdated or future-dated report", () => {
    expect(
      driverBMeasuredAtIsCurrent(new Date("2026-11-15T01:00:00Z"), now),
    ).toBe(false);
    expect(
      driverBMeasuredAtIsCurrent(new Date("2026-11-15T04:30:00Z"), now),
    ).toBe(false);
  });
});

describe("driverBEvidenceRows", () => {
  it("writes the seed's five observe capabilities as conformance", () => {
    const measuredAt = new Date("2026-11-15T04:00:00Z");
    const rows = driverBEvidenceRows({
      host: "automata-exec-1",
      measuredAt,
      platformSha: "0fa5e90",
      imageDigest: `sha256:${"a".repeat(64)}`,
    });
    expect(rows.map((r) => [r.capability, r.result.value])).toEqual(
      Object.entries(DRIVER_B_CAPABILITIES),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        profileId: DRIVER_B_PROFILE_ID,
        source: "conformance",
        measuredAt,
        platformSha: "0fa5e90",
        result: { probes: "2-7", driver: "B", trigger: "schedule" },
      });
    }
    expect(rows.some((r) => r.capability === "egress")).toBe(false);
  });
});

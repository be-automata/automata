/**
 * ADR-014 step 5: scheduled renewal of the box's evidence (Consequences,
 * "Evidence upkeep": the probes have to be re-run on a schedule).
 *
 * The box runs driver B (packages/worker/deploy/README.md, "Security probes")
 * once a week from a systemd timer (packages/worker/deploy/linux/
 * box-evidence-probes.sh) and posts the raw probe output of both containers.
 * The control plane, not the box, decides what that output proves: it accepts
 * only a report in which each container printed exactly one PASS for every
 * probe 2 to 7 and nothing else, and only then writes evidence, for the one
 * profile driver B measures (automata-box/observe). Anything less records
 * nothing and raises an ops alert.
 *
 * Driver B does not measure probe 1 (egress), so it never renews the enforce
 * profile: that one still needs driver A until probe 1 runs against the
 * enforce proxy on its own.
 */

export const PROFILE_EVIDENCE_TOKEN_HEADER =
  "x-automata-profile-evidence-token";

/** The one profile a driver B report renews. */
export const DRIVER_B_PROFILE_ID = "automata-box/observe";

export const DRIVER_B_PROBES = [2, 3, 4, 5, 6, 7] as const;

/** Two concurrent containers, each naming the other as its peer (probe 7). */
export const DRIVER_B_CONTAINERS = 2;

/**
 * What a full driver B pass proves, exactly as the 2026-11-10 seed records it
 * (deploy/migrations/2026-11-10-execution-profile-seed-automata-box.sql).
 */
export const DRIVER_B_CAPABILITIES: Readonly<Record<string, boolean>> = {
  metadata_blocked: true,
  peer_isolated: true,
  teardown_verified: true,
  secret_brokering: true,
  provider_creds_in_guest: false,
};

/** A report older than this, or dated in the future beyond the skew, is refused. */
export const DRIVER_B_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const DRIVER_B_MAX_SKEW_MS = 5 * 60 * 1000;

export interface ProbeLine {
  status: "PASS" | "FAIL" | "SKIP";
  probe: number;
  name: string;
}

const PROBE_LINE = /^(PASS|FAIL|SKIP) ([0-9]+) (\S+)/;

/** The probe lines of one container's output; every other line is ignored. */
export function parseProbeLines(output: string): ProbeLine[] {
  const lines: ProbeLine[] = [];
  for (const raw of output.split("\n")) {
    const match = PROBE_LINE.exec(raw);
    if (!match) continue;
    lines.push({
      status: match[1] as ProbeLine["status"],
      probe: Number(match[2]),
      name: match[3]!,
    });
  }
  return lines;
}

export type DriverBVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "wrong_container_count"
        | "probe_failed"
        | "probe_skipped"
        | "probe_missing"
        | "probe_repeated"
        | "unexpected_probe";
      /** Container index and probe number only; never the probe's detail text. */
      detail: string;
    };

/**
 * A pass is every container printing exactly one PASS for each of probes 2 to
 * 7, and no other probe line. An inconclusive container (no lines, a missing
 * probe) is a failure, as in the probe script itself.
 */
export function judgeDriverBReport(containers: string[]): DriverBVerdict {
  if (containers.length !== DRIVER_B_CONTAINERS) {
    return {
      ok: false,
      reason: "wrong_container_count",
      detail: `containers=${containers.length}`,
    };
  }
  const expected = new Set<number>(DRIVER_B_PROBES);
  for (const [index, output] of containers.entries()) {
    const seen = new Set<number>();
    for (const line of parseProbeLines(output)) {
      const where = `container=${index} probe=${line.probe}`;
      if (!expected.has(line.probe)) {
        return { ok: false, reason: "unexpected_probe", detail: where };
      }
      if (line.status === "FAIL") {
        return { ok: false, reason: "probe_failed", detail: where };
      }
      if (line.status === "SKIP") {
        return { ok: false, reason: "probe_skipped", detail: where };
      }
      if (seen.has(line.probe)) {
        return { ok: false, reason: "probe_repeated", detail: where };
      }
      seen.add(line.probe);
    }
    for (const probe of DRIVER_B_PROBES) {
      if (!seen.has(probe)) {
        return {
          ok: false,
          reason: "probe_missing",
          detail: `container=${index} probe=${probe}`,
        };
      }
    }
  }
  return { ok: true };
}

/** Refuses a backdated or future-dated report: measured_at sets expires_at. */
export function driverBMeasuredAtIsCurrent(
  measuredAt: Date,
  now: Date,
): boolean {
  const age = now.getTime() - measuredAt.getTime();
  return age <= DRIVER_B_MAX_AGE_MS && age >= -DRIVER_B_MAX_SKEW_MS;
}

/** The evidence rows a passing driver B report writes. */
export function driverBEvidenceRows({
  host,
  measuredAt,
  platformSha,
  imageDigest,
}: {
  host: string;
  measuredAt: Date;
  platformSha: string;
  imageDigest: string;
}) {
  return Object.entries(DRIVER_B_CAPABILITIES).map(([capability, value]) => ({
    profileId: DRIVER_B_PROFILE_ID,
    capability,
    measuredAt,
    source: "conformance",
    platformSha,
    artifactDigest: imageDigest,
    result: {
      value,
      probes: "2-7",
      driver: "B",
      host,
      containers: DRIVER_B_CONTAINERS,
      trigger: "schedule",
    },
  }));
}

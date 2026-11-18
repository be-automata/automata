import {
  ADMISSION_DEFERRAL_BUDGET_S,
  backoffSeconds,
  sumBackoffSeconds,
} from "./admission-retry";
import { sleepAbortable } from "./abort-sleep";
import { acquireBoxSlot, type BoxLock } from "./box-lock";
import { configForSlot, type loadWorkerConfig } from "./config";
import {
  AdmissionBudgetExhaustedError,
  AdmissionController,
  AdmissionDeferredError,
  assessHeadroomSupport,
  type Reservation,
} from "./headroom";
import { reclaimDeadWorkerRuns } from "./reclaim";
import { ensureRunNamespace, getProcessWorkerId } from "./run-namespace";
import type { AgentRunInput, AgentRunOutput } from "./types";
import {
  checkRunStaleness,
  postRunTerminal,
  type WwwClientOpts,
} from "./www-client";

/**
 * Run admission, shared by every executor (#656 PR-E, a MOVE out of
 * workflow.ts with the module state it owns): the box slot and headroom loop
 * (#183, #205, #371), the stale self-check around a deferral wait (#125 C4),
 * and the per-process admission gate with its test seams. A cell still spends
 * this box's memory and CPU, so it is admitted the same way.
 *
 * Imports nothing from workflow.ts (no cycle); workflow.ts re-exports the names
 * outside modules import from it.
 */

/** The slice of Hatchet's task context the run fn consumes. */
export type RunCtx = {
  abortController?: AbortController;
  cancelled: boolean;
  log: (message: string) => void;
  workflowRunId?: () => string;
};

/**
 * #371: the worker-wide admission gate — one per process, decided once from
 * the boot config on first use (a run's admission, or the boot line). null
 * where the check cannot run (`assessHeadroomSupport`: a platform without
 * /proc/meminfo, an inert policy) — then admission is byte-for-byte today's.
 * On Linux with a live policy an unreadable /proc/meminfo THROWS, and the boot
 * refuses to start (worker.ts) rather than caching "off" for the process life.
 */
type AdmissionGate = {
  controller: AdmissionController | null;
  reason: string;
  /** Boot-time load warning from assessHeadroomSupport (the box was not idle). */
  warning: string | null;
};
let admissionGate: AdmissionGate | undefined;
function admissionGateFor(
  config: ReturnType<typeof loadWorkerConfig>,
): AdmissionGate {
  if (admissionGate) return admissionGate;
  const policy = {
    floorBytes: config.headroomFloorBytes,
    commitFraction: config.headroomCommitFraction,
    runCommitBytes: config.headroomRunCommitBytes,
  };
  const support = assessHeadroomSupport({ policy });
  admissionGate = support.enabled
    ? {
        controller: new AdmissionController(policy),
        reason: "",
        warning: support.warning ?? null,
      }
    : { controller: null, reason: support.reason, warning: null };
  return admissionGate;
}
/** Boot-cached: the FIRST caller's config decides (the policy is box-wide, never per slot); later arguments are ignored. */
export function getAdmissionController(
  config: ReturnType<typeof loadWorkerConfig>,
): AdmissionController | null {
  return admissionGateFor(config).controller;
}

/** The boot-time load warning for an armed gate (null when none): the box was not idle when the gate was assessed. */
export function headroomBootWarning(
  config: ReturnType<typeof loadWorkerConfig>,
): string | null {
  return admissionGateFor(config).warning;
}

/** The boot log line for the gate: armed with its thresholds, or OFF and why. */
export function headroomBootLine(
  config: ReturnType<typeof loadWorkerConfig>,
): string {
  const gate = admissionGateFor(config);
  return gate.controller
    ? `memory headroom check armed: floor=${gate.controller.policy.floorBytes} fraction=${gate.controller.policy.commitFraction} runCommit=${gate.controller.policy.runCommitBytes} maxDeferrals=${config.admissionMaxDeferrals} budgetS=${sumBackoffSeconds(config.admissionMaxDeferrals)}/${ADMISSION_DEFERRAL_BUDGET_S}`
    : `memory headroom check OFF: ${gate.reason}`;
}

export { sleepAbortable };
let admissionSleep: typeof sleepAbortable = sleepAbortable;
/** Test seam: replace the deferral wait (undefined restores the real sleep). */
export function _setAdmissionSleepForTests(
  fn: typeof sleepAbortable | undefined,
): void {
  admissionSleep = fn ?? sleepAbortable;
}

/** Test seam: install a gate (a controller, or null = the check is off), or reset with undefined. */
export function _setAdmissionControllerForTests(
  controller: AdmissionController | null | undefined,
): void {
  admissionGate =
    controller === undefined
      ? undefined
      : { controller, reason: controller ? "" : "test: off", warning: null };
}

/**
 * #125 C4: under complete-run·queue, the run asks www whether a newer run of
 * its PR is already recorded and, if so, ends itself with the typed
 * `stale-skipped` terminal — no clone, no daemon, no credits. null = proceed.
 * Other policies and legacy runs (no run id) never ask; a transport failure
 * fails open (checkRunStaleness). Called before admission and, because a #371
 * deferral can hold a run for the whole 12-minute budget while commits land,
 * once more after a wait that ends in admission.
 */
export async function staleSkip(
  input: AgentRunInput,
  ctx: RunCtx,
  wwwOpts: WwwClientOpts,
): Promise<AgentRunOutput | null> {
  const runExternalId = wwwOpts.runExternalId ?? "";
  if (input.supersedePolicy !== "complete-run-queue" || !runExternalId) {
    return null;
  }
  const stale = await checkRunStaleness(
    wwwOpts,
    { runExternalId },
    ctx.abortController?.signal,
  );
  if (!stale) return null;
  const result = await postRunTerminal(wwwOpts, {
    runExternalId,
    cause: "stale-skipped",
    policy: input.supersedePolicy,
  });
  ctx.log(
    `[agent-run ${input.threadId}] stale-skipped (newer run queued for this PR) → terminal: ${result}`,
  );
  return {
    threadId: input.threadId,
    threadChatId: input.threadChatId,
    outcome: "stale-skipped",
  };
}

export type AdmitRunSlotResult =
  | {
      kind: "admitted";
      boxLock: BoxLock;
      /** The slot's config (configForSlot): every later read of `config` means this. */
      config: ReturnType<typeof loadWorkerConfig>;
      reservation: Reservation | null;
    }
  | { kind: "skipped"; output: AgentRunOutput };

/**
 * The namespace upkeep, the box slot and the #371 headroom admission, with the
 * deferral waited out in process (the loop that was inline in runAgentInner,
 * unchanged). Gives back what it holds when it throws or skips; on `admitted`
 * the CALLER owns the slot and the reservation and releases them.
 */
export async function admitRunSlot(args: {
  input: AgentRunInput;
  ctx: RunCtx;
  /** The base (not per-slot) config. */
  config: ReturnType<typeof loadWorkerConfig>;
  wwwOpts: WwwClientOpts;
  /** #371: the workflow run's stable identity (the reservation key). */
  runKey: string;
  signal: AbortSignal | undefined;
  step: (msg: string) => void;
  admissionLog: (m: string) => void;
}): Promise<AdmitRunSlotResult> {
  const { input, ctx, wwwOpts, runKey, signal, step, admissionLog } = args;
  let config = args.config;
  let boxLock: BoxLock | null = null;
  let reservation: Reservation | null = null;
  try {
    await ensureRunNamespace({
      root: config.runNamespaceRoot,
      workerId: getProcessWorkerId(),
    });
    reclaimDeadWorkerRuns({
      root: config.runNamespaceRoot,
      selfWorkerId: getProcessWorkerId(),
      log: admissionLog,
    });
    // #371: admission under the slot and BEFORE the clone, with the deferral
    // waited out IN PROCESS: a refusal gives the box slot back, sleeps the
    // backoff — abortable by the engine's cancel — and tries again, up to
    // WORKER_ADMISSION_MAX_DEFERRALS or until the deferral budget (wall clock,
    // slot re-acquire waits included) is spent; then the run fails final. The
    // run keeps its ENGINE slot while it waits (I3: engine slots = box slots),
    // so no engine-dispatched sibling can take the freed box slot — the box
    // runs at most N − (deferred runs) agents and the engine's queue waits its
    // scheduleTimeout. The release matters for the lock's out-of-process
    // tenants (a self-heal run) and for Decision 5: a
    // waiting run is never a lock holder. Nothing of the run is on disk while it waits. The
    // reservation lives as long as the run (released in the finally and in
    // every pre-daemon unwind).
    const baseConfig = config;
    const admission = getAdmissionController(config);
    let deferralStartedAt: number | null = null;
    let lastRefusal: AdmissionDeferredError | null = null;
    let deferrals = 0;
    for (;;) {
      boxLock = await acquireBoxSlot({
        root: baseConfig.runNamespaceRoot,
        slots: baseConfig.boxSlots,
        holder: input.threadId,
        signal,
        log: admissionLog,
      });
      step("box lock acquired");
      // The budget is wall clock from the FIRST refusal and the slot wait is
      // part of it: a re-acquire that blocked behind an out-of-process holder
      // (a self-heal run) past the budget must not spend the agent's execution
      // window — fail final here, slot given back, nothing on disk.
      if (deferralStartedAt !== null && lastRefusal) {
        const elapsedS = Math.round((Date.now() - deferralStartedAt) / 1000);
        if (elapsedS > ADMISSION_DEFERRAL_BUDGET_S) {
          await boxLock.release();
          boxLock = null;
          throw new AdmissionBudgetExhaustedError(
            deferrals,
            lastRefusal,
            elapsedS,
          );
        }
      }
      // #205: from here on this run IS slot `boxLock.slot` (configForSlot):
      // its container takes the slot's name and its per-run artefacts live in
      // the slot's own subdir. Every later read of `config` means the slot's.
      config = configForSlot(baseConfig, boxLock.slot);
      try {
        reservation =
          admission?.admit({
            runId: runKey,
            threadId: input.threadId,
            attempt: deferrals,
            log: admissionLog,
          }) ?? null;
        break;
      } catch (err) {
        if (!(err instanceof AdmissionDeferredError)) throw err;
        await boxLock.release();
        boxLock = null;
        config = baseConfig;
        lastRefusal = err;
        deferralStartedAt ??= Date.now();
        // Wall clock since the first refusal: the backoff sleeps AND the time
        // spent re-acquiring a box slot, which the boot-time budget check
        // (Σbackoff ≤ budget) cannot see.
        const elapsedS = Math.round((Date.now() - deferralStartedAt) / 1000);
        const waitS = backoffSeconds(deferrals + 1);
        if (
          deferrals >= baseConfig.admissionMaxDeferrals ||
          elapsedS + waitS > ADMISSION_DEFERRAL_BUDGET_S
        ) {
          throw new AdmissionBudgetExhaustedError(deferrals, err, elapsedS);
        }
        deferrals += 1;
        admissionLog(
          `box.headroom_deferred_wait ${JSON.stringify({
            runId: runKey,
            threadId: input.threadId,
            deferral: deferrals,
            of: baseConfig.admissionMaxDeferrals,
            waitS,
            elapsedS,
            budgetS: ADMISSION_DEFERRAL_BUDGET_S,
          })}`,
        );
        step(
          `admission deferred (${deferrals}/${baseConfig.admissionMaxDeferrals}): no memory headroom — waiting ${waitS}s`,
        );
        await admissionSleep(waitS * 1000, signal);
      }
    }
    // A deferral wait can span minutes while newer commits land on the PR:
    // under complete-run·queue ask www once more before spending the clone.
    // This is a pre-daemon exit (the daemon-phase finally is not reached), so
    // the reservation and the slot are given back here, nothing on disk.
    if (deferrals > 0) {
      const skipped = await staleSkip(input, ctx, wwwOpts);
      if (skipped) {
        step("stale after the deferral wait — skipped before the clone");
        reservation?.release();
        reservation = null;
        await boxLock.release();
        boxLock = null;
        return { kind: "skipped", output: skipped };
      }
    }
    return { kind: "admitted", boxLock, config, reservation };
  } catch (err) {
    reservation?.release();
    await boxLock?.release();
    throw err;
  }
}

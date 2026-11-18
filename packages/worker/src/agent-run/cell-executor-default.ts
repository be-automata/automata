import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { createOpenSandboxCellProvider } from "@terragon/sandbox/opensandbox-cell";

import { abortableSleep } from "./abort-sleep";
import { postAbnormalEnd } from "./abnormal-end";
import { loadCellConfig, type CellConfig } from "./cell-config";
import { createCellExecutor } from "./cell-run";
import {
  fetchCellPlan,
  postCellReport,
  postCellRevoke,
} from "./cell-www-client";
import { runEndMarks } from "./run-end-marks";
import {
  pollThreadStatus,
  pollUntilTerminal,
  postEgressEvents,
  pullNextMessage,
} from "./www-client";

/**
 * The cell executor's production wiring (#656 PR-E): the real www clients, the
 * OpenSandbox adapter, the clock and the run-end registry. workflow.ts loads
 * this module only for a marked run (`import()`), so it, like run-executor.ts,
 * imports no cell module at runtime and a box-only worker never loads the
 * sandbox adapter.
 */

/** The worker's cell config from its env, with the key file read now (per marked run, so a rotated key needs no restart). */
export function loadCellConfigFromEnv(): CellConfig {
  return loadCellConfig(process.env, (p) => readFileSync(p, "utf8"));
}

export const cellExecutor = createCellExecutor({
  www: {
    fetchPlan: (opts, body, signal) => fetchCellPlan(opts, body, { signal }),
    revoke: (opts, attempt, signal, retry) =>
      postCellRevoke(opts, attempt, signal, retry ? { retry } : {}),
    report: (opts, attempt, outcome, signal, flags) =>
      postCellReport(opts, attempt, outcome, signal, flags),
    nextMessage: (opts, signal) => pullNextMessage(opts, signal),
    pollThreadStatus: (opts, signal) => pollThreadStatus(opts, signal),
    pollUntilTerminal: (ctx, opts, pollIntervalMs) =>
      pollUntilTerminal(ctx, opts, pollIntervalMs),
    postEgress: (opts, events) => postEgressEvents(opts, events),
    postAbnormal: (state, end, deps) => postAbnormalEnd(state, end, deps),
  },
  makeProvider: (cfg) =>
    createOpenSandboxCellProvider(cfg, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => abortableSleep(ms),
      now: () => Date.now(),
      // Field values are dropped: a cell log line never carries a tag or a vault.
      logger: {
        info: (msg) => console.info(`[cell] ${msg}`),
        warn: (msg) => console.warn(`[cell] ${msg}`),
      },
    }),
  sleep: (ms, signal) => abortableSleep(ms, signal),
  now: () => Date.now(),
  randomId: () => randomBytes(18).toString("base64url"),
  marks: runEndMarks,
});

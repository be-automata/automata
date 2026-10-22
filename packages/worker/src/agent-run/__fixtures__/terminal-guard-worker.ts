/**
 * A real worker PROCESS for run-terminal-redelivery.integration.test.ts (#386):
 * the IT SIGTERMs it, so the SDK's own graceful drain runs exactly as it does
 * under `systemctl restart`. Registers the shipped `agent-run` definition with
 * a stub fn behind the same `guardRunTerminal` the real task fn uses.
 *
 * Env: HATCHET_CLIENT_TOKEN / HATCHET_CLIENT_TLS_STRATEGY (from the IT),
 * LEDGER_ROOT (the ledger's namespace root), GUARD ("0" = no guard: the
 * pre-#386 control), WORKER_NAME. Each execution prints one
 * `EXEC <label> <runId>` line and each refusal one `REFUSED <runId>` line on
 * stdout, and a no-op completion of a redelivered RETURNED run one
 * `NOOP <runId>` line (the same `onAlreadyReturned` wiring as workflow.ts).
 * The stub waits until `<LEDGER_ROOT>/release-<label>` exists, then returns,
 * or throws when the input says `fail`.
 */
import fs from "node:fs";
import path from "node:path";

import { Hatchet } from "@hatchet-dev/typescript-sdk";

import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "../definition";
import {
  RunAlreadyTerminalError,
  guardRunTerminal,
} from "../run-terminal-ledger";

type StubInput = { label: string; fail?: boolean };

const root = process.env.LEDGER_ROOT ?? "";
const guarded = process.env.GUARD !== "0";

async function stub(
  input: StubInput,
  runId: string,
): Promise<{ label: string; noop?: boolean }> {
  console.log(`EXEC ${input.label} ${runId}`);
  const release = path.join(root, `release-${input.label}`);
  while (!fs.existsSync(release)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (input.fail) throw new Error(`stub failure ${input.label}`);
  return { label: input.label };
}

async function main(): Promise<void> {
  const hatchet = Hatchet.init();
  const def = buildAgentRunDefinition(
    "agent-run",
    AGENT_RUN_VARIANTS["agent-run"],
  );
  const wf = hatchet.workflow<StubInput>(def.workflow);
  wf.task({
    ...def.task,
    fn: async (input: StubInput, ctx) => {
      const runId = ctx.workflowRunId();
      if (!guarded) return stub(input, runId);
      try {
        return await guardRunTerminal(
          {
            root,
            runId,
            log: (m) => console.log(`LEDGER ${m}`),
            onAlreadyReturned: () => {
              console.log(`NOOP ${runId}`);
              return { label: input.label, noop: true };
            },
          },
          () => stub(input, runId),
        );
      } catch (err) {
        if (err instanceof RunAlreadyTerminalError)
          console.log(`REFUSED ${runId}`);
        throw err;
      }
    },
  });
  const worker = await hatchet.worker(
    process.env.WORKER_NAME ?? "it-terminal-guard",
    {
      workflows: [wf],
      slots: 1,
    },
  );
  void worker.start();
  await worker.waitUntilReady(60_000);
  console.log("READY");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

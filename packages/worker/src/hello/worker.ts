import { hatchet } from "../hatchet-client";
import { workflows } from "../registry";

/**
 * Starts a worker that registers every workflow in the registry and long-polls the
 * engine over outbound gRPC for work. On a real customer box this is the process the
 * installer runs and keeps alive. Run locally with `pnpm --filter @terragon/worker worker`.
 */
async function main() {
  const worker = await hatchet.worker("automata-worker", {
    workflows,
    slots: 5,
  });
  await worker.start();
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});

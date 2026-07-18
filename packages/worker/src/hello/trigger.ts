import { hello } from "./workflow";

/**
 * Triggers one `hello` run and waits for its result — the control-plane side of
 * the round trip. Run with `pnpm --filter @terragon/worker trigger` while a worker
 * is running. Prints the returned output as JSON and exits non-zero if the result
 * is missing or malformed.
 */
async function main() {
  const name = process.argv[2] ?? "automata";
  const result = await hello.run({ name });
  console.log("HELLO_RESULT " + JSON.stringify(result));
  if (!result || typeof result.message !== "string") {
    throw new Error("round trip returned no usable result");
  }
}

main().catch((err) => {
  console.error("trigger failed", err);
  process.exit(1);
});

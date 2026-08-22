import "dotenv/config";
import { Sandbox } from "@e2b/code-interpreter";
import { execSync } from "child_process";

const SLEEP_MS = 60 * 15 * 1000; // 15 minutes

async function main() {
  const sandboxId = process.argv[2];
  if (!sandboxId) {
    console.error("Usage: tsx e2b-ssh.ts <sandbox-id>");
    process.exit(1);
  }
  console.log(`Resuming sandbox: ${sandboxId}`);
  // e2b v2: `connect` auto-resumes a paused sandbox (`Sandbox.resume` is gone).
  await Sandbox.connect(sandboxId, {
    timeoutMs: SLEEP_MS,
  });

  console.log(`Connecting to sandbox: ${sandboxId}`);
  execSync(`e2b sandbox connect ${sandboxId}`, {
    stdio: "inherit",
  });
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

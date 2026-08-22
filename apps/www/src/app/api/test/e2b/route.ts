import Sandbox from "@e2b/code-interpreter";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("This endpoint is only available in development");
  }
  const templateId = getTemplateIdForSize({
    provider: "e2b",
    size: "small",
  });

  let sandbox = await Sandbox.create(templateId, {
    // e2b v2: lifecycle.onTimeout replaces the old patched autoPause option.
    lifecycle: { onTimeout: "pause" },
    timeoutMs: 30 * 1000,
  });

  const id = sandbox.sandboxId;

  await sandbox.files.write("test.txt", "Hello, world!");

  await new Promise((resolve) => setTimeout(resolve, 60 * 1000));

  // e2b v2: `connect` auto-resumes a paused sandbox (`Sandbox.resume` is gone).
  sandbox = await Sandbox.connect(id, {
    timeoutMs: 30 * 1000,
  });

  const content = await sandbox.files.read("test.txt");
  return new Response(content);
}

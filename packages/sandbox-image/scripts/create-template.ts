import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { renderDockerfile } from "../src/render-dockerfile";

// Parse command line arguments for CPU/memory configuration
const args = process.argv.slice(2);
const sizeArg = args.find((arg) => arg.startsWith("--size="));
const providerArg = args.find((arg) => arg.startsWith("--provider="));
const size = sizeArg?.split("=")[1] as SandboxSize | undefined;
const provider = providerArg?.split("=")[1] as SandboxProvider | undefined;
const templatesJsonPath = path.join(__dirname, "../templates.json");
const dockerfileHbsPath = path.join(__dirname, "../Dockerfile.hbs");
const e2bTomlPath = path.join(__dirname, "../e2b.toml");
const isProd = process.env.NODE_ENV === "production";
const namePrefix = isProd ? "terry" : "terry-dev";

function getDockerfilePath(provider: SandboxProvider): string {
  return path.join(__dirname, `../Dockerfile.${provider}`);
}

type TemplateArgs = {
  cpuCount: number;
  memoryGB: number;
};

function randomSuffix() {
  const dateString = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");
  const hex = Math.random().toString(36).substring(2, 8);
  return `${dateString}-${hex}`;
}

function getTemplateName({ cpuCount, memoryGB }: TemplateArgs): string {
  // Lowercase: E2B's v2 build system rejects uppercase template names (the
  // v1 API lowercased them server-side, which is why the old terry-vCPU-*
  // names resolved as terry-vcpu-*).
  return `${namePrefix}-vcpu-${cpuCount}-ram-${memoryGB}gb-${randomSuffix()}`;
}

function getDaytonaBuildFlags({ cpuCount, memoryGB }: TemplateArgs) {
  const name = getTemplateName({ cpuCount, memoryGB });
  const dockerfilePath = getDockerfilePath("daytona");
  return {
    name,
    args: [
      name,
      "-f",
      path.relative(process.cwd(), dockerfilePath),
      "--cpu",
      cpuCount.toString(),
      "--disk",
      "20",
      "--memory",
      memoryGB.toString(),
    ],
  };
}

function getE2BBuildFlags({ cpuCount, memoryGB }: TemplateArgs) {
  const name = getTemplateName({ cpuCount, memoryGB });
  const dockerfilePath = getDockerfilePath("e2b");
  const memoryMB = memoryGB * 1024;
  return {
    name,
    // v2 `template create` takes the name as a positional argument.
    args: [
      name,
      "--dockerfile",
      path.relative(process.cwd(), dockerfilePath),
      "--cpu-count",
      cpuCount.toString(),
      "--memory-mb",
      memoryMB.toString(),
    ],
  };
}

function runCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Running command: ${command}`);
    const child = spawn(command, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
    });
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    child.on("error", (error: Error) => {
      reject(error);
    });
  });
}

function getDockerfileHash(): string {
  const dockerfileHbsContent = fs.readFileSync(dockerfileHbsPath, "utf-8");
  return crypto.createHash("sha256").update(dockerfileHbsContent).digest("hex");
}

async function buildE2BTemplate(templateArgs: TemplateArgs) {
  // Render the Dockerfile for e2b
  const dockerfileContent = renderDockerfile("e2b");
  const dockerfilePath = getDockerfilePath("e2b");
  fs.writeFileSync(dockerfilePath, dockerfileContent);

  // Delete e2b.toml if it exists
  if (fs.existsSync(e2bTomlPath)) {
    console.log(`Deleting existing e2b.toml at ${e2bTomlPath}`);
    fs.unlinkSync(e2bTomlPath);
  }
  const { name, args } = getE2BBuildFlags(templateArgs);
  // v2 build system (`template create`, remote builder); `template build` is
  // the deprecated v1 path and exits 1 with @e2b/cli >= 2.x.
  await runCommand(`e2b template create ${args.join(" ")}`);
  console.log(`Template built successfully: ${name}`);
  return name;
}

async function buildDaytonaTemplate(templateArgs: TemplateArgs) {
  // Render the Dockerfile for daytona
  const dockerfileContent = renderDockerfile("daytona");
  const dockerfilePath = getDockerfilePath("daytona");
  fs.writeFileSync(dockerfilePath, dockerfileContent);

  const { name, args } = getDaytonaBuildFlags(templateArgs);
  await runCommand(`daytona snapshot create ${args.join(" ")}`);
  console.log(`Template built successfully: ${name}`);
  return name;
}

async function updateTemplatesJson({
  templateName,
  dockerfileHash,
  cpuCount,
  memoryGB,
  provider,
  size,
}: {
  templateName: string;
  dockerfileHash: string;
  cpuCount: number;
  memoryGB: number;
  provider: SandboxProvider;
  size: SandboxSize;
}) {
  let templates: any[] = [];
  if (fs.existsSync(templatesJsonPath)) {
    const content = fs.readFileSync(templatesJsonPath, "utf-8");
    templates = JSON.parse(content);
  }
  // Add or update the template entry
  templates.push({
    name: templateName,
    dockerfileHash,
    cpuCount,
    memoryGB,
    provider,
    size,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(templatesJsonPath, JSON.stringify(templates, null, 2));
}

async function main() {
  if (!size) {
    throw new Error("Size is required");
  }
  if (!provider) {
    throw new Error("Provider is required");
  }
  // Default to 2vCPU/4GB if not specified
  const cpuCount = size === "large" ? 4 : 2;
  const memoryGB = size === "large" ? 8 : 4;
  const dockerfileHash = getDockerfileHash();
  console.log(`Creating ${provider} template for ${size} size...`);
  console.log(` * CPU: ${cpuCount} vCPU`);
  console.log(` * Memory: ${memoryGB}GB`);
  console.log(` * Dockerfile hash: ${dockerfileHash}`);

  const startTime = Date.now();
  let templateName: string;
  const templateArgs: TemplateArgs = { cpuCount, memoryGB };
  switch (provider) {
    case "e2b": {
      templateName = await buildE2BTemplate(templateArgs);
      break;
    }
    case "daytona":
      templateName = await buildDaytonaTemplate(templateArgs);
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
  await updateTemplatesJson({
    templateName,
    dockerfileHash,
    cpuCount,
    memoryGB,
    provider,
    size,
  });
  console.log(`Successfully created template: ${templateName}`, {
    cpuCount,
    memoryGB,
    dockerfileHash,
    provider,
    size,
    durationMs: Date.now() - startTime,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

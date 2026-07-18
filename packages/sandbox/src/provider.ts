import type { SandboxProvider } from "@terragon/types/sandbox";
import type { ISandboxProvider } from "./types";
import { DockerProvider } from "./providers/docker-provider";
import { E2BProvider } from "./providers/e2b-provider";
import { MockProvider } from "./providers/mock-provider";
import { DaytonaProvider } from "./providers/daytona-provider";

export function getSandboxProvider(
  provider: SandboxProvider,
): ISandboxProvider {
  switch (provider) {
    case "e2b":
      return new E2BProvider();
    case "mock":
      if (process.env.NODE_ENV === "test") {
        return new MockProvider();
      }
      throw new Error(
        "Mock sandbox provider is only available in test environments",
      );
    case "docker":
      return new DockerProvider();
    case "daytona":
      return new DaytonaProvider();
    case "hatchet-remote":
      // ADR-003: dispatched to the execution plane, never instantiated as a local
      // sandbox. Reaching here means a remote thread wrongly took the boot path.
      throw new Error(
        "hatchet-remote is dispatched to the execution plane, not instantiated as a local sandbox provider",
      );
    default:
      const _exhaustiveCheck: never = provider;
      throw new Error(`Unknown sandbox provider: ${_exhaustiveCheck}`);
  }
}

// NOTE: This is stored in the database, so don't remove any values from this list.
export type SandboxProvider =
  | "e2b"
  | "docker"
  | "mock"
  | "daytona"
  // ADR-003: not a locally-instantiable sandbox — a thread pinned to this is
  // dispatched to the remote execution plane (Hatchet), never booted in-process.
  | "hatchet-remote";

// Generic sandbox size - applies to all providers
// NOTE: This is stored in the database, so don't remove any values from this list.
export type SandboxSize = "small" | "large";

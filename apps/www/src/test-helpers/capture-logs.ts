import { vi } from "vitest";

/**
 * Silence console.error/warn/log for a test and read back what was written,
 * so a test can assert a secret never reached the logs. Call `restore()` when
 * done (in a `finally`).
 */
export function captureLogs() {
  const spies = (["error", "warn", "log"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return {
    text: () =>
      spies
        .flatMap((spy) => spy.mock.calls.flat())
        .map((arg) =>
          arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg),
        )
        .join("\n"),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** The Basic credential git sends for GitHub: `x-access-token:<token>`. */
export const basic = (pass: string) =>
  `Basic ${btoa(`x-access-token:${pass}`)}`;

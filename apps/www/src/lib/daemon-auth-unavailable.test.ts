import { describe, it, expect } from "vitest";
import {
  DaemonAuthUnavailableError,
  withDaemonAuthUnavailable,
} from "./daemon-auth-unavailable";

describe("withDaemonAuthUnavailable", () => {
  it("passes the handler's response through", async () => {
    const handler = withDaemonAuthUnavailable(
      async (status: number) => new Response("ok", { status }),
    );
    expect((await handler(201)).status).toBe(201);
  });

  it("maps DaemonAuthUnavailableError to 503 with Retry-After", async () => {
    const handler = withDaemonAuthUnavailable(async (): Promise<Response> => {
      throw new DaemonAuthUnavailableError("api key lookup failed", {
        cause: new Error("connect timeout"),
      });
    });
    const res = await handler();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({
      error: "Authentication temporarily unavailable",
    });
  });

  it("rethrows every other error", async () => {
    const handler = withDaemonAuthUnavailable(async (): Promise<Response> => {
      throw new Error("boom");
    });
    await expect(handler()).rejects.toThrow("boom");
  });
});

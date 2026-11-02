import { describe, expect, it, vi } from "vitest";

import {
  formatKnowledgeIntentFailedAlert,
  postKnowledgeIntentFailedAlert,
} from "./ops-alert";

const ALERT = {
  organizationId: "org_1",
  repoFullName: "o/r",
  code: "fetch_failed",
  attempts: 8,
};

describe("formatKnowledgeIntentFailedAlert", () => {
  it("carries exactly the four fields", () => {
    const { text } = formatKnowledgeIntentFailedAlert(ALERT);
    expect(text).toContain("org_1");
    expect(text).toContain("o/r");
    expect(text).toContain("fetch_failed");
    expect(text).toContain("8");
    expect(text).not.toContain("\n");
  });
});

describe("postKnowledgeIntentFailedAlert", () => {
  it("is unconfigured for an empty url and never fetches", async () => {
    const fetchImpl = vi.fn();
    const r = await postKnowledgeIntentFailedAlert(ALERT, {
      url: "",
      fetchImpl,
    });
    expect(r).toEqual({ sent: false, reason: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "http://hooks.example/x",
    "https://user:pw@hooks.example/x",
    "nope",
  ])("rejects %s as invalid_url", async (url) => {
    const fetchImpl = vi.fn();
    const r = await postKnowledgeIntentFailedAlert(ALERT, { url, fetchImpl });
    expect(r).toEqual({ sent: false, reason: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts JSON with redirect manual and a signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    const url = "https://hooks.example/secret-token";
    const r = await postKnowledgeIntentFailedAlert(ALERT, { url, fetchImpl });
    expect(r).toEqual({ sent: true });
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual(
      formatKnowledgeIntentFailedAlert(ALERT),
    );
  });

  it("maps a 302 to redirect and a 500 to non_2xx", async () => {
    const url = "https://hooks.example/t";
    expect(
      await postKnowledgeIntentFailedAlert(ALERT, {
        url,
        fetchImpl: vi.fn().mockResolvedValue({ status: 302 }),
      }),
    ).toEqual({ sent: false, reason: "redirect" });
    expect(
      await postKnowledgeIntentFailedAlert(ALERT, {
        url,
        fetchImpl: vi.fn().mockResolvedValue({ status: 500 }),
      }),
    ).toEqual({ sent: false, reason: "non_2xx" });
  });

  it("maps a thrown error to request_failed and a timeout to timeout, never echoing the url", async () => {
    const url = "https://hooks.example/secret-token";
    const failed = await postKnowledgeIntentFailedAlert(ALERT, {
      url,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("boom " + url)),
    });
    expect(failed).toEqual({ sent: false, reason: "request_failed" });
    const timeoutErr = Object.assign(new Error("t"), { name: "TimeoutError" });
    const timed = await postKnowledgeIntentFailedAlert(ALERT, {
      url,
      fetchImpl: vi.fn().mockRejectedValue(timeoutErr),
    });
    expect(timed).toEqual({ sent: false, reason: "timeout" });
    expect(JSON.stringify([failed, timed])).not.toContain("secret-token");
  });
});

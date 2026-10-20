import { describe, expect, it } from "vitest";

import {
  GROWTH_TRIGGER_INTERVAL_CEILING_S,
  GROWTH_TRIGGER_INTERVAL_DEFAULT_S,
  GROWTH_TRIGGER_RAM_FRACTION_DEFAULT,
  GROWTH_TRIGGER_SUSTAIN_DEFAULT_S,
  loadGrowthTriggerConfig,
} from "./growth-trigger-config";

const SECRET_URL = "https://hooks.example.com/services/T000/B000/SECRETTOKEN";

function load(extra: Record<string, string | undefined>) {
  return loadGrowthTriggerConfig({
    WORKER_ALERT_WEBHOOK_URL: SECRET_URL,
    ...extra,
  });
}

describe("loadGrowthTriggerConfig", () => {
  it("returns null when the webhook is unset, without validating other knobs", () => {
    const garbage = {
      WORKER_GROWTH_TRIGGER_INTERVAL_S: "nope",
      WORKER_GROWTH_TRIGGER_SUSTAIN_S: "1",
      WORKER_GROWTH_TRIGGER_RAM_FRACTION: "7",
      WORKER_ENTERPRISE_QUESTIONNAIRE: "1",
    };
    expect(loadGrowthTriggerConfig(garbage)).toBeNull();
    expect(
      loadGrowthTriggerConfig({ ...garbage, WORKER_ALERT_WEBHOOK_URL: "" }),
    ).toBeNull();
    expect(
      loadGrowthTriggerConfig({ ...garbage, WORKER_ALERT_WEBHOOK_URL: "   " }),
    ).toBeNull();
  });

  it("applies defaults", () => {
    expect(load({})).toEqual({
      webhookUrl: SECRET_URL,
      intervalS: GROWTH_TRIGGER_INTERVAL_DEFAULT_S,
      sustainS: GROWTH_TRIGGER_SUSTAIN_DEFAULT_S,
      ramFraction: GROWTH_TRIGGER_RAM_FRACTION_DEFAULT,
      questionnaire: false,
    });
    expect(GROWTH_TRIGGER_INTERVAL_DEFAULT_S).toBe(300);
    expect(GROWTH_TRIGGER_SUSTAIN_DEFAULT_S).toBe(900);
    expect(GROWTH_TRIGGER_RAM_FRACTION_DEFAULT).toBe(0.7);
  });

  function refusal(url: string): string {
    try {
      loadGrowthTriggerConfig({ WORKER_ALERT_WEBHOOK_URL: url });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  }

  it("refuses other protocols and junk without echoing the URL", () => {
    for (const bad of [
      "ftp://hooks.example.com/SECRETTOKEN",
      "file:///etc/SECRETTOKEN",
      "not a url SECRETTOKEN",
    ]) {
      const message = refusal(bad);
      expect(message).toMatch(/WORKER_ALERT_WEBHOOK_URL/);
      expect(message).not.toContain("SECRETTOKEN");
      expect(message).not.toContain("hooks.example.com");
    }
  });

  it("accepts any https host", () => {
    expect(load({})?.webhookUrl).toBe(SECRET_URL);
    expect(
      loadGrowthTriggerConfig({
        WORKER_ALERT_WEBHOOK_URL: "https://203.0.113.9/topic",
      })?.webhookUrl,
    ).toBe("https://203.0.113.9/topic");
  });

  it.each([
    ["a loopback literal", "http://127.0.0.1/topic"],
    ["a loopback literal", "http://127.255.0.9:9/topic"],
    ["a loopback literal", "http://[::1]:2586/topic"],
    ["a private IPv4 literal", "http://10.0.0.5/topic"],
    ["a private IPv4 literal", "http://10.255.255.255/topic"],
    ["a private IPv4 literal", "http://172.16.0.1/topic"],
    ["a private IPv4 literal", "http://172.31.255.254/topic"],
    ["a private IPv4 literal", "http://192.168.1.20:80/topic"],
  ])("accepts http to %s (%s)", (_kind, ok) => {
    expect(
      loadGrowthTriggerConfig({ WORKER_ALERT_WEBHOOK_URL: ok })?.webhookUrl,
    ).toBe(ok);
  });

  it("refuses http to a public or named host, naming the knob and the rule without the URL", () => {
    for (const bad of [
      "http://hooks.example.com/services/SECRETTOKEN",
      "http://ntfy.local/SECRETTOKEN",
      "http://172.15.0.1/SECRETTOKEN",
      "http://172.32.0.1/SECRETTOKEN",
      "http://192.169.0.1/SECRETTOKEN",
      "http://11.0.0.1/SECRETTOKEN",
      "http://8.8.8.8/SECRETTOKEN",
      "http://[fd00::1]/SECRETTOKEN",
      "http://localhost.example.com/SECRETTOKEN",
      "http://localhost:8080/SECRETTOKEN",
      "http://LOCALHOST/SECRETTOKEN",
    ]) {
      const message = refusal(bad);
      expect(message).toMatch(/^WORKER_ALERT_WEBHOOK_URL must use https:/);
      expect(message).toMatch(/loopback/);
      expect(message).not.toContain("SECRETTOKEN");
      expect(message).not.toContain("hooks.example.com");
      expect(message).not.toContain(new URL(bad).hostname);
    }
  });

  it("enforces the interval floor of 30 and integer values", () => {
    expect(
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "30",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "60",
      })?.intervalS,
    ).toBe(30);
    // AC 7 verbatim: the floor refusal names the knob, the bound and the other knob.
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "10" })).toThrow(
      "WORKER_GROWTH_TRIGGER_INTERVAL_S=10 is below the floor of 30 s " +
        "(WORKER_GROWTH_TRIGGER_SUSTAIN_S must also be ≥ 2 × the interval)",
    );
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "29" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S=29 is below the floor of 30 s/,
    );
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "30.5" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S/,
    );
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "abc" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S/,
    );
  });

  it("caps the interval at one day, naming the knob and the bound", () => {
    expect(GROWTH_TRIGGER_INTERVAL_CEILING_S).toBe(86_400);
    expect(
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "86400",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "172800",
      })?.intervalS,
    ).toBe(86_400);
    expect(() =>
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "86401",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "172802",
      }),
    ).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S=86401 is above the ceiling of 86400 s/,
    );
  });

  it("enforces the sustain floor of 60", () => {
    expect(
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "30",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "60",
      })?.sustainS,
    ).toBe(60);
    expect(() =>
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "30",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "59",
      }),
    ).toThrow(
      "WORKER_GROWTH_TRIGGER_SUSTAIN_S=59 is below the floor of 60 s " +
        "(it must also be ≥ 2 × WORKER_GROWTH_TRIGGER_INTERVAL_S)",
    );
  });

  it("refuses a sustain window below 2 × the interval, naming both knobs", () => {
    expect(() =>
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "300",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "599",
      }),
    ).toThrow(
      /WORKER_GROWTH_TRIGGER_SUSTAIN_S=599.*WORKER_GROWTH_TRIGGER_INTERVAL_S=300/,
    );
    expect(
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "300",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "600",
      })?.sustainS,
    ).toBe(600);
    // The default sustain (900) against a raised interval trips the rule too.
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "451" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S=451/,
    );
  });

  it("bounds the RAM fraction to 0 < x < 1", () => {
    expect(
      load({ WORKER_GROWTH_TRIGGER_RAM_FRACTION: "0.10" })?.ramFraction,
    ).toBe(0.1);
    for (const bad of ["0", "1", "-0.2", "1.5", "abc", "NaN"]) {
      expect(() => load({ WORKER_GROWTH_TRIGGER_RAM_FRACTION: bad })).toThrow(
        /WORKER_GROWTH_TRIGGER_RAM_FRACTION must be a number with 0 < x < 1/,
      );
    }
  });

  it("reads the questionnaire flag only as exactly '1'", () => {
    expect(load({ WORKER_ENTERPRISE_QUESTIONNAIRE: "1" })?.questionnaire).toBe(
      true,
    );
    for (const v of ["0", "true", "yes", " 1", undefined]) {
      expect(load({ WORKER_ENTERPRISE_QUESTIONNAIRE: v })?.questionnaire).toBe(
        false,
      );
    }
  });
});

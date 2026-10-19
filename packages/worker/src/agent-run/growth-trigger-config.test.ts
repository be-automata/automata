import { describe, expect, it } from "vitest";

import {
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

  it("accepts http and https; refuses other protocols and junk without echoing the URL", () => {
    expect(
      loadGrowthTriggerConfig({
        WORKER_ALERT_WEBHOOK_URL: "http://ntfy.local/topic",
      })?.webhookUrl,
    ).toBe("http://ntfy.local/topic");
    for (const bad of [
      "ftp://hooks.example.com/SECRETTOKEN",
      "file:///etc/SECRETTOKEN",
      "not a url SECRETTOKEN",
    ]) {
      let message = "";
      try {
        loadGrowthTriggerConfig({ WORKER_ALERT_WEBHOOK_URL: bad });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/WORKER_ALERT_WEBHOOK_URL/);
      expect(message).not.toContain("SECRETTOKEN");
      expect(message).not.toContain("hooks.example.com");
    }
  });

  it("enforces the interval floor of 30 and integer values", () => {
    expect(
      load({
        WORKER_GROWTH_TRIGGER_INTERVAL_S: "30",
        WORKER_GROWTH_TRIGGER_SUSTAIN_S: "60",
      })?.intervalS,
    ).toBe(30);
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "29" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S must be an integer >= 30/,
    );
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "30.5" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S/,
    );
    expect(() => load({ WORKER_GROWTH_TRIGGER_INTERVAL_S: "abc" })).toThrow(
      /WORKER_GROWTH_TRIGGER_INTERVAL_S/,
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
    ).toThrow(/WORKER_GROWTH_TRIGGER_SUSTAIN_S must be an integer >= 60/);
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

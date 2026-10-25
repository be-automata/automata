import { describe, expect, it } from "vitest";

import {
  effectiveDeliveryLoopMode,
  findDeliveryLoopFieldError,
  resolveDeliveryLoopMode,
} from "./delivery-loop-settings";

describe("#509 delivery-loop settings", () => {
  it("inherits repo -> '*' org row -> off", () => {
    expect(
      resolveDeliveryLoopMode({ repoValue: "on", orgDefaultValue: "shadow" }),
    ).toBe("on");
    expect(
      resolveDeliveryLoopMode({ repoValue: null, orgDefaultValue: "shadow" }),
    ).toBe("shadow");
    expect(
      resolveDeliveryLoopMode({ repoValue: null, orgDefaultValue: null }),
    ).toBe("off");
    expect(
      resolveDeliveryLoopMode({
        repoValue: undefined,
        orgDefaultValue: undefined,
      }),
    ).toBe("off");
  });

  it("an explicit repo 'off' wins over an org 'on'", () => {
    expect(
      resolveDeliveryLoopMode({ repoValue: "off", orgDefaultValue: "on" }),
    ).toBe("off");
  });

  it("an unknown stored value fails closed to off, never inherits past it", () => {
    expect(
      resolveDeliveryLoopMode({ repoValue: "yes", orgDefaultValue: "on" }),
    ).toBe("off");
  });

  it("the flag and a shadow installation cap the settings mode", () => {
    expect(
      effectiveDeliveryLoopMode({
        flagEnabled: false,
        installationShadow: false,
        settingsMode: "on",
      }),
    ).toBe("off");
    expect(
      effectiveDeliveryLoopMode({
        flagEnabled: true,
        installationShadow: true,
        settingsMode: "on",
      }),
    ).toBe("shadow");
    expect(
      effectiveDeliveryLoopMode({
        flagEnabled: true,
        installationShadow: true,
        settingsMode: "off",
      }),
    ).toBe("off");
    expect(
      effectiveDeliveryLoopMode({
        flagEnabled: true,
        installationShadow: false,
        settingsMode: "on",
      }),
    ).toBe("on");
  });

  it("the write boundary accepts the three modes and null, refuses anything else", () => {
    for (const ok of ["off", "shadow", "on", null, undefined]) {
      expect(
        findDeliveryLoopFieldError({ deliveryLoopMode: ok }),
      ).toBeUndefined();
    }
    expect(findDeliveryLoopFieldError({ deliveryLoopMode: "ON" })).toMatch(
      /must be one of off, shadow, on/,
    );
    expect(findDeliveryLoopFieldError({ deliveryLoopMode: 1 })).toBeDefined();
  });
});

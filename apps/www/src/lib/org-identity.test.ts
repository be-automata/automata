import { describe, expect, it } from "vitest";

import {
  ORG_HUES,
  isPersonalOrganizationSlug,
  orgHue,
  orgHueIndex,
  orgInitials,
} from "./org-identity";

describe("org identity", () => {
  it("gives an org the same hue every time, within the palette", () => {
    for (const id of ["org-1", "org-2", "a", "", "x".repeat(200)]) {
      const index = orgHueIndex(id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(ORG_HUES.length);
      expect(orgHueIndex(id)).toBe(index);
      expect(orgHue(id)).toBe(ORG_HUES[index]);
    }
  });

  it("spreads ids across more than one hue", () => {
    const used = new Set(
      Array.from({ length: 50 }, (_, i) => orgHueIndex(`org-${i}`)),
    );
    expect(used.size).toBeGreaterThan(4);
  });

  it("derives initials from the name", () => {
    expect(orgInitials("Automata AI")).toBe("AA");
    expect(orgInitials("acme")).toBe("AC");
    expect(orgInitials("  ")).toBe("?");
    expect(orgInitials("x")).toBe("X");
  });

  it("recognizes backfilled personal orgs by slug", () => {
    expect(isPersonalOrganizationSlug("personal-abc123")).toBe(true);
    expect(isPersonalOrganizationSlug("acme")).toBe(false);
    expect(isPersonalOrganizationSlug(null)).toBe(false);
  });
});

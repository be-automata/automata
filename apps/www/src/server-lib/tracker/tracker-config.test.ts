import { describe, expect, it } from "vitest";

import { parseTrackerConfig } from "./tracker-config";
import { TrackerConfigError } from "./youtrack-client";

const vars = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

describe("parseTrackerConfig", () => {
  it("returns null unless both the URL and the token are set", () => {
    expect(parseTrackerConfig([])).toBeNull();
    expect(
      parseTrackerConfig(vars({ YOUTRACK_URL: "https://yt.example.com" })),
    ).toBeNull();
    expect(parseTrackerConfig(vars({ YOUTRACK_TOKEN: "perm:x" }))).toBeNull();
    expect(
      parseTrackerConfig(
        vars({ YOUTRACK_URL: "https://yt.example.com", YOUTRACK_TOKEN: "  " }),
      ),
    ).toBeNull();
  });

  it("defaults writes to off — shadow until someone says live", () => {
    const config = parseTrackerConfig(
      vars({
        YOUTRACK_URL: "https://acme.youtrack.cloud/",
        YOUTRACK_TOKEN: "perm:x",
      }),
    );
    expect(config).toEqual({
      kind: "youtrack",
      baseUrl: "https://acme.youtrack.cloud",
      token: "perm:x",
      projects: [],
      writes: "off",
    });
  });

  it.each(["LIVE", "on", "true", "1", " live-ish", ""])(
    "treats AUTOMATA_TRACKER_WRITES=%j as off (only the exact word enables writes)",
    (value) => {
      const config = parseTrackerConfig(
        vars({
          YOUTRACK_URL: "https://yt.example.com",
          YOUTRACK_TOKEN: "perm:x",
          AUTOMATA_TRACKER_WRITES: value,
        }),
      );
      expect(config?.writes).toBe("off");
    },
  );

  it("drops malformed project names instead of building a pattern from them", () => {
    const config = parseTrackerConfig(
      vars({
        YOUTRACK_URL: "https://yt.example.com",
        YOUTRACK_TOKEN: "perm:x",
        YOUTRACK_PROJECTS: "ACME, .*, a b",
      }),
    );
    expect(config?.projects).toEqual(["ACME"]);
  });

  it("enables writes on exactly `live` and normalises the project list", () => {
    const config = parseTrackerConfig(
      vars({
        YOUTRACK_URL: "https://yt.example.com",
        YOUTRACK_TOKEN: "perm:x",
        YOUTRACK_PROJECTS: " acme , ,TRK ",
        AUTOMATA_TRACKER_WRITES: " live ",
      }),
    );
    expect(config?.writes).toBe("live");
    expect(config?.projects).toEqual(["ACME", "TRK"]);
  });

  it("throws on an unsafe URL instead of reading as unconfigured", () => {
    expect(() =>
      parseTrackerConfig(
        vars({ YOUTRACK_URL: "http://10.0.0.1", YOUTRACK_TOKEN: "perm:x" }),
      ),
    ).toThrow(TrackerConfigError);
  });
});

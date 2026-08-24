import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TERMINAL_CAUSES } from "@terragon/shared/model/terminal-cause";
import { RunStatusChip, runStatusChipModel } from "./run-status-chip";

describe("RunStatusChip (#125 C5)", () => {
  it("every typed cause renders a chip with text (not colour alone) and a status role (AC4)", () => {
    for (const cause of TERMINAL_CAUSES) {
      const html = renderToStaticMarkup(
        <RunStatusChip terminalCause={cause} />,
      );
      const model = runStatusChipModel({ terminalCause: cause })!;
      expect(html).toContain('role="status"');
      expect(html).toContain(model.label);
      expect(html).toContain("<svg"); // icon + text
    }
  });

  it("Superseded links to the newer run's thread", () => {
    const html = renderToStaticMarkup(
      <RunStatusChip
        terminalCause="superseded"
        supersededByThreadId="thr_new"
      />,
    );
    expect(html).toContain('href="/task/thr_new"');
    expect(html).toContain("Superseded");
  });

  it("renders nothing for a run without a typed terminal, or an unknown cause", () => {
    expect(renderToStaticMarkup(<RunStatusChip terminalCause={null} />)).toBe(
      "",
    );
    expect(renderToStaticMarkup(<RunStatusChip terminalCause="bogus" />)).toBe(
      "",
    );
    expect(runStatusChipModel({ terminalCause: undefined })).toBeNull();
  });

  it("the policy is named in human words in the detail", () => {
    const m = runStatusChipModel({
      terminalCause: "discarded",
      policy: "complete-run-discard",
    })!;
    expect(m.detail).toContain(
      "org policy: finish the running review, drop newer",
    );
    expect(m.tone).toBe("warning");
  });
});

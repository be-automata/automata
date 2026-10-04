import { describe, it, expect } from "vitest";
import {
  REVIEW_MODE_SECTION_CONDITIONS,
  assertReviewSkillContract,
  findReviewModeSectionError,
  hasReviewModeSections,
  renderReviewModeSections,
  validateSkillBody,
} from "./review-skill";
import { renderSkillPlaceholders } from "./resolve-review-skill";

/**
 * Review-mode sections (phase 6): the line-based `<!-- automata:if … -->`
 * grammar that lets ONE github-ops body carry a classic and an orchestrated
 * prompt. The classic render of a marker body must be exactly today's text,
 * and a marker-free body must come back as the very same string in every
 * mode.
 */

const CLASSIC = { mode: "classic", runTests: false } as const;
const ORCH_TESTS = { mode: "orchestrated", runTests: true } as const;
const ORCH_NO_TESTS = { mode: "orchestrated", runTests: false } as const;

const CONTRACT = '```json\n{ "verdict": "approve" }\n```';

describe("renderReviewModeSections", () => {
  it("returns a marker-free body unchanged in every mode", () => {
    const body = "Plain body.\n\n" + CONTRACT + "\n";
    expect(renderReviewModeSections(body)).toBe(body);
    expect(renderReviewModeSections(body, CLASSIC)).toBe(body);
    expect(renderReviewModeSections(body, ORCH_TESTS)).toBe(body);
    expect(renderReviewModeSections(body, ORCH_NO_TESTS)).toBe(body);
  });

  it("drops an orchestrated block for classic and keeps it (minus markers) for orchestrated", () => {
    const body =
      "A\n\n<!-- automata:if orchestrated -->\nX\n\n<!-- automata:endif -->\nB";
    expect(renderReviewModeSections(body)).toBe("A\n\nB");
    expect(renderReviewModeSections(body, CLASSIC)).toBe("A\n\nB");
    expect(renderReviewModeSections(body, ORCH_NO_TESTS)).toBe("A\n\nX\n\nB");
  });

  it("selects between a classic and an orchestrated sibling", () => {
    const body =
      "<!-- automata:if classic -->\nC\n<!-- automata:endif -->\n" +
      "<!-- automata:if orchestrated -->\nO\n<!-- automata:endif -->\nT";
    expect(renderReviewModeSections(body, CLASSIC)).toBe("C\nT");
    expect(renderReviewModeSections(body, ORCH_TESTS)).toBe("O\nT");
  });

  it("selects the run-tests sub-section from runTests", () => {
    const body =
      "H\n<!-- automata:if orchestrated run-tests -->\nRUN\n<!-- automata:endif -->\n" +
      "<!-- automata:if orchestrated no-run-tests -->\nNORUN\n<!-- automata:endif -->\nE";
    expect(renderReviewModeSections(body, ORCH_TESTS)).toBe("H\nRUN\nE");
    expect(renderReviewModeSections(body, ORCH_NO_TESTS)).toBe("H\nNORUN\nE");
    expect(renderReviewModeSections(body, CLASSIC)).toBe("H\nE");
  });

  it("recognises marker lines with trailing whitespace or CR and preserves CRLF content", () => {
    const body =
      "A\r\n<!-- automata:if orchestrated --> \t\r\nX\r\n<!-- automata:endif -->\t\r\nB\r\n";
    expect(renderReviewModeSections(body, CLASSIC)).toBe("A\r\nB\r\n");
    expect(renderReviewModeSections(body, ORCH_NO_TESTS)).toBe(
      "A\r\nX\r\nB\r\n",
    );
  });

  it("exposes the four conditions", () => {
    expect([...REVIEW_MODE_SECTION_CONDITIONS]).toEqual([
      "classic",
      "orchestrated",
      "orchestrated run-tests",
      "orchestrated no-run-tests",
    ]);
  });
});

describe("findReviewModeSectionError", () => {
  const malformed: Array<[string, string]> = [
    [
      "unknown condition",
      "<!-- automata:if fancy -->\nX\n<!-- automata:endif -->",
    ],
    [
      "nested if",
      "<!-- automata:if orchestrated -->\n<!-- automata:if classic -->\nX\n<!-- automata:endif -->\n<!-- automata:endif -->",
    ],
    ["endif without if", "X\n<!-- automata:endif -->"],
    ["unclosed if", "<!-- automata:if orchestrated -->\nX"],
    [
      "unknown directive",
      "<!-- automata:if orchestrated -->\nX\n<!-- automata:else -->\nY\n<!-- automata:endif -->",
    ],
  ];

  for (const [name, body] of malformed) {
    it(`rejects ${name}, and the renderer throws the same message`, () => {
      const message = findReviewModeSectionError(body);
      expect(message).toBeTypeOf("string");
      expect(() => renderReviewModeSections(body, CLASSIC)).toThrow(message);
      expect(() => renderReviewModeSections(body, ORCH_TESTS)).toThrow(message);
    });
  }

  it("accepts valid and marker-free bodies", () => {
    expect(findReviewModeSectionError("plain")).toBeUndefined();
    expect(
      findReviewModeSectionError(
        "<!-- automata:if orchestrated run-tests -->\nX\n<!-- automata:endif -->",
      ),
    ).toBeUndefined();
  });
});

describe("hasReviewModeSections", () => {
  it("is true only with at least one valid orchestrated block", () => {
    expect(hasReviewModeSections("plain")).toBe(false);
    expect(
      hasReviewModeSections(
        "<!-- automata:if classic -->\nC\n<!-- automata:endif -->",
      ),
    ).toBe(false);
    expect(
      hasReviewModeSections(
        "<!-- automata:if orchestrated no-run-tests -->\nO\n<!-- automata:endif -->",
      ),
    ).toBe(true);
    expect(
      hasReviewModeSections(
        "<!-- automata:if fancy -->\nO\n<!-- automata:endif -->",
      ),
    ).toBe(false);
  });
});

describe("assertReviewSkillContract with review-mode sections", () => {
  it("rejects a malformed grammar body that otherwise has the contract", () => {
    const body =
      CONTRACT + "\n<!-- automata:if fancy -->\nX\n<!-- automata:endif -->";
    expect(() => assertReviewSkillContract(body, "test")).toThrow(
      /review-mode section/,
    );
    expect(() => validateSkillBody("github-ops", body, "test")).toThrow(
      /review-mode section/,
    );
  });

  it("rejects a contract that lives only inside a section some render drops", () => {
    const onlyOrchestrated =
      "Intro\n<!-- automata:if orchestrated -->\n" +
      CONTRACT +
      "\n<!-- automata:endif -->\n";
    expect(() => assertReviewSkillContract(onlyOrchestrated, "t")).toThrow(
      /no fenced-json verdict contract/,
    );
    const onlyClassic =
      "Intro\n<!-- automata:if classic -->\n" +
      CONTRACT +
      "\n<!-- automata:endif -->\n";
    expect(() => assertReviewSkillContract(onlyClassic, "t")).toThrow(
      /no fenced-json verdict contract/,
    );
    const onlyRunTests =
      "Intro\n<!-- automata:if orchestrated run-tests -->\n" +
      CONTRACT +
      "\n<!-- automata:endif -->\n";
    expect(() => assertReviewSkillContract(onlyRunTests, "t")).toThrow(
      /no fenced-json verdict contract/,
    );
  });

  it("accepts a body whose contract survives every render", () => {
    const body =
      "Intro\n<!-- automata:if orchestrated -->\nO\n<!-- automata:endif -->\n" +
      CONTRACT;
    expect(() => validateSkillBody("github-ops", body, "t")).not.toThrow();
  });

  it("leaves non-github-ops validation unchanged", () => {
    const body = "<!-- automata:if fancy -->\nX\n<!-- automata:endif -->";
    expect(() => validateSkillBody("other-skill", body, "t")).not.toThrow();
    expect(() => validateSkillBody("other-skill", "  ", "t")).toThrow(/empty/);
  });
});

describe("renderSkillPlaceholders and review-mode sections", () => {
  const body =
    "Repo {{repoFullName}}\n<!-- automata:if orchestrated -->\nLead on {{baseBranch}}\n<!-- automata:endif -->\n" +
    "<!-- automata:if classic -->\nClassic {{baseBranch}}\n<!-- automata:endif -->\nEnd";
  const vars = { repoFullName: "acme/widgets", baseBranch: "develop" };

  it("does NOT interpret sections when the caller does not opt in", () => {
    expect(renderSkillPlaceholders(body, vars)).toBe(
      "Repo acme/widgets\n<!-- automata:if orchestrated -->\nLead on develop\n<!-- automata:endif -->\n" +
        "<!-- automata:if classic -->\nClassic develop\n<!-- automata:endif -->\nEnd",
    );
  });

  it("renders sections first, then placeholders, when opted in", () => {
    expect(
      renderSkillPlaceholders(body, { ...vars, reviewPrompt: ORCH_NO_TESTS }),
    ).toBe("Repo acme/widgets\nLead on develop\nEnd");
    expect(
      renderSkillPlaceholders(body, { ...vars, reviewPrompt: CLASSIC }),
    ).toBe("Repo acme/widgets\nClassic develop\nEnd");
  });
});

"use server";

import { adminOnly } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { User } from "@terragon/shared";
import { KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD } from "@terragon/shared/model/knowledge";
import {
  getKnowledgeBudgetCeilingSetting,
  setKnowledgeBudgetCeiling,
} from "@terragon/shared/model/knowledge-controls";

const DOLLARS_PATTERN = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Dollars string to integer micro-USD with integer math; null when invalid. */
function parseDollarsToMicro(dollars: string): number | null {
  const match = DOLLARS_PATTERN.exec(dollars.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(6, "0");
  // Reject before multiplying so absurd inputs cannot lose integer precision.
  if (whole.length > 6) return null;
  const micro = Number(whole) * 1_000_000 + Number(fraction);
  return Number.isSafeInteger(micro) ? micro : null;
}

export const getKnowledgeCeilingAction = adminOnly(
  async function getKnowledgeCeilingAction(adminUser: User) {
    const setting = await getKnowledgeBudgetCeilingSetting(db);
    return {
      ceilingMicroUsd: setting.ceilingMicroUsd,
      isDefault: setting.isDefault,
      updatedByUserId: setting.updatedByUserId,
      updatedAt: setting.updatedAt ? setting.updatedAt.toISOString() : null,
      absoluteMaxMicroUsd: KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD,
    };
  },
);

export const setKnowledgeCeilingAction = adminOnly(
  async function setKnowledgeCeilingAction(
    adminUser: User,
    input: { dollars?: string; reset?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: "invalid_amount" }> {
    let micro: number | null;
    if (input.reset === true) {
      micro = null;
    } else {
      // A blank field is not a reset: only the explicit reset loosens the ceiling.
      if (typeof input.dollars !== "string" || input.dollars.trim() === "") {
        return { ok: false, error: "invalid_amount" };
      }
      micro = parseDollarsToMicro(input.dollars.trim());
      if (micro === null || micro > KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD) {
        return { ok: false, error: "invalid_amount" };
      }
    }
    const previous = await getKnowledgeBudgetCeilingSetting(db);
    try {
      await setKnowledgeBudgetCeiling(db, {
        micro,
        actorUserId: adminUser.id,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return { ok: false, error: "invalid_amount" };
      }
      throw error;
    }
    console.log("[knowledge:ceiling]", {
      actorUserId: adminUser.id,
      fromMicroUsd: previous.isDefault ? null : previous.ceilingMicroUsd,
      toMicroUsd: micro,
    });
    return { ok: true };
  },
);

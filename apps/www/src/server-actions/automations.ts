"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AutomationInsert } from "@terragon/shared";
import {
  createAutomation as createAutomationModel,
  getAutomations as getAutomationsModel,
  deleteAutomation as deleteAutomationModel,
  updateAutomation as updateAutomationModel,
  getAutomation as getAutomationModel,
} from "@terragon/shared/model/automations";
import {
  runAutomation as runAutomationInternal,
  runPullRequestAutomation as runPullRequestAutomationInternal,
  runIssueAutomation as runIssueAutomationInternal,
  validateAutomationCreationOrUpdate,
  validateCanRunAutomation,
  hasReachedLimitOfAutomations,
} from "@/server-lib/automations";
import { getAccessInfoForUser } from "@/lib/subscription";

export const getHasReachedLimitOfAutomations = userOnlyAction(
  async function getHasReachedLimitOfAutomations(userId: string) {
    const { tier } = await getAccessInfoForUser(userId);
    return await hasReachedLimitOfAutomations({ userId, tier });
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);

export const getAutomations = userOnlyAction(
  async function getAutomations(userId: string) {
    // Fence the dashboard list on the active org (WI-5), mirroring the threads
    // route wiring. Nullable-safe: no active org = user-only, today's behavior.
    const tenant = await getTenantContextOrNull();
    return await getAutomationsModel({
      db,
      userId,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to get automations" },
);

export const getAutomation = userOnlyAction(
  async function getAutomation(userId: string, automationId: string) {
    const tenant = await getTenantContextOrNull();
    const automation = await getAutomationModel({
      db,
      automationId,
      userId,
      organizationId: tenant?.organizationId ?? null,
    });
    return automation;
  },
  { defaultErrorMessage: "Failed to get automation" },
);

export const createAutomation = userOnlyAction(
  async function createAutomation(
    userId: string,
    { automation }: { automation: Omit<AutomationInsert, "userId"> },
  ) {
    console.log("createAutomation", automation);
    const { tier } = await validateAutomationCreationOrUpdate({
      userId,
      automationId: null,
      updates: automation,
    });
    // Stamp the creator's active org (WI-5) so the automation's runs inherit it.
    const tenant = await getTenantContextOrNull();
    await createAutomationModel({
      db,
      userId,
      accessTier: tier,
      organizationId: tenant?.organizationId ?? null,
      automation,
    });
  },
  { defaultErrorMessage: "Failed to create automation" },
);

export const deleteAutomation = userOnlyAction(
  async function deleteAutomation(userId: string, automationId: string) {
    const tenant = await getTenantContextOrNull();
    await deleteAutomationModel({
      db,
      automationId,
      userId,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to delete automation" },
);

export const enableOrDisableAutomation = userOnlyAction(
  async function enableOrDisableAutomation(
    userId: string,
    { automationId, enabled }: { automationId: string; enabled: boolean },
  ) {
    const { tier } = await validateAutomationCreationOrUpdate({
      userId,
      automationId,
      updates: { enabled },
    });
    const tenant = await getTenantContextOrNull();
    await updateAutomationModel({
      db,
      automationId,
      userId,
      accessTier: tier,
      organizationId: tenant?.organizationId ?? null,
      updates: { enabled },
    });
  },
  {
    defaultErrorMessage: "Failed to update automation",
  },
);

export const updateAutomation = userOnlyAction(
  async function updateAutomation(
    userId: string,
    {
      automationId,
      updates,
    }: {
      automationId: string;
      updates: Omit<
        AutomationInsert,
        "userId" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount"
      >;
    },
  ) {
    const { tier } = await validateAutomationCreationOrUpdate({
      userId,
      automationId,
      updates,
    });
    const tenant = await getTenantContextOrNull();
    await updateAutomationModel({
      db,
      automationId,
      userId,
      accessTier: tier,
      organizationId: tenant?.organizationId ?? null,
      updates,
    });
  },
  {
    defaultErrorMessage: "Failed to update automation",
  },
);

export const runAutomation = userOnlyAction(
  async function runAutomation(userId: string, automationId: string) {
    await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["manual", "schedule"],
      throwOnError: true,
    });
    await runAutomationInternal({ userId, automationId, source: "manual" });
  },
  {
    defaultErrorMessage: "Failed to run automation",
  },
);

export const runPullRequestAutomation = userOnlyAction(
  async function runPullRequestAutomation(
    userId: string,
    { automationId, prNumber }: { automationId: string; prNumber: number },
  ) {
    const { automation } = await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["pull_request"],
      throwOnError: true,
    });
    await runPullRequestAutomationInternal({
      userId,
      automationId,
      prNumber,
      repoFullName: automation.repoFullName,
      prEventAction: "opened",
      source: "manual",
    });
  },
  { defaultErrorMessage: "Failed to run pull request automation" },
);

export const runIssueAutomation = userOnlyAction(
  async function runIssueAutomation(
    userId: string,
    {
      automationId,
      issueNumber,
    }: { automationId: string; issueNumber: number },
  ) {
    const { automation } = await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["issue"],
      throwOnError: true,
    });
    await runIssueAutomationInternal({
      userId,
      automationId,
      issueNumber,
      repoFullName: automation.repoFullName,
      issueEventAction: "opened",
      source: "manual",
    });
  },
  { defaultErrorMessage: "Failed to run issue automation" },
);

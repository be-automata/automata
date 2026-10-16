import {
  getAutomations,
  getAutomation,
  getAutomationLimit,
  getAutomationsHealth,
} from "@/server-actions/automations";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const automationQueryKeys = {
  list: () => ["automations", "list"],
  detail: (id: string) => ["automations", "detail", id],
  automationLimit: () => ["automations", "automationLimit"],
  health: () => ["automations", "health"],
};

export function automationQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: automationQueryKeys.list(),
    queryFn: async () => {
      const automations = await getAutomations();
      return automations;
    },
  });
}

export function automationDetailQueryOptions(id: string) {
  return getServerActionQueryOptions({
    queryKey: automationQueryKeys.detail(id),
    queryFn: async () => {
      const automation = await getAutomation(id);
      return automation;
    },
  });
}

export function automationLimitQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: automationQueryKeys.automationLimit(),
    queryFn: async () => {
      return await getAutomationLimit();
    },
  });
}

export function automationHealthQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: automationQueryKeys.health(),
    queryFn: () => getAutomationsHealth(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

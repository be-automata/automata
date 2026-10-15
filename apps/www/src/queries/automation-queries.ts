import {
  getAutomations,
  getAutomation,
  getAutomationLimit,
} from "@/server-actions/automations";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const automationQueryKeys = {
  list: () => ["automations", "list"],
  detail: (id: string) => ["automations", "detail", id],
  hasReachedLimit: () => ["automations", "hasReachedLimit"],
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

export function hasReachedLimitOfAutomationsQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: automationQueryKeys.hasReachedLimit(),
    queryFn: async () => {
      return await getAutomationLimit();
    },
  });
}

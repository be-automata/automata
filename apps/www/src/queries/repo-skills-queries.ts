import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "./server-action-helpers";
import {
  getRepoSkillDetailAction,
  listRepoSkillsAction,
  revertRepoSkillAction,
  saveRepoSkillAction,
} from "@/server-actions/repo-skills";

export const repoSkillsQueryKeys = {
  list: () => ["repo-skills", "list"] as const,
  detail: (repoFullName: string, skillName: string) =>
    ["repo-skills", "detail", repoFullName.toLowerCase(), skillName] as const,
};

export function useRepoSkillsQuery() {
  return useServerActionQuery({
    queryKey: repoSkillsQueryKeys.list(),
    queryFn: () => listRepoSkillsAction(),
  });
}

export function useRepoSkillDetailQuery({
  repoFullName,
  skillName,
}: {
  repoFullName: string | null;
  skillName: string | null;
}) {
  return useServerActionQuery({
    queryKey: repoSkillsQueryKeys.detail(repoFullName ?? "", skillName ?? ""),
    queryFn: () =>
      getRepoSkillDetailAction({
        repoFullName: repoFullName!,
        skillName: skillName!,
      }),
    enabled: Boolean(repoFullName && skillName),
  });
}

function useInvalidateSkill() {
  const queryClient = useQueryClient();
  return (repoFullName: string, skillName: string) => {
    void queryClient.invalidateQueries({
      queryKey: repoSkillsQueryKeys.list(),
    });
    void queryClient.invalidateQueries({
      queryKey: repoSkillsQueryKeys.detail(repoFullName, skillName),
    });
  };
}

export function useSaveRepoSkillMutation() {
  const invalidate = useInvalidateSkill();
  return useServerActionMutation({
    mutationFn: saveRepoSkillAction,
    onSuccess: (_data, { repoFullName, skillName }) => {
      toast.success("Skill saved — live on the next run");
      invalidate(repoFullName, skillName);
    },
  });
}

export function useRevertRepoSkillMutation() {
  const invalidate = useInvalidateSkill();
  return useServerActionMutation({
    mutationFn: revertRepoSkillAction,
    onSuccess: (_data, { repoFullName, skillName }) => {
      toast.success("Skill reverted — live on the next run");
      invalidate(repoFullName, skillName);
    },
  });
}

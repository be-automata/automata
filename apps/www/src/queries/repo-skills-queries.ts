import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { UserFacingError } from "@/lib/server-actions";

export const repoSkillsQueryKeys = {
  list: () => ["repo-skills", "list"] as const,
  detail: (repoFullName: string, skillName: string) =>
    ["repo-skills", "detail", repoFullName.toLowerCase(), skillName] as const,
  versionBody: (repoFullName: string, skillName: string, versionId: string) =>
    [
      "repo-skills",
      "version-body",
      repoFullName.toLowerCase(),
      skillName,
      versionId,
    ] as const,
};

/**
 * Fetch ONE historical version's body on demand (#64 slice 2 diff view). Uses
 * the tested `GET ?versionId` route — the single body-by-id surface — rather
 * than a second server action duplicating its org+skill fence. Enabled only
 * when a versionId is set, so opening the panel costs nothing.
 */
export function useRepoSkillVersionBodyQuery({
  repoFullName,
  skillName,
  versionId,
}: {
  repoFullName: string | null;
  skillName: string | null;
  versionId: string | null;
}) {
  return useQuery({
    queryKey: repoSkillsQueryKeys.versionBody(
      repoFullName ?? "",
      skillName ?? "",
      versionId ?? "",
    ),
    enabled: Boolean(repoFullName && skillName && versionId),
    queryFn: async (): Promise<string> => {
      const [owner, repo] = repoFullName!.split("/");
      const url =
        `/api/repo-skills/${encodeURIComponent(owner ?? "")}/` +
        `${encodeURIComponent(repo ?? "")}/${encodeURIComponent(skillName!)}` +
        `?versionId=${encodeURIComponent(versionId!)}`;
      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        // Network failure — UserFacingError so unwrapError surfaces THIS
        // message instead of collapsing to the generic one (this hook uses
        // fetch directly, bypassing the server-action wrappers that would
        // otherwise guarantee a UserFacingError).
        throw new UserFacingError(
          "Couldn't reach the server to load that version.",
        );
      }
      if (!res.ok) {
        // Prefer the route's own { error } message (e.g. "Version not found").
        const detail = await res
          .json()
          .then((j: { error?: unknown }) =>
            typeof j?.error === "string" ? j.error : null,
          )
          .catch(() => null);
        throw new UserFacingError(
          detail ?? `Couldn't load that version (${res.status}).`,
        );
      }
      const json = (await res.json()) as { version: { body: string } };
      return json.version.body;
    },
  });
}

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

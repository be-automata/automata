"use client";

import React, { memo, useState } from "react";
import { GitBranch, Github, Settings } from "lucide-react";
import { ResponsiveCombobox } from "@/components/ui/responsive-combobox";
import {
  useUserRepoBranchesQuery,
  useUserReposQuery,
} from "@/queries/user-repo-queries";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import { signInWithGithub } from "@/components/auth";
import { cn } from "@/lib/utils";

/**
 * The repo list comes from the user's GitHub OAuth token; the branch list comes
 * from the App INSTALLATION token (see server-actions/user-repos.ts). GitHub App
 * user tokens expire after 8h and this app deliberately does not refresh them
 * (lib/github.ts) — so the repo picker empties out while the branch picker keeps
 * working, and the fix is re-linking GitHub, NOT installing the App again.
 *
 * Without this, the expired-token state renders as the generic "Add a repo to get
 * started." + "Manage repository access", which sends the user to the App install
 * page and cannot fix it. Onboarding already branches on the same flag.
 */
function githubReconnectActionItem() {
  return {
    value: "reconnect-github",
    label: "Reconnect GitHub",
    icon: <Github className="size-4 shrink-0" />,
    action: () => {
      void signInWithGithub({
        returnUrl: "/dashboard",
        location: "repo_picker",
      });
    },
  };
}

export function repoEmptyText(githubTokenMissing: boolean) {
  return (didSearch: boolean) => {
    if (githubTokenMissing) {
      return "Your GitHub connection expired. Reconnect to list your repos.";
    }
    if (!didSearch) {
      return "Add a repo to get started.";
    }
    return "No repositories found.";
  };
}

function RepoSelectorInner({
  selectedRepoFullName,
  onChange,
}: {
  selectedRepoFullName: string | null;
  onChange: (repoFullName: string | null) => void;
}) {
  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery();
  const repos = repoData?.repos;
  const githubTokenMissing = repoData?.githubTokenMissing === true;
  const repoItems = React.useMemo(() => {
    const items = [];
    if (repos) {
      items.push(
        ...repos.map((repo) => ({
          value: repo.full_name,
          label: repo.full_name,
        })),
      );
    } else if (selectedRepoFullName) {
      items.push({
        value: selectedRepoFullName,
        label: selectedRepoFullName,
      });
    }
    return items;
  }, [selectedRepoFullName, repos]);

  const repoByFullName = React.useMemo(() => {
    return Object.fromEntries(
      repos?.map((repo) => [repo.full_name, repo]) ?? [],
    );
  }, [repos]);

  const displayRepoFullName = isLoadingRepos
    ? (selectedRepoFullName ?? null)
    : repoByFullName[selectedRepoFullName ?? ""]
      ? selectedRepoFullName
      : null;

  return (
    <ResponsiveCombobox
      items={repoItems}
      actionItems={[
        ...(githubTokenMissing ? [githubReconnectActionItem()] : []),
        {
          value: "manage-github-apps",
          label: "Manage repository access",
          icon: <Settings className="size-4 shrink-0" />,
          action: () => {
            window.open(getGHAppInstallUrl(), "_blank");
          },
        },
      ]}
      value={displayRepoFullName ?? null}
      setValue={(newRepoFullName) => {
        if (isLoadingRepos) {
          return;
        }
        onChange(newRepoFullName);
      }}
      placeholder="Select a Repo"
      searchPlaceholder="Search repositories"
      emptyText={repoEmptyText(githubTokenMissing)}
      isLoading={isLoadingRepos}
      loadingText="Loading repositories..."
      disabled={false}
      variant="outline"
    />
  );
}

function RepoBranchSelectorInner({
  hideRepoSelector,
  repoSelectorClassName,
  branchSelectorClassName,
  selectedRepoFullName,
  selectedBranch,
  onChange,
}: {
  hideRepoSelector?: boolean;
  repoSelectorClassName?: string;
  branchSelectorClassName?: string;
  selectedRepoFullName: string | null;
  selectedBranch: string | null;
  onChange: (
    repoFullName: string | null,
    branch: string | null,
    isDefaultBranch?: boolean,
  ) => void;
}) {
  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery();
  const repos = repoData?.repos;
  const githubTokenMissing = repoData?.githubTokenMissing === true;

  const [loadBranches, setLoadBranches] = useState(false);
  const { data: branches, isLoading: isLoadingBranches } =
    useUserRepoBranchesQuery(selectedRepoFullName, {
      enabled: loadBranches,
    });

  const repoItems = React.useMemo(() => {
    const items = [];

    if (repos) {
      items.push(
        ...repos.map((repo) => ({
          value: repo.full_name,
          label: repo.full_name,
        })),
      );
    } else if (selectedRepoFullName) {
      items.push({
        value: selectedRepoFullName,
        label: selectedRepoFullName,
      });
    }
    return items;
  }, [selectedRepoFullName, repos]);

  const repoByFullName = React.useMemo(() => {
    return Object.fromEntries(
      repos?.map((repo) => [repo.full_name, repo]) ?? [],
    );
  }, [repos]);

  const displayRepoFullName = isLoadingRepos
    ? (selectedRepoFullName ?? null)
    : repoByFullName[selectedRepoFullName ?? ""]
      ? selectedRepoFullName
      : null;
  const displaySelectedBranch =
    isLoadingBranches || !loadBranches
      ? (selectedBranch ?? null)
      : branches?.find((branch) => branch.name === selectedBranch)
        ? selectedBranch
        : null;
  return (
    <div className="flex flex-row items-center gap-2 sm:gap-4 px-2 sm:px-4 min-w-0">
      {!hideRepoSelector && (
        <ResponsiveCombobox
          icon={<Github className="size-4 shrink-0 hidden sm:block" />}
          items={repoItems}
          actionItems={[
            ...(githubTokenMissing ? [githubReconnectActionItem()] : []),
            {
              value: "manage-github-apps",
              label: "Manage repository access",
              icon: <Settings className="size-4 shrink-0" />,
              action: () => {
                window.open(getGHAppInstallUrl(), "_blank");
              },
            },
          ]}
          value={displayRepoFullName ?? null}
          setValue={(newRepoFullName) => {
            if (isLoadingRepos) {
              return;
            }
            if (newRepoFullName === null) {
              onChange(null, null);
              setLoadBranches(false);
            } else {
              const repo = repoByFullName?.[newRepoFullName];
              const newBranch = repo?.default_branch ?? "main";
              setLoadBranches(false);
              onChange(
                newRepoFullName,
                newBranch,
                repo?.default_branch === newBranch,
              );
            }
          }}
          placeholder="Select a Repo"
          searchPlaceholder="Search repositories"
          emptyText={repoEmptyText(githubTokenMissing)}
          isLoading={isLoadingRepos}
          loadingText="Loading repositories..."
          disabled={false}
          className={cn(repoSelectorClassName, "shrink-1")}
        />
      )}
      <ResponsiveCombobox
        icon={<GitBranch className="size-4 shrink-0 hidden sm:block" />}
        className={cn(branchSelectorClassName, "shrink-1 min-w-[50px]")}
        key={selectedRepoFullName ?? "no-repo"}
        onLoadItems={() => {
          setLoadBranches(true);
        }}
        items={
          branches?.map((branch) => ({
            value: branch.name,
            label: branch.name,
          })) ??
          (selectedBranch
            ? [
                {
                  value: selectedBranch,
                  label: selectedBranch,
                },
              ]
            : [])
        }
        value={displaySelectedBranch ?? null}
        setValue={(newBranch) => {
          onChange(selectedRepoFullName, newBranch);
        }}
        placeholder="Select a Branch"
        searchPlaceholder="Search branches"
        emptyText="No branches found"
        isLoading={isLoadingBranches}
        disabled={selectedRepoFullName === null}
      />
    </div>
  );
}

export const RepoBranchSelector = memo(RepoBranchSelectorInner);
export const RepoSelector = memo(RepoSelectorInner);

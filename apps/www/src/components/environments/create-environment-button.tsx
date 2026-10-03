"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Github,
  Search,
  Loader2,
  Check,
  ExternalLink,
} from "lucide-react";
import { createEnvironment } from "@/server-actions/create-environment";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useUserReposQuery } from "@/queries/user-repo-queries";
import { getEnvironments } from "@/server-actions/get-environments";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import { githubReconnectActionItem } from "@/components/repo-branch-selector";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "@/queries/server-action-helpers";

export function CreateEnvironmentButton() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery({
    enabled: isOpen,
  });

  const { data: environments, isLoading: isLoadingEnvironments } =
    useServerActionQuery({
      queryKey: ["environments"],
      queryFn: getEnvironments,
      staleTime: 10 * 60 * 1000, // 10 minutes
      enabled: isOpen,
    });

  const createEnvironmentMutation = useServerActionMutation({
    mutationFn: createEnvironment,
    onSuccess: (environment, { repoFullName }) => {
      toast.success(`Environment created for ${repoFullName}`);
      setIsOpen(false);
      router.push(`/environments/${environment.id}`);
      router.refresh();
    },
  });

  const environmentsByRepo = new Map(
    environments?.map((env) => [env.repoFullName, env]) || [],
  );

  const repos = repoData?.repos || [];
  // An expired GitHub connection lists ZERO repos, including ones that already
  // have an environment. Say so instead of "No repositories found.", which
  // points the user at the App-install page, a fix that cannot work.
  const githubTokenMissing = repoData?.githubTokenMissing === true;
  const reconnectGithub = githubReconnectActionItem("/environments");
  const filteredRepos = repos.filter((repo) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleCreateEnvironment = async () => {
    if (!selectedRepo) {
      toast.error("Please select a repository");
      return;
    }
    await createEnvironmentMutation.mutateAsync({
      repoFullName: selectedRepo,
    });
  };

  return (
    <>
      <Button
        onClick={() => {
          setIsOpen(true);
          setSelectedRepo(null);
          setSearchQuery("");
        }}
        variant="outline"
        size="sm"
        className="h-7"
      >
        <Plus className="h-4 w-4 mr-1" />
        Create Environment
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Environment</DialogTitle>
            <DialogDescription>
              Select a GitHub repository to create an environment for. This will
              allow you to configure environment variables, MCP servers, and
              setup scripts for this repository.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search repositories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Repository List */}
            <div className="border rounded-lg overflow-hidden flex flex-col">
              <div
                className="overflow-y-auto"
                style={{
                  minHeight: "56px",
                  maxHeight: `${56 * 6}px`,
                }}
              >
                {isLoadingRepos || isLoadingEnvironments ? (
                  <div className="min-h-[56px] flex items-center justify-center p-4">
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">
                        Loading repositories...
                      </span>
                    </div>
                  </div>
                ) : githubTokenMissing ? (
                  <div className="min-h-[56px] flex flex-col items-center justify-center gap-3 p-4">
                    <div className="text-center text-sm text-muted-foreground">
                      Your GitHub connection expired. Reconnect to list your
                      repos.
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={reconnectGithub.action}
                    >
                      {reconnectGithub.icon}
                      {reconnectGithub.label}
                    </Button>
                  </div>
                ) : filteredRepos.length === 0 ? (
                  <div className="min-h-[56px] flex items-center justify-center p-4">
                    <div className="text-center text-sm text-muted-foreground">
                      {searchQuery
                        ? "No repositories found matching your search."
                        : "No repositories found."}
                    </div>
                  </div>
                ) : (
                  <div className="divide-y">
                    {filteredRepos.map((repo) => {
                      const hasEnvironment = environmentsByRepo.has(
                        repo.full_name,
                      );
                      return (
                        <button
                          key={repo.full_name}
                          onClick={() => {
                            if (!hasEnvironment) {
                              setSelectedRepo(repo.full_name);
                            }
                          }}
                          disabled={hasEnvironment}
                          className={cn(
                            "w-full px-4 py-3 text-left transition-colors flex items-center gap-3",
                            hasEnvironment ? "opacity-50" : "hover:bg-accent",
                            selectedRepo === repo.full_name &&
                              !hasEnvironment &&
                              "bg-accent",
                          )}
                        >
                          <Github className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm">
                              {repo.full_name}
                            </div>
                          </div>
                          {hasEnvironment ? (
                            <Check className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            selectedRepo === repo.full_name && (
                              <Check className="h-3 w-3 text-primary" />
                            )
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Repository Access Link */}
            <div className="text-sm text-muted-foreground py-3">
              Don't see one of your repositories?{" "}
              <button
                type="button"
                onClick={() => {
                  window.open(getGHAppInstallUrl(), "_blank");
                }}
                className="text-muted-foreground hover:text-foreground underline transition-colors inline-flex items-center gap-1"
              >
                Manage repository access
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>

            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setIsOpen(false)}
                disabled={createEnvironmentMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateEnvironment}
                disabled={!selectedRepo || createEnvironmentMutation.isPending}
              >
                {createEnvironmentMutation.isPending
                  ? "Creating..."
                  : "Create Environment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

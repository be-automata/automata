"use client";

import React, { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "./ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { getUserRepos, UserRepo } from "@/server-actions/user-repos";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import { Loader2, CheckCircle2, ArrowRight, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { setOnboardingDone } from "@/server-actions/onboarding";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import posthog from "posthog-js";
import { GithubIcon } from "./icons/github";
import { signInWithGithub } from "./auth";
import { userCredentialsRefetchAtom } from "@/atoms/user-credentials";
import { userFlagsRefetchAtom } from "@/atoms/user-flags";
import { useServerActionQuery } from "@/queries/server-action-helpers";

function OnboardingDialogContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogContent className={cn("!p-0 relative")} hideCloseButton>
      <div className={cn("p-6", className)}>{children}</div>
    </DialogContent>
  );
}

export function Onboarding({ forceIsDone }: { forceIsDone?: boolean }) {
  const router = useRouter();
  const [isDone, setIsDone] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const refetchUserCredentials = useSetAtom(userCredentialsRefetchAtom);
  const refetchUserFlags = useSetAtom(userFlagsRefetchAtom);
  const { data: reposResult, isLoading: isLoadingRepos } = useServerActionQuery(
    {
      queryKey: ["repos-onboarding"],
      queryFn: () => getUserRepos(),
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: "always",
      refetchIntervalInBackground: false,
      refetchInterval: (query) => {
        if (query.state.data?.repos.length === 0) {
          return 5000; // 5 seconds for better UX when no repos found
        }
        return false;
      },
    },
  );
  const repos = reposResult?.repos ?? null;
  useEffect(() => {
    if (forceIsDone) {
      setIsDone(true);
    }
  }, [forceIsDone]);

  useEffect(() => {
    posthog.capture("onboarding_progress", {
      step: "github",
      isDone,
    });
  }, [isDone]);

  const onDone = async () => {
    try {
      setIsDone(true);
      await Promise.all([
        setOnboardingDone(),
        // Manually refetch user credentials and flags instead of relying on realtime
        // so that the default selected model/repo/branch don't flicker once we navigate to /dashboard
        refetchUserCredentials(),
        refetchUserFlags(),
      ]);
      router.push("/dashboard");
      toast.success("Welcome to Terragon!");
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Dialog open={!isDone}>
      <div
        className={cn(
          "transition-all duration-300 ease-in-out",
          isAnimating && "opacity-0",
        )}
      >
        {isLoadingRepos ? (
          <OnboardingDialogContent>
            <VisuallyHidden>
              <DialogTitle>Connect Your GitHub Repositories</DialogTitle>
            </VisuallyHidden>
            <div className="h-64 flex items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          </OnboardingDialogContent>
        ) : (
          <GithubStep
            repos={repos ?? null}
            githubTokenMissing={reposResult?.githubTokenMissing === true}
            onContinue={() => {
              setIsAnimating(true);
              setTimeout(() => {
                // GitHub connection is the final and only step now
                onDone();
                setIsAnimating(false);
              }, 150);
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

function openGHAppInstallPopup(onClosed: () => void) {
  const popup = window.open(
    getGHAppInstallUrl() + "?state=close",
    "github-app-permissions",
    "width=700,height=600,left=100,top=100",
  );

  // Check if popup is closed every 500ms
  if (popup) {
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed);
        onClosed();
      }
    }, 500);
  }
}

function AdjustGitHubAppPermissions() {
  const queryClient = useQueryClient();

  return (
    <a
      onClick={() => {
        openGHAppInstallPopup(() => {
          // Invalidate the repos query to trigger a refetch
          queryClient.invalidateQueries({ queryKey: ["repos-onboarding"] });
        });
      }}
      className="font-medium underline cursor-pointer inline-flex items-center gap-1"
    >
      Manage repository access
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

// Welcome step removed — onboarding is now a single GitHub step

function GithubStep({
  onContinue,
  repos,
  githubTokenMissing,
}: {
  onContinue: () => void;
  repos: UserRepo[] | null;
  githubTokenMissing: boolean;
}) {
  const hasRepos = repos && repos.length > 0;

  return (
    <OnboardingDialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader className="relative z-10">
        <div className="flex items-center justify-center mb-4">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-gray-900 to-gray-700 flex items-center justify-center shadow-lg">
            <GithubIcon className="p-2 text-white" />
          </div>
        </div>
        <DialogTitle className="text-center">
          Connect your GitHub repositories
        </DialogTitle>
        <DialogDescription className="text-center text-muted-foreground mt-3">
          Granting access allows the Terragon coding agent to write code and
          open pull requests on your behalf.
        </DialogDescription>
      </DialogHeader>
      <div className={cn("mt-6", hasRepos ? "h-[350px]" : "h-auto")}>
        <GithubStepContents
          onContinue={onContinue}
          repos={repos ?? null}
          githubTokenMissing={githubTokenMissing}
        />
      </div>
    </OnboardingDialogContent>
  );
}

function GithubStepContents({
  onContinue,
  repos,
  githubTokenMissing,
}: {
  onContinue: () => void;
  repos: UserRepo[] | null;
  githubTokenMissing: boolean;
}) {
  const hasRepos = repos && repos.length > 0;
  const queryClient = useQueryClient();
  const [isConnectingGithub, setIsConnectingGithub] = useState(false);

  const onPrimaryClick = () => {
    if (hasRepos) {
      onContinue();
      return;
    }
    if (githubTokenMissing) {
      // Email/password (or magic-link) accounts have no GitHub OAuth token,
      // so the App-install flow can't help — repos are listed with the USER
      // token. Send them through GitHub sign-in; better-auth matches the
      // existing github account row and stores the token on callback.
      void signInWithGithub({
        setLoading: setIsConnectingGithub,
        returnUrl: "/welcome",
        location: "onboarding",
      });
      return;
    }
    // Token is fine but no repos yet: the GitHub App isn't installed (or has
    // no repositories selected). Open the install popup and refetch on close.
    openGHAppInstallPopup(() => {
      queryClient.invalidateQueries({ queryKey: ["repos-onboarding"] });
    });
  };

  const primaryLabel = hasRepos
    ? "Continue"
    : githubTokenMissing
      ? "Connect GitHub Account"
      : "Grant Repository Access";

  return (
    <div
      className={cn(
        "flex flex-col",
        hasRepos ? "justify-between h-full" : "space-y-6",
      )}
    >
      {hasRepos ? (
        <ScrollArea className="h-full mb-4 overflow-y-auto pr-4">
          <div className="space-y-2">
            {repos.map((repo, index) => (
              <div
                key={repo.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-muted/20"
                style={{
                  animationDelay: `${index * 30}ms`,
                  animation: "fadeIn 0.3s ease-out forwards",
                  opacity: 0,
                }}
              >
                <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="text-sm font-medium">{repo.full_name}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : null}
      <div className="space-y-3">
        <div className="text-sm text-muted-foreground text-center">
          {githubTokenMissing ? (
            <>
              Your account isn't connected to GitHub yet. Connect it so
              Terragon can list your repositories.
            </>
          ) : (
            <>
              Don't see one of your repositories? <AdjustGitHubAppPermissions />
            </>
          )}
        </div>
        <Button
          className="w-full group"
          size="lg"
          disabled={isConnectingGithub}
          onClick={onPrimaryClick}
        >
          {isConnectingGithub ? (
            <Loader2 className="mr-2 w-4 h-4 animate-spin" />
          ) : null}
          <span>{primaryLabel}</span>
          <ArrowRight className="ml-2 w-4 h-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </div>
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

// Agent provider steps removed

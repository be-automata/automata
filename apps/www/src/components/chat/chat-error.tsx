import { Button } from "../ui/button";
import { RotateCcw, GitBranch, Loader2 } from "lucide-react";
import { Thread, ThreadErrorType } from "@terragon/shared";
import Link from "next/link";
import { isAgentWorking } from "@/agent/thread-status";
import { useTheme } from "next-themes";
import { ansiToHtml } from "./tools/utils";
import {
  describeProviderUnavailable,
  parseProviderUnavailableInfo,
} from "@/agent/msg/classify-provider-result";

const ERROR_TYPES_THAT_HIDE_RETRY_BUTTON = new Set<ThreadErrorType>([
  "no-user-message",
  "request-timeout",
  "unknown-error",
  "prompt-too-long",
]);

export function ChatError({
  errorType,
  errorInfo,
  status,
  handleRetry,
  isReadOnly,
  isRetrying,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
  status: Thread["status"];
  handleRetry: () => Promise<void>;
  isReadOnly: boolean;
  isRetrying?: boolean;
}) {
  const showRetryButton = !!(
    errorType &&
    !ERROR_TYPES_THAT_HIDE_RETRY_BUTTON.has(errorType as ThreadErrorType) &&
    !isAgentWorking(status) &&
    !isReadOnly
  );
  return (
    <div className="p-2 border border-destructive bg-destructive/10 rounded-md text-sm">
      <div className="flex gap-2 mb-1 justify-between items-start">
        <div className="min-w-0 flex-1">
          <ChatContent errorType={errorType} errorInfo={errorInfo} />
        </div>
        {showRetryButton && (
          <Button
            onClick={handleRetry}
            size="icon"
            variant="ghost"
            className="size-6 hover:bg-transparent hover:text-foreground flex-shrink-0"
            title="Retry"
            disabled={isRetrying}
          >
            {isRetrying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function ChatErrorContents({
  header,
  body,
}: {
  header: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 font-mono">
      <p className="text-xs font-medium flex items-center gap-1">{header}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

function ChatErrorContentsWithPre({
  header,
  errorStr,
  renderAnsi = false,
}: {
  header: React.ReactNode;
  errorStr: string | null;
  renderAnsi?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";

  return (
    <div className="flex flex-col gap-2 font-mono">
      <p className="text-xs font-medium flex items-center gap-1">{header}</p>
      {errorStr && (
        <p className="text-xs text-muted-foreground">
          {renderAnsi ? (
            <pre
              className="whitespace-pre-wrap break-words overflow-hidden"
              dangerouslySetInnerHTML={{
                __html: ansiToHtml(errorStr, theme),
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words overflow-hidden">
              {errorStr}
            </pre>
          )}
        </p>
      )}
    </div>
  );
}

function ChatContent({
  errorType,
  errorInfo,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
}) {
  const errorTypeStrict = errorType as ThreadErrorType;
  switch (errorTypeStrict) {
    case "invalid-claude-credentials": {
      return (
        <ChatErrorContents
          header="Claude credentials expired"
          body={
            <>
              Please update your Claude credentials to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to update your credentials.
            </>
          }
        />
      );
    }
    case "missing-gemini-credentials": {
      return (
        <ChatErrorContents
          header="Gemini API key required"
          body={
            <>
              Please add your Gemini API key to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to add your API key.
            </>
          }
        />
      );
    }
    case "missing-amp-credentials": {
      return (
        <ChatErrorContents
          header="Amp API key required"
          body={
            <>
              Please add your Amp API key to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to add your API key.
            </>
          }
        />
      );
    }
    case "chatgpt-sub-required": {
      return (
        <ChatErrorContents
          header="ChatGPT Subscription required"
          body={
            <>
              This model requires a ChatGPT Subscription. Choose a different
              model or connect your ChatGPT account to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to connect your account.
            </>
          }
        />
      );
    }
    case "invalid-codex-credentials": {
      return (
        <ChatErrorContents
          header="OpenAI credentials expired"
          body={
            <>
              Please update your OpenAI credentials to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to update your credentials.
            </>
          }
        />
      );
    }
    case "git-checkpoint-diff-failed": {
      return (
        <ChatErrorContentsWithPre
          header={
            <>
              <GitBranch className="size-3" /> Git checkpoint failed
            </>
          }
          errorStr={errorInfo}
        />
      );
    }
    case "git-checkpoint-push-failed": {
      return (
        <ChatErrorContentsWithPre
          header={
            <>
              <GitBranch className="size-3" /> Git push failed
            </>
          }
          errorStr={errorInfo}
        />
      );
    }
    case "request-timeout": {
      return (
        <ChatErrorContentsWithPre header="Request timed out" errorStr={null} />
      );
    }
    case "no-user-message": {
      return (
        <ChatErrorContentsWithPre
          header="No user message found"
          errorStr={errorInfo}
        />
      );
    }
    case "unknown-error": {
      return (
        <ChatErrorContentsWithPre header="Unknown Error" errorStr={errorInfo} />
      );
    }
    case "sandbox-not-found": {
      return (
        <ChatErrorContentsWithPre
          header="Sandbox not found"
          errorStr={errorInfo}
        />
      );
    }
    case "sandbox-creation-failed": {
      return (
        <ChatErrorContentsWithPre
          header="Sandbox creation failed"
          errorStr={errorInfo}
        />
      );
    }
    case "sandbox-resume-failed": {
      return (
        <ChatErrorContentsWithPre
          header="Sandbox failed to start"
          errorStr={errorInfo}
        />
      );
    }
    case "agent-not-responding":
      return (
        <ChatErrorContentsWithPre
          header="Agent did not respond. Please try again."
          errorStr={errorInfo}
        />
      );
    case "agent-generic-error": {
      return (
        <ChatErrorContentsWithPre
          header="Agent exited with an error"
          errorStr={errorInfo}
          renderAnsi
        />
      );
    }
    case "setup-script-failed": {
      return (
        <ChatErrorContentsWithPre
          header="terragon-setup.sh failed"
          errorStr={errorInfo}
          renderAnsi
        />
      );
    }
    case "prompt-too-long": {
      return (
        <ChatErrorContents
          header="Context window full"
          body={
            <>
              The context window is too long. Run `/compact` to clear the
              compress the context window.
            </>
          }
        />
      );
    }
    case "queue-limit-exceeded": {
      return (
        <ChatErrorContentsWithPre
          header="Task queue limit reached. Please try again later."
          errorStr={errorInfo}
        />
      );
    }
    case "provider-unavailable": {
      const provider = parseProviderUnavailableInfo(errorInfo);
      return (
        <ChatErrorContents
          header="Claude subscription unavailable"
          body={
            provider
              ? describeProviderUnavailable(provider)
              : "The connected Claude subscription refused this run."
          }
        />
      );
    }
    default: {
      const _exhaustiveCheck: never = errorTypeStrict;
      console.log("Unhandled error", _exhaustiveCheck);
    }
    // TODO: make typescript error here if non-exhaustive
  }

  // Backwards compatibility
  if (errorType || errorInfo) {
    const errorStr = [errorType, errorInfo].filter(Boolean).join("\n\n");
    return (
      <ChatErrorContentsWithPre
        header="An error occurred"
        errorStr={errorStr}
      />
    );
  }

  return (
    <ChatErrorContentsWithPre
      header="An unexpected error occurred"
      errorStr={null}
    />
  );
}

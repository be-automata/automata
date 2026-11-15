import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useThreadDetail } from "../hooks/useApi.js";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ThreadSelector } from "../components/ThreadSelector.js";
import { launchClaude } from "../utils/claude.js";
import { useCurrentGitHubRepo } from "../hooks/useGitInfo.js";
import {
  assertSafeBranchName,
  InvalidBranchNameError,
  runGit,
} from "../utils/git.js";

interface ProcessingResult {
  success: boolean;
  error?: string;
  gitRoot?: string;
  cwdWithHyphens?: string;
  sessionId?: string;
}

// Find git repository root
async function findGitRoot(): Promise<{ gitRoot?: string; error?: string }> {
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"]);
    const gitRoot = stdout.trim();
    return { gitRoot };
  } catch (err) {
    return { error: "Not in a git repository" };
  }
}

// Switch to and pull the specified branch
async function switchToBranch(
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await assertSafeBranchName(branchName);
  } catch (err) {
    if (err instanceof InvalidBranchNameError) {
      return { success: false, error: err.message };
    }
    throw err;
  }

  try {
    // First check if working directory is clean
    const { stdout: statusOutput } = await runGit(["status", "--porcelain"]);
    if (statusOutput.trim()) {
      return {
        success: false,
        error: `Cannot switch branches: you have uncommitted changes. Please commit or stash your changes before running 'terry pull'.`,
      };
    }

    // Fetch to ensure we have the latest remote info
    await runGit(["fetch"]);

    // Check if branch exists locally
    let branchExists = false;
    try {
      await runGit([
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      branchExists = true;
    } catch {
      // Branch doesn't exist locally
    }

    if (branchExists) {
      // Switch to branch
      await runGit(["checkout", branchName]);
      // Pull latest changes
      await runGit(["pull"]);
    } else {
      // Create and checkout branch from remote if it exists
      try {
        await runGit(["checkout", "-b", branchName, `origin/${branchName}`]);
      } catch {
        return {
          success: false,
          error: `Branch ${branchName} not found on remote`,
        };
      }
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Failed to pull branch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Save session data to JSONL file
async function saveSessionData(
  sessionId: string,
  cwdWithHyphens: string,
  jsonl: any[],
): Promise<string> {
  const claudeDir = join(homedir(), ".claude", "projects", cwdWithHyphens);
  await fs.mkdir(claudeDir, { recursive: true });

  const jsonlPath = join(claudeDir, `${sessionId}.jsonl`);
  const jsonlContent = jsonl.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(jsonlPath, jsonlContent);

  return jsonlPath;
}

// Process the session data after fetching
async function processSessionData(
  data: any,
  setProcessingStatus: (status: string) => void,
  onComplete: (sessionId: string) => void,
): Promise<ProcessingResult> {
  try {
    // Step 1: Find git repository root and cd into it
    setProcessingStatus("Finding git repository root...");
    const { gitRoot, error: gitError } = await findGitRoot();
    if (gitError || !gitRoot) {
      return { success: false, error: gitError };
    }

    // Change to git root directory
    process.chdir(gitRoot);
    setProcessingStatus(`Changed to git root: ${gitRoot}`);

    // Step 2: Pull latest version of branch if branchName exists
    if (data.branchName) {
      setProcessingStatus(
        `Pulling latest version of branch: ${data.branchName}`,
      );
      const { success, error: branchError } = await switchToBranch(
        data.branchName,
      );
      if (!success) {
        return { success: false, error: branchError };
      }
      setProcessingStatus(
        `Successfully switched to branch: ${data.branchName}`,
      );
    }

    // Step 3: Get cwd and replace "/" with "-"
    const cwd = process.cwd();
    const cwdWithHyphens = cwd.replace(/\//g, "-");
    setProcessingStatus(`Project directory: ${cwdWithHyphens}`);

    // Step 4: Write sessionData.jsonl to ~/.claude/projects/{dir}/{sessionId}.jsonl
    if (data.jsonl && data.jsonl.length > 0) {
      const jsonlPath = await saveSessionData(
        data.sessionId,
        cwdWithHyphens,
        data.jsonl,
      );
      setProcessingStatus(`Saved session data to: ${jsonlPath}`);
    }

    // Step 5: Session is ready
    setProcessingStatus(`Session ready: ${data.sessionId}`);

    // Notify completion
    setTimeout(() => {
      onComplete(data.sessionId);
    }, 1000); // Small delay to allow status messages to be displayed

    return {
      success: true,
      gitRoot,
      cwdWithHyphens,
      sessionId: data.sessionId,
    };
  } catch (err) {
    return {
      success: false,
      error: `Processing error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function PullCommand({
  threadId,
  resume,
}: {
  threadId?: string;
  resume?: boolean;
}) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    threadId,
  );
  const [processingStatus, setProcessingStatus] = useState<string>("");
  const [processingError, setProcessingError] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(
    null,
  );
  const repoQuery = useCurrentGitHubRepo();
  const currentRepo = repoQuery.data;

  const {
    data: sessionData,
    isLoading,
    error: sessionFetchError,
  } = useThreadDetail(selectedThreadId);

  useEffect(() => {
    if (!sessionData) return;

    const process = async () => {
      setIsProcessing(true);
      // Process the session data after successful fetch
      const result = await processSessionData(
        sessionData,
        setProcessingStatus,
        (sessionId) => {
          setCompletedSessionId(sessionId);
          setIsProcessing(false);

          // Launch Claude if resume flag is set
          if (resume) {
            // Give a brief delay to ensure the UI updates
            setTimeout(() => {
              launchClaude(sessionId);
            }, 100);
          }
        },
      );
      if (!result.success) {
        setProcessingError(result.error || "Unknown error during processing");
        setIsProcessing(false);
      }
    };

    process();
  }, [sessionData, resume]);

  const handleThreadSelect = (threadId: string) => {
    setSelectedThreadId(threadId);
  };

  if (!selectedThreadId) {
    return (
      <ThreadSelector
        onSelect={handleThreadSelect}
        currentRepo={currentRepo || undefined}
      />
    );
  }

  if (sessionFetchError) {
    return (
      <Box flexDirection="column">
        <Text color="red">
          Error:{" "}
          {sessionFetchError instanceof Error
            ? sessionFetchError.message
            : String(sessionFetchError)}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Loading or Success state */}
      <Box>
        {isLoading ? (
          <>
            <Text>
              <Spinner type="dots" />
            </Text>
            <Text> Fetching session for task {selectedThreadId}...</Text>
          </>
        ) : sessionData ? (
          <Text color="green">✓ Session fetched successfully</Text>
        ) : (
          <Text color="red">Error: No session data</Text>
        )}
      </Box>

      {/* Session details as table */}
      {sessionData && !isLoading && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Box width={15}>
              <Text dimColor>Name</Text>
            </Box>
            <Text>{sessionData.name}</Text>
          </Box>
          <Box>
            <Box width={15}>
              <Text dimColor>Branch</Text>
            </Box>
            <Text>{sessionData.branchName || "N/A"}</Text>
          </Box>
          <Box>
            <Box width={15}>
              <Text dimColor>Repository</Text>
            </Box>
            <Text>{sessionData.githubRepoFullName || "N/A"}</Text>
          </Box>
          <Box>
            <Box width={15}>
              <Text dimColor>PR Number</Text>
            </Box>
            <Text>
              {sessionData.githubPRNumber
                ? `#${sessionData.githubPRNumber}`
                : "N/A"}
            </Text>
          </Box>
        </Box>
      )}

      {processingError && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Error: {processingError}</Text>
        </Box>
      )}

      {/* Processing status or Completion message */}
      {completedSessionId ? (
        <Box marginTop={1} flexDirection="column">
          <Text> </Text>
          {resume ? (
            <Text color="green">Launching Claude...</Text>
          ) : sessionData?.agent === "claudeCode" ? (
            <>
              <Text color="yellow">To continue this session, run:</Text>
              <Box
                marginLeft={2}
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
              >
                <Text color="cyan">claude --resume {completedSessionId}</Text>
              </Box>
            </>
          ) : (
            <Text color="green">Session ready</Text>
          )}
        </Box>
      ) : (
        isProcessing &&
        processingStatus && (
          <Box marginTop={1}>
            <Text>
              <Spinner type="dots" />
            </Text>
            <Text> {processingStatus}</Text>
          </Box>
        )
      )}
    </Box>
  );
}

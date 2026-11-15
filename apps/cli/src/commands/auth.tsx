import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { createServer } from "http";
import { execFile } from "child_process";
import { useSaveApiKey } from "../hooks/useApi.js";

const AUTH_PORT = 8742; // Uncommon port
const TERRAGON_WEB_URL =
  process.env.TERRAGON_WEB_URL || "http://localhost:3000";

function openBrowser(url: string) {
  // `start` is a cmd builtin on Windows; the empty string is its window title.
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(command, args, (error) => {
    if (error) {
      console.error("Failed to open browser:", error);
    }
  });
}

interface AuthServerCallbacks {
  onError: (error: Error) => void;
  onApiKeyReceived: (apiKey: string) => void;
}

function createAuthServer({ onError, onApiKeyReceived }: AuthServerCallbacks) {
  return createServer(async (req, res) => {
    // Set CORS headers for all requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/auth") {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const { apiKey } = JSON.parse(body);

          if (!apiKey) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "API key required" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));

          onApiKeyReceived(apiKey);
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to process API key" }));

          onError(error instanceof Error ? error : new Error("Unknown error"));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

interface AuthCommandProps {
  apiKey?: string;
}

export function AuthCommand({ apiKey: providedApiKey }: AuthCommandProps) {
  const [status, setStatus] = useState<
    "waiting" | "authenticating" | "success" | "error"
  >("waiting");
  const [message, setMessage] = useState("");
  const [manualApiKey, setManualApiKey] = useState("");
  const [browserOpened, setBrowserOpened] = useState(false);
  const saveApiKeyMutation = useSaveApiKey();

  const handleApiKey = async (apiKey: string) => {
    setStatus("authenticating");
    try {
      await saveApiKeyMutation.mutateAsync(apiKey);
      setStatus("success");
      setMessage("API key saved successfully!");
      setTimeout(() => {
        process.exit(0);
      }, 2000);
    } catch (error) {
      setStatus("error");
      setMessage(
        `Failed to save API key: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  useEffect(() => {
    // If API key is provided as argument, use it immediately
    if (providedApiKey) {
      handleApiKey(providedApiKey);
      return;
    }
    // Set up the server for automatic auth
    if (status !== "waiting") {
      return;
    }
    const server = createAuthServer({
      onError: (error) => {
        // Silent fail - user can still paste manually
      },
      onApiKeyReceived: handleApiKey,
    });
    server.listen(AUTH_PORT, () => {
      setBrowserOpened(true);
      openBrowser(`${TERRAGON_WEB_URL}/cli/auth`);
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      // Silent fail - user can still paste manually
      if (error.code === "EADDRINUSE") {
        // Port in use, but still allow manual paste
      }
    });
    return () => {
      server.close();
    };
  }, [providedApiKey, status]);

  return (
    <Box flexDirection="column" paddingY={1}>
      {status === "success" ? (
        <Text color="green">✓ {message}</Text>
      ) : (
        <>
          {browserOpened && (
            <Box marginBottom={1} flexDirection="column">
              <Text>
                A browser window should open for automatic authentication.
              </Text>
              <Text dimColor>
                If auto auth doesn't work, you can manually paste the code
                below.
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text>
              Visit: <Text color="blue">{TERRAGON_WEB_URL}/cli/auth</Text>
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text>Paste the code from the browser: </Text>
          </Box>

          <Box marginTop={1}>
            <TextInput
              value={manualApiKey}
              onChange={setManualApiKey}
              onSubmit={() => {
                if (manualApiKey.trim()) {
                  handleApiKey(manualApiKey.trim());
                }
              }}
              placeholder="ter_..."
            />
          </Box>

          {status === "authenticating" && (
            <Box marginTop={1}>
              <Text color="yellow">
                <Spinner type="dots" /> Authenticating...
              </Text>
            </Box>
          )}

          {status === "error" && (
            <Box marginTop={1}>
              <Text color="red">✗ {message}</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

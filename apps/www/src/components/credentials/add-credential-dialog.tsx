"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye, EyeOff, ChevronDown, ChevronRight } from "lucide-react";
import {
  useExchangeClaudeAuthorizationCodeMutation,
  useSaveClaudeSetupTokenMutation,
  useSaveCodexAuthJsonMutation,
  useSaveApiKeyMutation,
} from "@/queries/credentials-queries";
import type { AuthType } from "@/lib/claude-oauth";
import { Textarea } from "@/components/ui/textarea";
import { AIAgent } from "@terragon/agent/types";

type ApiKeyConfig = {
  agent: AIAgent;
  agentName: string;
  placeholder: string;
  validatePrefix: string;
  helpText: React.ReactNode;
};

const API_KEY_CONFIGS = {
  amp: {
    agent: "amp" as const,
    agentName: "Amp",
    placeholder: "sgamp_user...",
    validatePrefix: "sgamp_user",
    helpText: (
      <>
        Enter your Amp API key to use the Amp model. Get one from your{" "}
        <a
          href="https://ampcode.com/settings"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Amp Code Settings Page
        </a>
      </>
    ),
  },
  gemini: {
    agent: "gemini" as const,
    agentName: "Gemini",
    placeholder: "AIza...",
    validatePrefix: "AIza",
    helpText: (
      <>
        Enter your Gemini API key to use the Gemini model. Get one at{" "}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Google AI Studio
        </a>
      </>
    ),
  },
} as const satisfies Record<string, ApiKeyConfig>;

// Generic API key dialog for providers that only support API keys
function AddApiKeyDialog({
  open,
  onOpenChange,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: ApiKeyConfig;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const saveApiKeyMutation = useSaveApiKeyMutation();

  const resetForm = () => {
    setApiKey("");
    setShowApiKey(false);
  };

  const validateApiKey = (key: string) => {
    return key.startsWith(config.validatePrefix);
  };

  const handleSubmit = async () => {
    if (!apiKey) {
      toast.error(`Please enter a ${config.agentName} API key`);
      return;
    }
    if (!validateApiKey(apiKey)) {
      toast.error(
        `Invalid API key format. Please check your ${config.agentName} API key.`,
      );
      return;
    }
    await saveApiKeyMutation.mutateAsync({ agent: config.agent, apiKey });
    onOpenChange(false);
    resetForm();
  };

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config.agentName}</DialogTitle>
          <DialogDescription>
            Add your {config.agentName} API key.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{config.helpText}</p>
          <div className="relative">
            <Input
              id="apiKey"
              type={showApiKey ? "text" : "password"}
              placeholder={config.placeholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value.trim())}
              className="pr-10"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-0 top-0 h-full px-3"
            >
              {showApiKey ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!apiKey || saveApiKeyMutation.isPending}
          >
            {saveApiKeyMutation.isPending ? "Adding..." : "Add Credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Specific dialog exports using the generic component
export function AddAmpCredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AddApiKeyDialog
      open={open}
      onOpenChange={onOpenChange}
      config={API_KEY_CONFIGS.amp}
    />
  );
}

export function AddGeminiCredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AddApiKeyDialog
      open={open}
      onOpenChange={onOpenChange}
      config={API_KEY_CONFIGS.gemini}
    />
  );
}

// Claude dialog with subscription OAuth or API key
export function AddClaudeCredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<
    "api-key" | "subscription" | "setup-token" | null
  >(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [showSetupToken, setShowSetupToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authType, setAuthType] = useState<AuthType | null>(null);
  const [codeVerifier, setCodeVerifier] = useState("");
  const [authCode, setAuthCode] = useState("");

  const saveApiKeyMutation = useSaveApiKeyMutation();
  const saveSetupTokenMutation = useSaveClaudeSetupTokenMutation();
  const exchangeCodeMutation = useExchangeClaudeAuthorizationCodeMutation();

  const resetForm = () => {
    setMode(null);
    setApiKey("");
    setShowApiKey(false);
    setSetupToken("");
    setShowSetupToken(false);
    setCodeVerifier("");
    setAuthCode("");
    setAuthType(null);
    setLoading(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      if (event.data.type === "claude-oauth-started") {
        setCodeVerifier(event.data.codeVerifier);
        setLoading(false);
        toast.info(
          "Complete authentication in the popup window, then paste the code below",
        );
      } else if (event.data.type === "claude-oauth-error") {
        setLoading(false);
        toast.error(
          event.data.error || "Authentication failed. Please try again.",
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [open]);

  const handleStartClaudeAuth = async (type: AuthType) => {
    setLoading(true);
    setAuthType(type);

    const width = 900;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      `/auth/claude-redirect?type=${type}`,
      "claude-oauth",
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    );

    if (!popup) {
      window.location.href = `/auth/claude-redirect?type=${type}`;
    }
  };

  const handleExchangeCode = async () => {
    if (!authCode || !codeVerifier || !authType) {
      toast.error("Please complete the authentication flow first");
      return;
    }
    const [actualCode, state] = authCode.split("#");
    if (!state || !actualCode) {
      toast.error(
        "Invalid code format. Please paste the complete URL from the authentication window.",
      );
      return;
    }
    await exchangeCodeMutation.mutateAsync({
      code: actualCode,
      codeVerifier,
      state,
      authType,
    });
    onOpenChange(false);
    resetForm();
  };

  const handleSaveSetupToken = async () => {
    // Mirror the server's cross-field check so the likely mistake — pasting an
    // API key here — is named before a round-trip, not after.
    if (setupToken.startsWith("sk-ant-api")) {
      toast.error('That is an Anthropic API key. Use "Add API Key" instead.');
      return;
    }
    if (!setupToken.startsWith("sk-ant-oat")) {
      toast.error(
        "That does not look like a `claude setup-token` token — it should start with sk-ant-oat.",
      );
      return;
    }
    await saveSetupTokenMutation.mutateAsync({ token: setupToken });
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = async () => {
    if (!apiKey) {
      toast.error("Please enter a Claude API key");
      return;
    }
    if (!apiKey.startsWith("sk-ant-")) {
      toast.error("Invalid API key format. Please check your Claude API key.");
      return;
    }
    await saveApiKeyMutation.mutateAsync({ agent: "claudeCode", apiKey });
    onOpenChange(false);
    resetForm();
  };

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claude</DialogTitle>
          <DialogDescription>
            {mode === null
              ? "Choose how you'd like to add credentials for Claude."
              : mode === "api-key"
                ? "Add a new API key for Claude."
                : "Connect your Claude subscription."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {mode === null ? (
            <div className="space-y-3">
              <Button
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setMode("subscription");
                  handleStartClaudeAuth("subscription");
                }}
                disabled={loading}
              >
                {loading && authType === "subscription"
                  ? "Opening..."
                  : "Connect Claude subscription"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => setMode("setup-token")}
              >
                Connect with a setup token
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => setMode("api-key")}
              >
                Add API Key
              </Button>
            </div>
          ) : mode === "setup-token" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Run this locally to mint a long-lived token from your Claude
                subscription, then paste it below.
              </p>
              <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
                <code>{`# requires a Claude subscription
claude setup-token`}</code>
              </pre>
              <div className="relative">
                <Input
                  id="setupToken"
                  type={showSetupToken ? "text" : "password"}
                  placeholder="sk-ant-oat01-..."
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value.trim())}
                  className="pr-10"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowSetupToken(!showSetupToken)}
                  className="absolute right-0 top-0 h-full px-3"
                >
                  {showSetupToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Starts with <code>sk-ant-oat</code> and lasts for months. It is
                used only to run your agents. If it stops working, run{" "}
                <code>claude setup-token</code> again and paste the new one.
              </p>
            </div>
          ) : mode === "api-key" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Enter your Anthropic API key. Create one at{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  console.anthropic.com
                </a>
              </p>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? "text" : "password"}
                  placeholder="sk-ant-api03-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value.trim())}
                  className="pr-10"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-0 top-0 h-full px-3"
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {!codeVerifier ? (
                <p className="text-sm text-muted-foreground">
                  Complete the authentication in the popup window, then paste
                  the code below.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Authorize Claude in the new window, then paste code below:
                  </p>
                  <input
                    type="text"
                    placeholder="Paste authentication code"
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value.trim())}
                    className="w-full px-3 py-2 border rounded-md text-sm"
                  />
                </>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          {mode === "api-key" && (
            <Button
              onClick={handleSubmit}
              disabled={!apiKey || saveApiKeyMutation.isPending}
            >
              {saveApiKeyMutation.isPending ? "Adding..." : "Add Credential"}
            </Button>
          )}
          {mode === "setup-token" && (
            <Button
              onClick={handleSaveSetupToken}
              disabled={!setupToken || saveSetupTokenMutation.isPending}
            >
              {saveSetupTokenMutation.isPending ? "Connecting..." : "Connect"}
            </Button>
          )}
          {mode === "subscription" && codeVerifier && (
            <Button
              onClick={handleExchangeCode}
              disabled={!authCode || exchangeCodeMutation.isPending}
            >
              {exchangeCodeMutation.isPending ? "Connecting..." : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Codex dialog with ChatGPT subscription (auth.json) or API key
export function AddCodexCredentialDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"api-key" | "subscription" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [authJson, setAuthJson] = useState("");
  const [showCodexHelp, setShowCodexHelp] = useState(false);

  const saveApiKeyMutation = useSaveApiKeyMutation();
  const saveCodexMutation = useSaveCodexAuthJsonMutation();

  const resetForm = () => {
    setMode(null);
    setApiKey("");
    setShowApiKey(false);
    setAuthJson("");
  };

  const handleSaveCodexAuth = async () => {
    let parsed: any;
    try {
      parsed = JSON.parse(authJson);
    } catch (e) {
      toast.error(
        "Invalid JSON format. Please check your auth.json and try again.",
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      toast.error("Invalid auth.json. Make sure it contains valid token data.");
      return;
    }
    await saveCodexMutation.mutateAsync({
      authJson: JSON.stringify(parsed),
    });
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = async () => {
    if (!apiKey) {
      toast.error("Please enter an OpenAI API key");
      return;
    }
    if (!apiKey.startsWith("sk-")) {
      toast.error("Invalid API key format. Please check your OpenAI API key.");
      return;
    }
    await saveApiKeyMutation.mutateAsync({ agent: "codex", apiKey });
    onOpenChange(false);
    resetForm();
  };

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Codex</DialogTitle>
          <DialogDescription>
            {mode === null
              ? "Choose how you'd like to add credentials for Codex."
              : mode === "api-key"
                ? "Add a new API key for Codex."
                : "Connect your ChatGPT subscription."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {mode === null ? (
            <div className="space-y-3">
              <Button
                size="sm"
                className="w-full justify-start"
                onClick={() => setMode("subscription")}
              >
                Connect ChatGPT subscription
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => setMode("api-key")}
              >
                Add API Key
              </Button>
            </div>
          ) : mode === "api-key" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Enter your OpenAI API key. Get one from{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  platform.openai.com/api-keys
                </a>
              </p>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? "text" : "password"}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value.trim())}
                  className="pr-10"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-0 top-0 h-full px-3"
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Log in to ChatGPT in a terminal, then paste your{" "}
                <code className="font-mono rounded bg-muted px-1">
                  ~/.codex/auth.json
                </code>{" "}
                below:
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-0 text-xs text-muted-foreground justify-start"
                onClick={() => setShowCodexHelp((v) => !v)}
              >
                {showCodexHelp ? (
                  <ChevronDown className="mr-1 h-3 w-3" />
                ) : (
                  <ChevronRight className="mr-1 h-3 w-3" />
                )}
                {showCodexHelp
                  ? "Hide setup instructions"
                  : "How to get auth.json"}
              </Button>
              {showCodexHelp && (
                <div className="mt-2 space-y-2 text-sm">
                  <pre className="rounded-md bg-muted p-2 overflow-x-auto">
                    <code>{`# Install Codex
npm install -g @openai/codex

# Log in to ChatGPT
codex login

# Copy auth.json (macOS)
cat ~/.codex/auth.json | pbcopy`}</code>
                  </pre>
                  <p className="text-muted-foreground">Then paste it below.</p>
                </div>
              )}
              <Textarea
                placeholder={`{\n  "tokens": {\n    "access_token": "...",\n    "refresh_token": "...",\n    "id_token": "..."\n  }\n}`}
                value={authJson}
                onChange={(e) => setAuthJson(e.target.value)}
                className="min-h-24 max-h-48 overflow-x-auto font-mono break-all"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          {mode === "api-key" && (
            <Button
              onClick={handleSubmit}
              disabled={!apiKey || saveApiKeyMutation.isPending}
            >
              {saveApiKeyMutation.isPending ? "Adding..." : "Add Credential"}
            </Button>
          )}
          {mode === "subscription" && (
            <Button
              onClick={handleSaveCodexAuth}
              disabled={saveCodexMutation.isPending}
            >
              {saveCodexMutation.isPending ? "Connecting..." : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

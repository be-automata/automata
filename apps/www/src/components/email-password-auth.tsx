"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";

/**
 * Email + password sign-in / sign-up form.
 *
 * Rendered only when the server reports email/password auth is enabled
 * (AUTH_EMAIL_PASSWORD_ENABLED — self-host bootstrap). Hosted deployments are
 * OAuth-only and never render this. Email verification is off server-side, so
 * a new account gets a session immediately with no SMTP round-trip.
 */
export function EmailPasswordAuth({ returnUrl }: { returnUrl: string }) {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const isSignUp = mode === "signUp";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const onSuccess = () => {
        window.location.href = returnUrl;
      };
      if (isSignUp) {
        const { error } = await authClient.signUp.email({
          email,
          password,
          // Better Auth requires a name on sign-up; default to the local part.
          name: name.trim() || email.split("@")[0] || email,
        });
        if (error) {
          toast.error(error.message ?? "Could not create account");
          return;
        }
        onSuccess();
      } else {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) {
          toast.error(error.message ?? "Could not sign in");
          return;
        }
        onSuccess();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {isSignUp && (
        <Input
          type="text"
          autoComplete="name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={loading}
        />
      )}
      <Input
        type="email"
        required
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={loading}
      />
      <Input
        type="password"
        required
        minLength={8}
        autoComplete={isSignUp ? "new-password" : "current-password"}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={loading}
      />
      <Button
        type="submit"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={loading}
      >
        {loading
          ? isSignUp
            ? "Creating account..."
            : "Signing in..."
          : isSignUp
            ? "Create account"
            : "Sign in with email"}
      </Button>
      <button
        type="button"
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setMode(isSignUp ? "signIn" : "signUp")}
        disabled={loading}
      >
        {isSignUp
          ? "Already have an account? Sign in"
          : "No account? Create one"}
      </button>
    </form>
  );
}

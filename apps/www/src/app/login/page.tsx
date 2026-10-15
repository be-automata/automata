import { getUserIdOrNull } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import Login from "./login";
import type { Metadata } from "next";
import { env } from "@terragon/env/apps-www";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "@/lib/safe-return-path";

export const metadata: Metadata = {
  title: "Login | Terragon",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnUrl?: string | string[] }>;
}) {
  const userId = await getUserIdOrNull();
  // Attacker-controlled: only a same-origin path may become a redirect.
  const returnUrl =
    safeReturnPath((await searchParams).returnUrl) ?? DEFAULT_RETURN_PATH;
  if (userId) {
    redirect(returnUrl);
  }

  return (
    <Login
      returnUrl={returnUrl}
      emailPasswordEnabled={env.AUTH_EMAIL_PASSWORD_ENABLED}
    />
  );
}

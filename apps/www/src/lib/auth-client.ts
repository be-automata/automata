import { createAuthClient } from "better-auth/react";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  magicLinkClient,
  adminClient,
  organizationClient,
} from "better-auth/client/plugins";
// Moved out of better-auth core in 1.5 (see apps/www/src/lib/auth.ts).
import { apiKeyClient } from "@better-auth/api-key/client";
import { stripeClient } from "@better-auth/stripe/client";

export const authClient = createAuthClient({
  baseURL: publicAppUrl(),
  plugins: [
    apiKeyClient(),
    magicLinkClient(),
    adminClient(),
    organizationClient(),
    stripeClient({
      subscription: true, //if you want to enable subscription management
    }),
  ],
});

import { createAuthClient } from "better-auth/react";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  apiKeyClient,
  magicLinkClient,
  adminClient,
  organizationClient,
} from "better-auth/client/plugins";
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

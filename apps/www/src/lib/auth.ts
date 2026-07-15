import * as schema from "@terragon/shared/db/schema";
import { betterAuth } from "better-auth";
import {
  bearer,
  magicLink,
  apiKey,
  admin,
  organization,
  createAuthMiddleware,
} from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { stripe as createStripePlugin } from "@better-auth/stripe";
import { db } from "./db";
import { env } from "@terragon/env/apps-www";
import { Resend } from "resend";
import { encryptToken } from "@terragon/utils/encryption";
import { getPostHogServer } from "./posthog-server";
import { nonLocalhostPublicAppUrl } from "./server-utils";
import { publicAppUrl } from "@terragon/env/next-public";
import { handleStripeCreditTopUpEvent } from "@/server-lib/stripe-credit-top-ups";
import { maybeGrantSignupBonus } from "@/server-lib/credits";
import { handlePromotionCodeCheckoutSessionCompleted } from "./stripe-promotion-codes";
import Stripe from "stripe";
import { LoopsClient } from "loops";
import { getUnusedPromotionCodeForUser } from "@terragon/shared/model/subscription";
import {
  STRIPE_PLAN_CONFIGS,
  getStripeWebhookSecret,
} from "@/server-lib/stripe";
import { getStripeClient } from "@/server-lib/stripe";
import { isStripeConfigured } from "@/server-lib/stripe";

const stripePlugins = (() => {
  if (!isStripeConfigured()) {
    return [];
  }
  const stripeClient = getStripeClient();
  return [
    createStripePlugin({
      stripeClient,
      stripeWebhookSecret: getStripeWebhookSecret(),
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: STRIPE_PLAN_CONFIGS,
        // Configure Stripe Checkout session parameters globally
        // so all upgrade flows use the Better Auth checkout.
        getCheckoutSessionParams: async (
          { user, plan, subscription },
          _request,
        ) => {
          try {
            // Only attempt to auto-apply a one-time promo when the user
            // does not already have an active subscription context.
            // Additionally, verify with Stripe that the code is still
            // active and has not been redeemed yet.
            const promo = await getUnusedPromotionCodeForUser({
              db,
              userId: user.id,
            });
            let discounts:
              | Stripe.Checkout.SessionCreateParams.Discount[]
              | undefined;
            if (promo?.stripePromotionCodeId) {
              try {
                const promotion = await stripeClient.promotionCodes.retrieve(
                  promo.stripePromotionCodeId,
                );

                const timesRedeemed = promotion.times_redeemed ?? 0;
                const isActive = promotion.active ?? false;

                // Only auto-apply if it's active and has not been used.
                if (isActive && timesRedeemed === 0) {
                  discounts = [{ promotion_code: promo.stripePromotionCodeId }];
                }
              } catch (stripeErr) {
                // If Stripe lookup fails, skip auto-apply (user can still enter code manually)
                console.warn(
                  "Stripe promotion code lookup failed; continuing without auto-apply",
                  stripeErr,
                );
              }
            }

            return {
              params: {
                custom_text: {
                  submit: {
                    message: "We'll start your subscription right away",
                  },
                },
                ...(discounts ? { discounts } : {}),
              },
              options: {
                idempotencyKey: `sub_${user.id}_${plan.name}_${Date.now()}`,
              },
            } as const;
          } catch (err) {
            // If any lookup fails, fall back to default params while still
            // enabling promotion code entry for the user.
            return {
              params: {
                custom_text: {
                  submit: {
                    message: "We'll start your subscription right away",
                  },
                },
              },
              options: {
                idempotencyKey: `sub_${user.id}_${plan.name}_${Date.now()}`,
              },
            } as const;
          }
        },
      },
      onEvent: async (event) => {
        await handlePromotionCodeCheckoutSessionCompleted({
          event,
          stripeClient,
        });
        await handleStripeCreditTopUpEvent(event);
      },
    }),
  ] as const;
})();

export const auth = betterAuth({
  baseUrl:
    process.env.NEXT_PUBLIC_VERCEL_ENV !== "preview"
      ? env.BETTER_AUTH_URL
      : `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  user: {
    additionalFields: {
      signupTrialPlan: {
        type: "string",
      },
    },
  },
  // Email/password is off by default (hosted = OAuth-only). Self-host enables it
  // (AUTH_EMAIL_PASSWORD_ENABLED=true) so a fresh instance can bootstrap the
  // first account with no SMTP and no GitHub OAuth handshake. Email verification
  // is deliberately OFF here — requiring it would gate first sign-in behind the
  // same SMTP that self-host doesn't have. autoSignIn (default) means sign-up
  // yields a session immediately.
  emailAndPassword: {
    enabled: env.AUTH_EMAIL_PASSWORD_ENABLED,
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 60, // 60 days (2 months)
    updateAge: 60 * 60 * 24, // Update session if it's older than 1 day
  },
  hooks: {
    after: createAuthMiddleware(async (context) => {
      if (context.request && context.path === "/callback/:id") {
        const url = new URL(context.request.url);
        const state = url.searchParams.get("state");
        if (state === "close") {
          // This will be handled on the client side to close the window
          return new Response(
            "<html><body><script>window.close();</script></body></html>",
            {
              status: 200,
              headers: {
                "Content-Type": "text/html",
              },
            },
          );
        }
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          getPostHogServer().capture({
            distinctId: user.id,
            event: "user_created",
            properties: {
              name: user.name,
              email: user.email,
              signupMethod: "open_signup",
            },
          });

          // Create Loops contact + event (best-effort)
          try {
            if (env.LOOPS_API_KEY && user.email) {
              const loops = new LoopsClient(env.LOOPS_API_KEY);
              await loops.createContact({
                email: user.email,
                properties: {
                  name: user.name ?? undefined,
                  userId: user.id,
                  source: "signup",
                },
              });
              // Also log a user_created event for workflows
              await loops.sendEvent({
                email: user.email,
                eventName: "user_created",
                eventProperties: {
                  userId: user.id,
                },
              });
            }
          } catch (err) {
            console.warn("Loops createContact/sendEvent failed", err);
          }
        },
      },
    },
    account: {
      create: {
        before: async (account) => {
          const accountWithEncryptedTokens = { ...account };
          if (account.accessToken) {
            accountWithEncryptedTokens.accessToken = encryptToken(
              account.accessToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          if (account.refreshToken) {
            accountWithEncryptedTokens.refreshToken = encryptToken(
              account.refreshToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          if (account.idToken) {
            accountWithEncryptedTokens.idToken = encryptToken(
              account.idToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          return {
            data: accountWithEncryptedTokens,
          };
        },
        after: async (account) => {
          await maybeGrantSignupBonus({ db, userId: account.userId });
        },
      },
      update: {
        before: async (account) => {
          const accountWithEncryptedTokens = { ...account };
          if (account.accessToken) {
            accountWithEncryptedTokens.accessToken = encryptToken(
              account.accessToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          if (account.refreshToken) {
            accountWithEncryptedTokens.refreshToken = encryptToken(
              account.refreshToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          if (account.idToken) {
            accountWithEncryptedTokens.idToken = encryptToken(
              account.idToken,
              env.ENCRYPTION_MASTER_KEY,
            );
          }
          return {
            data: accountWithEncryptedTokens,
          };
        },
      },
    },
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  },
  plugins: [
    admin(),
    bearer(),
    apiKey({
      maximumNameLength: 64,
      rateLimit: {
        enabled: false,
      },
      // Enable per-key metadata so the daemon-token path can carry an
      // organizationId alongside the userId (see auth-server.ts). The
      // dedicated column retrofit lands with the WI-5c schema sweep.
      enableMetadata: true,
    }),
    // Tenant boundary. Each org maps to a Hatchet tenant + org-scoped rows.
    // Adds organization/member/invitation tables + session.activeOrganizationId
    // (Drizzle mapping in @terragon/shared/db/schema). See ADR-001.
    organization(),
    magicLink({
      expiresIn: 15 * 60, // 15 minutes
      sendMagicLink: async ({ email, url: rawUrl }) => {
        const url =
          process.env.NEXT_PUBLIC_VERCEL_ENV === "preview"
            ? rawUrl.replace(
                "https://www.terragonlabs.com",
                `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
              )
            : rawUrl;
        const resend = new Resend(env.RESEND_API_KEY ?? "DUMMY_KEY");
        const result = await resend.emails.send({
          from: "Terry <onboarding@mail.terragonlabs.com>",
          to: email,
          subject: "Sign in to Terragon",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Sign in to Terragon</h2>
              <p>Hello,</p>
              <p>Click the link below to sign in to your Terragon account:</p>
              <a href="${url}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; margin: 16px 0;">Sign in to Terragon</a>
              <p style="color: #666; font-size: 14px;">This link will expire in 15 minutes.</p>
              <p style="color: #666; font-size: 14px;">If you didn't request this email, you can safely ignore it.</p>
            </div>
          `,
        });
        console.log("Magic send result", result);
        if (result.error) {
          throw new Error("Error sending magic link");
        }
      },
    }),
    // Conditionally include Stripe plugin only when configured
    ...stripePlugins,
  ],
  trustedOrigins: [
    "www.terragonlabs.com",
    "terragonlabs.com",
    process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL &&
      `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
    process.env.NODE_ENV === "development" && publicAppUrl(),
    process.env.NODE_ENV === "development" && nonLocalhostPublicAppUrl(),
  ].filter(Boolean) as string[],
});

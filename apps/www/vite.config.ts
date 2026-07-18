import path from "path";
import { defineConfig } from "vite";
import { Plugin } from "vite";

export default defineConfig({
  plugins: [
    stubNextNavigation(),
    // Only stub server actions for the Ladle/prod build, never under Vitest.
    // vitest sets NODE_ENV=test itself, but if a non-test NODE_ENV leaks in from
    // the invoking environment (a build tool, a shell, an isolated CI worktree)
    // it is present at *config-load* time before vitest normalizes it — which
    // would stub every server action into `undefined` and break ~all action
    // tests with "reading 'success'". `VITEST` is always set during a run, so
    // gate on it to make the harness robust to NODE_ENV timing.
    process.env.NODE_ENV !== "test" && !process.env.VITEST
      ? stubServerActions()
      : undefined,
  ].filter(Boolean),
  optimizeDeps: {
    exclude: ["next/navigation"],
  },
  clearScreen: false,
  server: {
    host: "0.0.0.0",
  },
  test: {
    silent: "passed-only",
    env: {
      // Force the test NODE_ENV for the whole run so a non-test value leaking in
      // from the invoking environment can't reach runtime code (sandbox mock
      // guard, e2e provider selection, etc.). Config-load-time checks that run
      // before this applies are guarded separately via `process.env.VITEST`.
      NODE_ENV: "test",
      GITHUB_CLIENT_ID: "GITHUB_CLIENT_ID_TEST",
      GITHUB_CLIENT_SECRET: "GITHUB_CLIENT_SECRET_TEST",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY_TEST",
      OPENAI_API_KEY: "OPENAI_API_KEY_TEST",
      NGROK_DOMAIN: "NGROK_DOMAIN_TEST",
      R2_ACCESS_KEY_ID: "R2_ACCESS_KEY_ID_TEST",
      R2_SECRET_ACCESS_KEY: "R2_SECRET_ACCESS_KEY_TEST",
      R2_ACCOUNT_ID: "R2_ACCOUNT_ID_TEST",
      R2_BUCKET_NAME: "R2_BUCKET_NAME_TEST",
      R2_PRIVATE_BUCKET_NAME: "R2_PRIVATE_BUCKET_NAME_TEST",
      R2_PUBLIC_URL: "R2_PUBLIC_URL_TEST",
      // Support passing this in the environment to override the test key
      E2B_API_KEY: process.env.E2B_API_KEY || "E2B_API_KEY_TEST",
      DAYTONA_API_KEY: process.env.DAYTONA_API_KEY || "DAYTONA_API_KEY_TEST",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_GITHUB_APP_NAME: "test-app",
      GITHUB_WEBHOOK_SECRET: "GITHUB_WEBHOOK_SECRET_TEST",
      GITHUB_APP_ID: "GITHUB_APP_ID_TEST",
      GITHUB_APP_PRIVATE_KEY: "GITHUB_APP_PRIVATE_KEY_TEST",

      // Hatchet dispatch config (HATCHET_ENABLED stays unset/false so tests never
      // auto-dispatch; these let the transport be exercised against a mocked fetch).
      HATCHET_API_URL: "https://hatchet-test.example.com",
      HATCHET_TENANT_ID: "TENANT_TEST",
      HATCHET_API_TOKEN: "HATCHET_API_TOKEN_TEST",

      // Make sure all the codepaths for isStripeConfigured are covered.
      STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY_TEST",
      STRIPE_WEBHOOK_SECRET: "STRIPE_WEBHOOK_SECRET_TEST",
      STRIPE_PRICE_CORE_MONTHLY: "STRIPE_PRICE_CORE_MONTHLY_TEST",
      STRIPE_PRICE_PRO_MONTHLY: "STRIPE_PRICE_PRO_MONTHLY_TEST",
      STRIPE_PRICE_CREDIT_PACK: "STRIPE_PRICE_CREDIT_PACK_TEST",
    },
    setupFiles: ["./src/test-helpers/test-setup.ts"],
    globalSetup: "./src/test-helpers/test-global-setup.ts",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "next/image": path.resolve(__dirname, "./.ladle/UnoptimizedImage.tsx"),
      "next/link": path.resolve(__dirname, "./.ladle/UnoptimizedLink.tsx"),
      "next/navigation": path.resolve(__dirname, "./.ladle/mock-nav.tsx"),
    },
  },
});

function stubServerActions(): Plugin {
  return {
    name: "vite:stub-use-server",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("src/server-actions")) {
        return;
      }
      if (!/["']use server["']/.test(code)) {
        return;
      }

      const fileShortName = id.split("src/server-actions/")[1];
      const serverActionStub = (exportName: string) => {
        return `\
          export const ${exportName} = async (...args) => {
            console.log("Stubbed out server action called", {
              file: ${JSON.stringify(fileShortName)},
              name: ${JSON.stringify(exportName)},
              args,
            });
          };`;
      };

      const matchers = [
        /export\s+function\s+([A-Za-z0-9_]+)/g,
        /export\s+const\s+([A-Za-z0-9_]+)/g,
        /export\s+async\s+function\s+([A-Za-z0-9_]+)/g,
        /export\s+async\s+const\s+([A-Za-z0-9_]+)/g,
      ];

      const exportNames = new Set<string>();
      for (const matcher of matchers) {
        const matches = [...code.matchAll(matcher)];
        for (const match of matches) {
          if (match[1]) {
            exportNames.add(match[1]);
          }
        }
      }
      if (!exportNames.size) {
        return;
      }
      const stubParts = Array.from(exportNames).map((name) =>
        serverActionStub(name),
      );
      stubParts.push(
        `export default () => { throw new Error("default server stub"); };`,
      );
      return { code: stubParts.join("\n"), map: null };
    },
  };
}

function stubNextNavigation(): Plugin {
  return {
    name: "vite:stub-next-navigation",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("next/navigation")) {
        return;
      }
      return {
        code: `
          export const useRouter = () => {
            return {
              back: () => { throw new Error("Stubbed out") },
              forward: () => { throw new Error("Stubbed out") },
              refresh: () => { throw new Error("Stubbed out") },
              push: () => { throw new Error("Stubbed out") },
              replace: () => { throw new Error("Stubbed out") },
              prefetch: () => { throw new Error("Stubbed out") },
            };
          };`,
        map: null,
      };
    },
  };
}

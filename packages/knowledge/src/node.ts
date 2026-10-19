/**
 * The full knowledge engine, including evidence resolution against a checkout.
 *
 * Node only: claims.ts reads source files with `node:fs`. Import this from the
 * worker, never from apps/www (the Cloudflare Worker bundle has no filesystem;
 * core.test.ts enforces that boundary). The fs-free surface is the package root.
 */
export * from "./core";
export * from "./claims";

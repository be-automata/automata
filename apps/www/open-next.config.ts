import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Control-plane pilot: apps/www on Cloudflare Workers via the OpenNext adapter.
// Default config = R2-less incremental cache off; caching is layered in later
// (KV/R2 incremental cache) once bindings exist. Kept minimal for the step-1
// deployability build.
export default defineCloudflareConfig();

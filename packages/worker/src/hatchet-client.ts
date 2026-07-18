import { Hatchet } from "@hatchet-dev/typescript-sdk";

/**
 * Execution-plane Hatchet client (ADR-002). On a customer-supplied box this reads
 * that org's own worker token from the environment — never the control plane's App
 * key or master key.
 *
 * Config comes from the environment (set by the installer on a real box; by
 * scratchpad/hatchet-pilot.env locally):
 *   HATCHET_CLIENT_TOKEN         — the org-scoped worker token (embeds the gRPC
 *                                  broadcast address + server URL as signed claims).
 *   HATCHET_CLIENT_TLS_STRATEGY  — "none" for the localhost pilot (insecure gRPC);
 *                                  MUST be TLS on a real customer box — the token
 *                                  crosses the public internet (ADR-002 §Option D).
 */
export const hatchet = Hatchet.init();

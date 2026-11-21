import { implement } from "@orpc/server";
import { cliAPIContract } from "@terragon/cli-api-contract";

import type { EgressRequestContext } from "./principal";

/** The one implementer of the CLI contract; `cli-router.ts` and `egress-router.ts` both build on it. */
export const orpcBase =
  implement(cliAPIContract).$context<EgressRequestContext>();

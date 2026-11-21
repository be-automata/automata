import { ORPCError, ValidationError } from "@orpc/server";

/** The API version both mounts (`/api/cli`, `/api/v1`) announce on every response (CLI practices rule 10). */
export const API_VERSION = "1";

export function withApiVersion(response: Response): Response {
  response.headers.set("x-api-version", API_VERSION);
  return response;
}

interface ValidationIssueLike {
  message: string;
  path?: readonly (PropertyKey | { key: PropertyKey })[];
}

function issuePath(issue: ValidationIssueLike): string {
  return (issue.path ?? [])
    .map((part) => String(typeof part === "object" ? part.key : part))
    .join(".");
}

function validationFailure(
  error: ORPCError<string, unknown>,
): ORPCError<string, unknown> {
  const issues = (error.cause as ValidationError)
    .issues as readonly ValidationIssueLike[];
  const messages = issues.map((issue) => {
    const path = issuePath(issue);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return new ORPCError("BAD_REQUEST", {
    status: 400,
    message: "Invalid input",
    data: {
      errors: (messages.length > 0 ? messages : ["Invalid input"]).map(
        (message) => ({
          code: "invalid_input" as const,
          message,
          entry: null,
          index: null,
        }),
      ),
    },
    cause: error.cause,
  });
}

/**
 * oRPC rejects an input that fails its zod schema with an undeclared
 * `BAD_REQUEST`. This client interceptor maps it to the declared
 * `BAD_REQUEST` shape of the egress contract, worded for any procedure, (`code: "invalid_input"`), so no
 * undeclared error leaves a mount (CLI practices rule 6). It is the one place
 * a raw `ORPCError` is built; the conformance test allow-lists it by name.
 */
export async function mapInputValidationError<T>(options: {
  next: () => Promise<T>;
}): Promise<T> {
  try {
    return await options.next();
  } catch (error) {
    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof ValidationError
    ) {
      throw validationFailure(error);
    }
    throw error;
  }
}

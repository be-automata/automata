import { ORPCError, ValidationError } from "@orpc/server";

/** The API version both mounts (`/api/cli`, `/api/v1`) announce on every response (CLI practices rule 10). */
export const API_VERSION = "1";

export function withApiVersion(response: Response): Response {
  response.headers.set("x-api-version", API_VERSION);
  return response;
}

function issueMessage(issue: ValidationError["issues"][number]): string {
  const path = (issue.path ?? [])
    .map((part) => String(typeof part === "object" ? part.key : part))
    .join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * The `data` of the `BAD_REQUEST` every procedure declares: one
 * `invalid_input` entry per message. Used by the interceptor below and by a
 * handler that refuses a request-shape rule the schema cannot express.
 */
export function invalidInputError(messages: readonly string[]) {
  return {
    errors: (messages.length > 0 ? messages : ["Invalid input"]).map(
      (message) => ({
        code: "invalid_input" as const,
        message,
        entry: null,
        index: null,
      }),
    ),
  };
}

function validationFailure(cause: ValidationError): ORPCError<string, unknown> {
  return new ORPCError("BAD_REQUEST", {
    status: 400,
    message: "Invalid input",
    data: invalidInputError(cause.issues.map(issueMessage)),
    cause,
  });
}

/**
 * oRPC rejects an input that fails its zod schema with an undeclared
 * `BAD_REQUEST`. This client interceptor maps it to the `BAD_REQUEST` that
 * the base contract declares (`code: "invalid_input"`), so no undeclared
 * error leaves a mount for any procedure (CLI practices rule 6). It is the
 * one place a raw `ORPCError` is built; the conformance test allow-lists it
 * by name.
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
      throw validationFailure(error.cause);
    }
    throw error;
  }
}

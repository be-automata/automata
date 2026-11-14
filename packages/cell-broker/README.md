# @terragon/cell-broker

The remote-cell broker (ADR-014, L3): the handlers that let a remote cell use
`git` and `gh` without holding a GitHub credential.

- `git`: `createGitBrokerHandler`, a git smart-HTTP proxy (fetch and push). A
  push is a recorded effect keyed by its command list, so an identical retry
  replays GitHub's answer instead of pushing twice.
- `gh`: `createGhBrokerHandler`, read-only GitHub REST (`/api/v3/*`) and
  GraphQL (`/api/graphql`); writes and mutations are refused.
- `common`: bearer extraction, the authorization gate, header and path
  helpers, shared responses.
- `report-status`: parsers for receive-pack responses and advertisements.

Every dependency is injected: the database (`db`), `fetch`, the token minters
(read and write), the `enabled` and `sideEffectsEnabled` switches, and the
size and time limits (`maxPushBytes`, `pushTimeoutMs`) and an optional
`waitUntil`, which keeps the continuation of a claimed push (forward, then
release or store) running after a client disconnect, bounded by
`pushTimeoutMs`. A hard runtime kill is left to the reconciler. The package reads no environment variables and imports
nothing from a host.

## Mounting it

A host builds a handler with its own dependencies and exposes it on a route.
`apps/www` is the reference host: `src/app/api/cell/git/[...path]/route.ts`,
`src/app/api/v3/[[...path]]/route.ts` and `src/app/api/graphql/route.ts`
create the handlers with the host's `db`, the GitHub App token minters from
`@terragon/shared/github-app`, and `src/lib/cell-broker-enabled.ts`.

## Tests

The integration tests live with the host, in
`apps/www/src/server-lib/cell-broker/`, because they need the host's database
harness (and real `git` and `gh` binaries for the end-to-end cases).

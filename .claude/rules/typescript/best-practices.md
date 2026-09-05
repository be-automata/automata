---
description: TypeScript conventions — naming, types, async/await, error handling, logging. Applies to all .ts files (apps, packages, scripts).
paths:
  - "**/*.ts"
alwaysApply: false
---

### General guidelines for TypeScript code in this repo.
# TypeScript Best Practices

These rules apply to every `.ts` file in the repo (apps, packages, build
scripts, utilities). Framework-specific conventions (Next.js, Drizzle,
PartyKit, the daemon) live with the package that owns them.

Assume the reader knows JavaScript and is comfortable with static types. Do
not restate basic language mechanics.

---

## tsconfig standards

Canonical baseline is `packages/tsconfig/base.json` (`@terragon/tsconfig`).
Extend it in any new TS package unless the framework overrides a flag:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022"
  }
}
```

Why these flags:
- `strict: true` turns on `strictNullChecks`, `noImplicitAny`, and the rest —
  non-negotiable.
- `noUncheckedIndexedAccess` types every index access as possibly
  `undefined`. Narrow instead of assuming the element exists.
- `noUnusedLocals` makes dead variables a compile error. Remove them instead
  of prefixing `_`.
- `esModuleInterop` lets default imports work against CommonJS packages.
- `skipLibCheck` skips type-checking of `node_modules/**/*.d.ts` — faster
  builds, and we can't fix upstream types anyway.

Never downgrade `strict` to bypass an error. Fix the type.

---

## Naming

- **Functions, variables, parameters:** `camelCase`. Verb-first for functions:
  `createThread()`, `parseDaemonEvent()`.
- **Constants (module-level, immutable):** `SCREAMING_SNAKE_CASE`.
- **Types, interfaces, classes, enums:** `PascalCase`.
- **Files:** `kebab-case.ts` (e.g. `active-org.ts`, `feature-flags-definitions.ts`). Barrel files (`index.ts`) re-export only.
- **Secret/env keys:** `SCREAMING_SNAKE_CASE` strings — match the name
  declared in `@terragon/env` and `.env.example`.
- **Identifiers in code are always English.**

---

## Imports & modules

Use ES module syntax (`import`/`export`) even when the compiled output is
CommonJS. Never write `require()` in source.

Grouping: built-in → third-party → local, separated by a blank line.

```typescript
// ✅ Good
import { readFile } from 'node:fs/promises';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@terragon/shared/db';
import { formatTime } from './utils';
```

Import only what you use. Prefer named imports over `import * as X` unless the
library exposes a large surface you actually consume (e.g.
`import * as schema from '@terragon/shared/db/schema'`).

Use workspace imports (`@terragon/...`) across packages, the `@/*` alias
(`./src/*`) inside `apps/www`, and relative paths within a package.

---

## Types

- **`interface` for object shapes** that are part of a public contract
  (function parameters, return types, repository models). They extend cleanly
  and produce better error messages.
- **`type` for unions, tuples, conditional types, aliases.**
- **Never `any` without a one-line comment justifying it.** At external
  boundaries (`JSON.parse`, `req.body`, library escape hatches), use `unknown`
  and narrow:

```typescript
// ✅ Good
function parseThreadPayload(raw: unknown): ThreadData {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    throw new Error('Invalid response shape');
  }
  const obj = raw as { id: unknown };
  if (typeof obj.id !== 'string') {
    throw new Error('id must be a string');
  }
  return { id: obj.id };
}

// ❌ Bad
function parseThreadPayload(raw: any): ThreadData {
  return { id: raw.id };
}
```

- **Type guards** are functions that narrow `unknown`/union types. Name them
  `isX()` and return `value is X`:

```typescript
interface ThreadData { id: string; status: string; }

function isThreadData(v: unknown): v is ThreadData {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as ThreadData).id === 'string' &&
    typeof (v as ThreadData).status === 'string'
  );
}
```

- **No enums for string unions.** Use a literal union type instead — it
  plays better with JSON and erases at runtime:

```typescript
// ✅ Good
type ThreadStatus = 'queued' | 'running' | 'done';

// ❌ Bad
enum ThreadStatus { Queued = 'queued', Running = 'running', Done = 'done' }
```

---

## Nullables & optionals

With `strict: true`, `null` and `undefined` are never assignable to non-null
types. Use them deliberately:

- Optional object fields: `field?: string` — the field may be absent or
  `undefined`.
- Explicitly nullable fields (present but can hold null): `field: string | null`.
- Defaults via nullish coalescing:

```typescript
// ✅ Good
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
const ids = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);

// ❌ Bad — || coerces 0 and '' to the default, which is a bug if those are valid values
const port = process.env.PORT || 3000;
```

Avoid the non-null assertion `!` unless you add a comment explaining why the
value is guaranteed non-null. Prefer narrowing, optional chaining, or
explicit checks.

```typescript
// ❌ Bad — crashes silently if user is missing
const email = req.user!.email;

// ✅ Good
if (!req.user) {
  res.status(401).end();
  return;
}
const email = req.user.email;
```

---

## Async / await

Always `async`/`await`. No `.then()` chains in source code.

```typescript
// ✅ Good
async function saveThread(data: ThreadData): Promise<void> {
  const row = await buildRow(data);
  await threadRepo.insert(row);
}

// ❌ Bad
function saveThread(data: ThreadData): Promise<void> {
  return buildRow(data).then(row => threadRepo.insert(row));
}
```

Parallelize independent calls with `Promise.all`. Keep sequential only when
each step depends on the previous one:

```typescript
// ✅ Good — independent reads run in parallel
const [threads, pullRequests] = await Promise.all([
  threadRepo.list(),
  pullRequestRepo.list(),
]);
```

Every `await` in a non-throwing path must be reachable from a caller that
either handles the rejection or intentionally lets it propagate (see error
handling below).

---

## Error handling

- **Throw `Error` subclasses with descriptive messages.** Define a custom
  class for domain errors you want callers to distinguish:

```typescript
export class SandboxNotFoundError extends Error {
  constructor(public readonly sandboxId: string) {
    super(`sandbox not found: ${sandboxId}`);
    this.name = 'SandboxNotFoundError';
  }
}
```

- **Narrow `unknown` in catches before accessing `.message`.** In strict
  mode, the catch variable is `unknown`:

```typescript
// ✅ Good
try {
  await uploadArtifact(buffer);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  logger.error('uploadArtifact failed', { error: message });
}

// ❌ Bad — e.message is a type error in strict mode
try { /* ... */ } catch (e) {
  console.error(e.message);
}
```

- **Services throw; callers decide what to do.** Service functions (pure
  data access or external API wrappers) do not wrap their own body in
  try/catch — they let errors propagate. The route handler or orchestrator
  decides whether to fail the request, fall back to a default, or log and
  continue.

---

## Logging

- In plain Node scripts, `console.log` / `console.error` are fine.
- In library code or shared utilities, **accept a logger via dependency
  injection** rather than importing a logger module at the top level — keeps
  the utility testable without mocking `console`.
- Never log secrets, ID tokens, full request headers, or PII. If a field
  might contain user email, redact or hash before logging.

---

## What NOT to Do

- ❌ Do not write `require()` in source. Use ES module `import`.
- ❌ Do not use `any` without an explanatory comment.
- ❌ Do not mutate function parameters. Build a new object and return it.
- ❌ Do not `export *` from barrel files unless the re-exported module is
  explicitly a public surface. Prefer named re-exports.
- ❌ Do not `catch (e)` and silently swallow. Log or rethrow.
- ❌ Do not use `||` for defaults when `0`, `''`, or `false` are valid
  values — use `??`.
- ❌ Do not suppress type errors with `@ts-ignore` / `@ts-nocheck` in source.
  (Tests may use `@ts-nocheck` when mocking — that's an explicit exception.)
- ❌ Do not commit commented-out code. Delete it; git remembers.

---

## Rules

1. `strict: true` is non-negotiable. Fix type errors, don't suppress them.
2. Identifiers are English.
3. `camelCase` members, `PascalCase` types, `SCREAMING_SNAKE_CASE` constants.
4. ES module `import` only — never `require()`.
5. Group imports: built-in → third-party → local, blank line between groups.
6. `interface` for object shapes, `type` for unions and aliases. No enums for
   string unions.
7. Use `unknown` + type guards at external boundaries; never `any` without a
   comment.
8. `??` for defaults; `!` only with a comment justifying the assertion.
9. `async`/`await` only. Parallelize with `Promise.all` when calls are
   independent.
10. Catch `unknown`; narrow with `instanceof Error` before reading `.message`.
11. Services throw; callers decide how to handle. No silent swallowing.
12. Never log secrets, ID tokens, or PII.

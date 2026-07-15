/**
 * Self-host dev bootstrap: seed authenticated user(s) + org(s) + session(s).
 *
 * A fresh self-host has no first-user path — email/password sign-up is disabled
 * (`EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED`), magic-link needs a real Resend
 * key (it calls Resend's HTTP API, not SMTP), and GitHub OAuth needs a browser
 * handshake. This script seeds directly into Postgres so headless UAT / local
 * dev can authenticate immediately.
 *
 * How auth works with what this seeds: better-auth's `bearer` plugin (enabled in
 * apps/www/src/lib/auth.ts, no `requireSignature`) signs a *raw* token itself,
 * so a request with `Authorization: Bearer <session.token>` authenticates against
 * a plain session row — no password, no cookie signing. This writes exactly that
 * row (plus the org + membership the tenant model needs).
 *
 * Usage (DATABASE_URL must point at the self-host Postgres):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     pnpm exec tsx deploy/seed-selfhost.ts [orgCount]
 *
 * Default orgCount is 2 (covers cross-org isolation checks — two orgs, one user
 * each, whose data must not leak across the boundary).
 *
 * Idempotent: user/org/member rows are deterministic per index and upserted; a
 * fresh session token is minted each run and stale sessions for the seeded users
 * are cleared, so re-running always prints a currently-valid token.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
// Import the schema source directly rather than the "@terragon/shared/db"
// subpath export — pnpm hoists a store copy of that package whose exports map
// doesn't expose "./db", so the package-relative import fails under tsx. The
// source path is unambiguous and carries the same table definitions.
import {
  user,
  session,
  organization,
  member,
} from "../packages/shared/src/db/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Point it at the self-host Postgres, e.g.\n" +
      "  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm exec tsx deploy/seed-selfhost.ts",
  );
  process.exit(1);
}

const orgCount = Math.max(1, Number.parseInt(process.argv[2] ?? "2", 10) || 2);
const db = drizzle(databaseUrl);

const SESSION_TTL_MS = 60 * 60 * 24 * 60 * 1000; // 60 days, matches auth.ts

type Seeded = {
  index: number;
  email: string;
  orgSlug: string;
  orgId: string;
  userId: string;
  token: string;
};

async function seedOne(i: number): Promise<Seeded> {
  const now = new Date();
  const userId = `usr_selfhost_${i}`;
  const orgId = `org_selfhost_${i}`;
  const memberId = `mbr_selfhost_${i}`;
  const email = `owner${i}@selfhost.local`;
  const orgSlug = `selfhost-org-${i}`;
  const token = randomBytes(32).toString("hex");

  // user — deterministic id, upsert so re-runs don't duplicate
  await db
    .insert(user)
    .values({
      id: userId,
      name: `Self-host Owner ${i}`,
      email,
      emailVerified: true,
      role: "user",
      shadowBanned: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: user.id,
      set: { email, updatedAt: now },
    });

  // organization
  await db
    .insert(organization)
    .values({
      id: orgId,
      name: `Self-host Org ${i}`,
      slug: orgSlug,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: organization.id,
      set: { name: `Self-host Org ${i}`, slug: orgSlug },
    });

  // membership (owner)
  await db
    .insert(member)
    .values({
      id: memberId,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing({ target: member.id });

  // fresh session — clear stale ones for this user first, then insert
  await db.delete(session).where(eq(session.userId, userId));
  await db.insert(session).values({
    id: `ses_selfhost_${i}_${randomBytes(6).toString("hex")}`,
    token,
    userId,
    activeOrganizationId: orgId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
    updatedAt: now,
  });

  return { index: i, email, orgSlug, orgId, userId, token };
}

async function main() {
  const seeded: Seeded[] = [];
  for (let i = 1; i <= orgCount; i++) {
    seeded.push(await seedOne(i));
  }

  console.log(`\nSeeded ${seeded.length} org(s) with an owner + active session.\n`);
  for (const s of seeded) {
    console.log(`Org ${s.index}: ${s.orgSlug}`);
    console.log(`  user:   ${s.email}  (userId ${s.userId})`);
    console.log(`  orgId:  ${s.orgId}`);
    console.log(`  auth:   Authorization: Bearer ${s.token}`);
    console.log("");
  }
  console.log("Verify a session (replace <base> with the app URL, e.g. http://localhost:3100):");
  console.log(
    `  curl -s -H "Authorization: Bearer ${seeded[0].token}" <base>/api/auth/get-session\n`,
  );

  // node-postgres pool keeps the event loop alive; exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

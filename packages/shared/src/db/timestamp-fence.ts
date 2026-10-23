import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Optimistic-concurrency fence on a `timestamp` column, compared at
 * MILLISECOND precision.
 *
 * Postgres stores microseconds. The app only ever sees milliseconds: drizzle
 * reads a `timestamp` into a JS `Date` (the parse truncates the extra digits)
 * and the page sends that back as the expected stamp. Stamps the app writes
 * come from a `Date` too, so they already end in `000` microseconds. A stamp
 * written by raw SQL (`updated_at = now()`) does not, and an exact `=` fence
 * against it never matches again: every save conflicts, forever.
 *
 * Truncating the stored side mirrors the JS parse, so the stamp the caller read
 * always matches, and a caller holding a different millisecond still loses.
 *
 * The expected value is bound with the column as its encoder, so it goes to
 * the driver exactly as `eq(column, value)` would send it (an ISO string that
 * Postgres reads as `timestamp`, ignoring the zone) — no driver-side
 * local-time conversion of a bare `Date`.
 */
export function eqAtMillisecond(column: PgColumn, expected: Date): SQL {
  return sql`date_trunc('milliseconds', ${column}) = ${sql.param(expected, column)}`;
}

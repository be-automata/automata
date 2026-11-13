import { and, asc, eq } from "drizzle-orm";

import { DB } from "../db";
import { addonCall, addonCallDelivery } from "../db/schema";

/**
 * Add-on calls and their callback deliveries (ADR-014 managed tier; add-on
 * contract RAP / MCP Tasks). MULTI-TENANT: a call is read only together with its
 * `organizationId`.
 *
 * The rules come from the session-continuity spikes:
 *  1. record the call BEFORE dispatching it (`recordAddonCall`);
 *  2. apply every delivery through a create-only key (`recordAddonDelivery`), so a
 *     retried or replayed delivery is never applied twice;
 *  3. a new cell reconciles from these rows before it re-dispatches anything.
 */

export type AddonTransport = "rap";
export type AddonDeliveryKind = "tool_result" | "subscription_event" | "other";
/** `created`: this write won; `exists`: the row was already there (a retry or replay). */
export type CreateOnlyResult = "created" | "exists";

export interface AddonCallRecord {
  id: string;
  organizationId: string;
  threadId: string | null;
  transport: AddonTransport;
  groupId: string;
  expiresAt: Date;
}

export async function recordAddonCall({
  db,
  call,
}: {
  db: DB;
  call: AddonCallRecord;
}): Promise<CreateOnlyResult> {
  const inserted = await db
    .insert(addonCall)
    .values(call)
    .onConflictDoNothing({ target: addonCall.id })
    .returning({ id: addonCall.id });
  return inserted[0] ? "created" : "exists";
}

export async function getAddonCall({
  db,
  callId,
  organizationId,
}: {
  db: DB;
  callId: string;
  organizationId: string;
}): Promise<AddonCallRecord | null> {
  const rows = await db
    .select({
      id: addonCall.id,
      organizationId: addonCall.organizationId,
      threadId: addonCall.threadId,
      transport: addonCall.transport,
      groupId: addonCall.groupId,
      expiresAt: addonCall.expiresAt,
    })
    .from(addonCall)
    .where(
      and(
        eq(addonCall.id, callId),
        eq(addonCall.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function recordAddonDelivery({
  db,
  delivery,
}: {
  db: DB;
  delivery: {
    callId: string;
    deliveryKey: string;
    kind: AddonDeliveryKind;
    body: Record<string, unknown>;
    final: boolean;
  };
}): Promise<CreateOnlyResult> {
  const inserted = await db
    .insert(addonCallDelivery)
    .values(delivery)
    .onConflictDoNothing({
      target: [addonCallDelivery.callId, addonCallDelivery.deliveryKey],
    })
    .returning({ id: addonCallDelivery.id });
  return inserted[0] ? "created" : "exists";
}

/** Deliveries of one call in arrival order (ties broken by key, which sorts in send order). */
export async function listAddonDeliveries({
  db,
  callId,
  organizationId,
}: {
  db: DB;
  callId: string;
  organizationId: string;
}): Promise<
  {
    deliveryKey: string;
    kind: AddonDeliveryKind;
    body: Record<string, unknown>;
    final: boolean;
    receivedAt: Date;
  }[]
> {
  return db
    .select({
      deliveryKey: addonCallDelivery.deliveryKey,
      kind: addonCallDelivery.kind,
      body: addonCallDelivery.body,
      final: addonCallDelivery.final,
      receivedAt: addonCallDelivery.receivedAt,
    })
    .from(addonCallDelivery)
    .innerJoin(addonCall, eq(addonCall.id, addonCallDelivery.callId))
    .where(
      and(
        eq(addonCallDelivery.callId, callId),
        eq(addonCall.organizationId, organizationId),
      ),
    )
    .orderBy(
      asc(addonCallDelivery.receivedAt),
      asc(addonCallDelivery.deliveryKey),
    );
}

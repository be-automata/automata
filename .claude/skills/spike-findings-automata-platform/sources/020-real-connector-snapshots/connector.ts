// Spike 020: a Slack connector that materializes a channel AS OF a revision id into spike 010's
// resolver layout, so 010's checkPage/reconcile run unchanged on real captured data.
//
// Revision id for a channel view = (channel, asOfTs). Logical evidence URIs (no revision inside):
//   ticket://slack/<channel>/latest-from/<user>#/text   "the newest message from <user>" (current state)
//   ticket://slack/<channel>/msg/<ts>#/text             one immutable message (a decision, a quote)
// The revision the pin was observed at is provenance, stored next to the pin, never in the URI:
// a URI that names its own revision resolves to the same bytes forever and can never go stale.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SlackMessage { ts: string; user: string; text: string }
interface Capture { channel: string; reads: { call: string; messages: SlackMessage[] }[] }

const HERE = import.meta.dirname;
export const CAPTURE: Capture = JSON.parse(readFileSync(join(HERE, "fixtures", "slack-capture.json"), "utf8"));

/** Every message seen in any read, deduped by ts; throws if two reads disagree on one ts. */
export function allMessages(): SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const r of CAPTURE.reads) for (const m of r.messages) {
    const seen = byTs.get(m.ts);
    if (seen && seen.text !== m.text) throw new Error(`ts ${m.ts} not reproducible across reads`);
    byTs.set(m.ts, m);
  }
  return [...byTs.values()].sort((a, b) => Number(b.ts) - Number(a.ts));
}

/** conversations.history semantics: `latest` is EXCLUSIVE unless inclusive=true. Newest first. */
export function historyAsOf(asOf: string, inclusive: boolean, drop: string[] = []): SlackMessage[] {
  return allMessages().filter((m) => !drop.includes(m.ts) && (inclusive ? Number(m.ts) <= Number(asOf) : Number(m.ts) < Number(asOf)));
}

/** Write the channel view at revision asOf (inclusive) into <root>/tickets/slack/... for 010's resolver. */
export function materialize(root: string, asOf: string, drop: string[] = []): void {
  rmSync(join(root, "tickets", "slack"), { recursive: true, force: true });
  const msgs = historyAsOf(asOf, true, drop);
  const put = (rel: string, v: unknown) => {
    const p = join(root, "tickets", "slack", CAPTURE.channel, `${rel}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v, null, 2));
  };
  for (const m of msgs) put(`msg/${m.ts}`, m);
  for (const user of new Set(msgs.map((m) => m.user))) {
    const newest = msgs.find((m) => m.user === user);
    if (newest) put(`latest-from/${user}`, { ...newest, rev: asOf });
  }
}

export const viewUri = (user: string, field = "text") => `ticket://slack/${CAPTURE.channel}/latest-from/${user}#/${field}`;
export const msgUri = (ts: string) => `ticket://slack/${CAPTURE.channel}/msg/${ts}#/text`;

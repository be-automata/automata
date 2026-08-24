import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireBoxSlot, withBoxSlot } from "./box-slot";

describe("box slot (#125 C4 — the worker-side one-agent budget)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "box-slot-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serialises two concurrent holders: the second starts only after the first releases", async () => {
    const order: string[] = [];
    const a = withBoxSlot({ dir, holder: "a", pollMs: 20 }, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 200));
      order.push("a-end");
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = withBoxSlot({ dir, holder: "b", pollMs: 20 }, async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("reclaims a slot whose owner pid is dead", async () => {
    await mkdir(path.join(dir, "slot"));
    await writeFile(
      path.join(dir, "slot", "owner.json"),
      JSON.stringify({
        pid: 2 ** 22 - 1,
        holder: "ghost",
        nonce: "x",
        heartbeatAt: Date.now(),
      }),
    );
    const slot = await acquireBoxSlot({ dir, holder: "me", pollMs: 20 });
    await slot.release();
  });

  it("reclaims a slot whose live owner stopped heartbeating (stale)", async () => {
    await mkdir(path.join(dir, "slot"));
    await writeFile(
      path.join(dir, "slot", "owner.json"),
      JSON.stringify({
        pid: process.pid,
        holder: "silent",
        nonce: "y",
        heartbeatAt: Date.now() - 60_000,
      }),
    );
    const slot = await acquireBoxSlot({
      dir,
      holder: "me",
      pollMs: 20,
      staleMs: 45_000,
    });
    await slot.release();
  });

  it("does NOT reclaim a live, heartbeating owner; an abort while waiting rejects promptly", async () => {
    const held = await acquireBoxSlot({ dir, holder: "first", pollMs: 20 });
    const ac = new AbortController();
    const waiter = acquireBoxSlot({
      dir,
      holder: "second",
      pollMs: 20,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 80);
    await expect(waiter).rejects.toThrow(/aborted/);
    await held.release();
  });

  it("an already-aborted signal never holds the slot, even when it is free", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      acquireBoxSlot({ dir, holder: "late", pollMs: 20, signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
    const slot = await acquireBoxSlot({ dir, holder: "next", pollMs: 20 });
    await slot.release();
  });

  it("a holder that was reclaimed after a heartbeat stall never frees the NEW holder's slot", async () => {
    let clock = Date.now();
    const stalled = await acquireBoxSlot({
      dir,
      holder: "stalled",
      pollMs: 20,
      now: () => clock,
    });
    // Its heartbeat goes silent for a minute; a waiter reclaims the slot.
    clock += 60_000;
    const fresh = await acquireBoxSlot({
      dir,
      holder: "fresh",
      pollMs: 20,
      staleMs: 45_000,
      now: () => clock,
    });
    // The stalled holder finally releases — it must NOT remove "fresh"'s lock.
    await stalled.release();
    const probe = new AbortController();
    setTimeout(() => probe.abort(), 120);
    await expect(
      acquireBoxSlot({
        dir,
        holder: "probe",
        pollMs: 20,
        signal: probe.signal,
        now: () => clock,
      }),
    ).rejects.toThrow(/aborted/);
    await fresh.release();
  });

  it("releases on throw (withBoxSlot)", async () => {
    await expect(
      withBoxSlot({ dir, holder: "x", pollMs: 20 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const slot = await acquireBoxSlot({ dir, holder: "y", pollMs: 20 });
    await slot.release();
  });
});

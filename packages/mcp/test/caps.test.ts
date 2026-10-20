/**
 * Per-caller and daily caps on fresh runs, the injectable limiter, and the
 * guarantee that no key leaves the server.
 */
import type { StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryFreshRunLimiter, createUnlimitedFreshRunLimiter, sheetEnvelope, type FreshRunLimiter } from "../src/index";
import { caller, CLOCK_MS, connect, services } from "./helpers";

const SHOW = "Hollis Creek String Band @ The Truth, Nov 20 2026";

describe("fresh-run caps", () => {
  it("allows N fresh runs per caller per day, then refuses with the same envelope; presets stay open", async () => {
    const s = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 2, perDay: 3 }) });
    const a = await connect(s, caller("192.0.2.1"));
    const b = await connect(s, caller("192.0.2.2"));
    const d = await connect(s, caller("192.0.2.3"));
    try {
      const r1 = await a.call("plan_show", { event: SHOW });
      expect(r1.env.freshRuns).toEqual({ leftForCaller: 1, leftToday: 2 });
      const r2 = await a.call("rank_partners", { planId: "g1-a", partnerNames: ["Bellhop Records"] });
      expect(r2.env.status).not.toBe("error");
      expect(r2.env.freshRuns).toEqual({ leftForCaller: 0, leftToday: 1 });

      const r3 = await a.call("plan_show", { event: SHOW });
      expect(r3.result.isError).toBe(true);
      expect(r3.env.status).toBe("error");
      expect(r3.env.reason).toMatch(/^limit reached: 2 fresh runs per caller per day/);
      expect(r3.env.freshRuns).toEqual({ leftForCaller: 0, leftToday: 1 });
      expect(r3.text).toContain("limit reached");
      const r3b = await a.call("rank_partners", { planId: "g1-a", partnerNames: ["Bellhop Records"] });
      expect(r3b.env.reason).toMatch(/^limit reached/);

      // Presets and reads are not fresh runs.
      expect((await a.call("plan_show", { presetId: "g1-b" })).env.status).not.toBe("error");
      expect((await a.call("get_sheet", { planId: "g1-a" })).env.status).not.toBe("error");
      expect((await a.call("bill_vs_house", { planId: "g1-a" })).env.status).not.toBe("error");

      // Another caller has their own allowance, until the server's daily total runs out.
      const r4 = await b.call("plan_show", { event: SHOW, operator: { seatsLeft: 900 } });
      expect(r4.env.status).not.toBe("error");
      expect(r4.env.freshRuns).toEqual({ leftForCaller: 1, leftToday: 0 });
      const r5 = await d.call("plan_show", { presetId: "g1-a", operator: { radiusKm: 30 } });
      expect(r5.env.reason).toMatch(/^limit reached: 3 fresh runs per day on this server/);
    } finally {
      await Promise.all([a.close(), b.close(), d.close()]);
    }
    // Three full fixture runs in one test (about 6 s alone, 33 s when the whole suite runs in parallel).
  }, 120_000);

  it("refunds a run that failed before any Qloo request", async () => {
    const calls: string[] = [];
    const inner = createMemoryFreshRunLimiter({ perCallerPerDay: 1, perDay: 10 });
    const limiter: FreshRunLimiter = {
      check: (k, n) => inner.check(k, n),
      take: (k, n) => (calls.push("take"), inner.take(k, n)),
      refund: (k, n) => (calls.push("refund"), inner.refund(k, n)),
    };
    const s = services({ limiter });
    // A Ticketmaster factory that finds the event for the lookup but fails the run's own intake.
    const tm = s.deps.tm!;
    s.deps.tm = (ledger) => {
      const client = tm(ledger);
      return { ...client, getEvent: async () => ({ data: null, ledgerRef: "T9", httpStatus: 404 }) } as typeof client;
    };
    const c = await connect(s, caller("192.0.2.50"));
    try {
      const r = await c.call("plan_show", { event: SHOW });
      expect(r.env.status).toBe("error");
      expect(r.env.reason).toMatch(/was not found/);
      expect(calls).toEqual(["take", "refund"]);
      expect(r.env.freshRuns).toEqual({ leftForCaller: 1, leftToday: 10 });
      expect((await inner.check("x", CLOCK_MS)).allowed).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("keeps a refunded run's envelope valid under the unlimited limiter (stdio --unlimited)", async () => {
    const s = services({ limiter: createUnlimitedFreshRunLimiter() });
    const tm = s.deps.tm!;
    s.deps.tm = (ledger) => {
      const client = tm(ledger);
      return { ...client, getEvent: async () => ({ data: null, ledgerRef: "T9", httpStatus: 404 }) } as typeof client;
    };
    const c = await connect(s, caller("192.0.2.60"));
    try {
      // The client validates structuredContent against the output schema (safe integers only).
      const r = await c.call("plan_show", { event: SHOW });
      expect(r.env.status).toBe("error");
      expect(r.env.freshRuns?.leftForCaller).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      await c.close();
    }
  });

  it("hands the injected limiter the caller's address for every fresh run (the limiter keeps only a hash)", async () => {
    const keys: string[] = [];
    const limiter: FreshRunLimiter = {
      check: (k) => (keys.push(k), { allowed: true, leftForCaller: 5, leftToday: 5 }),
      take: (k) => (keys.push(k), { allowed: true, leftForCaller: 4, leftToday: 4 }),
      refund: () => {},
    };
    const s = services({ limiter });
    const c = await connect(s, caller("203.0.113.77"));
    try {
      const r = await c.call("plan_show", { event: SHOW });
      expect(r.env.freshRuns).toEqual({ leftForCaller: 4, leftToday: 4 });
      expect(keys).toEqual(["203.0.113.77", "203.0.113.77"]);
    } finally {
      await c.close();
    }
  });

  it("resets at 00:00 UTC", async () => {
    const l = createMemoryFreshRunLimiter({ perCallerPerDay: 1, perDay: 1 });
    expect((await l.take("k", CLOCK_MS)).allowed).toBe(true);
    expect((await l.take("k", CLOCK_MS + 1000)).allowed).toBe(false);
    expect((await l.take("other", CLOCK_MS + 1000)).reason).toMatch(/per day on this server/);
    const tomorrow = Date.parse("2026-10-31T00:00:01Z");
    expect((await l.take("k", tomorrow)).allowed).toBe(true);
  });
});

describe("no key leaves the server", () => {
  it("never returns the fixture transport key, and scrubs configured secrets from every result", async () => {
    const secret = "sk-qloo-test-0123456789abcdef";
    const s = services({ secrets: [{ name: "QLOO_API_KEY", value: secret }] });
    const c = await connect(s);
    try {
      const { env, text, result } = await c.call("get_sheet", { planId: "g1-a" });
      const raw = JSON.stringify(result);
      expect(raw).not.toContain("fixture-world-no-key");
      for (const e of (env.results as StreetSheet).ledger) {
        if (e.kind === "qloo") expect(e.curl).toContain("$QLOO_API_KEY");
      }
      // Plant the secret where a dependency might echo it and read the plan back.
      const stored = await s.store.get("g1-a");
      const sh = stored!.sheet!;
      sh.limits = [...sh.limits, `upstream said: bad key ${secret}`];
      sh.ledger[0]!.note = `x-api-key=${secret}`;
      await s.store.put({ ...stored!, sheet: sh });
      const again = await c.call("get_sheet", { planId: "g1-a" });
      const rawAgain = JSON.stringify(again.result);
      expect(rawAgain).not.toContain(secret);
      expect(rawAgain).toContain("bad key $QLOO_API_KEY");
      expect(again.text).not.toContain(secret);
      expect(text).not.toContain(secret);
      // The envelope is otherwise unchanged.
      expect(again.env.planId).toBe(sheetEnvelope(sh, null).planId);
    } finally {
      await c.close();
    }
  });
});

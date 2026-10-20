/**
 * Small pieces: link parsing, input policy, caller keys, statuses, scrubbing.
 */
import type { StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  callerKey,
  clientIpFrom,
  containsEmail,
  dataDirFrom,
  errorEnvelope,
  inputProblem,
  looksLikeUrl,
  looksPolitical,
  normalizeLabel,
  pausedEnvelope,
  scrubSecrets,
  scrubText,
  secretsFromEnv,
  sheetStatus,
  sheetUrlFor,
  slugHints,
  tmEventIdFromUrl,
  worstStatus,
} from "../src/index";

describe("Ticketmaster links", () => {
  it("reads the event id from Ticketmaster, Live Nation and fixture-world links only", () => {
    expect(tmEventIdFromUrl("https://www.ticketmaster.com/hollis-creek-nashville-tennessee-11-20-2026/event/0D0061ABCDEF1234")).toBe("0D0061ABCDEF1234");
    expect(tmEventIdFromUrl("https://www.ticketmaster.com/event/vvG1zZ9KjSmb7z?irgwc=1")).toBe("vvG1zZ9KjSmb7z");
    expect(tmEventIdFromUrl("https://www.ticketmaster.ca/event/Z7r9jZ1AdFfqA")).toBe("Z7r9jZ1AdFfqA");
    expect(tmEventIdFromUrl("https://concerts.livenation.com/x-tickets/event/1B00ABCD")).toBe("1B00ABCD");
    expect(tmEventIdFromUrl("https://tickets.example/event/syn-tm-ev-truth-1120-hollis")).toBe("syn-tm-ev-truth-1120-hollis");
    expect(tmEventIdFromUrl("https://ticketmaster.com.evil.example/event/abcd1234")).toBeNull();
    expect(tmEventIdFromUrl("https://www.axs.com/events/12345")).toBeNull();
    expect(tmEventIdFromUrl("javascript:alert(1)//ticketmaster.com/event/abcd")).toBeNull();
    expect(tmEventIdFromUrl("https://user:pw@www.ticketmaster.com/event/abcd1234")).toBeNull();
    expect(tmEventIdFromUrl("https://www.ticketmaster.com/artist/12345")).toBeNull();
    expect(looksLikeUrl("https://x.example")).toBe(true);
    expect(looksLikeUrl("Artist @ Venue, Nov 20 2026")).toBe(false);
  });

  it("reads keyword hints and the date from a link slug", () => {
    expect(slugHints("https://www.ticketmaster.com/hollis-creek-string-band-nashville-tennessee-11-20-2026/event/0D00")).toEqual({
      words: ["hollis", "creek", "string", "band", "nashville", "tennessee"],
      date: "2026-11-20",
    });
    expect(slugHints("https://www.ticketmaster.com/event/0D00")).toEqual({ words: [], date: null });
  });

  it("normalizes venue and act labels", () => {
    expect(normalizeLabel("The Truth")).toBe("truth");
    expect(normalizeLabel("Wren & Wolfe")).toBe("wren and wolfe");
    expect(normalizeLabel("Café Tacvba!")).toBe("cafe tacvba");
  });
});

describe("input policy", () => {
  it("finds emails and campaign events, and leaves ordinary names alone", () => {
    expect(containsEmail("call ops@venue.example")).toBe(true);
    expect(containsEmail("Hollis Creek @ The Truth, Nov 20 2026")).toBe(false);
    expect(containsEmail("Sable & Sun @ The Truth")).toBe(false);
    expect(looksPolitical("Campaign rally @ Hampton Coliseum")).toBe(true);
    expect(looksPolitical("Jane Doe for Senate @ The Truth")).toBe(true);
    expect(looksPolitical("Super PAC benefit night")).toBe(true);
    expect(looksPolitical("Rivergate Rollers @ The Truth")).toBe(false);
    expect(looksPolitical("Monster Truck Rally @ Hampton Coliseum")).toBe(false);
    expect(inputProblem([{ field: "partnerNames", value: "Row House Barbers" }])).toBeNull();
    expect(inputProblem([{ field: "partnerNames", value: "a@b.example" }])?.field).toBe("partnerNames");
  });
});

describe("caller keys", () => {
  it("hashes addresses with a salt and reads the proxy's view of the caller", () => {
    const k = callerKey("198.51.100.1", "salt-a");
    expect(k).toMatch(/^[0-9a-f]{24}$/);
    expect(k).toBe(callerKey(" 198.51.100.1 ", "salt-a"));
    expect(k).not.toBe(callerKey("198.51.100.1", "salt-b"));
    expect(k).not.toBe(callerKey("198.51.100.2", "salt-a"));
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIpFrom(h({ "fly-client-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIpFrom(h({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "2.2.2.2" }))).toBe("3.3.3.3");
    expect(clientIpFrom(h({ "x-forwarded-for": "6.6.6.6, 5.5.5.5" }))).toBe("5.5.5.5");
    expect(clientIpFrom(h({}))).toBe("unknown");
  });
});

describe("envelopes", () => {
  const card = (status: string, reason?: string) => ({ status, summary: "s", results: [], provenance: [], limits: [], ...(reason ? { reason } : {}) });
  const fakeSheet = (statuses: Record<string, string>) =>
    ({
      cards: {
        resolution: card(statuses.resolution ?? "ok"),
        liftMap: card(statuses.liftMap ?? "ok"),
        partners: card(statuses.partners ?? "ok"),
        declared: card(statuses.declared ?? "empty"),
      },
    }) as unknown as StreetSheet;

  it("ranks statuses and reports degraded cards as degraded", () => {
    expect(sheetStatus(fakeSheet({}))).toBe("ok");
    expect(sheetStatus(fakeSheet({ liftMap: "degraded", partners: "partial" }))).toBe("degraded");
    expect(sheetStatus(fakeSheet({ partners: "partial" }))).toBe("partial");
    expect(sheetStatus(fakeSheet({ resolution: "needs_input" }))).toBe("needs_input");
    expect(sheetStatus(fakeSheet({ partners: "error", resolution: "needs_input" }))).toBe("needs_input");
    expect(sheetStatus(fakeSheet({ partners: "error", liftMap: "degraded" }))).toBe("error");
    expect(worstStatus(["ok", "empty"])).toBe("ok");
    expect(worstStatus(["empty", "empty"])).toBe("empty");
    expect(worstStatus(["partial", "degraded", "ok"])).toBe("degraded");
  });

  it("builds share links, paused and error envelopes", () => {
    expect(sheetUrlFor("https://h.example/", "g1-a")).toBe("https://h.example/s/g1-a");
    expect(sheetUrlFor(null, "g1-a")).toBeNull();
    const e = errorEnvelope("nope", "live");
    expect(e).toMatchObject({ status: "error", summary: "nope", reason: "nope", results: null, planId: null, mode: "live", provenance: [] });
    expect(e.limits.some((l) => l.startsWith("Sample data"))).toBe(false);
    const p = pausedEnvelope(
      "plan-9",
      {
        resolution: { summary: "", results: [], provenance: ["Q1"] },
        pending: [{ input: "Sidecar", candidates: [] }, { input: "Comet", candidates: [] }],
      },
      "fixture",
      "https://h.example",
    );
    expect(p.summary).toBe('"Sidecar", "Comet" need a pick before the plan can run.');
    expect(p.reason).toBe('Pick the right entity for "Sidecar", "Comet" to continue.');
    expect(p.provenance).toEqual(["Q1"]);
    expect(p.pending).toHaveLength(2);
    expect(p.planUrl).toBe("https://h.example/plan/plan-9");
    expect(p.sheetUrl).toBe("https://h.example/plan/plan-9");
    expect(p.limits.some((l) => l.startsWith("Sample data"))).toBe(true);
  });
});

describe("secrets", () => {
  it("collects only non-trivial secret values and replaces them everywhere", () => {
    const secrets = secretsFromEnv({ QLOO_API_KEY: "abcdefgh12345678", TICKETMASTER_API_KEY: "short", OTHER: "zzzzzzzzzzzz", RESEND_API_KEY: "  re_123456789  " });
    expect(secrets.map((s) => s.name)).toEqual(["QLOO_API_KEY", "RESEND_API_KEY"]);
    const v = { a: "key abcdefgh12345678 here", b: ["re_123456789"], c: 3 };
    expect(scrubSecrets(v, secrets)).toEqual({ a: "key $QLOO_API_KEY here", b: ["$RESEND_API_KEY"], c: 3 });
    expect(scrubSecrets(v, [])).toBe(v);
    const quoted = [{ name: "QLOO_API_KEY", value: 'ab"cd\\ef12' }];
    expect(scrubSecrets({ x: 'pre ab"cd\\ef12 post' }, quoted)).toEqual({ x: "pre $QLOO_API_KEY post" });
    expect(scrubText("x abcdefgh12345678 y", secrets)).toBe("x $QLOO_API_KEY y");
  });

  it("resolves the data directory from the environment first", () => {
    expect(dataDirFrom({ WALKUP_DATA_DIR: "/data" }, "/fallback").replace(/\\/g, "/")).toMatch(/\/data$/);
    expect(dataDirFrom({}, "/fallback").replace(/\\/g, "/")).toMatch(/\/fallback$/);
  });
});

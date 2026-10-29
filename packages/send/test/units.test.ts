import { describe, expect, it } from "vitest";
import {
  SendConfigError,
  TEST_INBOX,
  buildMessage,
  checkRecipients,
  fromAddress,
  isValidEmail,
  redactRecipient,
  resolveSendConfig,
  showDate,
} from "../src/index";
import { deriveKeys, open, seal } from "../src/crypto";
import { TEST_SECRET, makeSheet } from "./helpers";

describe("isValidEmail", () => {
  it("accepts plain addresses", () => {
    for (const a of ["a@example.com", "first.last+tag@sub.example.co.uk", "x_y-z@example.org", TEST_INBOX]) {
      expect(isValidEmail(a), a).toBe(true);
    }
  });
  it("rejects anything that could smuggle a header or a second address", () => {
    for (const a of [
      "",
      "a",
      "a@b",
      "@example.com",
      "a@",
      "a@@example.com",
      "a@b@example.com",
      "a b@example.com",
      "a@example.com\nBcc: b@example.com",
      "a@example.com,b@example.com",
      "Name <a@example.com>",
      "\"quoted\"@example.com",
      ".a@example.com",
      "a..b@example.com",
      "a@-example.com",
      "a@example.c",
      "a@[192.0.2.1]",
      `${"x".repeat(65)}@example.com`,
    ]) {
      expect(isValidEmail(a), JSON.stringify(a)).toBe(false);
    }
  });
});

describe("checkRecipients", () => {
  it("is the test inbox alone by default", () => {
    expect(checkRecipients(undefined)).toEqual({ ok: true, recipients: [{ address: TEST_INBOX, source: "test_inbox" }] });
    expect(checkRecipients([])).toEqual({ ok: true, recipients: [{ address: TEST_INBOX, source: "test_inbox" }] });
  });
  it("refuses an empty list when the test inbox is turned off", () => {
    expect(checkRecipients([], false).ok).toBe(false);
  });
  it("trims and lower-cases the domain only", () => {
    const r = checkRecipients([{ address: "  Lead.Person@EXAMPLE.com ", typedByOperator: true }]);
    expect(r.ok && r.recipients[1]).toEqual({ address: "Lead.Person@example.com", source: "typed" });
  });
});

describe("redactRecipient", () => {
  it("keeps the public test inbox and hashes typed addresses with the server secret", () => {
    const k1 = deriveKeys(TEST_SECRET).id;
    const k2 = deriveKeys(`${TEST_SECRET}-other`).id;
    expect(redactRecipient({ address: TEST_INBOX, source: "test_inbox" }, k1)).toBe(TEST_INBOX);
    const a = redactRecipient({ address: "lead@example.com", source: "typed" }, k1);
    expect(a).toMatch(/^typed:[0-9a-f]{12}$/);
    expect(redactRecipient({ address: "LEAD@example.com", source: "typed" }, k1)).toBe(a);
    expect(redactRecipient({ address: "lead@example.com", source: "typed" }, k2)).not.toBe(a);
  });
});

describe("seal/open", () => {
  it("round-trips and fails closed on a wrong context or key", () => {
    const k = deriveKeys(TEST_SECRET);
    const s = seal(k.enc, "secret text", "ctx-1");
    expect(open(k.enc, s, "ctx-1")).toBe("secret text");
    expect(open(k.enc, s, "ctx-2")).toBeNull();
    expect(open(deriveKeys(`${TEST_SECRET}x`).enc, s, "ctx-1")).toBeNull();
    expect(open(k.enc, "!!", "ctx-1")).toBeNull();
  });
});

describe("resolveSendConfig", () => {
  it("reads every value and defaults the cap to 10", () => {
    const c = resolveSendConfig({
      WALKUP_SIGNING_SECRET: TEST_SECRET,
      RESEND_API_KEY: " k ",
      RESEND_FROM: "Walkup <s@example.com>",
      WALKUP_POSTAL_ADDRESS: "1 Example St\\nNashville, TN 37201",
    });
    expect(c).toMatchObject({ secretSource: "env", resendApiKey: "k", dailyCap: 10, postalAddress: "1 Example St\nNashville, TN 37201" });
  });
  it("uses a random per-process secret when none is set", () => {
    const a = resolveSendConfig({});
    const b = resolveSendConfig({});
    expect(a.secretSource).toBe("ephemeral");
    expect(a.signingSecret).toBe(b.signingSecret);
    expect(a.signingSecret.length).toBeGreaterThanOrEqual(32);
    expect(a.resendApiKey).toBeNull();
  });
  it("refuses a short secret, a bad cap and a multi-line from", () => {
    expect(() => resolveSendConfig({ WALKUP_SIGNING_SECRET: "short" })).toThrow(SendConfigError);
    expect(() => resolveSendConfig({ WALKUP_SEND_DAILY_CAP: "ten" })).toThrow(SendConfigError);
    expect(() => resolveSendConfig({ RESEND_FROM: "a@example.com\nBcc: b@example.com" })).toThrow(SendConfigError);
  });
  it("extracts the bare from address", () => {
    expect(fromAddress("Walkup <s@example.com>")).toBe("s@example.com");
    expect(fromAddress("s@example.com")).toBe("s@example.com");
  });
});

describe("buildMessage", () => {
  const opts = { postalAddress: "1 Example St, Nashville, TN 37201", replyAddress: "s@example.com" };

  it("has no what-if or fixture wording on a live sheet with real counts", () => {
    const m = buildMessage(makeSheet({ mode: "live", hypothetical: false }), [], opts);
    expect(m.subject).toBe("Street sheet for Synthetic Headliner, Test Hall, Fri Nov 20 2026");
    expect(m.text).not.toContain("assumed numbers");
    expect(m.text).not.toContain("Sample sheet");
    expect(m.text).toContain("Suggested, not affiliated");
    expect(m.text).toContain("Walkup, 1 Example St, Nashville, TN 37201");
  });

  it("lists the top tiles and the first 10 partners, and points to the CSV for the rest", () => {
    const files = [{ kind: "partners" as const, filename: "partners.csv", contentType: "text/csv", content: new Uint8Array([1]), bytes: 1, sha256: "x" }];
    const m = buildMessage(makeSheet(), files, opts);
    expect(m.text).toContain("1. Test Heights: lift 1.84x, ZIP 37206.");
    expect(m.text).toContain("2. Area 2: lift 1.51x.");
    expect(m.text).toContain("Partners (10 of 12; all 12 are in partners.csv)");
    expect(m.text).toMatch(/\d+\. Synthetic Shop 10, record store, [^.]+\. (Hours not listed: call first|[A-Z][a-z]{2} \d)/);
    expect(m.text).not.toMatch(/hours on the street-team day|area: |\.example/);
    expect(m.text).not.toContain("Synthetic Shop 11");
    expect(m.text).toContain("Partner call list (CSV): partners.csv");
    expect(m.text).toContain("Walkup did not contact anyone on this sheet.");
    expect(m.text).toContain("What this sheet doesn't show");
  });

  it("marks a national chain partner, as the plan page and the paper do", () => {
    const sheet = makeSheet();
    sheet.cards.partners.results = sheet.cards.partners.results.map((p, i) => (i === 0 ? { ...p, chain: true } : p));
    const m = buildMessage(sheet, [], opts);
    expect(m.text).toContain("1. Synthetic Shop 1, coffee, national chain, 1 Example Ave, Nashville.");
    expect(m.text).toContain("2. Synthetic Shop 2, record store, 2 Example Ave, Nashville.");
  });

  it("escapes HTML and strips line breaks from the subject", () => {
    const sheet = makeSheet();
    sheet.bill.acts = [{ name: "<b>Act</b>\r\nBcc: x@example.com", role: "headliner" }];
    const m = buildMessage(sheet, [], opts);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).toContain("&lt;b&gt;Act&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Act</b>");
  });

  it("never uses a declared partner's contact email", () => {
    const m = buildMessage(makeSheet(), [], opts);
    expect(m.text + m.html).not.toContain("friend@example.org");
  });

  it("formats the show date without time zone shifts", () => {
    expect(showDate("2026-12-11", "friday")).toBe("Fri Dec 11 2026");
    expect(showDate("2026-01-01", undefined)).toBe("Jan 1 2026");
  });
});

describe("buildMessage tile list", () => {
  const opts = { postalAddress: "1 Example St, Nashville, TN 37201", replyAddress: "s@example.com" };

  it("lists only tiles at or above the sheet's lift floor, highest first, whatever order they arrive in", () => {
    const sheet = makeSheet();
    const base = { billPct: 0.5, housePct: 0.5, popularityPct: 0.5, lat: 36.1, lon: -86.7 };
    sheet.cards.liftMap.results.tiles = [
      { ...base, geohash: "dn6m01", lift: 0.72, name: "Under Town" },
      { ...base, geohash: "dn6m02", lift: 1.45, name: "Second Place", lat: 36.3, lon: -86.5 },
      { ...base, geohash: "dn6m03", lift: 1.12, name: "Barely Over" },
      { ...base, geohash: "dn6m04", lift: 2.03, name: "Top Hill" },
    ];
    const m = buildMessage(sheet, [], opts);
    expect(m.text).toContain("1. Top Hill: lift 2.03");
    expect(m.text).toContain("2. Second Place: lift 1.45");
    expect(m.text).not.toContain("Under Town");
    expect(m.text).not.toContain("Barely Over");
  });

  it("leaves the tile section out when no tile clears the floor", () => {
    const sheet = makeSheet();
    sheet.cards.liftMap.results.tiles = [{ geohash: "dn6m01", lift: 0.9, billPct: 0.4, housePct: 0.5, popularityPct: 0.5, lat: 36.1, lon: -86.7 }];
    const m = buildMessage(sheet, [], opts);
    expect(m.text).not.toContain("versus the room's usual crowd");
    expect(m.text).not.toContain("dn6m01");
  });
});

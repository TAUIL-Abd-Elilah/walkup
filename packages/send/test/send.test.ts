import { describe, expect, it } from "vitest";
import { createMemoryLedger, type LedgerEntry } from "@walkup/contracts";
import {
  DEFAULT_DAILY_CAP,
  LEDGER_ENDPOINT,
  NOT_AFFILIATED_LINE,
  TEST_INBOX,
  TOKEN_TTL_MS,
  confirmSend,
  createMemorySendStore,
  createSheetLedger,
  prepareSend,
  type PrepareSendResult,
  type SendStore,
  type TypedRecipient,
} from "../src/index";
import {
  PDF_BYTES,
  T0,
  TEST_POSTAL,
  clock,
  demoConfig,
  fakeExporters,
  forbiddenClient,
  freshStore,
  liveConfig,
  makeSheet,
  mockResend,
  tokenPayloadText,
} from "./helpers";

const IP = "203.0.113.7";
const typed = (address: string): TypedRecipient => ({ address, typedByOperator: true });

function ready(r: PrepareSendResult) {
  if (r.status !== "ready") throw new Error(`expected ready, got refused: ${r.reason}`);
  return r;
}

function setup(config = liveConfig()) {
  const c = clock();
  const store = freshStore(c.now);
  const ledger = createMemoryLedger();
  const exporters = fakeExporters();
  const client = mockResend();
  return { c, store, ledger, exporters, client, config };
}

describe("prepareSend", () => {
  it("defaults to the test inbox, renders all three attachments and writes nothing to the ledger", async () => {
    const s = setup();
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    expect(r.preview.recipients).toEqual([{ address: TEST_INBOX, source: "test_inbox" }]);
    expect(r.preview.mode).toBe("live");
    expect(r.preview.attachments.map((a) => a.filename)).toEqual(["fixture-street-sheet.pdf", "fixture-street-team.ics", "fixture-partners.csv"]);
    expect(r.preview.attachments[0]?.bytes).toBe(PDF_BYTES.byteLength);
    expect(s.exporters.calls).toEqual(["pdf:syn-plan-1", "ics:syn-plan-1", "csv:syn-plan-1"]);
    expect(r.preview.expiresAt).toBe(new Date(T0 + TOKEN_TTL_MS).toISOString());
    expect(r.preview.sendsLeftToday).toBe(DEFAULT_DAILY_CAP);
    expect(r.confirmToken.startsWith("hl1.")).toBe(true);
    expect(s.ledger.entries()).toHaveLength(0);
    expect(s.client.calls).toHaveLength(0);
  });

  it("puts the not-affiliated line, the what-if note and a CAN-SPAM footer in the message", async () => {
    const s = setup();
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    const { text, footer, subject } = r.preview;
    expect(subject).toBe("Street sheet for Synthetic Headliner, Test Hall, Fri Nov 20 2026 (sample)");
    expect(text).toContain(NOT_AFFILIATED_LINE);
    expect(text).toContain("Suggested, not affiliated");
    // The web sheet's own words: no uppercase labels, no "what-if numbers the operator typed".
    expect(text).toContain("Seats left 1,200 and capacity 3,000 are assumed numbers, not ticket sales.");
    expect(text).toContain("Sample sheet: made-up places and numbers, not a live run.");
    expect(text).not.toMatch(/HYPOTHETICAL|FIXTURE|synthetic|illustrative/);
    expect(footer).toContain(TEST_POSTAL);
    expect(footer).toMatch(/opt out/i);
    expect(footer).toContain("sheets@example.com");
    expect(text).toContain(footer);
  });

  it("never adds an address from the sheet: a declared partner's contact email stays off the list", async () => {
    const s = setup();
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    expect(r.preview.recipients.map((x) => x.address)).toEqual([TEST_INBOX]);
    expect(JSON.stringify(r.preview)).not.toContain("friend@example.org");
  });

  it("refuses an untyped recipient (no typedByOperator flag, a plain string, or a non-true flag)", async () => {
    const s = setup();
    const deps = { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters };
    const bad: unknown[] = [
      [{ address: "lead@example.com" }],
      ["lead@example.com"],
      [{ address: "lead@example.com", typedByOperator: "true" }],
      [{ address: "lead@example.com", typedByOperator: false }],
    ];
    for (const recipients of bad) {
      // Deliberately malformed input, as a JS caller or a bad request body could send it.
      const r = await prepareSend({ sheet: makeSheet(), requesterIp: IP, recipients: recipients as TypedRecipient[] }, deps);
      expect(r.status).toBe("refused");
      if (r.status === "refused") expect(r.reason).toMatch(/not typed by the operator/);
    }
    expect(s.exporters.calls).toHaveLength(0);
  });

  it("checks syntax, caps typed addresses at 5 and drops duplicates", async () => {
    const s = setup();
    const deps = { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters };
    for (const a of ["no-at-sign", "a@b", "two@@example.com", "x y@example.com", "a@example.com\r\nBcc: z@example.com", "Name <a@example.com>"]) {
      const r = await prepareSend({ sheet: makeSheet(), requesterIp: IP, recipients: [typed(a)] }, deps);
      expect(r.status, a).toBe("refused");
    }
    const five = ["a", "b", "c", "d", "e"].map((x) => typed(`${x}@example.com`));
    const ok = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP, recipients: [...five, typed("A@EXAMPLE.COM"), typed(TEST_INBOX)] }, deps));
    expect(ok.preview.recipients).toHaveLength(6);
    expect(ok.preview.recipients.filter((x) => x.source === "typed")).toHaveLength(5);
    const six = await prepareSend({ sheet: makeSheet(), requesterIp: IP, recipients: [...five, typed("f@example.com")] }, deps);
    expect(six.status).toBe("refused");
    if (six.status === "refused") expect(six.reason).toMatch(/At most 5/);
  });

  it("keeps typed addresses out of the token in plain text", async () => {
    const s = setup();
    const r = ready(
      await prepareSend(
        { sheet: makeSheet(), requesterIp: IP, recipients: [typed("street.lead@example.com")] },
        { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters },
      ),
    );
    expect(r.confirmToken).not.toContain("street.lead");
    expect(tokenPayloadText(r.confirmToken)).not.toContain("street.lead");
    expect(tokenPayloadText(r.confirmToken)).not.toContain(IP);
  });

  it("accepts a subset of attachments and refuses unknown kinds", async () => {
    const s = setup();
    const deps = { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters };
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP, attachments: ["partners", "ics"] }, deps));
    expect(r.preview.attachments.map((a) => a.filename)).toEqual(["fixture-street-team.ics", "fixture-partners.csv"]);
    const bad = await prepareSend({ sheet: makeSheet(), requesterIp: IP, attachments: ["zip" as never] }, deps);
    expect(bad.status).toBe("refused");
  });

  it("leaves out an export that fails and says so in the preview", async () => {
    const s = setup();
    const exporters = fakeExporters({
      pdf: () => {
        throw new Error("renderer unavailable");
      },
    });
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters }));
    expect(r.preview.attachments.map((a) => a.kind)).toEqual(["ics", "partners"]);
    expect(r.preview.attachmentFailures).toEqual([
      { kind: "pdf", filename: "fixture-street-sheet.pdf", reason: "could not build fixture-street-sheet.pdf: renderer unavailable" },
    ]);
  });

  it("refuses a real send without a postal address", async () => {
    const s = setup(liveConfig({ WALKUP_POSTAL_ADDRESS: undefined }));
    const r = await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters });
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.reason).toContain("WALKUP_POSTAL_ADDRESS");
  });

  it("refuses something that is not a sheet", async () => {
    const s = setup();
    const r = await prepareSend({ sheet: {} as never, requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters });
    expect(r.status).toBe("refused");
  });
});

describe("confirmSend: live path with a mocked Resend client", () => {
  it("sends once and records the message id in an A# action entry", async () => {
    const s = setup();
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    s.c.advance(30_000);
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    expect(out.status).toBe("sent");
    expect(out.messageId).toBe("re_synthetic_1");
    expect(out.ledgerEntryId).toBe("A1");
    expect(out.planId).toBe("syn-plan-1");

    const e = s.ledger.entries()[0] as LedgerEntry;
    expect(e).toMatchObject({
      id: "A1",
      kind: "action",
      method: "ACTION",
      endpoint: LEDGER_ENDPOINT,
      httpStatus: 200,
      envelopeStatus: "ok",
      cacheHit: false,
      curl: "",
      resultCount: 1,
    });
    expect(e.endpoint).toBe("resend.emails.send");
    expect(e.note).toBe("sent: message id re_synthetic_1");
    expect(e.params["recipients"]).toEqual([TEST_INBOX]);
    expect(e.params["attachments"]).toEqual(["fixture-street-sheet.pdf", "fixture-street-team.ics", "fixture-partners.csv"]);
    expect(e.bytes).toBeGreaterThan(0);
    expect(out.ledgerEntry).toEqual(e);

    expect(s.client.calls).toHaveLength(1);
    const call = s.client.calls[0]!;
    const p = call.payload as unknown as Record<string, unknown>;
    expect(p["from"]).toBe("Walkup Test <sheets@example.com>");
    expect(p["to"]).toEqual([TEST_INBOX]);
    expect(p["bcc"]).toBeUndefined();
    expect(p["subject"]).toBe(r.preview.subject);
    expect(p["text"]).toBe(r.preview.text);
    expect(String(p["html"])).toContain("Suggested, not affiliated");
    const atts = p["attachments"] as { filename: string; content: Buffer; contentType: string }[];
    expect(atts.map((a) => a.filename)).toEqual(["fixture-street-sheet.pdf", "fixture-street-team.ics", "fixture-partners.csv"]);
    expect(Buffer.from(atts[0]!.content).equals(Buffer.from(PDF_BYTES))).toBe(true);
    expect((p["headers"] as Record<string, string>)["List-Unsubscribe"]).toBe("<mailto:sheets@example.com?subject=unsubscribe>");
    expect(call.options?.idempotencyKey).toMatch(/^walkup-send-/);
  });

  it("hashes typed addresses in the ledger and keeps them out of each other's view", async () => {
    const s = setup();
    const r = ready(
      await prepareSend(
        { sheet: makeSheet(), requesterIp: IP, recipients: [typed("lead@example.com"), typed("Partner@Example.net")] },
        { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters },
      ),
    );
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    expect(out.status).toBe("sent");
    const p = s.client.calls[0]!.payload as unknown as Record<string, unknown>;
    expect(p["to"]).toEqual([TEST_INBOX]);
    expect(p["bcc"]).toEqual(["lead@example.com", "Partner@example.net"]);

    const e = s.ledger.entries()[0] as LedgerEntry;
    const recips = e.params["recipients"] as string[];
    expect(recips[0]).toBe(TEST_INBOX);
    expect(recips.slice(1).every((x) => /^typed:[0-9a-f]{12}$/.test(x))).toBe(true);
    expect(e.params["recipientCount"]).toBe(3);
    const dump = JSON.stringify(s.ledger.entries()) + JSON.stringify(out);
    expect(dump).not.toMatch(/lead@example\.com|partner@example\.net/i);
  });

  it("with only typed recipients and no test inbox, sends to the sender and bccs everyone", async () => {
    const s = setup();
    const r = ready(
      await prepareSend(
        { sheet: makeSheet(), requesterIp: IP, includeTestInbox: false, recipients: [typed("a@example.com"), typed("b@example.com")] },
        { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters },
      ),
    );
    await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    const p = s.client.calls[0]!.payload as unknown as Record<string, unknown>;
    expect(p["to"]).toEqual(["sheets@example.com"]);
    expect(p["bcc"]).toEqual(["a@example.com", "b@example.com"]);
  });

  it("reports a provider error as failed, with any address masked", async () => {
    const s = setup();
    const client = mockResend(() => ({
      data: null,
      error: { name: "validation_error", statusCode: 422, message: "Invalid `to` field: lead@example.com is not allowed" },
      headers: null,
    }));
    const r = ready(
      await prepareSend(
        { sheet: makeSheet(), requesterIp: IP, recipients: [typed("lead@example.com")] },
        { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters },
      ),
    );
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: client });
    expect(out.status).toBe("failed");
    expect(out.messageId).toBeUndefined();
    const e = s.ledger.entries()[0] as LedgerEntry;
    expect(e.envelopeStatus).toBe("error");
    expect(e.httpStatus).toBe(422);
    expect(e.note).toContain("validation_error");
    expect(e.note).toContain("[address]");
    expect(JSON.stringify(e) + JSON.stringify(out)).not.toContain("lead@example.com");
  });

  it("reports a thrown client error as failed", async () => {
    const s = setup();
    const client = mockResend(() => {
      throw new Error("network down");
    });
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: client });
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("network down");
  });
});

describe("confirmSend: token rules", () => {
  async function prepared(s: ReturnType<typeof setup>, ip = IP) {
    return ready(await prepareSend({ sheet: makeSheet(), requesterIp: ip }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
  }

  it("refuses a tampered token and never calls the provider", async () => {
    const s = setup();
    const r = await prepared(s);
    const [v, body, mac] = r.confirmToken.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    payload["exp"] = (payload["exp"] as number) + 60 * 60 * 1000;
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const flip = (str: string, i: number) => str.slice(0, i) + (str[i] === "A" ? "B" : "A") + str.slice(i + 1);
    const variants = [
      `${v}.${forgedBody}.${mac}`,
      `${v}.${body}.${flip(mac, 3)}`,
      `${v}.${flip(body, 10)}.${mac}`,
      `hl2.${body}.${mac}`,
      "not-a-token",
      "",
    ];
    for (const t of variants) {
      const out = await confirmSend(t, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
      expect(out.status, t.slice(0, 20)).toBe("refused");
      expect(out.planId).toBeNull();
    }
    const entries = s.ledger.entries();
    expect(entries).toHaveLength(variants.length);
    expect(entries.every((e) => e.kind === "action" && e.endpoint === LEDGER_ENDPOINT && e.note?.startsWith("refused:"))).toBe(true);
    expect(entries.every((e) => e.resultCount === 0 && e.envelopeStatus === "error")).toBe(true);

    // The untouched token still works after the failed attempts.
    const ok = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    expect(ok.status).toBe("sent");
  });

  it("refuses a token signed with another server's secret", async () => {
    const s = setup();
    const r = await prepared(s);
    const other = liveConfig({ WALKUP_SIGNING_SECRET: "a-different-secret-that-is-long-enough-0000" });
    const out = await confirmSend(r.confirmToken, { config: other, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/does not match/);
  });

  it("refuses when the stored message or attachments no longer match the token", async () => {
    const s = setup();
    const swapped: SendStore = {
      ...s.store,
      async takePending(id) {
        const p = await s.store.takePending(id);
        if (!p) return p;
        const first = p.attachments[0]!;
        // Same length and the old hash field: only the bytes differ.
        const swappedBytes = new Uint8Array(first.content.byteLength).fill(65);
        return { ...p, attachments: [{ ...first, content: swappedBytes }, ...p.attachments.slice(1)] };
      },
    };
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: swapped, now: s.c.now, exporters: s.exporters }));
    const out = await confirmSend(r.confirmToken, { config: s.config, store: swapped, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/changed after the preview/);
  });

  it("expires after 10 minutes", async () => {
    const s = setup();
    const a = await prepared(s);
    const b = await prepared(s);
    s.c.advance(TOKEN_TTL_MS - 1000);
    const ok = await confirmSend(a.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    expect(ok.status).toBe("sent");
    s.c.advance(2000);
    const late = await confirmSend(b.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(late.status).toBe("refused");
    expect(late.reason).toMatch(/expired/);
    expect(late.planId).toBe("syn-plan-1");
    expect(s.ledger.entries().map((e) => e.id)).toEqual(["A1", "A2"]);
  });

  it("is single use: a replay is refused and the provider is called once", async () => {
    const s = setup();
    const r = await prepared(s);
    const deps = { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client };
    const first = await confirmSend(r.confirmToken, deps);
    const second = await confirmSend(r.confirmToken, deps);
    expect(first.status).toBe("sent");
    expect(second.status).toBe("refused");
    expect(second.reason).toMatch(/already used/);
    expect(s.client.calls).toHaveLength(1);
    const [a1, a2] = s.ledger.entries();
    expect(a1?.note).toContain("message id");
    expect(a2?.note).toMatch(/^refused: This confirm token was already used/);
  });

  it("refuses when a different requester confirms", async () => {
    const s = setup();
    const r = await prepared(s);
    const out = await confirmSend(r.confirmToken, {
      config: s.config,
      store: s.store,
      now: s.c.now,
      ledger: s.ledger,
      mailClient: forbiddenClient(),
      requesterIp: "198.51.100.9",
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/different requester/);
    const same = await prepared(s);
    const ok = await confirmSend(same.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client, requesterIp: IP });
    expect(ok.status).toBe("sent");
  });

  it("refuses when the server restarted between prepare and confirm (pending entry gone)", async () => {
    const s = setup();
    const r = await prepared(s);
    const out = await confirmSend(r.confirmToken, { config: s.config, store: freshStore(s.c.now), now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/no longer on this server/);
  });
});

describe("per-requester daily cap", () => {
  it("allows 10 sends per IP per UTC day, then refuses at prepare; other IPs and the next day are unaffected", async () => {
    const s = setup();
    const pdeps = { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters };
    const cdeps = { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client };
    for (let i = 0; i < DEFAULT_DAILY_CAP; i++) {
      const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, pdeps));
      expect(r.preview.sendsLeftToday).toBe(DEFAULT_DAILY_CAP - i);
      expect((await confirmSend(r.confirmToken, cdeps)).status).toBe("sent");
    }
    const over = await prepareSend({ sheet: makeSheet(), requesterIp: IP }, pdeps);
    expect(over.status).toBe("refused");
    if (over.status === "refused") expect(over.reason).toMatch(/Daily limit reached: 10/);

    const other = ready(await prepareSend({ sheet: makeSheet(), requesterIp: "198.51.100.20" }, pdeps));
    expect((await confirmSend(other.confirmToken, cdeps)).status).toBe("sent");

    s.c.set(Date.UTC(2026, 9, 14, 0, 0, 1));
    const tomorrow = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, pdeps));
    expect((await confirmSend(tomorrow.confirmToken, cdeps)).status).toBe("sent");
  });

  it("enforces the cap again at confirm (tokens prepared before the cap was reached)", async () => {
    const s = setup(liveConfig({ WALKUP_SEND_DAILY_CAP: "2" }));
    const pdeps = { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters };
    const tokens = [];
    for (let i = 0; i < 3; i++) tokens.push(ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, pdeps)).confirmToken);
    const cdeps = { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: s.client };
    const results = [];
    for (const t of tokens) results.push(await confirmSend(t, cdeps));
    expect(results.map((r) => r.status)).toEqual(["sent", "sent", "refused"]);
    expect(results[2]?.reason).toMatch(/Daily limit reached: 2/);
    expect(s.client.calls).toHaveLength(2);
  });

  it("never stores the raw IP", async () => {
    const seen: string[] = [];
    const s = setup();
    const spy: SendStore = {
      ...s.store,
      sendsToday: (k, d) => {
        seen.push(k);
        return s.store.sendsToday(k, d);
      },
      reserveSend: (k, d, c) => {
        seen.push(k);
        return s.store.reserveSend(k, d, c);
      },
    };
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: spy, now: s.c.now, exporters: s.exporters }));
    await confirmSend(r.confirmToken, { config: s.config, store: spy, now: s.c.now, ledger: s.ledger, mailClient: s.client });
    expect(seen.length).toBe(2);
    expect(seen.every((k) => !k.includes("203.0.113") && /^[0-9a-f]{16}$/.test(k))).toBe(true);
  });
});

describe("demo path (no Resend keys)", () => {
  it("records an A# entry marked demo: not sent and never builds a client", async () => {
    const s = setup(demoConfig());
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    expect(r.preview.mode).toBe("demo");
    expect(r.preview.modeReason).toBe("RESEND_API_KEY and RESEND_FROM are not set on this server, so nothing is sent.");
    expect(r.preview.footer).toContain("Postal address not configured");

    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("demo_not_sent");
    expect(out.messageId).toBeUndefined();
    expect(out.ledgerEntryId).toBe("A1");
    expect(out.reason).toMatch(/^demo: not sent\./);
    const e = s.ledger.entries()[0] as LedgerEntry;
    expect(e.kind).toBe("action");
    expect(e.endpoint).toBe("resend.emails.send");
    expect(e.note).toMatch(/^demo: not sent\. RESEND_API_KEY and RESEND_FROM are not set/);
    expect(e.envelopeStatus).toBe("degraded");
    expect(e.httpStatus).toBeNull();
    expect(e.resultCount).toBe(0);
    expect(e.params["provider"]).toBe("none (demo)");
    expect(e.params["recipients"]).toEqual([TEST_INBOX]);
  });

  it("names only the missing key", async () => {
    const s = setup(demoConfig({ RESEND_API_KEY: "test-resend-key-not-real" }));
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    expect(r.preview.modeReason).toBe("RESEND_FROM is not set on this server, so nothing is sent.");
  });

  it("still applies replay and cap rules", async () => {
    const s = setup(demoConfig({ WALKUP_SEND_DAILY_CAP: "1" }));
    const deps = { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() };
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { ...deps, exporters: s.exporters }));
    expect((await confirmSend(r.confirmToken, deps)).status).toBe("demo_not_sent");
    expect((await confirmSend(r.confirmToken, deps)).status).toBe("refused");
    expect((await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { ...deps, exporters: s.exporters })).status).toBe("refused");
  });
});

describe("createSheetLedger", () => {
  it("continues a sheet's numbering", async () => {
    const s = setup(demoConfig());
    const existing: LedgerEntry[] = [
      { id: "Q1", kind: "qloo", method: "GET", endpoint: "/search", params: {}, httpStatus: 200, envelopeStatus: "ok", latencyMs: 1, bytes: 1, cacheHit: false, resultCount: 1, curl: "", startedAt: "2026-10-13T00:00:00.000Z" },
      { id: "A1", kind: "action", method: "ACTION", endpoint: LEDGER_ENDPOINT, params: {}, httpStatus: null, envelopeStatus: "degraded", latencyMs: 0, bytes: 0, cacheHit: false, resultCount: 0, curl: "", startedAt: "2026-10-13T00:00:00.000Z" },
    ];
    const ledger = createSheetLedger(existing);
    const r = ready(await prepareSend({ sheet: makeSheet({ ledger: existing }), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger });
    expect(out.ledgerEntryId).toBe("A2");
    expect(ledger.entries().map((e) => e.id)).toEqual(["Q1", "A1", "A2"]);
  });
});

describe("confirm matches what the person saw", () => {
  it("refuses when the server moved from demo to live between preview and confirm, and never calls the provider", async () => {
    const s = setup(demoConfig());
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    expect(r.preview.mode).toBe("demo");
    const out = await confirmSend(r.confirmToken, { config: liveConfig(), store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/mode changed after the preview \(was demo, now live\)/);
    expect(s.ledger.entries()[0]?.note).toMatch(/^refused: .*Nothing was sent\.$/);
  });

  it("refuses when the server moved from live to demo", async () => {
    const s = setup();
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    const out = await confirmSend(r.confirmToken, { config: demoConfig(), store: s.store, now: s.c.now, ledger: s.ledger, mailClient: forbiddenClient() });
    expect(out.status).toBe("refused");
    expect(out.reason).toMatch(/was live, now demo/);
  });
});

describe("failed sends say what is known", () => {
  it("a 4xx from Resend means nothing was sent", async () => {
    const s = setup();
    const client = mockResend(() => ({ data: null, error: { name: "invalid_from_address", statusCode: 403, message: "domain not verified" }, headers: null }));
    const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
    const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: client });
    expect(out.status).toBe("failed");
    expect(s.ledger.entries()[0]?.note).toMatch(/Nothing was sent\.$/);
  });

  it("a network error or a 5xx leaves the outcome unknown, and the ledger does not claim nothing went out", async () => {
    const s = setup();
    const responses = [
      () => ({ data: null, error: { name: "application_error" as const, statusCode: null, message: "Unable to fetch data." }, headers: null }),
      () => ({ data: null, error: { name: "internal_server_error" as const, statusCode: 500, message: "oops" }, headers: null }),
      () => {
        throw new Error("socket hang up");
      },
    ];
    for (const respond of responses) {
      const r = ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config: s.config, store: s.store, now: s.c.now, exporters: s.exporters }));
      const out = await confirmSend(r.confirmToken, { config: s.config, store: s.store, now: s.c.now, ledger: s.ledger, mailClient: mockResend(respond) });
      expect(out.status).toBe("failed");
      expect(out.reason).toMatch(/may or may not have gone out/);
    }
    expect(s.ledger.entries().every((e) => !/Nothing was (sent|delivered)/.test(e.note ?? ""))).toBe(true);
  });
});

describe("in-memory store bound", () => {
  it("drops the oldest pending send past maxPending; its confirm is refused and the newer ones still work", async () => {
    const c = clock();
    const store = createMemorySendStore({ now: c.now, maxPending: 2 });
    const config = liveConfig();
    const exporters = fakeExporters();
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) tokens.push(ready(await prepareSend({ sheet: makeSheet(), requesterIp: IP }, { config, store, now: c.now, exporters })).confirmToken);
    const ledger = createMemoryLedger();
    const client = mockResend();
    const first = await confirmSend(tokens[0]!, { config, store, now: c.now, ledger, mailClient: client });
    expect(first.status).toBe("refused");
    expect(first.reason).toMatch(/no longer on this server/);
    expect((await confirmSend(tokens[1]!, { config, store, now: c.now, ledger, mailClient: client })).status).toBe("sent");
    expect((await confirmSend(tokens[2]!, { config, store, now: c.now, ledger, mailClient: client })).status).toBe("sent");
  });
});

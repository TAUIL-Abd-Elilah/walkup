/**
 * Synthetic test data, fake exporters and a mock Resend client. Every name,
 * address and id below is invented for tests ("synthetic": true). No network.
 */
import type { CreateEmailOptions, CreateEmailRequestOptions, CreateEmailResponse } from "resend";
import { LIMITS_EVERY_SHEET, type Partner, type StreetSheet } from "@walkup/contracts";
import { createMemorySendStore, resolveSendConfig, type MailClient, type SendConfig, type SheetExporters } from "../src/index";

export const SYNTHETIC = true;

export const TEST_SECRET = "test-only-signing-secret-0123456789abcdef";
export const TEST_FROM = "Walkup Test <sheets@example.com>";
export const TEST_POSTAL = "100 Example Street, Suite 1, Nashville, TN 37201";
export const T0 = Date.UTC(2026, 9, 13, 15, 0, 0);

export function liveConfig(over: Record<string, string | undefined> = {}): SendConfig {
  return resolveSendConfig({
    WALKUP_SIGNING_SECRET: TEST_SECRET,
    RESEND_API_KEY: "test-resend-key-not-real",
    RESEND_FROM: TEST_FROM,
    WALKUP_POSTAL_ADDRESS: TEST_POSTAL,
    ...over,
  });
}

export function demoConfig(over: Record<string, string | undefined> = {}): SendConfig {
  return resolveSendConfig({ WALKUP_SIGNING_SECRET: TEST_SECRET, ...over });
}

function partner(i: number): Partner {
  return {
    entity: {
      entityId: `syn-place-${i}`,
      name: `Synthetic Shop ${i}`,
      subtype: "urn:entity:place",
      popularity: 0.5,
      affinity: 0.6,
      tags: [],
      properties: {},
    },
    tileGeohash: "dn6m9q",
    tileName: "Test Heights",
    category: i % 2 === 0 ? "record_store" : "coffee",
    score: 0.9 - i / 100,
    qlooRank: i,
    hoursOnDay: "10:00-20:00",
    address: `${i} Example Ave, Nashville, TN`,
    phone: `615-555-01${String(i).padStart(2, "0")}`,
    website: "https://example.com/",
    chips: [{ label: "over-indexes for this bill", ledgerRef: "Q9" }],
  };
}

export function makeSheet(over: Partial<StreetSheet> = {}): StreetSheet {
  const env = <T,>(results: T) => ({ status: "ok" as const, summary: "synthetic", results, provenance: [], limits: [] });
  return {
    planId: "syn-plan-1",
    createdAt: "2026-10-13T12:00:00.000Z",
    mode: "fixture",
    hypothetical: true,
    bill: {
      acts: [
        { name: "Synthetic Headliner", role: "headliner" },
        { name: "Synthetic Opener", role: "support" },
      ],
      venue: { name: "Test Hall", lat: 36.16, lon: -86.77, city: "Nashville", state: "TN", country: "US" },
      date: "2026-11-20",
      weekday: "friday",
      legalAgeEnforced: false,
    },
    operator: {
      seatsLeft: 1200,
      capacity: 3000,
      mediaBudgetUsd: null,
      streetTeamDays: ["thursday", "saturday"],
      radiusKm: 40,
      declaredPartners: [{ label: "Operator's Friend Cafe", contactEmail: "friend@example.org" }],
    },
    cards: {
      resolution: env([]),
      liftMap: {
        ...env({
          tiles: [
            { geohash: "dn6m9q", lat: 36.17, lon: -86.75, lift: 1.84, billPct: 0.9, housePct: 0.4, popularityPct: 0.8, name: "Test Heights", zctas: ["37206"] },
            { geohash: "dn6m9r", lat: 36.25, lon: -86.6, lift: 1.51, billPct: 0.8, housePct: 0.5, popularityPct: 0.7 },
          ],
          diagnostics: { spearmanLiftVsHeat: 0.3, baseline: "house" as const },
        }),
      },
      partners: env(Array.from({ length: 12 }, (_, i) => partner(i + 1))),
      declared: env([]),
      prePost: env([]),
      media: env([]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env({ shared: [], a: [], b: [], fromTagDiff: false }),
      copyHooks: env([]),
    },
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    limits: [...LIMITS_EVERY_SHEET],
    ...over,
  };
}

export const PDF_BYTES = new Uint8Array(Buffer.from("%PDF-1.4\n% synthetic test pdf\n%%EOF\n", "latin1"));

export function fakeExporters(over: Partial<SheetExporters> = {}): SheetExporters & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pdf: (s) => {
      calls.push(`pdf:${s.planId}`);
      return PDF_BYTES;
    },
    ics: (s) => {
      calls.push(`ics:${s.planId}`);
      return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
    },
    partners: (s) => {
      calls.push(`csv:${s.planId}`);
      return "rank,name\r\n1,Synthetic Shop 1\r\n";
    },
    ...over,
  };
}

export interface MockCall {
  payload: CreateEmailOptions;
  options: CreateEmailRequestOptions | undefined;
}

export function mockResend(
  respond: (call: MockCall, n: number) => CreateEmailResponse | Promise<CreateEmailResponse> = (_c, n) => ({
    data: { id: `re_synthetic_${n}` },
    error: null,
    headers: null,
  }),
): MailClient & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    emails: {
      async send(payload, options) {
        const call = { payload, options };
        calls.push(call);
        return respond(call, calls.length);
      },
    },
  };
}

/** A client that fails the test if it is ever called. */
export function forbiddenClient(): MailClient {
  return {
    emails: {
      send() {
        throw new Error("the mail client must not be called here");
      },
    },
  };
}

export function clock(start = T0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export function freshStore(now: () => number) {
  return createMemorySendStore({ now });
}

/** Decodes the JSON payload part of a confirm token (no verification). */
export function tokenPayloadText(token: string): string {
  const body = token.split(".")[1] ?? "";
  return Buffer.from(body, "base64url").toString("utf8");
}

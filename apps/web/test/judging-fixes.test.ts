import { describe, expect, it } from "vitest";
import { toolCallsLine } from "../components/plan/model";
import { recordedDetail, runtimeMode } from "../lib/mode";
import { REVISES_PER_HOUR } from "../lib/server/limits";

describe("tool calls named on a revision", () => {
  it("lists each tool once, without the question tool", () => {
    expect(
      toolCallsLine([
        { tool: "set_all_ages" },
        { tool: "exclude_partner_categories" },
        { tool: "exclude_partner_categories" },
        { tool: "ask_operator" },
      ]),
    ).toBe("Tool calls: set_all_ages, exclude_partner_categories.");
  });

  it("says nothing when no tool was called", () => {
    expect(toolCallsLine([])).toBeNull();
    expect(toolCallsLine([{ tool: "ask_operator" }])).toBeNull();
  });
});

describe("the recorded strip names a later day for ready-made changes", () => {
  it("adds the changes day only when it is later than the recorded day", () => {
    expect(recordedDetail("2026-10-21", "2026-10-28")).toBe(
      "Recorded from live Qloo and Ticketmaster runs on Oct 21 2026; changes recorded ahead on Oct 28 2026. Live runs are paused for judging; these sheets are what a live run produced.",
    );
    expect(recordedDetail("2026-10-21", "2026-10-21")).toBe(recordedDetail("2026-10-21"));
    expect(recordedDetail("2026-10-21", null)).toBe(recordedDetail("2026-10-21"));
    expect(recordedDetail(null, "2026-10-28")).toBe(recordedDetail(null));
  });

  it("reads the changes day from the options", () => {
    const env = { WALKUP_MODE: "recorded" };
    const mode = runtimeMode(env, { recordedOn: () => "2026-10-21", changesRecordedOn: () => "2026-10-28" });
    expect(mode.detail).toContain("changes recorded ahead on Oct 28 2026");
    expect(runtimeMode(env, { recordedOn: () => "2026-10-21" }).detail).toBe(recordedDetail("2026-10-21"));
  });
});

describe("change notes on the recorded site", () => {
  it("allow more notes per network than live runs, since they call no API", () => {
    expect(REVISES_PER_HOUR.recorded).toBeGreaterThan(REVISES_PER_HOUR.live);
  });
});

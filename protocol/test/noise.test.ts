import { describe, expect, test } from "bun:test";
import { ACTIONS, parseActionParams, parseActionResult } from "../src/actions.ts";
import { AGENT_META, buildRaftManifest } from "../src/agent.ts";
import { CAPABILITIES } from "../src/frames.ts";
import { chatSummary } from "../src/model.ts";
import { MAX_NOISE_DECISIONS, MAX_NOISE_DEFINITION_LENGTH, MAX_NOISE_LINES, NOISE_CONFIDENCE_THRESHOLD, noiseDecision, noiseLines, noiseSettings } from "../src/noise.ts";
import { parse } from "../src/schema.ts";
import { WEB_PAGES } from "../src/web.ts";
import { chat, chatID } from "./fixtures/examples.ts";

const settings = { definition: "Newsletters\nCold emails I sent that nobody answered", enabled: true, keySet: true, problem: null, noiseCount: 2, decisions: [] };
const decision = { chatID, title: "Weekly digest", network: "Gmail", noise: true, reason: "Newsletters", confidence: 0.91, source: "jev", at: "2026-10-29T10:00:00.000Z" };

describe("noise definition lines", () => {
  test("one idea per line: trimmed, bullets and numbers dropped, empty and repeated lines left out", () => {
    expect(noiseLines("  Newsletters, ads, app notifications \n\n- Cold emails I sent that nobody has replied to yet\n* newsletters, ADS, app notifications\n2) Receipts\r\n• Shipping updates\n")).toEqual([
      "Newsletters, ads, app notifications",
      "Cold emails I sent that nobody has replied to yet",
      "Receipts",
      "Shipping updates",
    ]);
    expect(noiseLines("")).toEqual([]);
    expect(noiseLines("\n \t \n")).toEqual([]);
  });
  test("bounded: at most MAX_NOISE_LINES lines of at most 300 characters, controls and lone surrogates cleaned", () => {
    const many = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
    expect(noiseLines(many)).toHaveLength(MAX_NOISE_LINES);
    const [long] = noiseLines("x".repeat(1000));
    expect(long!.length).toBe(300);
    const [hostile] = noiseLines("a\u0000b‮ c \ud800 <script>");
    expect(parse(noiseDecision, { ...decision, reason: hostile }).ok).toBe(true);
  });
  test("the threshold: uncertain is not noise", () => expect(NOISE_CONFIDENCE_THRESHOLD).toBe(0.7));
});

describe("shapes", () => {
  test("ChatSummary.noise: reason, confidence 0-1, source jev or owner", () => {
    expect(parse(chatSummary, { ...chat, isLowPriority: true, noise: { reason: "Newsletters", confidence: 0.9, source: "jev" } }).ok).toBe(true);
    expect(parse(chatSummary, { ...chat, noise: { reason: "You marked it as noise", confidence: 1, source: "owner" } }).ok).toBe(true);
    for (const bad of [{ reason: "", confidence: 0.9, source: "jev" }, { reason: "x", confidence: 1.5, source: "jev" }, { reason: "x", confidence: 0.5, source: "agent" }, { reason: "x".repeat(301), confidence: 0.5, source: "jev" }, { reason: "x", confidence: 0.5, source: "jev", text: "leak" }])
      expect(parse(chatSummary, { ...chat, noise: bad }).ok).toBe(false);
  });
  test("settings and decisions", () => {
    expect(parse(noiseSettings, settings).ok).toBe(true);
    expect(parse(noiseSettings, { ...settings, decisions: Array(MAX_NOISE_DECISIONS).fill(decision) }).ok).toBe(true);
    expect(parse(noiseSettings, { ...settings, decisions: Array(MAX_NOISE_DECISIONS + 1).fill(decision) }).ok).toBe(false);
    expect(parse(noiseSettings, { ...settings, problem: "no_key" }).ok).toBe(true);
    expect(parse(noiseSettings, { ...settings, problem: "boom" }).ok).toBe(false);
    expect(parse(noiseDecision, { ...decision, noise: false, reason: null, confidence: 0.8 }).ok).toBe(true);
    expect(parse(noiseDecision, { ...decision, source: "owner", confidence: null }).ok).toBe(true);
  });
});

describe("actions", () => {
  test("owner only, at the connector (not cloud actions), never in the agent manifest", () => {
    for (const n of ["get_noise_settings", "set_noise_definition", "set_noise"] as const) {
      expect([ACTIONS[n].humanOnly, (ACTIONS[n] as { cloud?: boolean }).cloud, (ACTIONS[n] as { cloudOnly?: boolean }).cloudOnly, ACTIONS[n].needsApprovalForAgents]).toEqual([true, undefined, undefined, false]);
    }
    const names = buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" }).actions.map((a: { name: string }) => a.name);
    for (const n of ["get_noise_settings", "set_noise_definition", "set_noise"]) expect(names).not.toContain(n);
    expect(Object.keys(AGENT_META)).not.toContain("set_noise");
  });
  test("params and results", () => {
    expect(parseActionParams("set_noise_definition", { definition: "Newsletters\nAds" }).ok).toBe(true);
    expect(parseActionParams("set_noise_definition", { definition: "" }).ok).toBe(true);
    expect(parseActionParams("set_noise_definition", { definition: "x".repeat(MAX_NOISE_DEFINITION_LENGTH + 1) }).ok).toBe(false);
    expect(parseActionParams("set_noise_definition", {}).ok).toBe(false);
    expect(parseActionParams("set_noise", { chatID, noise: false }).ok).toBe(true);
    expect(parseActionParams("set_noise", { chatID, noise: "yes" }).ok).toBe(false);
    expect(parseActionParams("set_noise", { chatID }).ok).toBe(false);
    expect(parseActionParams("get_noise_settings", { x: 1 }).ok).toBe(false);
    expect(parseActionResult("get_noise_settings", settings).ok).toBe(true);
    expect(parseActionResult("set_noise_definition", { ...settings, decisions: [decision] }).ok).toBe(true);
    expect(parseActionResult("set_noise", { chatID, noise: true }).ok).toBe(true);
  });
  test("capability and page", () => {
    expect(CAPABILITIES.noise).toBe("noise.v1");
    expect(WEB_PAGES.noise).toBe("/settings/noise");
  });
});

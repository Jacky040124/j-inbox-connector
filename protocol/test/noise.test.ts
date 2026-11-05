import { describe, expect, test } from "bun:test";
import { ACTIONS, parseActionParams, parseActionResult } from "../src/actions.ts";
import { AGENT_META, buildRaftManifest } from "../src/agent.ts";
import { CAPABILITIES } from "../src/frames.ts";
import { chatSummary } from "../src/model.ts";
import { MAX_NOISE_DECISIONS, MAX_NOISE_DEFINITION_LENGTH, MAX_NOISE_LINES, NOISE_CONFIDENCE_THRESHOLD, SENDER_NOISE_REASON, noiseDecision, noiseLines, noiseSender, noiseSenderValue, noiseSettings, parseNoiseSender } from "../src/noise.ts";
import { parse } from "../src/schema.ts";
import { WEB_PAGES } from "../src/web.ts";
import { chat, chatID } from "./fixtures/examples.ts";

const settings = { definition: "Newsletters\nCold emails I sent that nobody answered", enabled: true, keySet: true, problem: null, noiseCount: 2, decisions: [] };
const decision = { chatID, title: "Weekly digest", network: "Gmail", noise: true, reason: "Newsletters", confidence: 0.91, source: "jev", at: "2026-10-29T10:00:00.000Z" };

describe("the noise list of senders", () => {
  test("an entry: what the owner typed, as an address or a domain; what can't be matched or could be a search operator is neither", () => {
    expect(parseNoiseSender(" Warm@Example.COM ")).toEqual({ kind: "address", value: "warm@example.com" });
    expect(parseNoiseSender("Example.com")).toEqual({ kind: "domain", value: "example.com" });
    expect(parseNoiseSender("@example.com")).toEqual({ kind: "domain", value: "example.com" });
    expect(parseNoiseSender("*@mail.example.co.uk")).toEqual({ kind: "domain", value: "mail.example.co.uk" });
    expect(parseNoiseSender("a.b+c_d@xn--bcher-kva.example")).toEqual({ kind: "address", value: "a.b+c_d@xn--bcher-kva.example" });
    for (const bad of ["", "@", "a", "localhost", "a@b", "a@b.c", "a b@example.com", "a@example.com b", "a@example.com OR b", "from:a@example.com", "{a@example.com}", "(a@example.com)", '"a"@example.com', "a@-example.com", "a@example.com.", "a@@example.com", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(64)}.com`, `${"x.".repeat(150)}com`, "unknown@unknown.invalid", 7, null]) expect(parseNoiseSender(bad)).toBeNull();
  });
  test("the schema takes only what parseNoiseSender makes", () => {
    expect(parse(noiseSenderValue, "warm@example.com").ok).toBe(true);
    expect(parse(noiseSenderValue, "example.com").ok).toBe(true);
    expect(parse(noiseSenderValue, "Warm@example.com").ok).toBe(false);
    expect(parse(noiseSender, { value: "example.com", kind: "domain", origin: "learned", addedAt: "2026-11-05T10:00:00.000Z" }).ok).toBe(true);
    expect(parse(noiseSender, { value: "example.com", kind: "domain", origin: "someone", addedAt: "2026-11-05T10:00:00.000Z" }).ok).toBe(false);
  });
  test("the mark, the decision: its own source and reason; owner only, never in the manifest", () => {
    expect(parse(chatSummary, { ...chat, isLowPriority: true, noise: { reason: SENDER_NOISE_REASON, confidence: 1, source: "sender" } }).ok).toBe(true);
    expect(parse(noiseDecision, { ...decision, source: "sender", reason: SENDER_NOISE_REASON, confidence: null }).ok).toBe(true);
    expect(CAPABILITIES.noiseSenders).toBe("noise-senders.v1");
    const manifest = JSON.stringify(buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" }));
    for (const name of ["get_noise_senders", "add_noise_sender", "add_noise_sender_of_chat", "remove_noise_sender"]) {
      expect(ACTIONS[name as keyof typeof ACTIONS].humanOnly).toBe(true);
      expect(manifest).not.toContain(name);
    }
  });
});

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

// Local audit log: JSONL, metadata only (what, when, ok/error), size-rotated.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.ts";

const dir = () => mkdtempSync(join(tmpdir(), "jinbox-audit-"));

describe("AuditLog", () => {
  test("writes one JSON object per line with only whitelisted fields; file is 0600", () => {
    const d = dir();
    const a = new AuditLog({ path: join(d, "audit.jsonl"), now: () => Date.parse("2026-10-25T10:00:00Z") });
    a.request({ action: "send_message", ok: true, ms: 120 });
    a.request({ action: "read_chat", ok: false, code: "TIMEOUT", ms: 14000 });
    a.lifecycle("cloud.connected");
    a.lifecycle("cloud.disconnected", { closeCode: 1006 });
    const lines = readFileSync(join(d, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { ts: "2026-10-25T10:00:00.000Z", event: "request", action: "send_message", ok: true, ms: 120 },
      { ts: "2026-10-25T10:00:00.000Z", event: "request", action: "read_chat", ok: false, code: "TIMEOUT", ms: 14000 },
      { ts: "2026-10-25T10:00:00.000Z", event: "cloud.connected" },
      { ts: "2026-10-25T10:00:00.000Z", event: "cloud.disconnected", closeCode: 1006 },
    ]);
    expect(statSync(join(d, "audit.jsonl")).mode & 0o777).toBe(0o600);
  });
  test("refuses anything that could carry content: unknown actions, codes, events and extra fields", () => {
    const d = dir();
    const a = new AuditLog({ path: join(d, "audit.jsonl") });
    a.request({ action: "Hello <script>secret</script>", ok: true, ms: 1 } as any);
    a.request({ action: "send_message", ok: false, code: "my secret message" as any, ms: 1 });
    a.request({ action: "send_message", ok: true, ms: 1, text: "secret text" } as any);
    a.lifecycle("secret event text" as any);
    a.lifecycle("cloud.disconnected", { closeCode: "secret" as any });
    a.request({ action: "send_message", ok: true, ms: Number.NaN });
    const raw = existsSync(join(d, "audit.jsonl")) ? readFileSync(join(d, "audit.jsonl"), "utf8") : "";
    expect(raw).not.toContain("secret");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const l of lines) for (const k of Object.keys(l)) expect(["ts", "event", "action", "ok", "code", "ms", "closeCode", "caller", "callerName"]).toContain(k);
  });
  test("records who asked (human or agent, and the Raft display name) when the cloud says so", () => {
    const d = dir();
    const a = new AuditLog({ path: join(d, "audit.jsonl"), now: () => Date.parse("2026-10-25T10:00:00Z") });
    a.request({ action: "read_chat", ok: true, ms: 5, caller: { type: "agent", name: "龙虾" } });
    a.request({ action: "send_message", ok: true, ms: 5, caller: { type: "human" } });
    expect(a.tail(5)).toEqual([
      { ts: "2026-10-25T10:00:00.000Z", event: "request", action: "read_chat", ok: true, ms: 5, caller: "agent", callerName: "龙虾" },
      { ts: "2026-10-25T10:00:00.000Z", event: "request", action: "send_message", ok: true, ms: 5, caller: "human" },
    ]);
  });
  test("a hostile caller name is cleaned and capped; a bad caller type is dropped", () => {
    const d = dir();
    const a = new AuditLog({ path: join(d, "audit.jsonl"), now: () => Date.parse("2026-10-25T10:00:00Z") });
    a.request({ action: "status", ok: true, ms: 1, caller: { type: "agent", name: "evil\nname\u0000\u202e" + "x".repeat(500) } });
    a.request({ action: "status", ok: true, ms: 1, caller: { type: "system" as any, name: "secret" } });
    const t = a.tail(5);
    expect(t[0]!.callerName!.length).toBeLessThanOrEqual(64);
    expect(t[0]!.callerName).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(t[1]).toEqual({ ts: "2026-10-25T10:00:00.000Z", event: "request", action: "status", ok: true, ms: 1 });
    expect(readFileSync(join(d, "audit.jsonl"), "utf8")).not.toContain("secret");
  });
  test("rotates by size and keeps a bounded number of files", () => {
    const d = dir();
    const path = join(d, "audit.jsonl");
    const a = new AuditLog({ path, maxBytes: 1000, keep: 2 });
    for (let i = 0; i < 200; i++) a.request({ action: "list_chats", ok: true, ms: i });
    expect(statSync(path).size).toBeLessThanOrEqual(1000);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
  });
  test("tail returns the newest entries across rotated files, oldest first", () => {
    const d = dir();
    const path = join(d, "audit.jsonl");
    const a = new AuditLog({ path, maxBytes: 600, keep: 3 });
    for (let i = 0; i < 30; i++) a.request({ action: "list_chats", ok: true, ms: i });
    const t = a.tail(10);
    expect(t.map((e) => e.ms)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });
  test("tail skips corrupt lines and lines with unexpected fields", () => {
    const d = dir();
    const path = join(d, "audit.jsonl");
    writeFileSync(path, ['{"ts":"2026-10-25T10:00:00.000Z","event":"request","action":"status","ok":true,"ms":1}', "garbage", '{"ts":"x","event":"request","text":"evil"}', ""].join("\n"));
    expect(new AuditLog({ path }).tail(10)).toEqual([{ ts: "2026-10-25T10:00:00.000Z", event: "request", action: "status", ok: true, ms: 1 }]);
  });
  test("an unwritable path never throws into the caller", () => {
    const a = new AuditLog({ path: "/dev/null/nope/audit.jsonl" });
    expect(() => a.request({ action: "status", ok: true, ms: 1 })).not.toThrow();
  });
});

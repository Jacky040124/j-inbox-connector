// spec-r1-F10: subscribe to app state too, and relay it as a status event; relay chat/message
// events as metadata-only event frames.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { parseConnectorFrame } from "@j-inbox/protocol";
import { BEEPER_SUBSCRIBE, mapBeeperEvent } from "../src/beeper-ws.ts";

let fb: FakeBeeper;
beforeAll(async () => {
  fb = await startFakeBeeper();
});
afterAll(() => fb.stop());
afterEach(() => fb.reset());

function open() {
  const ws = new WebSocket(fb.wsURL, { headers: { authorization: `Bearer ${fb.token}` } } as any);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  const next = async (pred: (m: any) => boolean, ms = 2000) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error("timeout");
      await Bun.sleep(10);
    }
  };
  return { ws, next };
}
const NOW = "2026-10-25T12:00:00.000Z";

describe("Beeper /v1/ws subscription", () => {
  test("subscribes to every chat and to app state", () => {
    expect(BEEPER_SUBSCRIBE).toEqual({ type: "subscriptions.set", chatIDs: ["*"], app: { state: true } });
  });
  test("app state reaches the cloud as a status event with appState", async () => {
    const c = open();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify(BEEPER_SUBSCRIBE));
    const first = mapBeeperEvent(await c.next((m) => m.type === "app.state.updated"), { beeperVersion: "4.2.1", now: NOW });
    expect(first).toEqual([{ type: "event", kind: "status", ts: NOW, beeper: { reachable: true, version: "4.2.1", appState: "ready" } }]);
    fb.setAppState("needs-login");
    const second = mapBeeperEvent(await c.next((m) => m.type === "app.state.updated"), { beeperVersion: null, now: NOW });
    expect(second[0]).toMatchObject({ kind: "status", beeper: { appState: "needs-login" } });
    for (const f of [...first, ...second]) expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    c.ws.close();
  });
  test("message and chat events become metadata-only frames (no text)", async () => {
    const c = open();
    await c.next((m) => m.type === "ready");
    c.ws.send(JSON.stringify(BEEPER_SUBSCRIBE));
    await c.next((m) => m.type === "subscriptions.updated");
    fb.state.receive(CHAT_IDS.imessageAlice, { text: "secret body text" });
    const frames = [
      ...mapBeeperEvent(await c.next((m) => m.type === "message.upserted"), { beeperVersion: null, now: NOW }),
      ...mapBeeperEvent(await c.next((m) => m.type === "chat.upserted"), { beeperVersion: null, now: NOW }),
    ];
    expect(frames.map((f) => f.kind)).toEqual(["message", "chat"]);
    expect((frames[1] as any).unreadCount).toBe(3);
    for (const f of frames) {
      expect(JSON.stringify(f)).not.toContain("secret body text");
      expect(parseConnectorFrame(JSON.stringify(f)).ok).toBe(true);
    }
    c.ws.close();
  });
  // tests-r2-TQ2-06: exact expectations, so a mapper that invents frames cannot pass.
  test("hostile or unknown messages map to exactly nothing", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      "x",
      42,
      [],
      {},
      { type: "error", code: "X" },
      { type: "ready" },
      { type: "subscriptions.updated", chatIDs: ["*"] },
      { type: "message.upserted", chatID: "a b", ids: ["1"] },
      { type: "message.upserted", chatID: "", ids: ["1"] },
      { type: "message.upserted", chatID: 7, ids: ["1"] },
      { type: "message.upserted", ids: ["1"] },
      { type: "chat.upserted", chatID: "x".repeat(10_000) },
      { type: "chat.deleted", chatID: "c\u202e" },
      { type: "message.edited", chatID: "c", ids: ["1"] },
      { type: "__proto__", chatID: "c" },
      { type: "message.upserted", chatID: "c", ids: [] },
      { type: "message.upserted", chatID: "c", ids: ["has space", "", 5, null] },
      { type: "message.upserted", chatID: "c" },
    ];
    for (const m of hostile) expect(mapBeeperEvent(m as any, { beeperVersion: null, now: NOW })).toEqual([]);
  });
  test("valid edge cases map to the exact frame", () => {
    const ctx = { beeperVersion: null, now: NOW };
    expect(mapBeeperEvent({ type: "chat.upserted", chatID: "c", ids: [] }, ctx)).toEqual([{ type: "event", kind: "chat", op: "upserted", chatID: "c", ts: NOW }]);
    expect(mapBeeperEvent({ type: "chat.upserted", chatID: "c", entries: [] }, ctx)).toEqual([{ type: "event", kind: "chat", op: "upserted", chatID: "c", ts: NOW }]);
    expect(mapBeeperEvent({ type: "chat.upserted", chatID: "c", entries: [{ unreadCount: -1 }] }, ctx)).toEqual([{ type: "event", kind: "chat", op: "upserted", chatID: "c", ts: NOW }]);
    expect(mapBeeperEvent({ type: "chat.upserted", chatID: "c", entries: [{ unreadCount: 2, title: "secret" }] }, ctx)).toEqual([{ type: "event", kind: "chat", op: "upserted", chatID: "c", ts: NOW, unreadCount: 2 }]);
    expect(mapBeeperEvent({ type: "chat.deleted", chatID: "imsg##thread:+1/a?b" }, ctx)).toEqual([{ type: "event", kind: "chat", op: "deleted", chatID: "imsg##thread:+1/a?b", ts: NOW }]);
    expect(mapBeeperEvent({ type: "message.deleted", chatID: "c", ids: ["m1", "bad id", "m2"], entries: [{ text: "secret" }] }, ctx)).toEqual([{ type: "event", kind: "message", op: "deleted", chatID: "c", messageIDs: ["m1", "m2"], ts: NOW }]);
  });
  test("unknown app states become appState unknown; huge id lists are split into valid frames", () => {
    expect(mapBeeperEvent({ type: "app.state.updated", appState: { state: "brand-new" } }, { beeperVersion: null, now: NOW })[0]).toMatchObject({ beeper: { appState: "unknown" } });
    const many = mapBeeperEvent({ type: "message.deleted", chatID: "c", ids: Array.from({ length: 250 }, (_, i) => `m${i}`) }, { beeperVersion: null, now: NOW });
    expect(many.length).toBe(3);
    expect(many.flatMap((f: any) => f.messageIDs).length).toBe(250);
  });
});

// Staying inside Gmail's per-user quota: pacing, retrying reads Gmail asked to slow down, and not
// fetching unchanged threads again.
import { describe, expect, test } from "bun:test";
import { createGmailClient } from "../src/gmail/client.ts";
import { createGmailSource, listFilterFor } from "../src/gmail/source.ts";

const okToken = async () => ({ ok: true as const, accessToken: "at_123456789", expiresIn: 3600 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Gmail quota", () => {
  test("requests start at most N per second (real clock)", async () => {
    const startedAt: number[] = [];
    const client = createGmailClient({
      email: "a@gmail.com",
      refreshToken: async () => "rt_123456789",
      refresh: okToken,
      maxRequestsPerSecond: 3,
      fetchImpl: (async () => (startedAt.push(Date.now()), json(200, {}))) as unknown as typeof fetch,
    });
    await Promise.all(Array.from({ length: 7 }, () => client.get(client.path(["profile"]))));
    expect(startedAt.length).toBe(7);
    startedAt.sort((a, b) => a - b);
    // Any 4 consecutive starts span at least a second (allow a few ms of timer slack).
    for (let i = 3; i < startedAt.length; i++) expect(startedAt[i]! - startedAt[i - 3]!).toBeGreaterThanOrEqual(990);
  }, 10_000);

  test("a read Gmail answered 429 is tried again after a wait; a write is not", async () => {
    let calls = 0;
    const waits: number[] = [];
    const mk = (fail: number) =>
      createGmailClient({
        email: "a@gmail.com",
        refreshToken: async () => "rt_123456789",
        refresh: okToken,
        retryDelaysMs: [5, 7],
        sleep: async (ms) => void waits.push(ms),
        fetchImpl: (async () => (++calls <= fail ? json(429, { error: { errors: [{ reason: "rateLimitExceeded" }] } }) : json(200, { ok: 1 }))) as unknown as typeof fetch,
      });
    calls = 0;
    const r = await mk(2).get("/gmail/v1/users/me/profile");
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 7]);
    calls = 0;
    const gaveUp = await mk(9).get("/gmail/v1/users/me/profile");
    expect(gaveUp.ok ? "ok" : gaveUp.error.code).toBe("RATE_LIMITED");
    expect(calls).toBe(3);
    calls = 0;
    const w = await mk(1).write("/gmail/v1/users/me/messages/send", { raw: "x" });
    expect(w.ok ? "ok" : w.error.code).toBe("RATE_LIMITED");
    expect(calls).toBe(1);
  });

  test("listing again does not fetch threads whose historyId did not change", async () => {
    const gets: string[] = [];
    let hist = "100";
    const thread = (id: string) => ({ id, historyId: id === "t1" ? hist : "50", messages: [{ id: id + "m", threadId: id, labelIds: ["INBOX"], internalDate: "1700000000000", payload: { headers: [{ name: "Subject", value: "Hi " + id }, { name: "From", value: "B <b@x.com>" }] } }] });
    const client = createGmailClient({
      email: "a@gmail.com",
      refreshToken: async () => "rt_123456789",
      refresh: okToken,
      fetchImpl: (async (u: URL) => {
        const url = new URL(String(u));
        if (url.pathname.endsWith("/threads")) return json(200, { threads: [{ id: "t1", historyId: hist }, { id: "t2", historyId: "50" }] });
        const id = url.pathname.split("/").pop()!;
        gets.push(id);
        return json(200, thread(id));
      }) as unknown as typeof fetch,
    });
    const src = createGmailSource({ email: "a@gmail.com", client });
    const f = listFilterFor({});
    expect((await src.listThreads(f, null, 10, {})).items.length).toBe(2);
    expect(gets.sort()).toEqual(["t1", "t2"]);
    gets.length = 0;
    await src.listThreads(f, null, 10, {});
    expect(gets).toEqual([]);
    hist = "101";
    await src.listThreads(f, null, 10, {});
    expect(gets).toEqual(["t1"]);
  });
});

// Staying inside Gmail's per-user quota: pacing, retrying reads Gmail asked to slow down, and not
// fetching unchanged threads again.
import { describe, expect, test } from "bun:test";
import { createGmailClient } from "../src/gmail/client.ts";
import { createGmailSource, listFilterFor } from "../src/gmail/source.ts";

const okToken = async () => ({ ok: true as const, accessToken: "at_123456789", expiresIn: 3600 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Gmail batch answer: each inner GET (request line) handed to `one`, its answers as application/http parts. */
async function batchAnswer(req: Request, one: (url: URL) => Response | Promise<Response>): Promise<Response> {
  const boundary = /boundary=([^;\s]+)/.exec(req.headers.get("content-type") ?? "")![1]!;
  const text = await req.text();
  const out: string[] = [];
  for (const part of text.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const id = /Content-ID: <([^>]+)>/i.exec(part)![1]!;
    const path = /\r\n\r\nGET (\S+) HTTP\/1\.1/.exec(part)![1]!;
    const r = await one(new URL(path, "https://gmail.test"));
    out.push(`--zz\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${r.status} X\r\nContent-Type: application/json\r\n\r\n${await r.text()}\r\n`);
  }
  return new Response(out.join("") + "--zz--\r\n", { headers: { "content-type": "multipart/mixed; boundary=zz" } });
}

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
      fetchImpl: (async (u: URL, init?: RequestInit) => {
        const one = (url: URL) => {
          if (url.pathname.endsWith("/threads")) return json(200, { threads: [{ id: "t1", historyId: hist }, { id: "t2", historyId: "50" }] });
          const id = url.pathname.split("/").pop()!;
          gets.push(id);
          return json(200, thread(id));
        };
        const url = new URL(String(u));
        return url.pathname === "/batch/gmail/v1" ? batchAnswer(new Request(url, init), one) : one(url);
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

  test("a batch counts as all its calls in the per-second window, and is not starved by a stream of small calls", async () => {
    const startedAt: { at: number; n: number }[] = [];
    const client = createGmailClient({
      email: "a@gmail.com",
      refreshToken: async () => "rt_123456789",
      refresh: okToken,
      maxRequestsPerSecond: 4,
      fetchImpl: (async (u: URL, init?: RequestInit) => {
        const url = new URL(String(u));
        if (url.pathname !== "/batch/gmail/v1") return startedAt.push({ at: Date.now(), n: 1 }), json(200, {});
        const req = new Request(url, init);
        const n = ((await req.clone().text()).match(/Content-ID/g) ?? []).length;
        startedAt.push({ at: Date.now(), n });
        return batchAnswer(req, () => json(200, { ok: 1 }));
      }) as unknown as typeof fetch,
    });
    const small = Array.from({ length: 3 }, () => client.get(client.path(["profile"])));
    const batch = client.batchGet(Array.from({ length: 6 }, (_, i) => client.path(["threads", `t${i}`])));
    const after = client.get(client.path(["profile"]));
    const [r] = await Promise.all([batch, ...small, after]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(startedAt.map((s) => s.n)).toEqual([1, 1, 1, 6, 1]);
    // The batch (worth the whole window of 4) waited for the 3 small calls to leave it; the call after it waited for the batch.
    expect(startedAt[3]!.at - startedAt[0]!.at).toBeGreaterThanOrEqual(990);
    expect(startedAt[4]!.at - startedAt[3]!.at).toBeGreaterThanOrEqual(990);
  }, 10_000);
});

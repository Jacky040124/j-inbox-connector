// Gmail metadata in batch requests (one POST /batch/gmail/v1 for up to GMAIL_BATCH_SIZE threads
// instead of one GET each) and the thread metadata cache kept on disk, sealed, so a restart is warm.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FAKE_GOOGLE_CLIENT, FakeGoogle, OWNER_EMAIL, THREADS } from "@j-inbox/fake-google";
import { GMAIL_BATCH_SIZE, buildBatch, parseBatchResponse } from "../src/gmail/batch.ts";
import { createGmailClient } from "../src/gmail/client.ts";
import { ThreadMetaCache, keptThread } from "../src/gmail/meta-cache.ts";
import { createGmailSource, listFilterFor } from "../src/gmail/source.ts";
import { mapGmailThread } from "../src/gmail/map.ts";
import { requestContext } from "../src/actions.ts";

const ORIGIN = "https://google.fake";
let g: FakeGoogle;
beforeEach(() => {
  g = new FakeGoogle();
});

function source(o: { cache?: ThreadMetaCache; email?: string } = {}) {
  const email = o.email ?? OWNER_EMAIL;
  const rt = g.issueRefreshToken(email);
  const client = createGmailClient({
    email,
    refreshToken: async () => rt,
    refresh: async (t) => {
      const r = await g.fetch(new Request(ORIGIN + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret }) }));
      const j = (await r.json()) as any;
      return r.ok ? { ok: true as const, accessToken: j.access_token, expiresIn: j.expires_in } : { ok: false as const, error: { code: "REAUTH_REQUIRED" as const, message: "x" } };
    },
    baseURL: ORIGIN,
    maxRequestsPerSecond: 1000,
    retryDelaysMs: [5, 5],
    fetchImpl: ((u: URL | string, init?: RequestInit) => g.fetch(new Request(String(u), init))) as unknown as typeof fetch,
  });
  return createGmailSource({ email, client, ...(o.cache ? { metaCache: o.cache } : {}) });
}
const http = () => g.requests.filter((r) => !r.inBatch && r.path.startsWith("/gmail") || r.path === "/batch/gmail/v1");
const threadGets = () => g.requests.filter((r) => /\/threads\/[A-Za-z0-9]+$/.test(r.path));

describe("batch codec", () => {
  test("builds application/http parts and refuses paths that could break out of them", () => {
    const body = buildBatch(["/gmail/v1/users/me/threads/a?format=metadata", "/gmail/v1/users/me/profile"], "jinbox_boundary1");
    expect(body).toBe(
      "--jinbox_boundary1\r\nContent-Type: application/http\r\nContent-ID: <c0>\r\n\r\nGET /gmail/v1/users/me/threads/a?format=metadata HTTP/1.1\r\nAccept: application/json\r\n\r\n" +
        "--jinbox_boundary1\r\nContent-Type: application/http\r\nContent-ID: <c1>\r\n\r\nGET /gmail/v1/users/me/profile HTTP/1.1\r\nAccept: application/json\r\n\r\n--jinbox_boundary1--\r\n",
    );
    for (const bad of ["/gmail/v1/x\r\nAuthorization: y", "/gmail/v1/x y", "https://evil/gmail/v1/x", "/upload/gmail/v1/x"]) expect(() => buildBatch([bad], "jinbox_boundary1")).toThrow();
    expect(() => buildBatch(["/gmail/v1/x"], "bad boundary")).toThrow();
  });
  const part = (id: string | null, status: number, body: string) => `--b\r\nContent-Type: application/http\r\n${id ? `Content-ID: <${id}>\r\n` : ""}\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${body}\r\n`;
  test("parts are matched by Content-ID, whatever their order; missing or unreadable ones are null", () => {
    const text = part("response-c2", 200, '{"n":2}') + part("response-c0", 404, '{"error":{}}') + part("response-c1", 200, "{not json") + "--b--\r\n";
    expect(parseBatchResponse("multipart/mixed; boundary=b", text, 4)).toEqual([{ status: 404, body: { error: {} } }, null, { status: 200, body: { n: 2 } }, null]);
  });
  test("without Content-IDs: by order; hostile ids (out of range, repeated, foreign) are dropped", () => {
    expect(parseBatchResponse('multipart/mixed; boundary="b"', part(null, 200, "{}") + part(null, 201, "[1]") + "--b--", 2)).toEqual([{ status: 200, body: {} }, { status: 201, body: [1] }]);
    const t = part("response-c9", 200, "{}") + part("response-c0", 200, '{"a":1}') + part("response-c0", 200, '{"a":2}') + part("item-1", 200, "{}") + "--b--";
    expect(parseBatchResponse("multipart/mixed; boundary=b", t, 2)).toEqual([{ status: 200, body: { a: 1 } }, null]);
  });
  test("not a batch answer at all: null", () => {
    expect(parseBatchResponse("application/json", "{}", 1)).toBeNull();
    expect(parseBatchResponse(null, "", 1)).toBeNull();
    expect(parseBatchResponse("multipart/mixed; boundary=zz", "no boundary here", 1)).toBeNull();
  });
});

describe("thread metadata in batches (fake Gmail)", () => {
  test("a list of 25 threads: one threads.list and two batches instead of 25 GETs; listing again: none", async () => {
    const s = source();
    const f = listFilterFor({});
    const page = await s.listThreads(f, null, 25, {});
    expect(page.items.length).toBe(25);
    expect(http().map((r) => r.path)).toEqual(["/gmail/v1/users/me/threads", "/batch/gmail/v1", "/batch/gmail/v1"]);
    // 20, then 25 - 20 + 2 (the list reads two ahead, in case some are dropped)
    expect(threadGets().length).toBe(27);
    expect(threadGets().every((r) => r.inBatch)).toBe(true);
    g.requests = [];
    const again = await s.listThreads(f, null, 25, {});
    expect(again.items.map((i) => i.key)).toEqual(page.items.map((i) => i.key));
    expect(threadGets()).toEqual([]);
  });
  test("a batch of at most GMAIL_BATCH_SIZE calls; the same chats as one GET per thread", async () => {
    const s = source();
    const page = await s.listThreads(listFilterFor({}), null, 45, {});
    const batches = g.requests.filter((r) => r.path === "/batch/gmail/v1").length;
    expect(threadGets().length).toBeLessThanOrEqual(batches * GMAIL_BATCH_SIZE);
    // Every chat equals what one plain threads.get per thread maps to.
    const plain = source();
    for (const it of page.items) {
      const id = it.key.slice(it.key.lastIndexOf(":") + 1);
      const raw = await plain.client.get(plain.client.path(["threads", id], { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Message-ID"] }));
      expect(raw.ok).toBe(true);
      expect(it.value).toEqual(mapGmailThread(raw.ok ? raw.body : null, OWNER_EMAIL)!);
    }
  });
  test("one thread Gmail asked to slow down is fetched again on its own; a deleted one is left out", async () => {
    const s = source();
    g.failNext({ path: `/gmail/v1/users/me/threads/${THREADS.lunch}`, status: 429, body: { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } } });
    const page = await s.listThreads(listFilterFor({}), null, 10, {});
    expect(page.items.some((i) => i.key.endsWith(THREADS.lunch))).toBe(true);
    expect(g.requests.filter((r) => r.path.endsWith(THREADS.lunch)).map((r) => [r.status, r.inBatch ?? false])).toEqual([
      [429, true],
      [200, false],
    ]);
    g.requests = [];
    g.failNext({ path: `/gmail/v1/users/me/threads/${THREADS.kickoff}`, status: 404 });
    const s2 = source();
    const p2 = await s2.listThreads(listFilterFor({}), null, 10, {});
    expect(p2.items.some((i) => i.key.endsWith(THREADS.kickoff))).toBe(false);
    expect(p2.items.length).toBe(10);
  });
  test("a whole batch refused fails the list like one GET would; an expired token is refreshed once", async () => {
    const s = source();
    g.failNext({ path: "/batch/gmail/v1", status: 500 });
    await expect(s.listThreads(listFilterFor({}), null, 5, {})).rejects.toMatchObject({ body: { code: "UPSTREAM_DOWN" } });
    await s.listThreads(listFilterFor({}), null, 1, {});
    g.expireAccessTokens();
    const s3 = source();
    expect((await s3.listThreads(listFilterFor({ inbox: "archive" }), null, 3, {})).items.length).toBeGreaterThan(0);
  });
  test("search: message and thread metadata batched too", async () => {
    const s = source();
    const chats = new Map();
    const page = await s.search("in:anywhere", () => true, null, 12, {}, chats);
    expect(page.items.length).toBe(12);
    expect(g.requests.filter((r) => /\/messages\/[A-Za-z0-9]+$/.test(r.path)).every((r) => r.inBatch)).toBe(true);
    expect(threadGets().every((r) => r.inBatch)).toBe(true);
    expect(g.requests.filter((r) => r.path === "/batch/gmail/v1").length).toBeLessThanOrEqual(2);
  });
  test("cancel: no batch goes out after it", async () => {
    const s = source();
    g.latencyMs = 60;
    const cancel = new AbortController();
    const done = s.listThreads(listFilterFor({}), null, 45, requestContext({ timeoutMs: 10_000, cancel: cancel.signal }));
    await Bun.sleep(90);
    cancel.abort();
    await done.catch(() => {});
    const n = g.requests.length;
    await Bun.sleep(200);
    expect(g.requests.length).toBe(n);
    expect(g.requests.filter((r) => r.path === "/batch/gmail/v1").length).toBeLessThanOrEqual(1);
  });
});

describe("thread metadata cache on disk", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "jinbox-gcache-"));
  test("a restart is warm: the next process lists without a single thread fetch", async () => {
    const path = join(dir(), "gmail-cache.json");
    const key = randomBytes(32);
    const c1 = new ThreadMetaCache({ path, key, writeDelayMs: 10_000 });
    const first = await source({ cache: c1 }).listThreads(listFilterFor({ inbox: "primary" }), null, 20, {});
    c1.flush();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    g.requests = [];
    const c2 = new ThreadMetaCache({ path, key });
    expect(c2.size).toBe(c1.size);
    const second = await source({ cache: c2 }).listThreads(listFilterFor({ inbox: "primary" }), null, 20, {});
    expect(threadGets()).toEqual([]);
    expect(second.items.map((i) => i.value)).toEqual(first.items.map((i) => i.value));
  });
  test("sealed: no subject, address or snippet in the clear; another key or a damaged file starts empty", async () => {
    const path = join(dir(), "gmail-cache.json");
    const key = randomBytes(32);
    const c = new ThreadMetaCache({ path, key });
    await source({ cache: c }).listThreads(listFilterFor({}), null, 30, {});
    c.flush();
    const text = readFileSync(path, "utf8");
    for (const s of ["Lunch", "lunch", "alice", "example.com", "Friday", OWNER_EMAIL]) expect(text.includes(s)).toBe(false);
    expect(new ThreadMetaCache({ path, key: randomBytes(32) }).size).toBe(0);
    const box = JSON.parse(text);
    box.data = box.data.slice(0, -8) + "AAAAAAAA";
    writeFileSync(path, JSON.stringify(box));
    expect(new ThreadMetaCache({ path, key }).size).toBe(0);
    writeFileSync(path, "garbage");
    expect(new ThreadMetaCache({ path, key }).size).toBe(0);
    // No key: memory only, nothing written.
    const p2 = join(dir(), "none.json");
    const mem = new ThreadMetaCache({ path: p2 });
    mem.set(OWNER_EMAIL, "abc", "5", { id: "abc", messages: [] });
    mem.flush();
    expect(() => statSync(p2)).toThrow();
  });
  test("only list metadata is kept: no body parts, no other headers, no draft snippet", () => {
    const t = keptThread({
      id: "t1",
      historyId: "9",
      messages: [
        { id: "m1", threadId: "t1", labelIds: ["INBOX", "bad label!"], internalDate: "1700000000000", snippet: "hello", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "S" }, { name: "X-Secret", value: "no" }, { name: "From", value: "A <a@x.com>" }], body: { data: "Ym9keQ" }, parts: [{ body: { data: "eA" } }] } },
        { id: "m2", threadId: "t1", labelIds: ["DRAFT"], internalDate: "1700000000001", snippet: "unsent words", payload: { headers: [{ name: "To", value: "b@x.com" }] } },
      ],
    })!;
    expect(t).toEqual({
      id: "t1",
      messages: [
        { id: "m1", threadId: "t1", labelIds: ["INBOX"], internalDate: "1700000000000", snippet: "hello", payload: { headers: [{ name: "Subject", value: "S" }, { name: "From", value: "A <a@x.com>" }] } },
        { id: "m2", threadId: "t1", labelIds: ["DRAFT"], internalDate: "1700000000001", payload: { headers: [{ name: "To", value: "b@x.com" }] } },
      ],
    });
    // The mapping does not change: drafts count only as hasDraft.
    expect(mapGmailThread(t, "me@x.com")!.hasDraft).toBe(true);
    for (const bad of [null, [], { id: "a b" }, { id: "x", messages: "no" }, { id: "x", messages: [{ id: "bad id" }] }, { id: "x", messages: Array.from({ length: 301 }, (_, i) => ({ id: `m${i}` })) }]) expect(keptThread(bad)).toBeNull();
  });
  test("bounded by entries and bytes, least recently used out; a changed historyId misses; forget(email)", () => {
    const c = new ThreadMetaCache({ maxEntries: 3, maxBytes: 100_000 });
    const t = (id: string, pad = 0) => ({ id, messages: [{ id: id + "m", labelIds: [], snippet: "x".repeat(pad), payload: { headers: [] } }] });
    for (const id of ["a1", "a2", "a3"]) c.set("a@x", id, "1", t(id));
    expect(c.get("a@x", "a1", "1")).not.toBeNull(); // a1 is now the most recent
    c.set("a@x", "a4", "1", t("a4"));
    expect(c.get("a@x", "a2", "1")).toBeNull();
    expect(c.get("a@x", "a1", "1")).not.toBeNull();
    expect(c.get("a@x", "a1", "2")).toBeNull();
    expect(c.get("a@x", "a1", undefined)).toBeNull();
    c.set("b@x", "b1", "1", t("b1"));
    c.forget("a@x");
    expect(c.size).toBe(1);
    const small = new ThreadMetaCache({ maxBytes: 2000 });
    for (let i = 0; i < 10; i++) small.set("a@x", `t${i}`, "1", t(`t${i}`, 400));
    expect(small.size).toBeLessThanOrEqual(4);
    expect(small.get("a@x", "t9", "1")).not.toBeNull();
    // Hostile input never enters.
    for (const [id, h] of [["a b", "1"], ["ok", "x1"], ["ok", ""]] as const) expect(c.set("a@x", id, h, t(id))).toBeNull();
  });
});

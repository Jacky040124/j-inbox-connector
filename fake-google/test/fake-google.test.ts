import { beforeEach, describe, expect, test } from "bun:test";
import { FAKE_GOOGLE_CLIENT, FakeGoogle, GMAIL_MODIFY, OWNER_EMAIL, PDF_BYTES, THREADS, b64urlDecode, b64urlEncode, compileQuery, decodeHeader, parseRaw, startFakeGoogle } from "../src/index.ts";

const REDIRECT = "http://127.0.0.1:8787/auth/google/callback";
const ORIGIN = "https://google.fake";
let g: FakeGoogle;

const call = (path: string, init: RequestInit = {}) => g.fetch(new Request(ORIGIN + path, init));
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

async function s256(v: string) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
}

async function authorize(extra: Record<string, string> = {}) {
  const verifier = "v".repeat(43);
  const q = new URLSearchParams({
    client_id: FAKE_GOOGLE_CLIENT.id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: `openid email ${GMAIL_MODIFY}`,
    state: "st4te",
    access_type: "offline",
    prompt: "consent",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    ...extra,
  });
  const res = await call(`/o/oauth2/v2/auth?${q}`);
  return { res, verifier, back: res.headers.get("location") ? new URL(res.headers.get("location")!) : null };
}

async function exchange(code: string, verifier: string, extra: Record<string, string> = {}) {
  return call("/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret, ...extra }));
}

async function accessToken(email = OWNER_EMAIL) {
  const rt = g.issueRefreshToken(email);
  const r = (await (await call("/token", form({ grant_type: "refresh_token", refresh_token: rt, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret }))).json()) as any;
  return r.access_token as string;
}

async function gmail(path: string, token: string, init: RequestInit = {}) {
  const res = await call(`/gmail/v1/users/me/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => {
  g = new FakeGoogle({ redirectUris: [REDIRECT] });
});

describe("OAuth", () => {
  test("authorize -> code -> tokens (refresh + id_token) -> refresh -> revoke", async () => {
    const { res, back, verifier } = await authorize();
    expect(res.status).toBe(302);
    expect(back!.origin + back!.pathname).toBe(REDIRECT);
    expect(back!.searchParams.get("state")).toBe("st4te");
    const tok = await exchange(back!.searchParams.get("code")!, verifier);
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as any;
    expect(t.refresh_token).toMatch(/^1\/\//);
    expect(t.scope.split(" ")).toContain(GMAIL_MODIFY);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(t.id_token.split(".")[1])!));
    expect(claims).toMatchObject({ iss: "https://accounts.google.com", aud: FAKE_GOOGLE_CLIENT.id, email: OWNER_EMAIL, email_verified: true });
    const ref = await call("/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret }));
    expect(ref.status).toBe(200);
    expect(((await ref.json()) as any).access_token).toMatch(/^ya29\./);
    expect((await call("/revoke", form({ token: t.refresh_token }))).status).toBe(200);
    const after = await call("/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret }));
    expect(after.status).toBe(400);
    expect(((await after.json()) as any).error).toBe("invalid_grant");
    // Revoking the grant also kills its access tokens.
    expect((await gmail("profile", t.access_token)).status).toBe(401);
  });
  test("codes are single-use, expire, need the right verifier, redirect and secret", async () => {
    const a = await authorize();
    const code = a.back!.searchParams.get("code")!;
    expect((await exchange(code, "w".repeat(43))).status).toBe(400);
    // A failed exchange still used the code up.
    expect((await exchange(code, a.verifier)).status).toBe(400);
    const b = await authorize();
    expect((await exchange(b.back!.searchParams.get("code")!, b.verifier, { client_secret: "wrong" })).status).toBe(401);
    const c = await authorize();
    g.advance(11 * 60_000);
    expect((await exchange(c.back!.searchParams.get("code")!, c.verifier)).status).toBe(400);
  });
  test("redirect mismatch, unknown scope, denied consent, granular consent", async () => {
    expect((await authorize({ redirect_uri: "https://evil.example/cb" })).res.status).toBe(400);
    expect((await authorize({ scope: "openid https://mail.google.com/" })).res.status).toBe(400);
    g.denyNextConsent();
    const d = await authorize();
    expect(d.back!.searchParams.get("error")).toBe("access_denied");
    expect(d.back!.searchParams.get("code")).toBeNull();
    g.grantOnly(["openid", "email"]);
    const p = await authorize();
    const t = (await (await exchange(p.back!.searchParams.get("code")!, p.verifier)).json()) as any;
    expect(t.scope).toBe("openid email");
    expect((await gmail("profile", t.access_token)).status).toBe(403);
  });
  test("access tokens expire", async () => {
    const at = await accessToken();
    expect((await gmail("profile", at)).status).toBe(200);
    g.advance(3600_000);
    expect((await gmail("profile", at)).status).toBe(401);
  });
});

describe("Gmail", () => {
  test("threads.list: newest first, paged, filtered with q and labelIds", async () => {
    const at = await accessToken();
    const p1 = await gmail("threads?maxResults=10", at);
    expect(p1.body.threads).toHaveLength(10);
    expect(p1.body.nextPageToken).toBeTruthy();
    const p2 = await gmail(`threads?maxResults=10&pageToken=${p1.body.nextPageToken}`, at);
    const ids = [...p1.body.threads, ...p2.body.threads].map((t: any) => t.id);
    expect(new Set(ids).size).toBe(20);
    const unread = await gmail(`threads?q=${encodeURIComponent("is:unread in:inbox -category:promotions")}`, at);
    const got = unread.body.threads.map((t: any) => t.id);
    expect(got).toContain(THREADS.lunch);
    expect(got).not.toContain(THREADS.promo);
    expect(got).not.toContain(THREADS.html);
    const inbox = await gmail("threads?labelIds=INBOX&maxResults=500", at);
    expect(inbox.body.threads.map((t: any) => t.id)).not.toContain(THREADS.archived);
  });
  test("snippets are HTML-escaped like Gmail's", async () => {
    const at = await accessToken();
    const t = await gmail(`threads/${THREADS.hostile}?format=metadata`, at);
    expect(t.body.messages[0].snippet).toContain("&lt;script&gt;");
    expect(t.body.messages[0].payload.body).toBeUndefined();
  });
  test("threads.get full: payload tree, attachments by id", async () => {
    const at = await accessToken();
    const t = await gmail(`threads/${THREADS.attachments}`, at);
    const parts = t.body.messages[0].payload.parts;
    const pdf = parts.find((p: any) => p.filename === "invoice.pdf");
    expect(pdf.body.attachmentId).toBeTruthy();
    const a = await gmail(`messages/${t.body.messages[0].id}/attachments/${pdf.body.attachmentId}`, at);
    expect(b64urlDecode(a.body.data)).toEqual(PDF_BYTES);
    expect(decodeHeader((await gmail(`threads/${THREADS.encoded}?format=metadata&metadataHeaders=Subject`, at)).body.messages[0].payload.headers[0].value)).toBe("Grüße aus Zürich 🇨🇭 und mehr");
  });
  test("messages.send joins the thread only with matching subject and references", async () => {
    const at = await accessToken();
    const t = await gmail(`threads/${THREADS.lunch}?format=metadata`, at);
    const last = t.body.messages.at(-1).payload.headers.find((h: any) => h.name === "Message-ID").value;
    const raw = (subject: string, refs: boolean) =>
      b64urlEncode(new TextEncoder().encode([`From: ${OWNER_EMAIL}`, "To: alice@example.com", `Subject: ${subject}`, ...(refs ? [`In-Reply-To: ${last}`, `References: ${last}`] : []), "Content-Type: text/plain; charset=UTF-8", "", "See you"].join("\r\n")));
    const ok = await gmail("messages/send", at, { method: "POST", body: JSON.stringify({ raw: raw("Re: Lunch on Friday?", true), threadId: THREADS.lunch }) });
    expect(ok.body.threadId).toBe(THREADS.lunch);
    const noRefs = await gmail("messages/send", at, { method: "POST", body: JSON.stringify({ raw: raw("Re: Lunch on Friday?", false), threadId: THREADS.lunch }) });
    expect(noRefs.body.threadId).not.toBe(THREADS.lunch);
    const otherSubject = await gmail("messages/send", at, { method: "POST", body: JSON.stringify({ raw: raw("Something else", true), threadId: THREADS.lunch }) });
    expect(otherSubject.body.threadId).not.toBe(THREADS.lunch);
    expect(g.sent()).toHaveLength(3);
    expect(parseRaw(b64urlDecode(g.sent()[0]!.raw)!)!.text).toBe("See you");
    const none = await gmail("messages/send", at, { method: "POST", body: JSON.stringify({ raw: b64urlEncode(new TextEncoder().encode("Subject: x\r\n\r\nhi")) }) });
    expect(none.status).toBe(400);
  });
  test("a multipart/mixed send keeps its file: the name (RFC 2231) and bytes in sent(), an attachment in the message", async () => {
    const at = await accessToken();
    const b = "=_jinbox_test";
    const pdf64 = btoa(String.fromCharCode(...PDF_BYTES));
    const raw = [
      `From: ${OWNER_EMAIL}`,
      "To: alice@example.com",
      "Subject: The quote",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("Here it is"),
      `--${b}`,
      'Content-Type: application/pdf; name="Quote.pdf"',
      "Content-Disposition: attachment; filename=\"Quote.pdf\"; filename*=UTF-8''%E6%8A%A5%E4%BB%B7%20Quote.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      pdf64,
      `--${b}--`,
      "",
    ].join("\r\n");
    const sent = await gmail("messages/send", at, { method: "POST", body: JSON.stringify({ raw: b64urlEncode(new TextEncoder().encode(raw)) }) });
    expect(sent.status).toBe(200);
    const d = g.sent().at(-1)!;
    expect(d.text).toBe("Here it is");
    expect(d.attachments).toEqual([expect.objectContaining({ fileName: "报价 Quote.pdf", mimeType: "application/pdf", bytes: PDF_BYTES })]);
    const m = await gmail(`messages/${sent.body.id}?format=full`, at);
    const part = m.body.payload.parts.find((p: any) => p.filename === "报价 Quote.pdf");
    expect(b64urlDecode((await gmail(`messages/${sent.body.id}/attachments/${part.body.attachmentId}`, at)).body.data)).toEqual(PDF_BYTES);
  });
  test("modify, drafts and history; a too-old startHistoryId is 404", async () => {
    const at = await accessToken();
    const start = (await gmail("profile", at)).body.historyId;
    expect((await gmail(`threads/${THREADS.lunch}/modify`, at, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) })).status).toBe(200);
    expect((await gmail(`threads/${THREADS.lunch}/modify`, at, { method: "POST", body: JSON.stringify({ addLabelIds: ["NOPE"] }) })).status).toBe(400);
    const d = await gmail("drafts", at, { method: "POST", body: JSON.stringify({ message: { raw: b64urlEncode(new TextEncoder().encode("To: a@example.com\r\nSubject: x\r\n\r\nhi")) } }) });
    expect(d.body.message.labelIds).toEqual(["DRAFT"]);
    g.deliver(OWNER_EMAIL, { threadId: THREADS.kickoff, from: "Bob <bob@example.com>", subject: "Re: Project kickoff", text: "One more thing" });
    const h = await gmail(`history?startHistoryId=${start}`, at);
    const kinds = h.body.history.flatMap((r: any) => Object.keys(r));
    expect(kinds).toContain("labelsRemoved");
    expect(kinds).toContain("messagesAdded");
    expect(h.body.history.flatMap((r: any) => r.messages.map((m: any) => m.threadId))).toContain(THREADS.kickoff);
    expect(Number(h.body.historyId)).toBeGreaterThan(Number(start));
    g.expireHistory();
    expect((await gmail(`history?startHistoryId=${start}`, at)).status).toBe(404);
  });
  test("no token, a foreign mailbox and injected failures", async () => {
    const at = await accessToken();
    expect((await call("/gmail/v1/users/me/profile")).status).toBe(401);
    expect((await gmail("../../x", at)).status).toBe(404);
    expect((await call(`/gmail/v1/users/other%40example.com/profile`, { headers: { authorization: `Bearer ${at}` } })).status).toBe(403);
    g.failNext({ path: "/gmail/v1/users/me/threads", status: 503 });
    expect((await gmail("threads", at)).status).toBe(503);
    expect((await gmail("threads", at)).status).toBe(200);
    g.failNext({ path: "/token", network: true });
    await expect(call("/token", form({}))).rejects.toThrow();
  });
});

describe("query language", () => {
  const view = { labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], from: "Shop <deals@shop.example>", to: "owner@example.com", cc: "", subject: "50% off", text: "Big sale", internalDate: Date.parse("2026-10-20T00:00:00Z"), hasAttachment: false, messageIdHeader: "<a@b>" };
  test("operators, negation and OR groups", () => {
    const m = (q: string) => compileQuery(q, OWNER_EMAIL)(view);
    expect(m("is:unread in:inbox")).toBe(true);
    expect(m("-category:promotions")).toBe(false);
    expect(m("{category:social category:promotions}")).toBe(true);
    expect(m("(category:social OR category:forums)")).toBe(false);
    expect(m('"big sale" from:shop')).toBe(true);
    // from: is by whole words, as Gmail's is.
    expect(m("from:deals@shop.example")).toBe(true);
    expect(m("from:shop.example")).toBe(true);
    expect(m("from:eals@shop.example")).toBe(false);
    expect(m("from:hop.example")).toBe(false);
    expect(m("from:deals@shop.exampl")).toBe(false);
    expect(m("after:2026/10/19 before:2026/10/21")).toBe(true);
    expect(m(`after:${Date.parse("2026-10-21T00:00:00Z") / 1000}`)).toBe(false);
    expect(m("to:me")).toBe(true);
  });
});

describe("threads.list by time and read state, as To do's first run asks", () => {
  const T = Date.parse("2026-11-01T00:00:00.000Z");
  const sec = T / 1000;
  const list = async (at: string, q: string, more = "") => (await gmail(`threads?q=${encodeURIComponent(q)}${more}`, at)).body as { threads?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number };
  const ids = (r: { threads?: { id: string }[] }) => (r.threads ?? []).map((t) => t.id).sort();
  async function mail() {
    const at = await accessToken();
    g.mailbox().messages.clear();
    const send = (subject: string, when: number, labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], threadId?: string) => g.deliver(OWNER_EMAIL, { from: "A <a@example.com>", subject, text: "x", at: when, labels, ...(threadId ? { threadId } : {}) }).threadId;
    return { at, send };
  }

  test("after: and before: take epoch seconds and leave the very second to neither; is:unread and the tab narrow them", async () => {
    const { at, send } = await mail();
    const before = send("before", T - 1000);
    const exact = send("exact", T);
    const after = send("after", T + 1000);
    const read = send("read", T + 1000, ["INBOX", "CATEGORY_PERSONAL"]);
    const promo = send("promo", T + 1000, ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
    const out = send("out", T + 1000, ["UNREAD", "CATEGORY_PERSONAL"]);
    expect(ids(await list(at, `after:${sec}`))).toEqual([after, read, promo, out].sort());
    expect(ids(await list(at, `before:${sec}`))).toEqual([before]);
    expect(ids(await list(at, `after:${sec - 1}`))).toContain(exact);
    expect(ids(await list(at, `before:${sec + 1}`))).toContain(exact);
    expect(ids(await list(at, `is:unread in:inbox category:primary after:${sec}`))).toEqual([after]);
    expect(ids(await list(at, `is:unread in:inbox category:primary before:${sec}`))).toEqual([before]);
  });

  test("the query is per message: a thread with one old unread message and a new read one is old to is:unread", async () => {
    const { at, send } = await mail();
    const t = send("old unread", T - 1000);
    send("new read", T + 1000, ["INBOX", "CATEGORY_PERSONAL"], t);
    expect(ids(await list(at, `is:unread after:${sec}`))).toEqual([]);
    expect(ids(await list(at, `is:unread before:${sec}`))).toEqual([t]);
  });

  test("resultSizeEstimate as measured on real Gmail: 201 on a page with more after it, whatever the true size; on the last page, what it holds", async () => {
    const { at, send } = await mail();
    for (let i = 0; i < 7; i++) send(`m${i}`, T - 1000 - i);
    send("new", T + 1000);
    const q = `is:unread before:${sec}`;
    const first = await list(at, q, "&maxResults=3");
    expect(first.threads).toHaveLength(3);
    expect(first.resultSizeEstimate).toBe(201);
    const second = await list(at, q, `&maxResults=3&pageToken=${first.nextPageToken}`);
    expect(second.threads).toHaveLength(3);
    expect(second.resultSizeEstimate).toBe(201);
    const last = await list(at, q, `&maxResults=3&pageToken=${second.nextPageToken}`);
    expect(last.nextPageToken).toBeUndefined();
    expect(last.threads).toHaveLength(1);
    expect(last.resultSizeEstimate).toBe(1);
    // One page is the whole list; none is none.
    expect((await list(at, q)).resultSizeEstimate).toBe(7);
    expect((await list(at, `is:unread after:${sec + 100}`)).resultSizeEstimate).toBe(0);
  });

  test("the log keeps a list's search, and a rule can fail only a later page", async () => {
    const { at, send } = await mail();
    for (let i = 0; i < 3; i++) send(`m${i}`, T - i);
    g.failNext({ path: /\/threads$/, search: /pageToken=/, status: 400 });
    const first = await list(at, "is:unread", "&maxResults=2");
    expect(g.requests.at(-1)!.q).toBe("is:unread");
    const later = await gmail(`threads?q=is%3Aunread&maxResults=2&pageToken=${first.nextPageToken}`, at);
    expect(later.status).toBe(400);
  });

  test("a mailbox whose clock is given: its fixture stands there", async () => {
    const at = Date.parse("2030-01-01T00:00:00.000Z");
    const box = new FakeGoogle({ fixtureNow: at }).mailbox();
    expect(Math.max(...[...box.messages.values()].map((m) => m.internalDate))).toBeGreaterThan(at - 24 * 3_600_000);
    expect(Math.max(...[...box.messages.values()].map((m) => m.internalDate))).toBeLessThanOrEqual(at);
    expect(new FakeGoogle({ fixtureNow: at }).mailbox().names).toEqual(new FakeGoogle().mailbox().names);
  });
});

describe("batch (POST /batch/gmail/v1)", () => {
  const batchBody = (calls: { id?: string; line: string; headers?: string[] }[], boundary = "b0und") =>
    calls.map((c) => `--${boundary}\r\nContent-Type: application/http\r\n${c.id ? `Content-ID: <${c.id}>\r\n` : ""}\r\n${c.line}\r\n${(c.headers ?? []).map((h) => h + "\r\n").join("")}\r\n`).join("") + `--${boundary}--\r\n`;
  const send = (body: string, token: string | null, ct = "multipart/mixed; boundary=b0und") => call("/batch/gmail/v1", { method: "POST", headers: { "content-type": ct, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
  async function parts(res: Response) {
    const boundary = /boundary=([^;\s]+)/.exec(res.headers.get("content-type") ?? "")![1]!;
    const text = await res.text();
    return text
      .split(`--${boundary}`)
      .slice(1)
      .filter((p) => !p.startsWith("--"))
      .map((p) => {
        const [outer, rest] = p.replace(/^\r\n/, "").split("\r\n\r\n", 2) as [string, string];
        const httpPart = p.slice(p.indexOf("HTTP/1.1"));
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(httpPart)![1]);
        const body = httpPart.slice(httpPart.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
        return { id: /Content-ID: <([^>]+)>/i.exec(outer)?.[1] ?? null, status, body: JSON.parse(body), rest };
      });
  }

  test("each call answered in its own part, in order, with response- Content-IDs; calls are logged inBatch", async () => {
    const t = await accessToken();
    const res = await send(
      batchBody([
        { id: "a1", line: `GET /gmail/v1/users/me/threads/${THREADS.lunch}?format=metadata&metadataHeaders=Subject HTTP/1.1` },
        { id: "a2", line: `GET /gmail/v1/users/me/threads/nosuchthread?format=metadata HTTP/1.1` },
        { id: "a3", line: `GET /gmail/v1/users/me/profile HTTP/1.1` },
      ]),
      t,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary=/);
    const p = await parts(res);
    expect(p.map((x) => [x.id, x.status])).toEqual([
      ["response-a1", 200],
      ["response-a2", 404],
      ["response-a3", 200],
    ]);
    expect(p[0]!.body.id).toBe(THREADS.lunch);
    // metadata: headers only, never a body
    expect(JSON.stringify(p[0]!.body)).not.toContain('"data"');
    expect(p[2]!.body.emailAddress).toBe(OWNER_EMAIL);
    const logged = g.requests.slice(-4);
    expect(logged.map((r) => [r.path, r.status, r.inBatch ?? false])).toEqual([
      [`/gmail/v1/users/me/threads/${THREADS.lunch}`, 200, true],
      ["/gmail/v1/users/me/threads/nosuchthread", 404, true],
      ["/gmail/v1/users/me/profile", 200, true],
      ["/batch/gmail/v1", 200, false],
    ]);
  });

  test("the batch's token applies to calls without one; no token: every call is 401; a call's own header wins", async () => {
    const t = await accessToken();
    const other = await accessToken("other@example.com");
    const none = await parts(await send(batchBody([{ id: "x", line: "GET /gmail/v1/users/me/profile HTTP/1.1" }]), null));
    expect(none.map((x) => x.status)).toEqual([401]);
    const own = await parts(await send(batchBody([{ id: "x", line: "GET /gmail/v1/users/me/profile HTTP/1.1", headers: [`Authorization: Bearer ${other}`] }]), t));
    expect(own[0]!.body.emailAddress).toBe("other@example.com");
  });

  test("fault rules hit calls inside a batch; latency is paid once per batch", async () => {
    const t = await accessToken();
    g.failNext({ path: `/gmail/v1/users/me/threads/${THREADS.kickoff}`, status: 429 });
    g.latencyMs = 40;
    const t0 = Date.now();
    const p = await parts(
      await send(
        batchBody([
          { id: "1", line: `GET /gmail/v1/users/me/threads/${THREADS.lunch}?format=minimal HTTP/1.1` },
          { id: "2", line: `GET /gmail/v1/users/me/threads/${THREADS.kickoff}?format=minimal HTTP/1.1` },
          { id: "3", line: `GET /gmail/v1/users/me/threads/${THREADS.html}?format=minimal HTTP/1.1` },
        ]),
        t,
      ),
    );
    expect(Date.now() - t0).toBeLessThan(110);
    expect(p.map((x) => x.status)).toEqual([200, 429, 200]);
    expect(p[1]!.body.error.code).toBe(429);
  });

  test("refused: not multipart, no calls, more than 100 calls, a nested batch, a bad request line", async () => {
    const t = await accessToken();
    expect((await send("x", t, "application/json")).status).toBe(400);
    expect((await send("--b0und--\r\n", t)).status).toBe(400);
    const many = batchBody(Array.from({ length: 101 }, (_, i) => ({ id: `i${i}`, line: "GET /gmail/v1/users/me/profile HTTP/1.1" })));
    expect((await send(many, t)).status).toBe(400);
    expect((await call("/batch/gmail/v1", { headers: { authorization: `Bearer ${t}` } })).status).toBe(405);
    const p = await parts(await send(batchBody([{ id: "n", line: "POST /batch/gmail/v1 HTTP/1.1" }, { id: "b", line: "garbage" }]), t));
    expect(p.map((x) => x.status)).toEqual([400, 400]);
  });
});

test("startFakeGoogle serves the same handler over HTTP", async () => {
  const s = await startFakeGoogle({ redirectUris: [REDIRECT] });
  try {
    const rt = s.google.issueRefreshToken();
    const r = await fetch(`${s.url}/token`, form({ grant_type: "refresh_token", refresh_token: rt, client_id: FAKE_GOOGLE_CLIENT.id, client_secret: FAKE_GOOGLE_CLIENT.secret }));
    expect(r.status).toBe(200);
  } finally {
    s.stop();
  }
});

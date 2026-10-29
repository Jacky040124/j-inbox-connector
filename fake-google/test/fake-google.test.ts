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
    expect(m("after:2026/10/19 before:2026/10/21")).toBe(true);
    expect(m(`after:${Date.parse("2026-10-21T00:00:00Z") / 1000}`)).toBe(false);
    expect(m("to:me")).toBe(true);
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

// FakeGoogle: a web-standard fetch(Request) handler (no Bun APIs, so it also runs inside workerd)
// for Google's OAuth endpoints and the Gmail REST subset J-Inbox uses. One origin serves:
//
//   GET  /o/oauth2/v2/auth                     authorize (consent is scripted: consentAs / denyNextConsent / grantOnly)
//   POST /token                                authorization_code (PKCE, single-use, 10 min) and refresh_token grants
//   POST /revoke                               revoke a refresh or access token (and its whole grant)
//   GET  /oauth2/v3/userinfo                   sub, email, email_verified
//   /gmail/v1/users/me/...                     profile, threads.list/get/modify, messages.list/get/send/modify,
//                                              messages.attachments.get, drafts.create, history.list
//
// Behaviour follows developers.google.com (OAuth 2.0 for web server apps, Gmail API reference):
// error bodies, invalid_grant on a reused code or revoked refresh token, 404 for a too-old
// startHistoryId, Gmail's threading rule for messages.send (same subject + In-Reply-To/References,
// else a new thread), HTML-escaped snippets, attachments by attachmentId.
import { compileQuery } from "./query.ts";
import { b64urlDecode, b64urlEncode, findAttachment, parseRaw, partJSON, decodeHeader, type Part } from "./mime.ts";
import { Mailbox, SYSTEM_LABELS, header, snippet, viewOf, type AccessToken, type FMessage, type Grant } from "./state.ts";
import { OTHER_EMAIL, OWNER_EMAIL, buildMailbox, buildOtherMailbox, buildPayload } from "./fixtures.ts";

export const FAKE_GOOGLE_CLIENT = {
  id: "450283536596-fakeclientfortests.apps.googleusercontent.com",
  secret: "fake-google-client-secret-for-tests-only",
} as const;
export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const KNOWN_SCOPES = new Set(["openid", "email", "profile", GMAIL_MODIFY, "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"]);
const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 3599;

export type Client = { id: string; secret: string; redirectUris: string[] };
export type FakeGoogleOptions = {
  clients?: Client[];
  /** Redirect URIs for the default client (FAKE_GOOGLE_CLIENT). */
  redirectUris?: string[];
  now?: () => number;
};

export type FailRule = {
  method?: string;
  /** Matches when the path starts with this string (or matches this RegExp). */
  path?: string | RegExp;
  status?: number;
  /** JSON body (default: Google's error shape for the status). */
  body?: unknown;
  /** Throw instead of answering (a network failure for in-process callers). */
  network?: boolean;
  /** Never answer until releaseHangs(). */
  hang?: boolean;
  times?: number;
};

export type RequestLog = { method: string; path: string; status: number; email: string | null; grant?: string };

type Code = { clientId: string; redirectUri: string; email: string; scopes: string[]; challenge: string | null; method: string | null; expiresAt: number; used: boolean; offline: boolean; nonce: string | null };

const enc = new TextEncoder();
const randomToken = (prefix: string) => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return prefix + b64urlEncode(b);
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } });
}

const STATUS_TEXT: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 503: "UNAVAILABLE" };
/** Google API error body ({error: {code, message, errors, status}}). */
export function googleError(status: number, message: string, reason = "failed"): Response {
  return json({ error: { code: status, message, errors: [{ message, domain: "global", reason }], status: STATUS_TEXT[status] ?? "UNKNOWN" } }, status);
}
const oauthError = (status: number, error: string, description: string) => json({ error, error_description: description }, status);

async function s256(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

async function formOrJson(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (/application\/json/i.test(ct)) {
    try {
      const j = JSON.parse(text);
      return new URLSearchParams(Object.entries(j && typeof j === "object" ? j : {}).map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

const strip = (s: string) => {
  let v = decodeHeader(s).trim();
  for (let prev = ""; prev !== v; ) (prev = v), (v = v.replace(/^(re|fwd?|aw|sv)\s*:\s*/i, "").trim());
  return v.toLowerCase();
};

export class FakeGoogle {
  readonly clients: Client[];
  mailboxes = new Map<string, Mailbox>();
  requests: RequestLog[] = [];
  /** Query of the last authorize request. */
  lastAuthorize: URLSearchParams | null = null;
  /** Delay every answer by this many ms. */
  latencyMs = 0;
  private codes = new Map<string, Code>();
  private refresh = new Map<string, Grant>();
  private access = new Map<string, AccessToken>();
  private rules: FailRule[] = [];
  private hangs: (() => void)[] = [];
  private consentEmail = OWNER_EMAIL;
  private denyNext = false;
  private grantedScopes: string[] | null = null;
  private offset = 0;
  private readonly baseNow: () => number;

  constructor(private readonly opts: FakeGoogleOptions = {}) {
    this.clients = opts.clients ?? [{ ...FAKE_GOOGLE_CLIENT, redirectUris: opts.redirectUris ?? ["http://127.0.0.1:8787/auth/google/callback"] }];
    this.baseNow = opts.now ?? Date.now;
    this.reset();
  }

  now(): number {
    return this.baseNow() + this.offset;
  }

  // ---------------------------------------------------------------- controls

  /** Fixture mailboxes (owner@example.com, other@example.com), no tokens, no rules, clock back to real time. */
  reset() {
    this.mailboxes = new Map([
      [OWNER_EMAIL, buildMailbox()],
      [OTHER_EMAIL, buildOtherMailbox()],
    ]);
    this.codes.clear();
    this.refresh.clear();
    this.access.clear();
    this.rules = [];
    this.releaseHangs();
    this.requests = [];
    this.lastAuthorize = null;
    this.consentEmail = OWNER_EMAIL;
    this.denyNext = false;
    this.grantedScopes = null;
    this.offset = 0;
    this.latencyMs = 0;
  }

  mailbox(email = OWNER_EMAIL): Mailbox {
    const m = this.mailboxes.get(email);
    if (!m) throw new Error(`no fake mailbox ${email}`);
    return m;
  }

  /** The Google user who consents on the next authorize. */
  consentAs(email: string) {
    if (!this.mailboxes.has(email)) this.mailboxes.set(email, new Mailbox(email, `3${this.mailboxes.size}000000000000000000`.slice(0, 19), 0x30000 + this.mailboxes.size));
    this.consentEmail = email;
  }
  /** The user clicks "Cancel" on the next consent screen (redirect with error=access_denied). */
  denyNextConsent() {
    this.denyNext = true;
  }
  /** Granular consent: grant only these scopes from now on (null: everything asked). */
  grantOnly(scopes: string[] | null) {
    this.grantedScopes = scopes;
  }
  advance(ms: number) {
    this.offset += ms;
  }
  failNext(rule: FailRule) {
    this.rules.push({ times: 1, ...rule });
  }
  releaseHangs() {
    for (const r of this.hangs.splice(0)) r();
  }
  /** A refresh token for `email` without the browser dance (for connector tests). */
  issueRefreshToken(email = OWNER_EMAIL, scopes: string[] = ["openid", "email", GMAIL_MODIFY], clientId = this.clients[0]!.id): string {
    this.mailbox(email);
    const t = randomToken("1//0fake-");
    this.refresh.set(t, { email, clientId, scopes, revoked: false });
    return t;
  }
  /** Every grant of this user is revoked (the user removed the app in their Google account). */
  revokeAll(email: string) {
    for (const g of this.refresh.values()) if (g.email === email) g.revoked = true;
  }
  isRevoked(refreshToken: string): boolean {
    return this.refresh.get(refreshToken)?.revoked ?? true;
  }
  /** Live (not revoked) refresh tokens of a user. */
  liveGrants(email: string): number {
    return [...this.refresh.values()].filter((g) => g.email === email && !g.revoked).length;
  }
  expireAccessTokens() {
    for (const a of this.access.values()) a.expiresAt = 0;
  }
  /** Gmail forgets history before now: the next history.list from an older id is 404. */
  expireHistory(email = OWNER_EMAIL) {
    const b = this.mailbox(email);
    b.oldestHistoryId = b.historyId;
  }
  /** Messages a client sent (messages.send), newest last, with the parsed headers and text. */
  sent(email = OWNER_EMAIL) {
    return [...this.mailbox(email).messages.values()].filter((m) => m.raw && !m.labelIds.includes("DRAFT")).map((m) => this.describe(m));
  }
  drafts(email = OWNER_EMAIL) {
    return [...this.mailbox(email).messages.values()].filter((m) => m.raw && m.labelIds.includes("DRAFT")).map((m) => this.describe(m));
  }
  private describe(m: FMessage) {
    const parsed = parseRaw(b64urlDecode(m.raw!)!)!;
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, raw: m.raw!, headers: parsed.headers, text: parsed.text, contentType: parsed.contentType, transferEncoding: parsed.transferEncoding };
  }

  /** A new incoming email (in an existing thread when threadId is given). Returns the message. */
  deliver(email: string, o: { threadId?: string; from: string; subject: string; text: string; labels?: string[]; to?: string; at?: number }): FMessage {
    const box = this.mailbox(email);
    const id = box.newId();
    const at = o.at ?? this.now();
    const prev = o.threadId ? box.thread(o.threadId) : [];
    const refs = prev.map((m) => header(m.payload, "Message-ID")).filter(Boolean);
    const msg: FMessage = {
      id,
      threadId: o.threadId && prev.length ? o.threadId : id,
      labelIds: o.labels ?? ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
      internalDate: at,
      payload: buildPayload({ from: o.from, to: o.to ?? email, subject: o.subject, text: o.text, at, labels: [], messageId: `<${id}@mail.example.com>`, ...(refs.length ? { inReplyTo: refs.at(-1)!, references: refs.join(" ") } : {}) }),
    };
    box.add(msg);
    return msg;
  }

  // ---------------------------------------------------------------- entry

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const rule = this.rules.find((r) => (!r.method || r.method === req.method) && (!r.path || (typeof r.path === "string" ? path.startsWith(r.path) : r.path.test(path))) && (r.times ?? 1) > 0);
    if (rule) {
      rule.times = (rule.times ?? 1) - 1;
      this.rules = this.rules.filter((r) => (r.times ?? 1) > 0);
      if (rule.hang) await new Promise<void>((r) => this.hangs.push(r));
      if (rule.network) {
        this.requests.push({ method: req.method, path, status: 0, email: null });
        throw new TypeError("fake network failure");
      }
      if (rule.status) {
        this.requests.push({ method: req.method, path, status: rule.status, email: null });
        return rule.body !== undefined ? json(rule.body, rule.status) : googleError(rule.status, "Injected failure.", "backendError");
      }
    }
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const log: RequestLog = { method: req.method, path, status: 0, email: null };
    let res: Response;
    try {
      res = await this.route(req, url, log);
    } catch {
      res = googleError(500, "Internal error.", "backendError");
    }
    log.status = res.status;
    this.requests.push(log);
    return res;
  }

  private async route(req: Request, url: URL, log: RequestLog): Promise<Response> {
    const p = url.pathname;
    if (p === "/o/oauth2/v2/auth" && req.method === "GET") return this.authorize(url);
    if (p === "/token" && req.method === "POST") return this.token(req, log);
    if (p === "/revoke" && req.method === "POST") return this.revoke(req, url);
    if (p === "/oauth2/v3/userinfo" && req.method === "GET") {
      const a = this.bearer(req);
      if (!a) return googleError(401, "Invalid Credentials", "authError");
      const box = this.mailbox(a.grant.email);
      return json({ sub: box.sub, email: box.email, email_verified: true });
    }
    const m = /^\/gmail\/v1\/users\/([^/]+)\/(.*)$/.exec(p);
    if (m) {
      const a = this.bearer(req);
      if (!a) return googleError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", "authError");
      if (m[1] !== "me" && decodeURIComponent(m[1]!) !== a.grant.email) return googleError(403, "Delegation denied for " + a.grant.email, "forbidden");
      const write = req.method !== "GET";
      if (!a.grant.scopes.includes(GMAIL_MODIFY) && !(a.grant.scopes.includes("https://www.googleapis.com/auth/gmail.readonly") && !write))
        return googleError(403, "Request had insufficient authentication scopes.", "insufficientPermissions");
      log.email = a.grant.email;
      return this.gmail(req, url, m[2]!, this.mailbox(a.grant.email));
    }
    return googleError(404, "Not Found", "notFound");
  }

  // ---------------------------------------------------------------- OAuth

  private authorize(url: URL): Response {
    const q = url.searchParams;
    this.lastAuthorize = q;
    const client = this.clients.find((c) => c.id === q.get("client_id"));
    const html = (status: number, text: string) => new Response(`<!doctype html><title>Error</title><h1>${text}</h1>`, { status, headers: { "content-type": "text/html" } });
    if (!client) return html(401, "Error 401: invalid_client");
    const redirect = q.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirect)) return html(400, "Error 400: redirect_uri_mismatch");
    if (q.get("response_type") !== "code") return html(400, "Error 400: unsupported_response_type");
    const asked = (q.get("scope") ?? "").split(" ").filter(Boolean);
    if (!asked.length || asked.some((s) => !KNOWN_SCOPES.has(s))) return html(400, "Error 400: invalid_scope");
    const challenge = q.get("code_challenge");
    const method = q.get("code_challenge_method");
    if (challenge && method !== "S256" && method !== "plain") return html(400, "Error 400: invalid_request");
    const back = new URL(redirect);
    const state = q.get("state");
    if (this.denyNext) {
      this.denyNext = false;
      back.searchParams.set("error", "access_denied");
      if (state !== null) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    const granted = this.grantedScopes ? asked.filter((s) => this.grantedScopes!.includes(s)) : asked;
    const code = randomToken("4/0fake-");
    this.codes.set(code, { clientId: client.id, redirectUri: redirect, email: this.consentEmail, scopes: granted, challenge, method, expiresAt: this.now() + CODE_TTL_MS, used: false, offline: q.get("access_type") === "offline", nonce: q.get("nonce") });
    if (state !== null) back.searchParams.set("state", state);
    back.searchParams.set("code", code);
    back.searchParams.set("scope", granted.join(" "));
    back.searchParams.set("authuser", "0");
    back.searchParams.set("prompt", "consent");
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }

  private clientAuth(req: Request, f: URLSearchParams): Client | null {
    let id = f.get("client_id");
    let secret = f.get("client_secret");
    const basic = /^Basic (.+)$/.exec(req.headers.get("authorization") ?? "");
    if (basic) {
      try {
        const [u, s] = atob(basic[1]!).split(":");
        id = decodeURIComponent(u ?? "");
        secret = decodeURIComponent(s ?? "");
      } catch {}
    }
    const c = this.clients.find((x) => x.id === id);
    return c && c.secret === secret ? c : null;
  }

  private idToken(clientId: string, email: string, nonce: string | null): string {
    const box = this.mailbox(email);
    const now = Math.floor(this.now() / 1000);
    const part = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));
    return `${part({ alg: "RS256", kid: "fake-key-1", typ: "JWT" })}.${part({ iss: "https://accounts.google.com", azp: clientId, aud: clientId, sub: box.sub, email, email_verified: true, iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) })}.ZmFrZS1zaWduYXR1cmU`;
  }

  private mintAccess(grant: Grant): string {
    const t = randomToken("ya29.fake-");
    this.access.set(t, { grant, expiresAt: this.now() + ACCESS_TTL_S * 1000 });
    return t;
  }

  private async token(req: Request, log: RequestLog): Promise<Response> {
    const f = await formOrJson(req);
    const client = this.clientAuth(req, f);
    log.grant = f.get("grant_type") ?? "";
    if (!client) return oauthError(401, "invalid_client", "Unauthorized");
    const type = f.get("grant_type");
    if (type === "authorization_code") {
      const code = this.codes.get(f.get("code") ?? "");
      if (!code || code.clientId !== client.id) return oauthError(400, "invalid_grant", "Malformed auth code.");
      if (code.used) return oauthError(400, "invalid_grant", "Bad Request");
      code.used = true;
      if (this.now() > code.expiresAt) return oauthError(400, "invalid_grant", "Bad Request");
      if (f.get("redirect_uri") !== code.redirectUri) return oauthError(400, "redirect_uri_mismatch", "Bad Request");
      if (code.challenge) {
        const v = f.get("code_verifier");
        if (!v || (code.method === "S256" ? await s256(v) : v) !== code.challenge) return oauthError(400, "invalid_grant", "Invalid code verifier.");
      }
      const grant: Grant = { email: code.email, clientId: client.id, scopes: code.scopes, revoked: false };
      log.email = code.email;
      const out: Record<string, unknown> = { access_token: this.mintAccess(grant), expires_in: ACCESS_TTL_S, scope: code.scopes.join(" "), token_type: "Bearer" };
      if (code.offline) {
        const rt = randomToken("1//0fake-");
        this.refresh.set(rt, grant);
        out.refresh_token = rt;
      }
      if (code.scopes.includes("openid")) out.id_token = this.idToken(client.id, code.email, code.nonce);
      return json(out);
    }
    if (type === "refresh_token") {
      const g = this.refresh.get(f.get("refresh_token") ?? "");
      if (!g || g.revoked || g.clientId !== client.id) return oauthError(400, "invalid_grant", "Token has been expired or revoked.");
      log.email = g.email;
      return json({ access_token: this.mintAccess(g), expires_in: ACCESS_TTL_S, scope: g.scopes.join(" "), token_type: "Bearer" });
    }
    return oauthError(400, "unsupported_grant_type", "Invalid grant_type: " + (type ?? ""));
  }

  private async revoke(req: Request, url: URL): Promise<Response> {
    const f = await formOrJson(req);
    const t = f.get("token") ?? url.searchParams.get("token") ?? "";
    const g = this.refresh.get(t) ?? this.access.get(t)?.grant;
    if (!g || g.revoked) return oauthError(400, "invalid_token", "Token expired or revoked");
    g.revoked = true;
    return json({});
  }

  private bearer(req: Request): AccessToken | null {
    const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
    const a = m ? this.access.get(m[1]!) : undefined;
    if (!a || a.grant.revoked || this.now() >= a.expiresAt) return null;
    return a;
  }

  // ---------------------------------------------------------------- Gmail

  private messageJSON(m: FMessage, box: Mailbox, format: string, metaHeaders: Set<string> | undefined) {
    const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], snippet: snippet(m), historyId: String(box.historyId), internalDate: String(m.internalDate), sizeEstimate: 1000 };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: m.raw ?? b64urlEncode(enc.encode("Subject: " + header(m.payload, "Subject") + "\r\n\r\n")) };
    return { ...base, payload: partJSON(m.payload, "", format === "metadata" ? "metadata" : "full", format === "metadata" ? metaHeaders : undefined) };
  }

  private listFilter(box: Mailbox, q: URLSearchParams): FMessage[] {
    const labelIds = q.getAll("labelIds");
    const spam = q.get("includeSpamTrash") === "true";
    const match = compileQuery(q.get("q"), box.email);
    return [...box.messages.values()].filter((m) => (spam || (!m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"))) && labelIds.every((l) => m.labelIds.includes(l)) && match(viewOf(m)));
  }

  private page<T>(all: T[], q: URLSearchParams): { items: T[]; next: string | null } | Response {
    const max = q.get("maxResults") === null ? 100 : Number(q.get("maxResults"));
    if (!Number.isInteger(max) || max < 1 || max > 500) return googleError(400, "Invalid maxResults", "invalidArgument");
    const tok = q.get("pageToken");
    let start = 0;
    if (tok !== null) {
      const m = /^p(\d{1,9})$/.exec(tok);
      if (!m) return googleError(400, "Invalid pageToken", "invalidArgument");
      start = Number(m[1]);
    }
    const items = all.slice(start, start + max);
    return { items, next: start + max < all.length ? `p${start + max}` : null };
  }

  /** A thread's activity time: its newest message that is not a draft. */
  private threadTime(box: Mailbox, threadId: string): number {
    const msgs = box.thread(threadId);
    const real = msgs.filter((m) => !m.labelIds.includes("DRAFT"));
    return Math.max(...(real.length ? real : msgs).map((m) => m.internalDate));
  }

  private async gmail(req: Request, url: URL, rest: string, box: Mailbox): Promise<Response> {
    const q = url.searchParams;
    const fmt = q.get("format") ?? "full";
    if (!["full", "metadata", "minimal", "raw"].includes(fmt)) return googleError(400, "Invalid format", "invalidArgument");
    const meta = q.getAll("metadataHeaders").length ? new Set(q.getAll("metadataHeaders").map((h) => h.toLowerCase())) : undefined;
    const body = async (): Promise<Record<string, unknown> | null> => {
      try {
        const j = await req.json();
        return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    let m: RegExpExecArray | null;

    if (rest === "profile" && req.method === "GET") {
      return json({ emailAddress: box.email, messagesTotal: box.messages.size, threadsTotal: box.threadIds().length, historyId: String(box.historyId) });
    }

    if (rest === "threads" && req.method === "GET") {
      const msgs = this.listFilter(box, q);
      const ids = [...new Set(msgs.map((x) => x.threadId))].sort((a, b) => this.threadTime(box, b) - this.threadTime(box, a) || (a < b ? 1 : -1));
      const pg = this.page(ids, q);
      if (pg instanceof Response) return pg;
      const threads = pg.items.map((id) => {
        const last = box.thread(id).at(-1)!;
        return { id, snippet: snippet(last), historyId: String(box.historyId) };
      });
      return json({ ...(threads.length ? { threads } : {}), ...(pg.next ? { nextPageToken: pg.next } : {}), resultSizeEstimate: ids.length });
    }

    if ((m = /^threads\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      const msgs = box.thread(m[1]!);
      if (!msgs.length) return googleError(404, "Requested entity was not found.", "notFound");
      return json({ id: m[1], historyId: String(box.historyId), messages: msgs.map((x) => this.messageJSON(x, box, fmt, meta)) });
    }

    if ((m = /^threads\/([^/]+)\/modify$/.exec(rest)) && req.method === "POST") {
      const msgs = box.thread(m[1]!);
      if (!msgs.length) return googleError(404, "Requested entity was not found.", "notFound");
      const b = await body();
      const labels = this.labelChange(b);
      if (labels instanceof Response) return labels;
      for (const x of msgs) box.modify(x.id, labels.add, labels.remove);
      return json({ id: m[1], historyId: String(box.historyId), messages: box.thread(m[1]!).map((x) => this.messageJSON(x, box, "minimal", undefined)) });
    }

    if (rest === "messages" && req.method === "GET") {
      const msgs = this.listFilter(box, q).sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? 1 : -1));
      const pg = this.page(msgs, q);
      if (pg instanceof Response) return pg;
      return json({ ...(pg.items.length ? { messages: pg.items.map((x) => ({ id: x.id, threadId: x.threadId })) } : {}), ...(pg.next ? { nextPageToken: pg.next } : {}), resultSizeEstimate: msgs.length });
    }

    if ((m = /^messages\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      const msg = box.messages.get(m[1]!);
      if (!msg) return googleError(404, "Requested entity was not found.", "notFound");
      return json(this.messageJSON(msg, box, fmt, meta));
    }

    if ((m = /^messages\/([^/]+)\/attachments\/([^/]+)$/.exec(rest)) && req.method === "GET") {
      const msg = box.messages.get(m[1]!);
      const part = msg ? findAttachment(msg.payload, m[2]!) : null;
      if (!part) return googleError(404, "Requested entity was not found.", "notFound");
      return json({ attachmentId: part.attachmentId, size: part.data?.length ?? 0, data: b64urlEncode(part.data ?? new Uint8Array()) });
    }

    if ((m = /^messages\/([^/]+)\/modify$/.exec(rest)) && req.method === "POST") {
      const msg = box.messages.get(m[1]!);
      if (!msg) return googleError(404, "Requested entity was not found.", "notFound");
      const labels = this.labelChange(await body());
      if (labels instanceof Response) return labels;
      box.modify(msg.id, labels.add, labels.remove);
      return json(this.messageJSON(msg, box, "minimal", undefined));
    }

    if (rest === "messages/send" && req.method === "POST") {
      const b = await body();
      const out = this.store(box, b, false);
      return out instanceof Response ? out : json({ id: out.id, threadId: out.threadId, labelIds: out.labelIds });
    }

    if (rest === "drafts" && req.method === "POST") {
      const b = await body();
      const msg = b && typeof b.message === "object" && b.message !== null ? (b.message as Record<string, unknown>) : null;
      const out = this.store(box, msg, true);
      return out instanceof Response ? out : json({ id: out.draftId, message: { id: out.id, threadId: out.threadId, labelIds: out.labelIds } });
    }

    if (rest === "history" && req.method === "GET") {
      const start = Number(q.get("startHistoryId"));
      if (!q.get("startHistoryId") || !Number.isSafeInteger(start) || start < 0) return googleError(400, "Invalid startHistoryId", "invalidArgument");
      if (start < box.oldestHistoryId) return googleError(404, "Requested entity was not found.", "notFound");
      const types = new Set(q.getAll("historyTypes"));
      const label = q.get("labelId");
      const recs = box.history
        .filter((r) => r.id > start)
        .map((r) => {
          const keep: Record<string, unknown> = { id: String(r.id) };
          const pick = (k: "messagesAdded" | "messagesDeleted" | "labelsAdded" | "labelsRemoved", t: string) => {
            const v = r[k];
            if (!v || (types.size && !types.has(t))) return;
            const items = (v as { message?: { labelIds: string[] }; labelIds?: string[] }[]).filter((x) => !label || ((x.message ?? (x as { labelIds: string[] })).labelIds ?? []).includes(label));
            if (items.length) keep[k] = items.map((x) => ("message" in x ? x : { message: x }));
          };
          pick("messagesAdded", "messageAdded");
          pick("messagesDeleted", "messageDeleted");
          pick("labelsAdded", "labelAdded");
          pick("labelsRemoved", "labelRemoved");
          const ids = new Set<string>();
          for (const k of ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) for (const x of (keep[k] as { message: { id: string; threadId: string } }[] | undefined) ?? []) ids.add(`${x.message.id}|${x.message.threadId}`);
          keep.messages = [...ids].map((s) => ({ id: s.split("|")[0], threadId: s.split("|")[1] }));
          return keep;
        })
        .filter((r) => (r.messages as unknown[]).length);
      const pg = this.page(recs, q);
      if (pg instanceof Response) return pg;
      return json({ ...(pg.items.length ? { history: pg.items } : {}), historyId: String(box.historyId), ...(pg.next ? { nextPageToken: pg.next } : {}) });
    }

    return googleError(404, "Not Found", "notFound");
  }

  private labelChange(b: Record<string, unknown> | null): { add: string[]; remove: string[] } | Response {
    if (!b) return googleError(400, "Invalid JSON payload received.", "invalidArgument");
    const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
    const add = list(b.addLabelIds);
    const remove = list(b.removeLabelIds);
    if (!add || !remove) return googleError(400, "Invalid label list", "invalidArgument");
    for (const l of [...add, ...remove]) if (!(SYSTEM_LABELS as readonly string[]).includes(l) || l === "SENT" || l === "DRAFT") return googleError(400, `Invalid label: ${l}`, "invalidArgument");
    return { add, remove };
  }

  /** messages.send / drafts.create: parse the raw message and file it (Gmail's threading rule). */
  private store(box: Mailbox, b: Record<string, unknown> | null, draft: boolean): FMessage | Response {
    if (!b || typeof b.raw !== "string") return googleError(400, "'raw' RFC822 payload message string or uploading message via /upload/* URL required", "invalidArgument");
    const bytes = b64urlDecode(b.raw);
    const parsed = bytes ? parseRaw(bytes) : null;
    if (!parsed) return googleError(400, "Invalid raw message", "invalidArgument");
    const get = (n: string) => parsed.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    if (!draft && !/@/.test(get("to") + get("cc") + get("bcc"))) return googleError(400, "Recipient address required", "invalidArgument");
    let threadId: string | null = null;
    if (b.threadId !== undefined) {
      if (typeof b.threadId !== "string") return googleError(400, "Invalid thread_id value", "invalidArgument");
      const prev = box.thread(b.threadId);
      if (!prev.length) return googleError(404, "Requested entity was not found.", "notFound");
      const ids = new Set(prev.map((m) => header(m.payload, "Message-ID")).filter(Boolean));
      const refs = `${get("in-reply-to")} ${get("references")}`.split(/\s+/).filter(Boolean);
      // Gmail files it into the thread only when the subject matches and it references the thread.
      if (strip(get("subject")) === strip(header(prev[0]!.payload, "Subject")) && refs.some((r) => ids.has(r))) threadId = b.threadId;
    }
    const id = box.newId();
    const payload: Part = { mimeType: parsed.contentType.split(";")[0]!.trim(), headers: parsed.headers, data: new TextEncoder().encode(parsed.text) };
    payload.headers = [...payload.headers.filter((h) => !/^content-type$/i.test(h.name)), { name: "Content-Type", value: "text/plain; charset=UTF-8" }];
    if (!payload.headers.some((h) => h.name.toLowerCase() === "message-id")) payload.headers.push({ name: "Message-ID", value: `<${id}@mail.gmail.example>` });
    const msg: FMessage = { id, threadId: threadId ?? id, labelIds: draft ? ["DRAFT"] : ["SENT"], internalDate: this.now(), payload, raw: b.raw, ...(draft ? { draftId: `r-${id}` } : {}) };
    box.add(msg);
    return msg;
  }
}

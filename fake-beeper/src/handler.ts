// HTTP side of the fake Beeper Client API as a web-standard (Request) => Response handler.
// Behaviour follows vendor/beeper-client-api-spec.json; where the spec is silent the choice is noted.
import type { BChat, BMessage } from "./fixtures.ts";
import type { Call, FakeBeeperState } from "./state.ts";

export const FAKE_BEEPER_VERSION = "4.2.999-fake";

export type Controls = {
  latencyMs: number;
  /** Order of items inside one /messages page. The spec only says "sorted by timestamp". */
  messageOrder: "desc" | "asc";
  /** /messages has no limit parameter; Beeper picks the page size. */
  messagesPageSize: number;
  /** Delay before a sent message turns from PENDING to SUCCESS. */
  settleMs: number;
  /** Drop WebSocket events silently (at-most-once delivery). */
  dropEvents: boolean;
  /**
   * Real iMessage (imsg##) history: the first /messages page says hasMore:true, but the next
   * page (cursor + direction=before) is {items:[], hasMore:false}. Seen in the smoke run.
   */
  emptyOlderPageForIMessage: boolean;
  /**
   * /v1/ws: wait this long before `ready`. Commands that arrive before `ready` are dropped without
   * an answer (a server may ignore them; the spec says to subscribe only after `ready`).
   */
  wsReadyDelayMs: number;
  /** /v1/ws: never send `ready` at all. */
  wsNoReady: boolean;
  /** /v1/ws: refuse a subscriptions.set carrying `app` with INVALID_PAYLOAD (a build without app state). */
  wsRejectApp: boolean;
  /** /v1/ws: accept subscriptions.set but never answer subscriptions.updated (or error). */
  wsSilentSubscribe: boolean;
};

export const defaultControls = (): Controls => ({ latencyMs: 0, messageOrder: "desc", messagesPageSize: 20, settleMs: 0, dropEvents: false, emptyOlderPageForIMessage: false, wsReadyDelayMs: 0, wsNoReady: false, wsRejectApp: false, wsSilentSubscribe: false });

type Match = { method?: string; path?: string; route?: string; times?: number };
export type FailRule = Match & { status: number; code?: string; message?: string; rawBody?: string; headers?: Record<string, string> };
export type HangRule = Match;

export type HandlerContext = {
  state: () => FakeBeeperState;
  controls: Controls;
  tokens: Set<string>;
  failRules: FailRule[];
  hangRules: HangRule[];
  hangs: Set<() => void>;
  baseURL: () => string;
};

const JSON_HEADERS = { "content-type": "application/json", "x-beeper-desktop-version": FAKE_BEEPER_VERSION };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string, message: string, issues?: { path: (string | number)[]; message: string }[]): Response {
  const body: Record<string, unknown> = { message, code };
  if (issues) body.details = { issues: issues.map((i) => ({ code: "invalid", ...i })) };
  return json(body, status);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string) => new HttpError(400, "VALIDATION_ERROR", message);
const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found`);

// ---- cursors: opaque base64url JSON ----
function encCursor(v: Record<string, unknown>): string {
  return btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decCursor(s: string | null, kind: string): Record<string, any> | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    if (v && v.k === kind) return v;
  } catch {}
  throw bad("Invalid cursor");
}

// ---- query helpers ----
function qInt(q: URLSearchParams, key: string, def: number, min: number, max: number): number {
  const raw = q.get(key);
  if (raw === null) return def;
  if (!/^-?\d+$/.test(raw)) throw bad(`${key} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw bad(`${key} must be between ${min} and ${max}`);
  return n;
}
function qBool(q: URLSearchParams, key: string, def: boolean | null): boolean | null {
  const raw = q.get(key);
  if (raw === null) return def;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw bad(`${key} must be true or false`);
}
function qEnum<T extends string>(q: URLSearchParams, key: string, values: readonly T[]): T | null {
  const raw = q.get(key);
  if (raw === null) return null;
  if (!values.includes(raw as T)) throw bad(`${key} must be one of ${values.join(", ")}`);
  return raw as T;
}
function qDate(q: URLSearchParams, key: string): number | null {
  const raw = q.get(key);
  if (raw === null) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t) || !/T/.test(raw)) throw bad(`${key} must be an ISO 8601 date-time`);
  return t;
}
function qList(q: URLSearchParams, key: string): string[] | null {
  const vals = [...q.getAll(key), ...q.getAll(`${key}[]`)];
  return vals.length ? vals : null;
}
function direction(q: URLSearchParams): "before" | "after" {
  return qEnum(q, "direction", ["before", "after"] as const) ?? "before";
}

// ---- shapes ----
const clone = <T>(v: T): T => structuredClone(v);

function chatOut(c: BChat): BChat {
  return clone(c);
}
function chatWithPreview(state: FakeBeeperState, c: BChat) {
  const out: Record<string, unknown> = chatOut(c);
  const last = state.lastMessage(c.id);
  if (last) out.preview = clone(last);
  return out;
}

const ts = (c: BChat) => Date.parse(c.lastActivity ?? "1970-01-01T00:00:00Z");
const chatCmp = (a: { t: number; id: string }, b: { t: number; id: string }) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function pageByCursor<T>(sorted: T[], key: (x: T) => { t: number; id: string }, cursor: Record<string, any> | null, dir: "before" | "after", limit: number) {
  let page: T[];
  let hasMore: boolean;
  if (!cursor) {
    page = sorted.slice(0, limit);
    hasMore = sorted.length > limit;
  } else if (dir === "before") {
    const rest = sorted.filter((x) => chatCmp(key(x), cursor as any) > 0);
    page = rest.slice(0, limit);
    hasMore = rest.length > limit;
  } else {
    const newer = sorted.filter((x) => chatCmp(key(x), cursor as any) < 0);
    page = newer.slice(Math.max(0, newer.length - limit));
    hasMore = newer.length > limit;
  }
  return { page, hasMore };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 2_000_000) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Body too large");
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad("Body is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("Body must be a JSON object");
  return v as Record<string, unknown>;
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`Unknown field ${k}`);
}

function matches(rule: Match, method: string, path: string, route: string) {
  if (rule.method && rule.method.toUpperCase() !== method) return false;
  if (rule.path !== undefined && rule.path !== path) return false;
  if (rule.route !== undefined && rule.route !== route) return false;
  return true;
}

function takeRule<R extends Match>(rules: R[], method: string, path: string, route: string): R | undefined {
  const i = rules.findIndex((r) => matches(r, method, path, route));
  if (i < 0) return undefined;
  const r = rules[i]!;
  const left = (r.times ?? 1) - 1;
  if (left <= 0) rules.splice(i, 1);
  else r.times = left;
  return r;
}

type Route = { route: string; params: Record<string, string> };

function resolveRoute(method: string, segs: string[]): Route | null {
  const [v1, a, b, c, d, e, f] = segs;
  if (v1 !== "v1") return null;
  const n = segs.length;
  if (n === 2 && a === "info") return { route: "/v1/info", params: {} };
  if (n === 2 && a === "accounts") return { route: "/v1/accounts", params: {} };
  if (n === 3 && a === "accounts") return { route: "/v1/accounts/{accountID}", params: { accountID: b! } };
  if (n === 5 && a === "bridges" && c === "logins") return { route: "/v1/bridges/{bridgeID}/logins/{loginID}", params: { bridgeID: b!, loginID: d! } };
  if (n === 6 && a === "bridges" && c === "logins" && e === "remove") return { route: "/v1/bridges/{bridgeID}/logins/{loginID}/remove", params: { bridgeID: b!, loginID: d! } };
  if (n === 2 && a === "chats") return { route: "/v1/chats", params: {} };
  if (n === 3 && a === "chats" && b === "search" && method === "GET") return { route: "/v1/chats/search", params: {} };
  if (n === 3 && a === "messages" && b === "search") return { route: "/v1/messages/search", params: {} };
  if (n === 3 && a === "assets" && b === "serve") return { route: "/v1/assets/serve", params: {} };
  if (a !== "chats" || b === undefined) return null;
  if (n === 3) return { route: "/v1/chats/{chatID}", params: { chatID: b } };
  if (n === 4 && ["archive", "read", "unread", "messages"].includes(c!)) return { route: `/v1/chats/{chatID}/${c}`, params: { chatID: b } };
  if (n === 5 && c === "messages") return { route: "/v1/chats/{chatID}/messages/{messageID}", params: { chatID: b, messageID: d! } };
  if (n === 6 && c === "messages" && e === "reactions") return { route: "/v1/chats/{chatID}/messages/{messageID}/reactions", params: { chatID: b, messageID: d! } };
  if (n === 7 && c === "messages" && e === "reactions") return { route: "/v1/chats/{chatID}/messages/{messageID}/reactions/{reactionKey}", params: { chatID: b, messageID: d!, reactionKey: f! } };
  return null;
}

export function createBeeperHandler(ctx: HandlerContext) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    let segs: string[];
    try {
      segs = url.pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
    } catch {
      return error(400, "VALIDATION_ERROR", "Malformed path encoding");
    }
    const found = resolveRoute(method, segs);
    const route = found?.route ?? url.pathname;
    const state = ctx.state();
    if (ctx.controls.latencyMs > 0) await new Promise((r) => setTimeout(r, ctx.controls.latencyMs));

    // Read the body and log the call before anything can answer, so injected faults and
    // refused requests still count as attempts (a test for "sent only once" must see them).
    let body: Record<string, unknown> = {};
    let bodyError: HttpError | null = null;
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      try {
        body = await readJson(req);
      } catch (e) {
        bodyError = e instanceof HttpError ? e : bad("Body is not valid JSON");
      }
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const authorized = route === "/v1/info" || (token !== undefined && ctx.tokens.has(token));
    const call: Call = {
      method,
      route: `${method} ${route}`,
      params: found?.params ?? {},
      query: Object.fromEntries([...url.searchParams.keys()].map((k) => [k, url.searchParams.getAll(k)])),
      body,
      at: Date.now(),
      authorized,
    };
    state.calls.push(call);
    const done = (res: Response) => ((call.status = res.status), res);

    const hang = takeRule(ctx.hangRules, method, url.pathname, route);
    if (hang) {
      call.injected = "hang";
      await new Promise<void>((resolve) => ctx.hangs.add(resolve));
      return done(error(503, "UNAVAILABLE", "Released"));
    }
    const fail = takeRule(ctx.failRules, method, url.pathname, route);
    if (fail) {
      call.injected = "fail";
      if (fail.rawBody !== undefined) return done(new Response(fail.rawBody, { status: fail.status, headers: { "x-beeper-desktop-version": FAKE_BEEPER_VERSION, ...fail.headers } }));
      const res = error(fail.status, fail.code ?? `HTTP_${fail.status}`, fail.message ?? "Injected failure");
      for (const [k, v] of Object.entries(fail.headers ?? {})) res.headers.set(k, v);
      return done(res);
    }

    if (!authorized) return done(error(401, "UNAUTHORIZED", "Access token is missing or invalid"));
    if (!found) return done(error(404, "NOT_FOUND", "Route not found"));
    if (bodyError) return done(error(bodyError.status, bodyError.code, bodyError.message));

    try {
      return done(await dispatch(method, found, url.searchParams, body, req, state, ctx));
    } catch (e) {
      if (e instanceof HttpError) return done(error(e.status, e.code, e.message));
      return done(error(500, "INTERNAL_ERROR", "Internal error"));
    }
  };
}

async function dispatch(method: string, r: Route, q: URLSearchParams, body: Record<string, unknown>, req: Request, state: FakeBeeperState, ctx: HandlerContext): Promise<Response> {
  const key = `${method} ${r.route}`;
  const chat = () => {
    const c = state.chats.get(r.params.chatID!);
    if (!c) throw notFound("Chat");
    return c;
  };
  const message = () => {
    const m = state.messagesOf(r.params.chatID!).find((x) => x.id === r.params.messageID);
    if (!m) throw notFound("Message");
    return m;
  };

  switch (key) {
    case "GET /v1/info": {
      const base = ctx.baseURL();
      const port = Number(new URL(base).port);
      return json({
        app: { name: "Beeper Desktop", version: FAKE_BEEPER_VERSION, bundle_id: "com.automattic.beeper.desktop" },
        platform: { os: "darwin", arch: "arm64", release: "24.2.0" },
        server: { status: "running", base_url: base, port, hostname: "127.0.0.1", remote_access: false, mcp_enabled: false },
        endpoints: {
          oauth: {
            authorization_endpoint: `${base}/oauth/authorize`,
            token_endpoint: `${base}/oauth/token`,
            introspection_endpoint: `${base}/oauth/introspect`,
            userinfo_endpoint: `${base}/oauth/userinfo`,
            revocation_endpoint: `${base}/oauth/revoke`,
            registration_endpoint: `${base}/oauth/register`,
          },
          spec: `${base}/v1/spec`,
          mcp: `${base}/v0/mcp`,
          ws_events: base.replace(/^http/, "ws") + "/v1/ws",
        },
      });
    }

    case "GET /v1/accounts":
      return json(clone(state.accounts));

    case "GET /v1/accounts/{accountID}": {
      const acc = state.accounts.find((x) => x.accountID === r.params.accountID);
      if (!acc) throw notFound("Account");
      return json(clone(acc));
    }

    case "GET /v1/bridges/{bridgeID}/logins/{loginID}":
    case "POST /v1/bridges/{bridgeID}/logins/{loginID}/remove": {
      const accs = state.accounts.filter((x) => x.bridge?.id === r.params.bridgeID && x.loginID === r.params.loginID);
      // Beeper's own account is not a bridge login (the real API answers 404 for it too).
      if (!accs.length || r.params.bridgeID === "matrix") throw notFound("Bridge login");
      const removeScopes = accs[0]!.bridge?.provider === "local" ? ["current-device"] : ["all-devices"];
      if (method === "GET") return json({ loginID: r.params.loginID, bridgeID: r.params.bridgeID, accountIDs: accs.map((x) => x.accountID), status: "connected", removeScopes });
      if (typeof body.scope !== "string" || !removeScopes.includes(body.scope)) throw bad(`scope must be one of ${removeScopes.join(", ")}`);
      state.accounts = state.accounts.filter((x) => !accs.includes(x));
      return json({ bridgeID: r.params.bridgeID, loginID: r.params.loginID, affectedAccountIDs: accs.map((x) => x.accountID), status: "removed", scope: body.scope });
    }

    case "GET /v1/chats": {
      const limit = qInt(q, "limit", 25, 1, 200);
      const dir = direction(q);
      const cursor = decCursor(q.get("cursor"), "c");
      const accountIDs = qList(q, "accountIDs");
      const sorted = state
        .chatList()
        .filter((c) => !accountIDs || accountIDs.includes(c.accountID))
        .sort((a, b) => chatCmp({ t: ts(a), id: a.id }, { t: ts(b), id: b.id }));
      const { page, hasMore } = pageByCursor(sorted, (c) => ({ t: ts(c), id: c.id }), cursor, dir, limit);
      return json({
        items: page.map((c) => chatWithPreview(state, c)),
        hasMore,
        oldestCursor: page.length ? encCursor({ k: "c", t: ts(page[page.length - 1]!), id: page[page.length - 1]!.id }) : null,
        newestCursor: page.length ? encCursor({ k: "c", t: ts(page[0]!), id: page[0]!.id }) : null,
      });
    }

    case "GET /v1/chats/search": {
      const limit = qInt(q, "limit", 50, 1, 200);
      const dir = direction(q);
      const cursor = decCursor(q.get("cursor"), "c");
      const inbox = qEnum(q, "inbox", ["primary", "low-priority", "archive"] as const);
      const unreadOnly = qBool(q, "unreadOnly", null);
      const type = qEnum(q, "type", ["single", "group", "any"] as const) ?? "any";
      const scope = qEnum(q, "scope", ["titles", "participants"] as const) ?? "titles";
      const includeMuted = qBool(q, "includeMuted", true);
      const before = qDate(q, "lastActivityBefore");
      const after = qDate(q, "lastActivityAfter");
      const accountIDs = qList(q, "accountIDs");
      const rawQuery = q.get("query");
      if (rawQuery !== null && rawQuery.length < 1) throw bad("query must not be empty");
      const words = rawQuery ? rawQuery.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const sorted = state
        .chatList()
        .filter((c) => {
          if (accountIDs && !accountIDs.includes(c.accountID)) return false;
          if (inbox === "primary" && (c.isArchived || c.isLowPriority)) return false;
          if (inbox === "low-priority" && !c.isLowPriority) return false;
          if (inbox === "archive" && !c.isArchived) return false;
          if (unreadOnly && !(c.unreadCount > 0 || c.isMarkedUnread)) return false;
          if (type !== "any" && c.type !== type) return false;
          if (includeMuted === false && c.isMuted) return false;
          if (before !== null && !(ts(c) < before)) return false;
          if (after !== null && !(ts(c) > after)) return false;
          if (words.length) {
            const hay = (scope === "titles" ? `${c.title} ${c.network}` : c.participants.items.map((p) => p.fullName ?? "").join(" ")).toLowerCase();
            if (!words.every((w) => hay.includes(w))) return false;
          }
          return true;
        })
        .sort((a, b) => chatCmp({ t: ts(a), id: a.id }, { t: ts(b), id: b.id }));
      const { page, hasMore } = pageByCursor(sorted, (c) => ({ t: ts(c), id: c.id }), cursor, dir, limit);
      return json({
        items: page.map(chatOut),
        hasMore,
        oldestCursor: page.length ? encCursor({ k: "c", t: ts(page[page.length - 1]!), id: page[page.length - 1]!.id }) : null,
        newestCursor: page.length ? encCursor({ k: "c", t: ts(page[0]!), id: page[0]!.id }) : null,
      });
    }

    case "GET /v1/chats/{chatID}":
      return json(chatOut(chat()));

    case "PATCH /v1/chats/{chatID}": {
      const c = chat();
      onlyKeys(body, ["draft", "title", "description", "imgURL", "isArchived", "isLowPriority", "isPinned", "isMuted", "messageExpirySeconds"]);
      if ("draft" in body) {
        const d = body.draft;
        if (d === null) c.draft = null;
        else if (d && typeof d === "object" && !Array.isArray(d) && typeof (d as any).text === "string") {
          onlyKeys(d as Record<string, unknown>, ["text", "attachments"]);
          // Spec: "Non-empty drafts are accepted only when the current draft is empty."
          if ((d as any).text !== "" && c.draft?.text) throw new HttpError(409, "CONFLICT", "Chat already has a draft; clear it with draft=null first");
          c.draft = { text: (d as any).text };
        } else throw bad("draft must be null or {text}");
      }
      for (const k of ["isArchived", "isLowPriority", "isPinned", "isMuted"] as const) {
        if (k in body) {
          if (typeof body[k] !== "boolean") throw bad(`${k} must be boolean`);
          c[k] = body[k] as boolean;
        }
      }
      for (const k of ["title", "description"] as const) {
        if (k in body) {
          if (body[k] !== null && typeof body[k] !== "string") throw bad(`${k} must be a string or null`);
          if (k === "title" && typeof body[k] === "string") c.title = body[k] as string;
          if (k === "description") c.description = body[k] as string | null;
        }
      }
      state.emitChat(c);
      return json(chatOut(c));
    }

    case "POST /v1/chats/{chatID}/archive": {
      const c = chat();
      onlyKeys(body, ["archived"]);
      if ("archived" in body && typeof body.archived !== "boolean") throw bad("archived must be boolean");
      c.isArchived = body.archived === undefined ? true : (body.archived as boolean);
      state.emitChat(c);
      return new Response(null, { status: 204, headers: { "x-beeper-desktop-version": FAKE_BEEPER_VERSION } });
    }

    case "POST /v1/chats/{chatID}/read": {
      const c = chat();
      onlyKeys(body, ["messageID"]);
      const msgs = state.messagesOf(c.id);
      let upto = msgs.length - 1;
      if (body.messageID !== undefined) {
        if (typeof body.messageID !== "string") throw bad("messageID must be a string");
        upto = msgs.findIndex((m) => m.id === body.messageID);
        if (upto < 0) throw notFound("Message");
      }
      msgs.forEach((m, i) => {
        if (i <= upto) delete m.isUnread;
      });
      c.unreadCount = msgs.filter((m) => m.isUnread).length;
      c.isMarkedUnread = false;
      if (msgs[upto]) c.lastReadMessageSortKey = msgs[upto]!.sortKey;
      state.emitChat(c);
      return json(chatOut(c));
    }

    case "POST /v1/chats/{chatID}/unread": {
      const c = chat();
      onlyKeys(body, ["messageID"]);
      if (body.messageID !== undefined && typeof body.messageID !== "string") throw bad("messageID must be a string");
      c.isMarkedUnread = true;
      state.emitChat(c);
      return json(chatOut(c));
    }

    case "GET /v1/chats/{chatID}/messages": {
      const c = chat();
      const dir = direction(q);
      const cursor = decCursor(q.get("cursor"), "m");
      const n = ctx.controls.messagesPageSize;
      if (ctx.controls.emptyOlderPageForIMessage && cursor && dir === "before" && c.id.startsWith("imsg##"))
        return json({ items: [], hasMore: false, oldestCursor: null, newestCursor: null });
      const all = [...state.messagesOf(c.id)].sort((a, b) => Number(a.sortKey) - Number(b.sortKey));
      let page: BMessage[];
      let hasMore: boolean;
      if (!cursor) {
        page = all.slice(Math.max(0, all.length - n));
        hasMore = all.length > n;
      } else if (dir === "before") {
        const older = all.filter((m) => Number(m.sortKey) < cursor.s);
        page = older.slice(Math.max(0, older.length - n));
        hasMore = older.length > n;
      } else {
        const newer = all.filter((m) => Number(m.sortKey) > cursor.s);
        page = newer.slice(0, n);
        hasMore = newer.length > n;
      }
      const out = ctx.controls.messageOrder === "desc" ? [...page].reverse() : page;
      return json({
        items: out.map(clone),
        hasMore,
        oldestCursor: page.length ? encCursor({ k: "m", s: Number(page[0]!.sortKey) }) : null,
        newestCursor: page.length ? encCursor({ k: "m", s: Number(page[page.length - 1]!.sortKey) }) : null,
      });
    }

    case "POST /v1/chats/{chatID}/messages": {
      const c = chat();
      onlyKeys(body, ["text", "replyToMessageID", "attachment"]);
      if (body.text !== undefined && typeof body.text !== "string") throw bad("text must be a string");
      if (body.attachment !== undefined) throw new HttpError(404, "NOT_FOUND", "Upload not found");
      if (!body.text) throw bad("text or attachment is required");
      if (body.replyToMessageID !== undefined) {
        if (typeof body.replyToMessageID !== "string") throw bad("replyToMessageID must be a string");
        if (!state.messagesOf(c.id).some((m) => m.id === body.replyToMessageID)) throw notFound("Message");
      }
      if (c.isReadOnly) throw new HttpError(403, "FORBIDDEN", "Cannot send messages in this chat");
      const msg = state.sendOwn(c, body.text as string, body.replyToMessageID as string | undefined, ctx.controls.settleMs);
      return json({ chatID: c.id, pendingMessageID: msg.id });
    }

    case "GET /v1/chats/{chatID}/messages/{messageID}":
      chat();
      return json(clone(message()));

    case "POST /v1/chats/{chatID}/messages/{messageID}/reactions": {
      const c = chat();
      const m = message();
      onlyKeys(body, ["reactionKey", "transactionID"]);
      if (typeof body.reactionKey !== "string" || body.reactionKey.length < 1) throw bad("reactionKey is required");
      if (body.transactionID !== undefined && typeof body.transactionID !== "string") throw bad("transactionID must be a string");
      const self = c.participants.items.find((p) => p.isSelf)?.id ?? "@self";
      m.reactions = [...(m.reactions ?? []), { id: `rx_${Date.now()}`, reactionKey: body.reactionKey, participantID: self, emoji: true }];
      state.emitMessage(m);
      return json({ success: true, chatID: c.id, messageID: m.id, reactionKey: body.reactionKey, transactionID: (body.transactionID as string) ?? `txn_${Date.now()}` });
    }

    case "DELETE /v1/chats/{chatID}/messages/{messageID}/reactions/{reactionKey}": {
      const c = chat();
      const m = message();
      const self = c.participants.items.find((p) => p.isSelf)?.id ?? "@self";
      const before = m.reactions?.length ?? 0;
      m.reactions = (m.reactions ?? []).filter((x) => !(x.reactionKey === r.params.reactionKey && x.participantID === self));
      if (m.reactions.length === before) throw notFound("Reaction");
      state.emitMessage(m);
      return json({ success: true, chatID: c.id, messageID: m.id, reactionKey: r.params.reactionKey });
    }

    case "GET /v1/messages/search": {
      const limit = qInt(q, "limit", 20, 1, 20);
      const dir = direction(q);
      const cursor = decCursor(q.get("cursor"), "s");
      const query = q.get("query") ?? "";
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const chatIDs = qList(q, "chatIDs");
      const accountIDs = qList(q, "accountIDs");
      const chatType = qEnum(q, "chatType", ["group", "single"] as const);
      const mediaTypes = qList(q, "mediaTypes");
      const sender = q.get("sender");
      const dateAfter = qDate(q, "dateAfter");
      const dateBefore = qDate(q, "dateBefore");
      const excludeLowPriority = qBool(q, "excludeLowPriority", true);
      const includeMuted = qBool(q, "includeMuted", true);
      for (const t of mediaTypes ?? []) if (!["any", "video", "image", "link", "file"].includes(t)) throw bad("invalid mediaTypes");
      const hits: BMessage[] = [];
      for (const c of state.chatList()) {
        if (chatIDs && !chatIDs.includes(c.id) && !chatIDs.includes(c.localChatID ?? "")) continue;
        if (accountIDs && !accountIDs.includes(c.accountID)) continue;
        if (chatType && c.type !== chatType) continue;
        if (excludeLowPriority && c.isLowPriority) continue;
        if (includeMuted === false && c.isMuted) continue;
        for (const m of state.messagesOf(c.id)) {
          if (m.isDeleted) continue;
          const text = (m.text ?? "").toLowerCase();
          if (words.length && !words.every((w) => text.includes(w))) continue;
          if (sender === "me" && !m.isSender) continue;
          if (sender === "others" && m.isSender) continue;
          if (sender && sender !== "me" && sender !== "others" && m.senderID !== sender) continue;
          const t = Date.parse(m.timestamp);
          if (dateAfter !== null && !(t > dateAfter)) continue;
          if (dateBefore !== null && !(t < dateBefore)) continue;
          if (mediaTypes) {
            const kinds = new Set<string>((m.attachments ?? []).map((a) => (a.type === "img" ? "image" : a.type === "video" ? "video" : "file")));
            if (/https?:\/\//.test(m.text ?? "")) kinds.add("link");
            if (!mediaTypes.some((k) => (k === "any" ? kinds.size > 0 : kinds.has(k)))) continue;
          }
          hits.push(m);
        }
      }
      const key = (m: BMessage) => ({ t: Date.parse(m.timestamp), id: `${m.chatID}\u0000${m.id}` });
      hits.sort((a, b) => chatCmp(key(a), key(b)));
      const { page, hasMore } = pageByCursor(hits, key, cursor, dir, limit);
      const chats: Record<string, BChat> = {};
      for (const m of page) chats[m.chatID] = chatOut(state.chats.get(m.chatID)!);
      const enc = (m: BMessage) => encCursor({ k: "s", ...key(m) });
      return json({
        items: page.map(clone),
        chats,
        hasMore,
        oldestCursor: page.length ? enc(page[page.length - 1]!) : null,
        newestCursor: page.length ? enc(page[0]!) : null,
      });
    }

    case "GET /v1/assets/serve": {
      const raw = q.get("url");
      if (!raw) throw bad("url is required");
      // Only fixture assets exist: the fake never reads the real filesystem.
      let asset = state.assets.get(raw);
      if (!asset && raw.startsWith("file://")) {
        try {
          const norm = decodeURI(raw);
          asset = [...state.assets.values()].find((a) => a.url.startsWith("file://") && decodeURI(a.url) === norm);
        } catch {}
      }
      if (!asset) throw notFound("Asset");
      const size = asset.size;
      const headers: Record<string, string> = { "content-type": asset.mimeType, "accept-ranges": "bytes", "x-beeper-desktop-version": FAKE_BEEPER_VERSION };
      const range = req.headers.get("range");
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        let start = m && m[1] !== "" ? Number(m[1]) : NaN;
        let end = m && m[2] !== "" ? Number(m[2]) : NaN;
        if (m && m[1] === "" && m[2] !== "") {
          start = Math.max(0, size - Number(m[2]));
          end = size - 1;
        } else if (m && Number.isNaN(end)) end = size - 1;
        if (!m || Number.isNaN(start) || start >= size || start > end) {
          return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
        }
        end = Math.min(end, size - 1);
        const slice = asset.bytes().subarray(start, end + 1);
        return new Response(slice as Uint8Array<ArrayBuffer>, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(slice.length) } });
      }
      return new Response(asset.bytes() as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...headers, "content-length": String(size) } });
    }
  }
  throw notFound("Route");
}

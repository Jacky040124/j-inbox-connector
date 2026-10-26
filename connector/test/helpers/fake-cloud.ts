// A minimal fake of the J-Inbox cloud for connector tests: /connect (WebSocket, device-token auth,
// welcome, req/res/chunk/ack/cancel) and /pair/start + /pair/poll. Speaks only the protocol.
import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_VERSION, parseConnectorFrame, type ChunkFrame, type ConnectorFrame, type ResFrame, type WelcomeFrame } from "@j-inbox/protocol";

type WSData = { n: number; auth: string };
export type Reply = { res: ResFrame; chunks: ChunkFrame[] };

export type FakeCloudOptions = {
  token?: string;
  welcome?: Partial<WelcomeFrame>;
  /** Send welcome when hello arrives (default true). */
  autoWelcome?: boolean;
  /** Ack each chunk as it arrives (default true). */
  autoAck?: boolean;
};

export async function startFakeCloud(o: FakeCloudOptions = {}) {
  const tokens = new Set([o.token ?? "jid_" + "A".repeat(43)]);
  const sockets: ServerWebSocket<WSData>[] = [];
  const frames: { n: number; frame: ConnectorFrame }[] = [];
  const raw: string[] = [];
  const bad: string[] = [];
  const waiting = new Map<string, { resolve: (r: Reply) => void; res?: ResFrame; chunks: ChunkFrame[] }>();
  let conn = 0;
  let reqSeq = 0;
  const closeCodes: number[] = [];
  const upgrades: { auth: string | null; origin: string | null }[] = [];
  const state = { autoWelcome: o.autoWelcome !== false, autoAck: o.autoAck !== false, rejectUpgrades: 0, welcome: o.welcome ?? {}, silent: false, closeOnOpen: null as number | null };

  // pairing
  const pair = {
    starts: [] as unknown[],
    polls: [] as unknown[],
    startResponse: null as null | { status: number; body: unknown },
    pollQueue: [] as { status: number; body: unknown }[],
    revokes: [] as { auth: string | null }[],
  };

  const welcome = (): WelcomeFrame => ({ type: "welcome", v: PROTOCOL_VERSION, serverTime: new Date().toISOString(), heartbeatMs: 25_000, requestTimeoutMs: 15_000, maxFrameBytes: 1_000_000, ...state.welcome });

  let server: Server<WSData>;
  const handleFrame = (ws: ServerWebSocket<WSData>, text: string) => {
    raw.push(text);
    const r = parseConnectorFrame(text);
    if (!r.ok) {
      bad.push(text.slice(0, 200));
      return;
    }
    const f = r.value;
    frames.push({ n: ws.data.n, frame: f });
    if (state.silent) return;
    if (f.type === "hello" && state.autoWelcome) ws.send(JSON.stringify(welcome()));
    else if (f.type === "ping") ws.send(JSON.stringify({ type: "pong", t: f.t }));
    else if (f.type === "res") {
      const w = waiting.get(f.id);
      if (!w) return;
      w.res = f;
      const media = f.ok && typeof (f.data as any)?.mimeType === "string" && "size" in (f.data as any);
      if (!media) {
        waiting.delete(f.id);
        w.resolve({ res: f, chunks: [] });
      }
    } else if (f.type === "chunk") {
      const w = waiting.get(f.id);
      if (state.autoAck) ws.send(JSON.stringify({ type: "ack", id: f.id, seq: f.seq }));
      if (!w) return;
      w.chunks.push(f);
      if (f.last) {
        waiting.delete(f.id);
        w.resolve({ res: w.res!, chunks: w.chunks });
      }
    }
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  server = Bun.serve<WSData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/connect") {
        const auth = req.headers.get("authorization");
        upgrades.push({ auth, origin: req.headers.get("origin") });
        if (state.rejectUpgrades > 0) {
          state.rejectUpgrades--;
          return new Response("nope", { status: 503 });
        }
        const m = /^Bearer (\S+)$/.exec(auth ?? "");
        if (!m || !tokens.has(m[1]!)) return new Response("unauthenticated", { status: 401 });
        if (srv.upgrade(req, { data: { n: ++conn, auth: m[1]! } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/pair/start" && req.method === "POST") {
        pair.starts.push(await req.json().catch(() => null));
        const r = pair.startResponse ?? { status: 500, body: { error: "no start response configured" } };
        return json(r.status, r.body);
      }
      if (url.pathname === "/pair/poll" && req.method === "POST") {
        pair.polls.push(await req.json().catch(() => null));
        const r = pair.pollQueue.length > 1 ? pair.pollQueue.shift()! : (pair.pollQueue[0] ?? { status: 200, body: { status: "pending" } });
        return json(r.status, r.body);
      }
      if (url.pathname === "/pair/revoke" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        pair.revokes.push({ auth });
        const m = /^Bearer (\S+)$/.exec(auth ?? "");
        if (!m || !tokens.has(m[1]!)) return json(401, { ok: false, error: { code: "UNAUTHENTICATED", message: "Unknown device token." } });
        tokens.delete(m[1]!);
        for (const s of [...sockets]) if (s.data.auth === m[1]) s.close(4403, "revoked");
        return json(200, { revoked: true });
      }
      if (url.pathname === "/.well-known/raft-agent-manifest.json") return json(200, { schemaVersion: "raft-agent-manifest.v0", actions: [] });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 2 * 1024 * 1024,
      open(ws) {
        sockets.push(ws);
        // Like the real cloud for a token it rejects: accept the upgrade, then close with a code.
        if (state.closeOnOpen !== null) ws.close(state.closeOnOpen, "closed on open");
      },
      message(ws, m) {
        handleFrame(ws, typeof m === "string" ? m : new TextDecoder().decode(m));
      },
      close(ws, code) {
        closeCodes.push(code);
        const i = sockets.indexOf(ws);
        if (i >= 0) sockets.splice(i, 1);
      },
    },
  });

  const current = () => sockets[sockets.length - 1];

  async function waitFor<T>(fn: () => T | undefined | false | null, ms = 3000, what = "condition"): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
      await Bun.sleep(5);
    }
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    tokens,
    state,
    pair,
    frames,
    raw,
    bad,
    upgrades,
    closeCodes,
    get connections() {
      return conn;
    },
    get open() {
      return sockets.length;
    },
    waitFor,
    hello: (n?: number) => frames.find((f) => f.frame.type === "hello" && (n === undefined || f.n === n))?.frame,
    events: () => frames.filter((f) => f.frame.type === "event").map((f) => f.frame),
    /** Send a req on the newest socket and resolve with its res (+ chunks for media). */
    req(action: string, params: unknown = {}, opts: { id?: string; timeoutMs?: number } = {}): Promise<Reply> {
      const id = opts.id ?? `r${++reqSeq}`;
      const p = new Promise<Reply>((resolve, reject) => {
        waiting.set(id, { resolve, chunks: [] });
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error(`no answer for ${id} (${action})`));
        }, opts.timeoutMs ?? 5000);
      });
      current()!.send(JSON.stringify({ type: "req", id, action, params }));
      return p;
    },
    sendRaw(text: string | Uint8Array) {
      current()!.send(text as any);
    },
    send(frame: unknown) {
      current()!.send(JSON.stringify(frame));
    },
    welcomeNow() {
      current()!.send(JSON.stringify(welcome()));
    },
    close(code = 1000, reason = "") {
      for (const s of [...sockets]) s.close(code, reason);
    },
    terminate() {
      for (const s of [...sockets]) s.terminate();
    },
    stop() {
      for (const s of [...sockets]) s.terminate();
      server.stop(true);
    },
  };
}
export type FakeCloud = Awaited<ReturnType<typeof startFakeCloud>>;

// The inbox kept for sync ("sync.v1", sync.ts, task #57): inbox.db (db.ts), what keeps it true
// (ingest.ts), its first build (build.ts), sync_pull's answers (pull.ts) and the `sync` frames
// (push.ts), put together for the service and the dispatcher. The owner's computer is the only
// truth about the inbox: the pages keep a replica of this.
//   - ready(): inbox.db is open and its first build has started. Only then does the hello say
//     "sync.v1" (the cloud sends sync_pull only then, and the pages use the replica only then).
//   - Every hour the chats time took out of the window (archived, and older than SYNC_WINDOW_DAYS)
//     are removed.
//   - The owner's actions (dispatcher.ts): `begin` holds a chat's reads while an action on it runs,
//     then reads it with the request's opId; `caused` covers what is not one chat's (a new email's
//     thread, a removed account's chats).
import type { ActionResult, ConnectorActionName, EventFrame, SyncChange, SyncFrame, SyncPullParams } from "@j-inbox/protocol";
import type { RequestContext } from "../actions.ts";
import { InboxDB } from "./db.ts";
import { FirstBuild, type FirstBuildOptions } from "./build.ts";
import { InboxIngest, type ReadChat } from "./ingest.ts";
import { syncPull, type PullOutcome } from "./pull.ts";
import { SyncPusher } from "./push.ts";

export { InboxDB, type SyncIntent } from "./db.ts";
export { InboxIngest } from "./ingest.ts";
export { FirstBuild } from "./build.ts";
export { syncPull } from "./pull.ts";
export { SyncPusher, syncFrames } from "./push.ts";

/** What the dispatcher asks of the inbox (dispatcher.ts). */
export type SyncHooks = {
  pull(p: SyncPullParams): PullOutcome;
  begin(chatID: string, opId?: string): (ok: boolean) => Promise<void>;
  caused(action: ConnectorActionName, params: Record<string, unknown>, data: unknown, opId?: string): Promise<void>;
};

export type InboxOptions = {
  /** paths.inboxFile, or ":memory:" (no key, tests). */
  path: string;
  /** Seals inbox.db's JSON (the Keychain's `inbox-key`). */
  key?: Uint8Array | null;
  /** read_chat as the dispatcher answers it, late-bound (the dispatcher is made with these hooks). */
  read: ReadChat;
  beeperPage?: FirstBuildOptions["beeperPage"];
  gmail?: FirstBuildOptions["gmail"];
  /** Send a `sync` frame on the cloud link (CloudLink.sendSync). */
  send: (f: SyncFrame) => boolean;
  connected: () => boolean;
  /** Asset URLs a sync_pull answer carries (AssetAllowlist.add). */
  allow?: (url: string) => void;
  /** The connector is answering requests (the build waits). */
  busy?: () => boolean;
  now?: () => number;
  keep?: number;
  paceMs?: number;
  coalesceMs?: number;
  buildCoalesceMs?: number;
  sweepMs?: number;
  log?: (msg: string) => void;
};

export type Inbox = SyncHooks & {
  db: InboxDB;
  ingest: InboxIngest;
  build: FirstBuild;
  pusher: SyncPusher;
  ready(): boolean;
  onEvent(f: EventFrame): void;
  /** Take out the chats time took out of the window. */
  sweep(): number;
  stop(): void;
};

/** Open inbox.db and put the parts together. Throws when inbox.db cannot be opened (the service then goes without sync). */
export function openInbox(o: InboxOptions): Inbox {
  let pusher: SyncPusher | null = null;
  const db = InboxDB.open({ path: o.path, key: o.key, now: o.now, keep: o.keep, log: o.log, onChanges: (c: SyncChange[], background: boolean) => pusher?.push(c, background) });
  if (db.created) o.log?.("inbox: a new inbox.db (a new epoch)");
  pusher = new SyncPusher({ epoch: db.epoch, send: o.send, connected: o.connected, coalesceMs: o.coalesceMs, buildCoalesceMs: o.buildCoalesceMs });
  const ingest = new InboxIngest({ db, read: o.read, now: o.now, log: o.log });
  const build = new FirstBuild({ db, ingest, beeperPage: o.beeperPage, gmail: o.gmail, paceMs: o.paceMs, busy: o.busy, now: o.now, log: o.log });
  const sweep = () => {
    if (!db.isOpen) return 0;
    const out = db.outOfWindow();
    for (const id of out) ingest.removeChat(id);
    return out.length;
  };
  const sweeper = setInterval(sweep, o.sweepMs ?? 3600_000);
  return {
    db,
    ingest,
    build,
    pusher,
    ready: () => db.isOpen && build.started,
    onEvent: (f) => ingest.onEvent(f),
    sweep,
    pull: (p) => syncPull(db, p, { allow: o.allow }),
    begin: (chatID, opId) => ingest.begin(chatID, opId),
    async caused(action, params, data, opId) {
      const d = data as Record<string, any>;
      if (action === "compose_email" && typeof d?.chatID === "string") return ingest.refresh(d.chatID, opId ? { opId } : {});
      if (action === "remove_account") {
        const ids = Array.isArray(d?.affectedAccountIDs) && d.affectedAccountIDs.length ? d.affectedAccountIDs : [params.accountID];
        ingest.removeAccounts(ids.filter((x: unknown): x is string => typeof x === "string"), opId);
        for (const id of ids) if (typeof id === "string" && id.startsWith("gmail:")) build.forgetAccount(id.slice(6));
        return;
      }
      if (action === "gmail_connect") build.kick();
    },
    stop() {
      clearInterval(sweeper);
      build.stop();
      ingest.stop();
      pusher?.stop();
      db.close();
    },
  };
}

/** read_chat for the inbox: the dispatcher's own answer (decorated, checked), with the newest SYNC_MESSAGES_PER_CHAT messages. */
export type DispatchRead = (action: "read_chat", params: { chatID: string; limit: number }, ctx: RequestContext) => Promise<{ kind: string; ok?: boolean; data?: unknown; error?: unknown }>;
export function readThrough(dispatch: DispatchRead, limit: number): ReadChat {
  return async (chatID, ctx) => {
    const r = await dispatch("read_chat", { chatID, limit }, ctx);
    if (r.kind !== "res") return { ok: false, error: { code: "INTERNAL", message: "unexpected answer" } };
    return r.ok ? { ok: true, data: r.data as ActionResult<"read_chat"> } : { ok: false, error: r.error as never };
  };
}

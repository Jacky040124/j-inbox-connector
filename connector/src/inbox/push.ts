// The `sync` frames (sync.ts): inbox.db's new changes to the cloud as they happen, which relays
// each to every open page. Changes wait at most COALESCE_MS for the ones right behind them (a read
// makes a chat change and a messages change together), then go in seq order, at most
// MAX_SYNC_CHANGES a frame and every frame under MAX_FRAME_BYTES.
//   - The first build's changes (background) wait up to BUILD_COALESCE_MS: it reads a chat every
//     paceMs for as long as it takes, and a frame a read is about the cloud's whole budget
//     (DEVICE_SYNC_FRAMES_PER_MINUTE, 600, in cloud/src/ratelimit.ts), past which it drops frames and
//     every page pulls. So a build goes out about once a second, in fuller frames; and at once when
//     MAX_SYNC_CHANGES wait (a frame is full). Any other change brings the wait down to COALESCE_MS
//     for everything waiting (they go in seq order, together): a new message is never held for the build.
// Nothing is kept for later: while the cloud link is down (or refuses a frame) the changes are
// dropped, and the pages catch up with sync_pull from their cursor, which a seq gap tells them to
// do. So they are never put in the EventBuffer, which is for the metadata events.
import { MAX_SYNC_CHANGES, type SyncChange, type SyncFrame } from "@j-inbox/protocol";
import { FRAME_BUDGET_BYTES, jsonBytes } from "./window.ts";

export const COALESCE_MS = 50;
/** How long the first build's changes wait for the ones behind them. */
export const BUILD_COALESCE_MS = 1000;

/** Changes as frames: in order, at most MAX_SYNC_CHANGES each, under `budget` bytes (a change alone always fits: window.ts). */
export function syncFrames(epoch: string, changes: readonly SyncChange[], budget = FRAME_BUDGET_BYTES): SyncFrame[] {
  const frames: SyncFrame[] = [];
  let cur: SyncChange[] = [];
  let bytes = 0;
  for (const c of changes) {
    const b = jsonBytes(c) + 1;
    if (cur.length && (cur.length >= MAX_SYNC_CHANGES || bytes + b > budget)) {
      frames.push({ type: "sync", epoch, changes: cur });
      cur = [];
      bytes = 0;
    }
    cur.push(c);
    bytes += b;
  }
  if (cur.length) frames.push({ type: "sync", epoch, changes: cur });
  return frames;
}

export type SyncPusherOptions = {
  epoch: string;
  /** Send one frame on the cloud link: false when it did not go (not connected, too much waiting to go out). */
  send: (f: SyncFrame) => boolean;
  /** The cloud link is connected (welcome seen). */
  connected: () => boolean;
  coalesceMs?: number;
  buildCoalesceMs?: number;
  budgetBytes?: number;
};

export class SyncPusher {
  private pending: SyncChange[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** When the timer fires (ms). */
  private due = 0;
  /** Frames sent and changes dropped (link down or a frame refused), for tests and logs. */
  sent = 0;
  dropped = 0;

  constructor(private readonly o: SyncPusherOptions) {}

  /** New changes; `background`: the first build's (they may wait longer for the ones behind them). */
  push(changes: readonly SyncChange[], background = false) {
    if (!changes.length) return;
    if (!this.o.connected()) {
      // Nobody can hear them now; whoever opens a page later pulls from its cursor.
      this.dropped += changes.length + this.pending.length;
      this.pending = [];
      return;
    }
    this.pending.push(...changes);
    // A full frame waits for nothing.
    if (this.pending.length >= MAX_SYNC_CHANGES) return this.flush();
    const wait = background ? (this.o.buildCoalesceMs ?? BUILD_COALESCE_MS) : (this.o.coalesceMs ?? COALESCE_MS);
    const due = Date.now() + wait;
    if (this.timer !== undefined && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Send what waits now. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const changes = this.pending;
    this.pending = [];
    if (!changes.length) return;
    const frames = syncFrames(this.o.epoch, changes, this.o.budgetBytes);
    for (let i = 0; i < frames.length; i++) {
      if (this.o.connected() && this.o.send(frames[i]!)) {
        this.sent++;
        continue;
      }
      // The rest would come after a gap anyway: the pages pull.
      for (const f of frames.slice(i)) this.dropped += f.changes.length;
      return;
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}

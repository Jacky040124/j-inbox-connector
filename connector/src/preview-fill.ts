// A chat's latest-message line when Beeper's chat list says only who and when. Real LinkedIn,
// Instagram, X and WhatsApp chats (2026-11-06, about one in four) have a `preview` with no type,
// text or attachments when their newest event is a reaction (an event of its own, which history
// leaves out), a photo or an unsent message. The chat's newest history page says what it was: the
// same message (a photo, a deleted one) or, when it is not there, the newest message its sender
// reacted to. The answer, found or not, is kept per chat and preview id: the next list asks nothing.
import type { ChatSummary, MessageItem } from "@j-inbox/protocol";
import { mapMessage, type MapOptions } from "./beeper-map.ts";

type Raw = Record<string, any>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** A preview that says only who and when: the list could only call it "Message". */
export function isBarePreview(p: MessageItem | null | undefined): p is MessageItem {
  return !!p && p.type === "UNKNOWN" && !p.text?.trim() && !p.attachments?.length && p.isDeleted !== true && !p.sharedPost;
}

/** Beeper sortKeys are numeric strings of any length: compare by length, then lexically. */
const sortKeyCmp = (x: string, y: string) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);

/** The list named the sender with the chat's people, which a history entry alone does not have. */
const asListed = (found: MessageItem, preview: MessageItem): MessageItem => ({
  ...found,
  isSender: found.isSender || preview.isSender,
  ...(preview.senderName && !found.senderName ? { senderName: preview.senderName } : {}),
});

/**
 * What a bare preview was, from the chat's newest raw history entries (any order), or null when
 * they do not say. The same message when history has it with something to show; when history has
 * it not at all or only hidden, a reaction: the newest earlier message carrying a reaction from the
 * preview's sender (Beeper gives reactions no time of their own) becomes a REACTION with that key as
 * text and the message as the one it is for.
 */
export function previewFromHistory(preview: MessageItem, history: readonly unknown[], opts: MapOptions = {}): MessageItem | null {
  const raws = history.filter(isObj);
  const same = raws.find((m) => String(m.id) === preview.id);
  const found = same ? mapMessage(same, { ...opts, keepHidden: true }) : null;
  if (found && !isBarePreview(found)) return asListed(found, preview);
  // Visible there with nothing to show (a call, a poll): it was not a reaction, which history hides.
  if (same && same.isHidden !== true) return null;
  const older = raws
    .filter((m) => m.isHidden !== true && typeof m.sortKey === "string" && sortKeyCmp(m.sortKey, preview.sortKey) < 0)
    .sort((a, b) => sortKeyCmp(b.sortKey, a.sortKey));
  for (const raw of older) {
    const target = mapMessage(raw, { selfIDs: opts.selfIDs });
    if (!target || target.type === "REACTION") continue;
    // The owner's reactions are marked by their known IDs (isSelf); someone else's by their own.
    const r = target.reactions?.find((x) => (preview.isSender ? x.isSelf === true || x.participantID === preview.senderID : x.participantID === preview.senderID && x.isSelf !== true));
    if (r) return { ...preview, type: "REACTION", text: r.reactionKey, replyToMessageID: target.id };
  }
  return null;
}

type Found = { value: MessageItem | null; urls: string[] };

export type PreviewFillerOptions = {
  /** The chat's newest raw history entries, or null when Beeper could not say (nothing is remembered then). */
  history: (chatID: string, signal?: AbortSignal) => Promise<unknown[] | null>;
  /** The owner's user IDs seen so far: the owner's reactions in history. */
  selfIDs?: ReadonlySet<string>;
  /** The owner's numbers and emails seen so far (selfAddressesIn): the owner's messages signed with one. */
  selfAddresses?: ReadonlySet<string>;
  /** Names seen for user IDs in other chats and messages: a sender history leaves unnamed. */
  names?: ReadonlyMap<string, string>;
  /** How long a list waits for the answers (default 1.5 s); the ones still out are kept for the next list. */
  waitMs?: number;
  /** History reads at once (default 6). */
  concurrency?: number;
  /** Answers kept (default 2000, oldest out first). */
  max?: number;
};

/** Fills bare previews of mapped list rows in place (rows built for this one result only). */
export function createPreviewFiller(o: PreviewFillerOptions) {
  const known = new Map<string, Found>();
  const pending = new Map<string, Promise<Found | null>>();
  const queue: (() => void)[] = [];
  let running = 0;
  const concurrency = Math.max(1, o.concurrency ?? 6);
  const max = Math.max(1, o.max ?? 2000);

  const slot = () => (running < concurrency ? (running++, Promise.resolve()) : new Promise<void>((resolve) => queue.push(() => (running++, resolve()))));
  const done = () => {
    running--;
    queue.shift()?.();
  };

  function look(key: string, chatID: string, preview: MessageItem, signal?: AbortSignal): Promise<Found | null> {
    const have = pending.get(key);
    if (have) return have;
    const p = (async (): Promise<Found | null> => {
      await slot();
      try {
        if (signal?.aborted) return null;
        const history = await o.history(chatID, signal);
        if (!history) return null;
        const urls: string[] = [];
        const f: Found = { value: previewFromHistory(preview, history, { selfIDs: o.selfIDs, selfAddresses: o.selfAddresses, names: o.names, onAsset: (u) => urls.push(u) }), urls };
        known.set(key, f);
        while (known.size > max) known.delete(known.keys().next().value!);
        return f;
      } catch {
        return null;
      } finally {
        done();
        pending.delete(key);
      }
    })();
    pending.set(key, p);
    return p;
  }

  return {
    async fill(rows: readonly { value: ChatSummary; urls: string[] }[], ctx: { signal?: AbortSignal; deadline?: number } = {}): Promise<void> {
      // An answer that comes after the wait is only remembered: the rows may be on their way already.
      let open = true;
      const apply = (row: { value: ChatSummary; urls: string[] }, f: Found | null | undefined) => {
        if (!open || !f?.value) return;
        // A copy: the remembered answer serves later lists too.
        row.value.preview = { ...f.value };
        row.urls.push(...f.urls);
      };
      const waits: Promise<void>[] = [];
      for (const row of rows) {
        const p = row.value.preview;
        if (!isBarePreview(p)) continue;
        const key = `${row.value.id}\u0000${p.id}`;
        if (known.has(key)) apply(row, known.get(key));
        else waits.push(look(key, row.value.id, p, ctx.signal).then((f) => apply(row, f)));
      }
      if (!waits.length) return;
      // Within the request's time: what has not come by then is left as it is.
      const wait = Math.min(o.waitMs ?? 1500, ctx.deadline !== undefined ? Math.max(0, ctx.deadline - Date.now() - 500) : Number.POSITIVE_INFINITY);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(waits), new Promise<void>((resolve) => (timer = setTimeout(resolve, wait)))]);
      clearTimeout(timer);
      open = false;
    },
  };
}

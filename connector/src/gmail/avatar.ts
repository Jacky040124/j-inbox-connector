// Email sender pictures (gmail://<account>/avatar/<sender>): Gmail's API has none, so the
// connector looks for one the way mail apps do, from public sources only:
//   1. Gravatar (the sender's own picture, by SHA-256 of the address; 404 when they have none)
//   2. for company addresses: the company's icon (Google's favicon service at 128 px; the site's
//      apple-touch-icon when that is small), never for free-mail domains (every Gmail sender
//      would get the Gmail logo).
// Nothing is sent with a request but the URL (no cookies, no tokens). Answers are image bytes only
// (sniffed PNG/JPEG/GIF/WebP, at most MAX_AVATAR_BYTES), cached in memory, misses too.
import { sniffImageType } from "../media.ts";

export const MAX_AVATAR_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;
const HIT_TTL_MS = 24 * 3600_000;
const MISS_TTL_MS = 6 * 3600_000;
const CACHE_MAX = 1000;

/** Personal-mail domains: a company logo would be wrong there. */
export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.ca", "yahoo.co.uk", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "mail.com", "zoho.com",
  "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "sina.com", "foxmail.com", "naver.com", "hey.com", "fastmail.com", "tutanota.com",
]);
const SECOND_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "or.jp", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.br", "co.in", "co.kr", "co.za", "com.mx"]);

/** news.mail.lyft.com -> lyft.com; shop.example.co.uk -> example.co.uk. */
export function baseDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return SECOND_LEVEL.has(last2) ? labels.slice(-3).join(".") : last2;
}

/** Width of a PNG (from IHDR), or null for other formats. */
function pngWidth(b: Uint8Array): number | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  return ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0;
}

export type AvatarImage = { mimeType: string; bytes: Uint8Array };
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function createAvatarResolver(o: { fetch?: FetchFn; now?: () => number } = {}) {
  const fetchFn: FetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; img: AvatarImage | null }>();
  const inflight = new Map<string, Promise<AvatarImage | null>>();

  /** An image from `url`, or null (not 200, not an image, too big, too slow, too small). */
  async function image(url: string, minWidth = 0, signal?: AbortSignal): Promise<AvatarImage | null> {
    try {
      const ctl = AbortSignal.timeout(TIMEOUT_MS);
      const res = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, ctl]) : ctl, credentials: "omit", redirect: "follow", headers: { accept: "image/*" } });
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > MAX_AVATAR_BYTES) {
        await res.body.cancel().catch(() => {});
        return null;
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_AVATAR_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        parts.push(value);
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const p of parts) bytes.set(p, off), (off += p.byteLength);
      const mimeType = sniffImageType(bytes);
      if (!mimeType) return null;
      const w = pngWidth(bytes);
      if (minWidth && w !== null && w < minWidth) return null;
      return { mimeType, bytes };
    } catch {
      return null;
    }
  }

  async function lookUp(address: string, signal?: AbortSignal): Promise<AvatarImage | null> {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const gravatar = await image(`https://gravatar.com/avatar/${await sha256Hex(address)}?s=128&d=404`, 0, signal);
    if (gravatar) return gravatar;
    if (FREEMAIL.has(domain) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
    const base = baseDomain(domain);
    const s2 = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(base)}&sz=128`;
    return (await image(s2, 64, signal)) ?? (await image(`https://${base}/apple-touch-icon.png`, 64, signal)) ?? (await image(s2, 32, signal));
  }

  /** The picture for a sender address (lower-cased), cached; null when there is none. */
  async function resolve(sender: string, signal?: AbortSignal): Promise<AvatarImage | null> {
    const address = sender.trim().toLowerCase();
    const hit = cache.get(address);
    if (hit && now() - hit.at < (hit.img ? HIT_TTL_MS : MISS_TTL_MS)) return hit.img;
    const running = inflight.get(address);
    if (running) return running;
    const p = lookUp(address, signal).then((img) => {
      // A cancelled request found nothing because it stopped: not a miss.
      if (signal?.aborted && !img) return img;
      cache.set(address, { at: now(), img });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return img;
    });
    inflight.set(address, p);
    try {
      return await p;
    } finally {
      inflight.delete(address);
    }
  }

  return { resolve };
}

export type AvatarResolver = ReturnType<typeof createAvatarResolver>;

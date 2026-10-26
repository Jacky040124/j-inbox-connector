// Sender pictures (src/gmail/avatar.ts) against a fake fetch: which sources, in which order, what
// counts as a picture, caching. No network.
import { describe, expect, test } from "bun:test";
import { gmailAvatarURL, parseGmailAvatarURL, assetUrl, parse } from "@j-inbox/protocol";
import { MAX_AVATAR_BYTES, baseDomain, createAvatarResolver } from "../src/gmail/avatar.ts";

const png = (w: number) => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, w);
  return b;
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fakeWeb(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    for (const [k, f] of Object.entries(routes)) if (url.startsWith(k)) return f();
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}
const img = (b: Uint8Array, type = "image/png") => () => new Response(b as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": type } });

describe("avatar URLs", () => {
  test("round trip, lower-cased, valid get_media URLs; junk refused", () => {
    const u = gmailAvatarURL("owner@example.com", "Priya@Lyft.com");
    expect(parse(assetUrl(), u).ok).toBe(true);
    expect(parseGmailAvatarURL(u)).toEqual({ email: "owner@example.com", sender: "priya@lyft.com" });
    for (const bad of ["gmail://owner%40example.com/avatar/", "gmail://owner%40example.com/avatar/!!!!", "gmail://owner%40example.com/x/" + u.split("/").pop(), "https://x/avatar/abc", 5, null])
      expect(parseGmailAvatarURL(bad)).toBeNull();
    expect(() => gmailAvatarURL("owner@example.com", "not an address")).toThrow();
  });
  test("baseDomain", () => {
    expect(baseDomain("news.mail.lyft.com")).toBe("lyft.com");
    expect(baseDomain("e.costco.ca")).toBe("costco.ca");
    expect(baseDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(baseDomain("lyft.com")).toBe("lyft.com");
  });
});

describe("avatar resolver", () => {
  test("Gravatar first; requests carry no credentials", async () => {
    const w = fakeWeb({ "https://gravatar.com/avatar/": img(jpeg, "image/jpeg") });
    const r = createAvatarResolver({ fetch: w.fetch });
    expect((await r.resolve("Someone@Lyft.com"))?.mimeType).toBe("image/jpeg");
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url).toMatch(/^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=128&d=404$/);
    expect(w.calls[0]!.init.credentials).toBe("omit");
  });
  test("free-mail senders: Gravatar only, never the domain's logo", async () => {
    const w = fakeWeb({ "https://www.google.com/s2/favicons": img(png(128)) });
    const r = createAvatarResolver({ fetch: w.fetch });
    expect(await r.resolve("friend@gmail.com")).toBeNull();
    expect(w.calls.map((c) => c.url).some((u) => u.includes("favicons"))).toBe(false);
  });
  test("company senders: the 128 px icon of the base domain; a tiny one falls back to apple-touch-icon, then to 32 px", async () => {
    const big = fakeWeb({ "https://www.google.com/s2/favicons?domain=lyft.com": img(png(128)) });
    expect(await createAvatarResolver({ fetch: big.fetch }).resolve("no-reply@mail.lyft.com")).not.toBeNull();
    const small = fakeWeb({ "https://www.google.com/s2/favicons": img(png(16)), "https://costco.ca/apple-touch-icon.png": img(png(180)) });
    expect(await createAvatarResolver({ fetch: small.fetch }).resolve("orders@e.costco.ca")).not.toBeNull();
    expect(small.calls.at(-1)!.url).toBe("https://costco.ca/apple-touch-icon.png");
    const mid = fakeWeb({ "https://www.google.com/s2/favicons": img(png(32)) });
    expect(await createAvatarResolver({ fetch: mid.fetch }).resolve("info@cira.ca")).not.toBeNull();
    const tiny = fakeWeb({ "https://www.google.com/s2/favicons": img(png(16)) });
    expect(await createAvatarResolver({ fetch: tiny.fetch }).resolve("info@tiny.example")).toBeNull();
  });
  test("only real images count: an HTML page with status 200, an oversized answer, a failure", async () => {
    const html = fakeWeb({ "https://": () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "image/png" } }) });
    expect(await createAvatarResolver({ fetch: html.fetch }).resolve("a@site.example")).toBeNull();
    const huge = new Uint8Array(MAX_AVATAR_BYTES + 10);
    huge.set(png(128));
    const big = fakeWeb({ "https://": img(huge) });
    expect(await createAvatarResolver({ fetch: big.fetch }).resolve("a@site.example")).toBeNull();
    const boom = { fetch: async () => Promise.reject(new TypeError("offline")) };
    expect(await createAvatarResolver(boom).resolve("a@site.example")).toBeNull();
  });
  test("cached (hits and misses), one lookup for concurrent asks; misses retried after their time", async () => {
    let t = 0;
    const w = fakeWeb({});
    const r = createAvatarResolver({ fetch: w.fetch, now: () => t });
    await Promise.all([r.resolve("x@site.example"), r.resolve("X@site.example")]);
    const n = w.calls.length;
    await r.resolve("x@site.example");
    expect(w.calls.length).toBe(n);
    t += 7 * 3600_000;
    await r.resolve("x@site.example");
    expect(w.calls.length).toBe(2 * n);
  });
  test("a cancelled request is not remembered as 'no picture'", async () => {
    const ctl = new AbortController();
    const w = { calls: 0, fetch: async (_u: string, i: RequestInit) => (w.calls++, i.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : new Response(png(128) as Uint8Array<ArrayBuffer>, { status: 200 })) };
    const r = createAvatarResolver({ fetch: w.fetch });
    ctl.abort();
    expect(await r.resolve("me@company.example", ctl.signal)).toBeNull();
    expect(await r.resolve("me@company.example")).not.toBeNull();
  });
});

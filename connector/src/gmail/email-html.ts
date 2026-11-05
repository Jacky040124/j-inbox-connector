// Lock one of three for HTML email (protocol/src/email-frame.ts has the others): the email's HTML
// made safe on the Mac, before it leaves. An allowlist over Bun's HTMLRewriter (lol-html, a real HTML
// tokenizer): every element not listed goes, every attribute is taken off and only the allowed ones are put
// back, decoded, checked and encoded anew, so the browser reads the value that was checked. Text keeps no
// `<`, so removing something can never join two pieces into a new tag. Then what came out is read again by a
// second pass that mends nothing and only says yes or no; no means no HTML, and the page shows the text. So
// does an email with nothing visible left in it, or nested too deep to lay out. All of it runs off the
// connector's main thread (email-html-worker.ts), and everything here is linear in its input: lengths are capped
// before any pattern looks at them.
// Tracking: 1x1 and hidden images and a small list of tracker domains go. That does not catch everything,
// and there is no image proxy: a sender can still see that a remote image was loaded, from which IP.
import { MAX_EMAIL_CID_IMAGE_BYTES, encodeBase64 } from "@j-inbox/protocol";
import { MAX_STYLE_ATTR_LENGTH, cleanDeclarations, cleanStylesheet, declarationsOf, rawDeclarations, type ImageCheck } from "./email-css.ts";
import { sniffImageType } from "../media.ts";
import { decodeEntities } from "./mime.ts";

/** Elements kept as they are (without their attributes, which come back one by one). */
const KEPT = new Set(
  "a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong style sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr".split(" "),
);
/** Gone with everything inside. The ones whose content browsers and this parser could read differently are all here. */
const REMOVED = new Set(
  "script noscript title textarea xmp listing plaintext iframe frame frameset noframes noembed object embed applet svg math video audio canvas template select option optgroup datalist button input meta link base param source track map area portal slot bgsound isindex keygen command xml".split(" "),
);
// Everything else (html, head, form, label, picture, marquee, o:p, a made-up tag) goes but keeps its content.

const GLOBAL_ATTRS = new Set(["class", "id", "dir", "lang", "title", "align", "valign", "style", "role"]);
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "name"],
  img: ["src", "alt", "width", "height", "border", "hspace", "vspace"],
  table: ["width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "background"],
  tr: ["height", "bgcolor", "background"],
  td: ["width", "height", "colspan", "rowspan", "bgcolor", "background", "nowrap", "scope"],
  th: ["width", "height", "colspan", "rowspan", "bgcolor", "background", "nowrap", "scope"],
  thead: ["bgcolor"],
  tbody: ["bgcolor"],
  tfoot: ["bgcolor"],
  col: ["span", "width"],
  colgroup: ["span", "width"],
  div: ["bgcolor", "background"],
  font: ["color", "face", "size"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  li: ["value", "type"],
  hr: ["size", "noshade", "width", "color"],
  details: ["open"],
  blockquote: ["type"],
  p: [],
};
/** Elements whose end tag is optional: a sloppy email's open ones are no nesting. */
const OPTIONAL_END = new Set("p li td th tr tbody thead tfoot dt dd colgroup caption rp rt".split(" "));
const attrAllowed = (tag: string, name: string) => GLOBAL_ATTRS.has(name) || TAG_ATTRS[tag]?.includes(name) === true;
const NUMBER_ATTRS = new Set(["width", "height", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "span", "size", "start", "value", "hspace", "vspace"]);
const URL_ATTRS = new Set(["href", "src", "background", "style"]);
const MAX_ATTR_LENGTH = 4096;
const MAX_ELEMENTS = 60_000;
/** Nesting past this is no letter: real mail is a dozen tables deep, and each level can double a layout. */
export const MAX_NESTING = 100;
const MAX_ATTRS_PER_ELEMENT = 64;
const MAX_HREF_LENGTH = 16 * 1024;

/** Known open-tracking hosts (and everything under them). Small on purpose: an image from one of these is only ever a beacon. */
export const TRACKER_DOMAINS: readonly string[] = [
  "mailtrack.io", "mailsuite.com", "list-manage.com", "sendgrid.net", "mandrillapp.com", "sparkpostmail.com", "mailgun.org", "mixmax.com", "yesware.com", "bananatag.com", "mailfoogae.appspot.com", "getnotify.com", "superhuman.com",
  "cirrusinsight.com", "hubspotemail.net", "track.hubspot.com", "customer.io", "convertkit-mail.com", "returnpath.net", "emltrk.com", "doubleclick.net", "google-analytics.com", "pixel.wp.com", "tracking.tldrnewsletter.com", "beehiiv-tracking.com",
];

export function isTrackerHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return TRACKER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The encoded form of a checked value: the browser decodes exactly this back. */
const encodeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A value that does nothing but be read (alt, class): its entities stay for the browser, only what could end the attribute changes. */
const encodeRaw = (v: string) => v.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LINK_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:", "sms:", "webcal:"]);
/** A place in this email, which stays in its frame. */
const isAnchor = (v: string) => /^#[\w.:-]{1,128}$/.test(v);

/** The schemes mail uses, as the URL parser reads them (tabs, newlines and odd case included), no user:password@; or a place in this email. */
function cleanLink(v: string): string | null {
  const t = v.trim();
  if (t.length > MAX_HREF_LENGTH) return null;
  if (isAnchor(t)) return t;
  try {
    const u = new URL(t);
    if (u.username || u.password) return null;
    return LINK_SCHEMES.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** An image's source as it may stay: https (http becomes https), not a tracker's; or a data: image of a plain type, written one way. Never SVG. */
const cleanImageUrl: ImageCheck = (v) => {
  const t = v.trim();
  if (/^data:/i.test(t)) {
    if (t.length > (MAX_EMAIL_CID_IMAGE_BYTES * 4) / 3 + 64) return null;
    const m = DATA_IMAGE.exec(t.replace(/\s+/g, ""));
    if (!m) return null;
    const type = m[1]!.toLowerCase();
    return `data:image/${type === "jpg" ? "jpeg" : type};base64,${m[2]}`;
  }
  if (t.length > MAX_HREF_LENGTH) return null;
  try {
    const u = new URL(t);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" && !u.username && !u.password && !isTrackerHost(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
};

function cleanUrlAttr(name: string, v: string): string | null {
  if (name === "href") return cleanLink(v);
  return cleanImageUrl(v);
}

/** A length as a number, or null: short enough to look at and no more than digits. Cleaned values only reach here capped; an attribute may not be. */
function lengthOf(v: string): { n: number; unit: string } | null {
  const t = v.trim();
  if (t.length > 40) return null;
  const m = /^(-?)(\d{0,12}(?:\.\d{0,12})?)(px|pt|em|rem|%)?(?: *!important)?$/.exec(t);
  if (!m || !/\d/.test(m[2]!)) return null;
  return { n: Number(m[1]! + m[2]!), unit: m[3] ?? "" };
}
const isZero = (v: string) => lengthOf(v)?.n === 0;
const isTiny = (v: string) => {
  const l = lengthOf(v);
  return !!l && l.n <= 1 && (l.unit === "" || l.unit === "px" || l.unit === "pt");
};
/** Far off to the top or the left: how a preheader hides. */
const isFarOff = (v: string) => (lengthOf(v)?.n ?? 0) <= -500;

/** As it was written, before those properties went: off the page. Then nothing of it shows, and it is hidden in plain terms. */
function offPage(rawStyle: string): boolean {
  const d = rawDeclarations(rawStyle);
  const placed = d.some(([p, v]) => p === "position" && /^(absolute|fixed)/.test(v));
  return d.some(([p, v]) => (placed && (p === "left" || p === "top" || p === "right" || p === "bottom") && isFarOff(v)) || ((p === "margin-left" || p === "margin-top" || p === "text-indent") && isFarOff(v)));
}

/** A cleaned style that hides what it is on. */
function hides(style: string): boolean {
  return declarationsOf(style).some(([p, v]) => (p === "display" && v.startsWith("none")) || (p === "visibility" && v.startsWith("hidden")) || (p === "opacity" && isZero(v)) || ((p === "max-height" || p === "max-width" || p === "height" || p === "width") && isZero(v)));
}

/** An image no one can see: 1x1 or less by its attributes or its style. */
function tinyImage(attrs: Map<string, string>, style: string): boolean {
  if (isTiny(attrs.get("width") ?? "") || isTiny(attrs.get("height") ?? "")) return true;
  return declarationsOf(style).some(([p, v]) => (p === "width" || p === "height") && (isTiny(v) || isZero(v)));
}

const hasClass = (v: string | undefined, names: readonly string[]) => !!v && v.split(/\s+/).some((c) => names.includes(c));
const QUOTE_CLASSES = ["gmail_quote", "gmail_quote_container", "yahoo_quoted"];

/** Control characters a browser's tokenizer would turn into something else: gone before anyone parses. */
const withoutControls = (html: string) => html.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "");

/**
 * XHTML's <title/>, <style/> and <noscript/>, which mail writers still emit. To an HTML parser, ours and the browser's, the slash means
 * nothing: all the rest of the email would be that element's text. They said empty, so they are nothing here, before anyone parses.
 */
const withoutEmptyRawElements = (html: string) => html.replace(/<(?:title|style|noscript|script|textarea|xmp|iframe|noembed|noframes)(?:\s[^<>]{0,256})?\/>/gi, "");

/** A `cid:` reference's id, as the message's parts are keyed. */
function cidOf(v: string): string | null {
  const t = v.trim();
  if (t.slice(0, 4).toLowerCase() !== "cid:") return null;
  try {
    return decodeURIComponent(t.slice(4));
  } catch {
    return t.slice(4);
  }
}

/** The `cid:` ids the HTML's images name, in order (at most `max`). What the caller then has to fetch. */
export function cidReferences(html: string, max = 32): string[] {
  const out = new Set<string>();
  try {
    new HTMLRewriter()
      .on("img", {
        element(el) {
          const id = cidOf(decodeEntities(el.getAttribute("src") ?? ""));
          if (id && out.size < max) out.add(id);
        },
      })
      .transform(withoutControls(html));
  } catch {}
  return [...out];
}

/** An image part's bytes as a data: URI, by what the bytes are and never what the part says. null: not a picture, or too large. */
export function imageDataUri(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_EMAIL_CID_IMAGE_BYTES) return null;
  const type = sniffImageType(bytes);
  return type ? `data:${type};base64,${encodeBase64(bytes)}` : null;
}

/** One attribute as it may stay, as the decoded value, or null. */
function cleanAttr(tag: string, name: string, decoded: string, images: ImageCheck): string | null {
  if (name === "style") return decoded.length <= MAX_STYLE_ATTR_LENGTH ? cleanDeclarations(decoded, images) || null : null;
  if (name === "href" || name === "src" || name === "background") return cleanUrlAttr(name, decoded);
  if (NUMBER_ATTRS.has(name) && decoded.length > 32) return null;
  return decoded.length <= MAX_ATTR_LENGTH ? decoded : null;
}

type Options = {
  /** The message's own cid: images: id -> data: URI. */
  images?: ReadonlyMap<string, string>;
};

class TooComplex extends Error {}

export type Sanitized = {
  html: string;
  /** What the owner will see, as text: the visible words, in order, with each link's address after its words. */
  text: string;
};

const BLOCKS = new Set("address article aside blockquote caption center dd details div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr main nav ol p pre section table tbody td tfoot th thead tr ul".split(" "));
const MAX_VISIBLE_TEXT = 200_000;

/** One pass of the allowlist over the HTML. */
function clean(html: string, o: Options): Sanitized | null {
  // Read past the email's end, with a tag it cannot know: if that is not seen as a tag, the email ended
  // inside something (a tag, a comment, a raw element), and whatever follows it would be swallowed.
  const end = `jinbox-end-${crypto.randomUUID().replace(/-/g, "")}`;
  let ended = false;
  const images = o.images ?? new Map<string, string>();
  let elements = 0;
  let inStyle = false;
  let dropped = 0;
  let hidden = 0;
  let quotes = 0;
  let seenContent = false;
  let sawPicture = false;
  let depth = 0;
  let visible = "";
  let visibleLength = 0;
  const say = (t: string) => {
    if (dropped || hidden || visibleLength > MAX_VISIBLE_TEXT) return;
    visible += t;
    visibleLength += t.length;
  };
  let css = "";
  /** What to do at this element's end. An element takes one end-tag handler (the last set wins), so they all go in one. */
  let atEnd: (() => void)[] = [];
  const drop = (el: HTMLRewriterTypes.Element) => {
    if (el.canHaveContent) {
      dropped++;
      atEnd.push(() => void dropped--);
    }
    el.remove();
  };
  const visit = (el: HTMLRewriterTypes.Element) => {
        if (++elements > MAX_ELEMENTS) throw new TooComplex();
        const tag = el.tagName.toLowerCase();
        if (tag === end) {
          ended = true;
          el.remove();
          return;
        }
        if (REMOVED.has(tag)) return drop(el);
        const attrCount = [...el.attributes].length;
        if (attrCount > MAX_ATTRS_PER_ELEMENT) throw new TooComplex();
        if (el.canHaveContent && !OPTIONAL_END.has(tag)) {
          // Back to this element's own level when it ends, whatever it left open inside.
          const here = depth++;
          if (depth > MAX_NESTING) throw new TooComplex();
          atEnd.push(() => void (depth = here));
        }
        if (tag === "body") el.tagName = "div";
        else if (!KEPT.has(tag)) {
          stripAttrs(el);
          el.removeAndKeepContent();
          return;
        }
        const attrs = new Map<string, string>();
        for (const [name, raw] of el.attributes) if (!attrs.has(name)) attrs.set(name, raw);
        stripAttrs(el);
        if (tag === "style") {
          inStyle = true;
          css = "";
          atEnd.push(() => void (inStyle = false));
          return;
        }
        const kept = tag === "body" ? "div" : tag;
        const rawStyle = attrs.get("style") ?? "";
        const fullStyle = rawStyle.length <= MAX_STYLE_ATTR_LENGTH ? decodeEntities(rawStyle) : "";
        const gone = offPage(fullStyle);
        const decodedStyle = (cleanDeclarations(fullStyle, cleanImageUrl) + (gone ? ";display:none" : "")).replace(/^;/, "");
        if (tag === "img") {
          const raw = decodeEntities(attrs.get("src") ?? "");
          const id = cidOf(raw);
          const src = id !== null ? (images.get(id) ?? null) : cleanImageUrl(raw);
          if (src === null || hidden > 0 || tinyImage(attrs, decodedStyle) || hides(decodedStyle)) {
            el.remove();
            return;
          }
          if (!dropped) seenContent = true;
          say(`${attrs.get("alt") ? ` ${decodeEntities(attrs.get("alt")!)} ` : ""}`);
          if (!dropped) sawPicture = true;
          el.setAttribute("src", encodeAttr(src));
          attrs.delete("src");
        }
        for (const [name, raw] of attrs) {
          if (!attrAllowed(kept, name)) continue;
          if (name === "style") {
            if (decodedStyle) el.setAttribute("style", encodeAttr(decodedStyle));
            continue;
          }
          const decoded = URL_ATTRS.has(name) ? decodeEntities(raw) : raw;
          const safe = cleanAttr(kept, name, decoded, cleanImageUrl);
          if (safe !== null) el.setAttribute(name, URL_ATTRS.has(name) ? encodeAttr(safe) : encodeRaw(safe));
          if (safe !== null && name === "background" && !dropped && !hidden) sawPicture = true;
        }
        if (/url\(/i.test(decodedStyle) && !dropped && !hidden) sawPicture = true;
        const href = tag === "a" ? el.getAttribute("href") : null;
        if (href && !href.startsWith("#")) {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
        if (el.canHaveContent && hides(decodedStyle)) {
          hidden++;
          atEnd.push(() => void hidden--);
        }
        // The words as the owner will read them.
        if (kept === "br") say("\n");
        else if (kept === "li") say("\n• ");
        else if (BLOCKS.has(kept)) {
          say("\n");
          if (el.canHaveContent) atEnd.push(() => say("\n"));
        }
        if (href && !href.startsWith("#") && el.canHaveContent) {
          const at = decodeEntities(href);
          const from = visible.length;
          atEnd.push(() => {
            const label = visible.slice(from).trim();
            if (label !== at) say(label ? ` (${at})` : at);
          });
        }
        // Quoted history folds without script. All of an email being a quote (a forward) stays open.
        // Not a table's part: a <details> there would be moved out of the table by the browser, away from what it folds.
        const isQuote = (tag === "blockquote" && attrs.get("type") === "cite") || (hasClass(attrs.get("class"), QUOTE_CLASSES) && (tag === "div" || tag === "blockquote" || tag === "section"));
        if (isQuote && el.canHaveContent && !dropped) {
          if (quotes === 0) {
            el.before(`<details class="jinbox-quote"${seenContent ? "" : " open"}><summary>•••</summary>`, { html: true });
            el.after("</details>", { html: true });
          }
          quotes++;
          atEnd.push(() => void quotes--);
        }
  };
  const out = new HTMLRewriter()
    .on("*", {
      element(el) {
        atEnd = [];
        visit(el);
        const ends = atEnd;
        // In the order they were set, innermost matters last: the words before the levels they sit in close.
        if (ends.length && el.canHaveContent) el.onEndTag(() => {
          for (let i = ends.length - 1; i >= 0; i--) ends[i]!();
        });
      },
    })
    .on("style", {
      text(t) {
        css += t.text;
        t.remove();
        if (t.lastInTextNode) t.replace(cleanStylesheet(css, cleanImageUrl), { html: true });
      },
    })
    .onDocument({
      text(t) {
        if (inStyle) return;
        if (!dropped && !hidden && !seenContent && hasWords(t.text)) seenContent = true;
        if (hasOrSpace(t.text)) say(decodeEntities(t.text).replace(/[ \t\r\n\f]+/g, " "));
        if (t.text.includes("<") || t.text.includes(">")) t.replace(t.text.replace(/</g, "&lt;").replace(/>/g, "&gt;"), { html: true });
      },
      comments(c) {
        c.remove();
      },
      doctype(d) {
        d.remove();
      },
    })
    .transform(`${withoutEmptyRawElements(withoutControls(html))}<${end}>`);
  if (!ended) return null;
  const text = visible.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Nothing left to see: the page shows the text, not blank paper.
  if (!hasWords(text) && !sawPicture) return null;
  return { html: out, text };
}

/** Words, once entities and every kind of blank are out of the way. */
const hasWords = (t: string) => decodeEntities(t).replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "").length > 0;
const hasOrSpace = (t: string) => t.length > 0;

/** Every attribute off, however many times it was written. */
function stripAttrs(el: HTMLRewriterTypes.Element) {
  for (const [name] of [...el.attributes]) {
    while (el.hasAttribute(name)) el.removeAttribute(name);
  }
}

/** The second pass: is this only what the allowlist lets out? Mends nothing. */
function isClean(html: string): boolean {
  let ok = true;
  let inStyle = false;
  let css = "";
  new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (!KEPT.has(tag)) ok = false;
        const seen = new Set<string>();
        for (const [name, raw] of el.attributes) {
          if (seen.has(name)) ok = false;
          seen.add(name);
          if (tag === "a" && (name === "target" || name === "rel")) continue;
          if (!attrAllowed(tag, name)) {
            ok = false;
            continue;
          }
          const decoded = URL_ATTRS.has(name) ? decodeEntities(raw) : raw;
          if (cleanAttr(tag, name, decoded, cleanImageUrl) !== decoded) ok = false;
        }
        const href = tag === "a" ? el.getAttribute("href") : null;
        if (href && !href.startsWith("#") && (el.getAttribute("rel") !== "noopener noreferrer" || el.getAttribute("target") !== "_blank")) ok = false;
        if (tag === "style") {
          inStyle = true;
          css = "";
          el.onEndTag(() => void (inStyle = false));
        }
      },
    })
    .on("style", {
      text(t) {
        css += t.text;
        if (t.lastInTextNode && cleanStylesheet(css, cleanImageUrl) !== css) ok = false;
      },
    })
    .onDocument({
      text(t) {
        if (!inStyle && t.text.includes("<")) ok = false;
      },
      comments() {
        ok = false;
      },
      doctype() {
        ok = false;
      },
    })
    .transform(html);
  return ok;
}

/** The email's HTML as it may leave the Mac, with its visible words; or null: it could not be made safe or there is nothing in it to see, so the page shows the text. */
export function sanitizeEmail(html: string, o: Options = {}): Sanitized | null {
  try {
    const out = clean(html, o);
    return out !== null && isClean(out.html) ? out : null;
  } catch {
    return null;
  }
}

export const sanitizeEmailHtml = (html: string, o: Options = {}): string | null => sanitizeEmail(html, o)?.html ?? null;

const wordsOf = (t: string) => new Set(t.toLowerCase().replace(/https?:\/\/\S+|mailto:\S+/g, " ").match(/[\p{L}\p{N}]{2,}/gu) ?? []);

/**
 * Whether an email's plain part says clearly other than what its HTML shows. Sets of words, so order and layout do not count. Each
 * way: most of the plain part must be in the HTML (else it says things the owner never sees), and it must hold a fair part of
 * the HTML (else it is a stub, and the owner reads something else). Crying wolf costs little: an agent reads what the owner sees.
 */
export function textsDiffer(plain: string, shown: string): boolean {
  const p = wordsOf(plain);
  const h = wordsOf(shown);
  if (!h.size) return false;
  if (!p.size) return true;
  let common = 0;
  for (const w of p) if (h.has(w)) common++;
  return common / p.size < 0.85 || common / h.size < 0.25;
}

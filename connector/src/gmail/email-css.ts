// The CSS an email may keep: small hand-written scanners, not a browser's parser, so everything not
// recognized goes. What leaves here is written anew from what passed. Properties are an allowlist: what mail
// uses for type, colour, boxes and tables, and not what can hang a page (columns double the layout per level,
// and transforms, filters, animation and containment have no place in a letter) or take text out of the owner's
// hands. Nothing that loads remotely but an image the caller allows (`image`), no escapes (the one way to
// hide a word from a scanner), no attribute selectors (they read a page's values out, one request at a time), no
// function that is not on the list, no numbers past what a letter needs. Anything that follows the frame's own
// height (vh and its kin, height features in media queries) would feed its auto-height, and goes.
// A rule or declaration in doubt is dropped, never mended. Everything here is linear in its input.
export type ImageCheck = (url: string) => string | null;

const noImages: ImageCheck = () => null;

const FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp", "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient"]);
const IMAGE_PROPERTIES = new Set(["background", "background-image", "list-style", "list-style-image"]);
const PROPERTIES = new Set(
  `color opacity visibility display float clear overflow overflow-x overflow-y box-sizing vertical-align direction unicode-bidi cursor outline outline-color outline-style outline-width outline-offset
  width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left
  border border-width border-style border-color border-collapse border-spacing border-radius border-top border-right border-bottom border-left
  border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color
  border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
  background background-color background-image background-position background-repeat background-size background-origin
  font font-family font-size font-style font-variant font-weight font-stretch line-height letter-spacing word-spacing white-space word-break word-wrap overflow-wrap hyphens tab-size
  text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-overflow text-shadow text-transform text-size-adjust box-shadow
  table-layout empty-cells caption-side list-style list-style-image list-style-position list-style-type object-fit object-position aspect-ratio
  flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap justify-content align-content align-items align-self gap row-gap column-gap order
  -webkit-text-size-adjust -ms-text-size-adjust -webkit-font-smoothing -moz-osx-font-smoothing -webkit-border-radius -moz-border-radius -webkit-box-shadow -moz-box-shadow -webkit-box-sizing -moz-box-sizing`.split(/\s+/),
);
const DISPLAYS = new Set(["none", "block", "inline", "inline-block", "list-item", "flex", "inline-flex", "table", "inline-table", "table-row", "table-cell", "table-caption", "table-column", "table-column-group", "table-row-group", "table-header-group", "table-footer-group"]);
/** Sizes taken from the content make a layout measure twice per level. */
const CONTENT_SIZES = new Set(["min-content", "max-content", "fit-content", "-webkit-min-content", "-webkit-max-content", "-moz-min-content", "-moz-max-content", "-webkit-fit-content", "-moz-fit-content", "-webkit-fill-available", "stretch"]);
/** Any number followed by one of these, however it is written. */
const VIEWPORT_HEIGHT_UNIT = /^[-+.\d][\w.+-]*?(?:vh|vmin|vmax|svh|lvh|dvh|svmin|lvmin|dvmin|svmax|lvmax|dvmax|vb|svb|lvb|dvb|cqh|cqmin|cqmax|cqb)$/i;
const MAX_MEDIA_NESTING = 2;
const MAX_NUMBER = 20_000;
/** A big type or a wide shadow costs a page more than any box. */
const MAX_FONT_NUMBER = 300;
const MAX_SHADOW_NUMBER = 200;
const FONT_PROPERTIES = new Set(["font", "font-size", "line-height", "letter-spacing", "word-spacing"]);
const SHADOW_PROPERTIES = new Set(["box-shadow", "text-shadow", "-webkit-box-shadow", "-moz-box-shadow"]);
/** One declaration's value, and all of an inline style or of one sheet. A data: picture may be long. */
const MAX_VALUE_LENGTH = 2048;
export const MAX_STYLE_ATTR_LENGTH = 32 * 1024;
const MAX_SHEET_LENGTH = 512 * 1024;

/** CSS without its comments, each a space, as it is to a browser: a comment inside "url" does not make a url. An unterminated one takes the rest. */
function stripComments(css: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) {
      if (c === quote) quote = "";
      out += c;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) break;
      out += " ";
      i = end + 1;
    } else if (css.startsWith("<!--", i) || css.startsWith("-->", i)) {
      // HTML's old way of hiding a sheet: nothing, to CSS.
      out += " ";
      i += css[i] === "<" ? 3 : 2;
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

const isNameChar = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "-" || c === "_" || c === ".";

/** One declaration's value as it may stay, or null. `image`: the url() this property may have. */
function cleanValue(raw: string, image: ImageCheck, limit: number): string | null {
  const v = raw.trim();
  if (!v || (v.length > MAX_VALUE_LENGTH && !/^[a-z-]*\s*url\(/i.test(v))) return null;
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < v.length) {
    const c = v[i]!;
    if (c === "\\" || c === "<" || c === ">" || c === "@" || c === "{" || c === "}" || c === ";" || (c < " " && c !== "\t" && c !== "\n" && c !== "\r")) return null;
    if (c === '"' || c === "'") {
      const end = v.indexOf(c, i + 1);
      if (end < 0) return null;
      const s = v.slice(i + 1, end);
      if (/[\\<>\n\r]/.test(s)) return null;
      out += c + s + c;
      i = end + 1;
    } else if (isNameChar(c)) {
      let j = i;
      while (j < v.length && isNameChar(v[j]!)) j++;
      const word = v.slice(i, j);
      if (v[j] === "(") {
        const name = word.toLowerCase();
        if (name === "url") {
          const close = urlEnd(v, j + 1);
          if (close < 0) return null;
          const safe = image(unquote(v.slice(j + 1, close)));
          if (safe === null || /["\\<>\n\r]/.test(safe)) return null;
          out += `url("${safe}")`;
          i = close + 1;
          continue;
        }
        if (!FUNCTIONS.has(name)) return null;
        depth++;
        out += word + "(";
        i = j + 1;
      } else {
        // A hex colour is no number: #111111 is not past any limit, and must not be read as one.
        if (out.endsWith("#")) {
          if (!/^[\da-f]{3,8}$/i.test(word)) return null;
          out += word;
          i = j;
          continue;
        }
        if (word.length > 64 || VIEWPORT_HEIGHT_UNIT.test(word) || CONTENT_SIZES.has(word.toLowerCase())) return null;
        const n = word[0]! >= "0" && word[0]! <= "9" ? parseFloat(word) : word[0] === "." || word[0] === "-" ? parseFloat(word) : 0;
        if (Math.abs(n) > limit) return null;
        out += word;
        i = j;
      }
    } else {
      if (c === "(") return null;
      if (c === ")" && --depth < 0) return null;
      out += c;
      i++;
    }
  }
  return depth === 0 ? out : null;
}

function urlEnd(v: string, from: number): number {
  let i = from;
  while (i < v.length && v[i] === " ") i++;
  const q = v[i];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, i + 1);
    return end < 0 ? -1 : v.indexOf(")", end);
  }
  // Unquoted, an address may have balanced parentheses of its own: a(1).png.
  let depth = 0;
  for (; i < v.length; i++) {
    if (v[i] === "(") depth++;
    else if (v[i] === ")" && --depth < 0) return i;
  }
  return -1;
}

function unquote(s: string): string {
  const t = s.trim();
  const q = t[0];
  return (q === '"' || q === "'") && t.endsWith(q) && t.length >= 2 ? t.slice(1, -1) : t;
}

/** Splits at `;` outside strings and parentheses. */
function splitDeclarations(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < block.length; i++) {
    const c = block[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth <= 0) {
      out.push(block.slice(start, i));
      start = i + 1;
    }
  }
  out.push(block.slice(start));
  return out;
}

/** An inline style's or a block's declarations as they were written, cleaned of nothing: what says it is off the page, before those properties go. */
export function rawDeclarations(css: string): [string, string][] {
  return splitDeclarations(stripComments(css)).flatMap((d): [string, string][] => {
    const c = d.indexOf(":");
    return c > 0 && c < 64 ? [[d.slice(0, c).trim().toLowerCase(), d.slice(c + 1, c + 65).trim().toLowerCase()]] : [];
  });
}

const CLEAR_COLOR = /^\s*(?:transparent\b|rgba\([^)]*[,/]\s*0(?:\.0*)?\s*\))/i;
/** background-clip, -webkit-background-clip or the shorthand, asking for text. The clip is no property kept here: a dark frame could not read such text. */
function asksClipToText(part: string): boolean {
  const colon = part.indexOf(":");
  const prop = part.slice(0, colon).trim().toLowerCase();
  if (colon <= 0 || (prop !== "background" && prop !== "background-clip" && prop !== "-webkit-background-clip")) return false;
  return /\btext\b/i.test(part.slice(colon + 1).replace(/url\([^)]*\)/gi, ""));
}

/** An inline style or a rule's block, as it may stay: `a:b;c:d`, or "" when nothing does. */
export function cleanDeclarations(css: string, image: ImageCheck = noImages): string {
  const out: string[] = [];
  const parts = splitDeclarations(stripComments(css));
  const clipped = parts.some(asksClipToText);
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon <= 0 || colon > 64) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (!PROPERTIES.has(prop)) continue;
    // Words drawn by their background: without the clip they would be a bar, or nothing. They fall back to a plain readable colour.
    if (clipped && (prop.startsWith("background") || (prop === "color" && CLEAR_COLOR.test(part.slice(colon + 1))))) continue;
    const limit = FONT_PROPERTIES.has(prop) ? MAX_FONT_NUMBER : SHADOW_PROPERTIES.has(prop) ? MAX_SHADOW_NUMBER : MAX_NUMBER;
    const value = cleanValue(part.slice(colon + 1), IMAGE_PROPERTIES.has(prop) ? image : noImages, limit);
    if (value === null) continue;
    if (prop === "display" && !DISPLAYS.has(value.replace(/\s*!important$/i, "").toLowerCase())) continue;
    out.push(`${prop}:${value}`);
  }
  return out.join(";");
}

/** A cleaned style's declarations, as [property, value] (what decides that an image is hidden). */
export function declarationsOf(cleaned: string): [string, string][] {
  return splitDeclarations(cleaned).flatMap((d): [string, string][] => {
    const c = d.indexOf(":");
    return c > 0 ? [[d.slice(0, c), d.slice(c + 1).toLowerCase()]] : [];
  });
}

// Tags, classes, ids, descendants, the plain pseudo classes. No [attr], no functions, no escapes, no pseudo elements.
const SELECTOR = /^[A-Za-z0-9_\-#.>+~*: ]+$/;
const cleanSelector = (s: string) => s.replace(/\s+/g, " ").trim();
const MEDIA_QUERY = /^[A-Za-z0-9 ():,.\-/]+$/;
/** What a query may ask. Nothing about height: the frame's height follows its content, and a rule that answers height flips forever. Nor its shape, which is height too. */
const MEDIA_FEATURES = new Set(["width", "min-width", "max-width", "device-width", "min-device-width", "max-device-width", "resolution", "min-resolution", "max-resolution", "-webkit-device-pixel-ratio", "-webkit-min-device-pixel-ratio", "-webkit-max-device-pixel-ratio", "min--moz-device-pixel-ratio", "prefers-color-scheme", "prefers-reduced-motion", "color"]);
function cleanMediaQuery(q: string): string | null {
  if (!MEDIA_QUERY.test(q) || /\w\(/.test(q)) return null;
  for (const m of q.matchAll(/\(\s*([a-z-]+)/gi)) if (!MEDIA_FEATURES.has(m[1]!.toLowerCase())) return null;
  return q;
}

/** A <style> element's text, as it may stay; "" when nothing does. */
export function cleanStylesheet(css: string, image: ImageCheck = noImages, nesting = 0): string {
  if (css.length > MAX_SHEET_LENGTH) return "";
  const s = nesting ? css : stripComments(css);
  const rules: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    let quote = "";
    let parens = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") parens++;
      else if (c === ")") parens--;
      else if (parens <= 0 && (c === "{" || c === ";")) break;
      i++;
    }
    if (i >= s.length) break;
    // A statement (@import, @charset, @namespace, or stray text) goes, with nothing kept of it.
    if (s[i] === ";") {
      i++;
      continue;
    }
    const prelude = s.slice(start, i).trim();
    const bodyStart = ++i;
    let depth = 1;
    quote = "";
    while (i < s.length && depth > 0) {
      const c = s[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    // An unterminated block: a browser would close it; this stops at what it can be sure of.
    if (depth > 0) break;
    const body = s.slice(bodyStart, i - 1);
    if (prelude.startsWith("@")) {
      const media = /^@media\b(.*)$/is.exec(prelude);
      const query = media ? media[1]!.replace(/\s+/g, " ").trim() : "";
      if (!media || nesting >= MAX_MEDIA_NESTING || cleanMediaQuery(query) === null) continue;
      // Pictures only unconditionally: a load that depends on the print dialog, the colour scheme or the width is a beacon.
      const inner = cleanStylesheet(body, noImages, nesting + 1);
      if (inner) rules.push(`@media ${query}{${inner}}`);
      continue;
    }
    // Nor a pseudo element: its colour is not the element's, so a dark frame cannot read it. The whole rule goes: a browser ignores all of a list with one it does not know, and the rest of it must not come alive here.
    if (/::|:first-(?:line|letter)|:before|:after/i.test(prelude)) continue;
    const selectors = prelude.split(",").map(cleanSelector).filter((x) => x && SELECTOR.test(x) && !/:visited/i.test(x));
    if (!selectors.length) continue;
    // A pseudo class loads what it names only when it comes true: a beacon. Only plain rules load images.
    const decls = cleanDeclarations(body, selectors.some((x) => x.includes(":")) ? noImages : image);
    if (decls) rules.push(`${selectors.join(",")}{${decls}}`);
  }
  return rules.join("");
}

// Helpers to turn arbitrary (possibly hostile) upstream text into values the validators accept.

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateText(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return { text: s.slice(0, end), truncated: true };
}

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** For multi-line text: drop controls other than \t \n \r, replace lone surrogates with U+FFFD. */
export function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(LONE_SURROGATES, "�");
}

/** For single-line fields (titles, names): controls become spaces, whitespace runs collapse, then truncate. */
export function sanitizeLine(s: string, max: number): string {
  const line = s
    .replace(LONE_SURROGATES, "�")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return truncateText(line, max).text.trimEnd();
}

// Only bodies that are HTML: they start with a block or inline formatting tag and close one (or
// break a line). Ordinary chat text that merely contains tags ("hi <b>x</b>", a code snippet) is
// shown exactly as sent.
const HTML_TAGS = "p|div|span|b|i|u|strong|em|a|ul|ol|li|blockquote|h[1-6]";
const HTML_HINT = new RegExp(`^\\s*<(?:${HTML_TAGS}|br)(?:\\s[^<>]*)?\\/?>[\\s\\S]*(?:<\\/(?:${HTML_TAGS})>|<br\\s*\\/?>)`, "i");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/**
 * Some networks (LinkedIn InMail, some email-like bridges) hand Beeper message bodies as HTML.
 * Turns those into plain text with line breaks; text without HTML block/inline tags is returned
 * unchanged. Never produces markup: the result is plain text for a text node.
 */
export function htmlToPlainText(s: string): string {
  if (!HTML_HINT.test(s)) return s;
  const text = s
    .replace(/\r\n?/g, "\n")
    // Links keep their address so the page can still link them: "text (url)", or just the url.
    .replace(/<a\s[^<>]*?href\s*=\s*"([^"]*)"[^<>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^<>]*>/g, "").trim();
      return !label || label === href || href.includes(label.replace(/…$/, "")) ? href : `${label} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li(?:\s[^<>]*)?>/gi, "• ")
    // A block starts on a new line: marked here, merged with a line break the previous block already ended with.
    .replace(/<(?:p|div|ul|ol|blockquote|h[1-6])(?:\s[^<>]*)?>/gi, "\u0001")
    .replace(/<\/(?:p|div|li|ul|ol|blockquote|h[1-6])>/gi, "\n")
    .replace(/\n\u0001/g, "\n")
    .replace(/\u0001/g, "\n")
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+[0-9]*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k]!;
      const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? parseInt(k.slice(1), 10) : NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

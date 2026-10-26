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

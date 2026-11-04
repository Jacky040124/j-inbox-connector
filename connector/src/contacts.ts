// Names for the numbers and addresses iMessage gives instead of names. Beeper's API has only the number, so they
// come from the owner's Contacts: a small helper app (contacts-helper/), which has the Contacts permission and
// nothing else, writes contacts.json next to the connector's other data. Without it, numbers stay numbers. The
// names go where messages go: through the cloud in passing, never stored there.
import { closeSync, openSync, readFileSync, statSync } from "node:fs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 200;
const LOOK_EVERY_MS = 60_000;
const ASK_HELPER_EVERY_MS = 60 * 60_000;

let book: ReadonlyMap<string, string> = new Map();

// The invisible direction marks Contacts and iOS put around numbers.
const clean = (s: string) => s.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
const PHONE = /^\+?[\d\s().-]{7,24}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isAddress(s: string): boolean {
  const t = clean(s);
  return EMAIL.test(t) || (PHONE.test(t) && t.replace(/\D/g, "").length >= 7);
}

/** One form for a number or email however it is written; a North American number with or without its 1. */
export function contactKey(s: string): string | null {
  const t = clean(s);
  if (EMAIL.test(t)) return t.toLowerCase();
  if (!PHONE.test(t)) return null;
  const d = t.replace(/\D/g, "");
  if (d.length < 7) return null;
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export function sameAddress(a: string, b: string): boolean {
  const k = contactKey(a);
  return k !== null && k === contactKey(b);
}

export function contactName(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const k = contactKey(s);
  return k ? book.get(k) : undefined;
}

export function setContacts(next: ReadonlyMap<string, string>): void {
  book = next;
}

/** contacts.json: {"names": {"<number or email>": "<name>"}}. Anything else in it is ignored. */
export function parseContacts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const names = (JSON.parse(text) as { names?: unknown }).names;
  if (typeof names !== "object" || names === null || Array.isArray(names)) return out;
  for (const [address, name] of Object.entries(names)) {
    const k = contactKey(address);
    if (k && typeof name === "string" && name.trim() && !out.has(k)) out.set(k, name.trim().slice(0, MAX_NAME));
  }
  return out;
}

/** Reads the file if it changed. A file that is missing, too large or broken leaves the names as they are. */
export function loadContacts(file: string, last: number): number {
  try {
    const st = statSync(file);
    if (st.mtimeMs === last || st.size > MAX_FILE_BYTES) return last;
    setContacts(parseContacts(readFileSync(file, "utf8")));
    return st.mtimeMs;
  } catch {
    return last;
  }
}

export type ContactsWatch = { stop(): void };

/** Loads what is there, keeps it current, and has the helper (if installed) look at Contacts once an hour. */
export function watchContacts(o: { file: string; helperApp: string; run: (argv: string[]) => unknown }): ContactsWatch {
  let seen = loadContacts(o.file, -1);
  const installed = () => {
    try {
      closeSync(openSync(`${o.helperApp}/Contents/Info.plist`, "r"));
      return true;
    } catch {
      return false;
    }
  };
  const ask = () => {
    // -g -j: in the background, hidden. It writes the file and quits.
    if (installed()) o.run(["/usr/bin/open", "-g", "-j", "-a", o.helperApp, "--args", o.file]);
  };
  ask();
  const look = setInterval(() => (seen = loadContacts(o.file, seen)), LOOK_EVERY_MS);
  const refresh = setInterval(ask, ASK_HELPER_EVERY_MS);
  look.unref?.();
  refresh.unref?.();
  return {
    stop() {
      clearInterval(look);
      clearInterval(refresh);
    },
  };
}

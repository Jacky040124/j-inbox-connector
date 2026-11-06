import { sanitizeLine } from "@j-inbox/protocol";

// The owner's own addresses: every connected Gmail account and its "send mail as" aliases. Gmail only labels SENT in
// the account that sent, so mail from one of the owner's mailboxes arrives in another looking like anyone else's.
const known = new Map<string, ReadonlySet<string>>();
// The name each account's addresses send under ("send mail as": its display name), for the From of mail J-Inbox sends.
const names = new Map<string, ReadonlyMap<string, string>>();

/**
 * What one connected account owns: itself and what Gmail says it can send as. `sendNames` (from sendAsNamesOf)
 * replaces the names it sends under; without it they stand until Gmail answers.
 */
export function setOwnAddresses(email: string, aliases: readonly string[], sendNames?: ReadonlyMap<string, string>): void {
  known.set(email, new Set([email, ...aliases.map((a) => a.trim().toLowerCase()).filter(Boolean)]));
  if (sendNames) names.set(email, sendNames);
}

export function forgetOwnAddresses(email: string): void {
  known.delete(email);
  names.delete(email);
}

/** Tests: nobody yet. */
export function clearOwnAddresses(): void {
  known.clear();
  names.clear();
}

/** The name `address` of this account sends under, as Gmail's own From would carry it; "" when Gmail has not said (a bare address, as before). */
export function ownSendName(email: string, address: string = email): string {
  return names.get(email)?.get(address.trim().toLowerCase()) ?? "";
}

export function isOwnAddress(address: string | null | undefined, email: string): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === email) return true;
  for (const set of known.values()) if (set.has(a)) return true;
  return false;
}

/** Any connected account's address or alias. */
export function isAnyOwnAddress(address: string | null | undefined): boolean {
  return isOwnAddress(address, "");
}

/** Its aliases have been asked for, or it stands alone until they have. */
export function knowsOwnAddresses(email: string): boolean {
  return known.has(email);
}

/** More than the one mailbox being read: a message without SENT may still be the owner's, and only its headers tell. */
export function hasOtherOwnAddresses(email: string): boolean {
  for (const [account, set] of known) if (account !== email || set.size > 1) return true;
  return false;
}

/** `settings/sendAs`'s answer -> its addresses; anything else -> none. */
export function aliasesOf(body: unknown): string[] {
  const list = (body as { sendAs?: unknown } | null)?.sendAs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a) => (typeof (a as { sendAsEmail?: unknown })?.sendAsEmail === "string" ? [(a as { sendAsEmail: string }).sendAsEmail] : []));
}

/**
 * `settings/sendAs`'s answer -> each address's display name (lower-case address -> name; none without one). As
 * Gmail does: an alias with no name of its own goes out under the primary address's. A primary without one is
 * Gmail's default, "use the Google account's name": `accountName` (GmailSource sentName: no scope J-Inbox holds
 * gives that name, only the mail Gmail sent under it shows it).
 */
export function sendAsNamesOf(body: unknown, accountName = ""): Map<string, string> {
  const list = (body as { sendAs?: unknown } | null)?.sendAs;
  const out = new Map<string, string>();
  if (!Array.isArray(list)) return out;
  const entries = list.flatMap((a) => {
    const e = a as { sendAsEmail?: unknown; displayName?: unknown; isPrimary?: unknown } | null;
    if (typeof e?.sendAsEmail !== "string") return [];
    return [{ address: e.sendAsEmail.trim().toLowerCase(), name: typeof e.displayName === "string" ? sanitizeLine(e.displayName, 200) : "", primary: e.isPrimary === true }];
  });
  const primary = entries.find((e) => e.primary)?.name || sanitizeLine(accountName, 200);
  for (const e of entries) if (e.address && (e.name || primary)) out.set(e.address, e.name || primary);
  return out;
}

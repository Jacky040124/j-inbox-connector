// The owner's own addresses: every connected Gmail account and its "send mail as" aliases. Gmail only labels SENT in
// the account that sent, so mail from one of the owner's mailboxes arrives in another looking like anyone else's.
const known = new Map<string, ReadonlySet<string>>();

/** What one connected account owns: itself and what Gmail says it can send as. */
export function setOwnAddresses(email: string, aliases: readonly string[]): void {
  known.set(email, new Set([email, ...aliases.map((a) => a.trim().toLowerCase()).filter(Boolean)]));
}

export function forgetOwnAddresses(email: string): void {
  known.delete(email);
}

/** Tests: nobody yet. */
export function clearOwnAddresses(): void {
  known.clear();
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

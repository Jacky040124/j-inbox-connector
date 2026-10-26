// Which Gmail accounts this connector runs: addresses and status in a small 0600 file
// (`gmail.json` next to the idempotency journal), refresh tokens in the Keychain (account
// `gmail:<address>`). Nothing else about an account is kept on disk.
import { readFileSync } from "node:fs";
import { normalizeGmailAddress } from "@j-inbox/protocol";
import { writeAtomic } from "../config.ts";
import { gmailSecretName, isStorableSecret, type SecretStore } from "../secrets.ts";

export type GmailAccountStatus = "connected" | "reconnect_required";
export type GmailAccountEntry = { email: string; status: GmailAccountStatus; addedAt: string };

const MAX_ACCOUNTS = 20;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class GmailAccounts {
  private entries: GmailAccountEntry[] = [];

  constructor(private readonly o: { path?: string; secrets: SecretStore; now?: () => number }) {
    if (o.path) this.load(o.path);
  }

  private load(path: string) {
    try {
      const raw = readFileSync(path, "utf8");
      if (raw.length > 64 * 1024) return;
      const j = JSON.parse(raw);
      if (!j || j.v !== 1 || !Array.isArray(j.accounts)) return;
      for (const a of j.accounts) {
        const email = normalizeGmailAddress(a?.email);
        if (!email || email !== a.email || this.entries.some((e) => e.email === email)) continue;
        this.entries.push({ email, status: a.status === "reconnect_required" ? "reconnect_required" : "connected", addedAt: typeof a.addedAt === "string" && ISO.test(a.addedAt) ? a.addedAt : new Date(0).toISOString() });
        if (this.entries.length >= MAX_ACCOUNTS) break;
      }
    } catch {
      // missing or corrupt: no Gmail accounts
    }
  }

  private save() {
    if (this.o.path) writeAtomic(this.o.path, JSON.stringify({ v: 1, accounts: this.entries }) + "\n");
  }

  list(): GmailAccountEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(email: string): GmailAccountEntry | null {
    return this.entries.find((e) => e.email === email) ?? null;
  }

  async refreshToken(email: string): Promise<string | null> {
    if (!this.get(email)) return null;
    return this.o.secrets.get(gmailSecretName(email));
  }

  /** Store (or replace) an account's refresh token, then list it as connected. */
  async add(email: string, refreshToken: string): Promise<GmailAccountEntry> {
    const e = normalizeGmailAddress(email);
    if (!e || e !== email) throw new Error("invalid Gmail address");
    if (!isStorableSecret(refreshToken)) throw new Error("invalid refresh token");
    if (!this.get(e) && this.entries.length >= MAX_ACCOUNTS) throw new Error("too many Gmail accounts");
    await this.o.secrets.set(gmailSecretName(e), refreshToken);
    const existing = this.get(e);
    if (existing) existing.status = "connected";
    else this.entries.push({ email: e, status: "connected", addedAt: new Date(this.o.now?.() ?? Date.now()).toISOString() });
    this.save();
    return { ...this.get(e)! };
  }

  /** Forget an account; returns its refresh token (to revoke it at Google) or null. */
  async remove(email: string): Promise<string | null> {
    if (!this.get(email)) return null;
    const token = await this.o.secrets.get(gmailSecretName(email)).catch(() => null);
    await this.o.secrets.delete(gmailSecretName(email));
    this.entries = this.entries.filter((e) => e.email !== email);
    this.save();
    return token;
  }

  setStatus(email: string, status: GmailAccountStatus) {
    const e = this.entries.find((x) => x.email === email);
    if (!e || e.status === status) return;
    e.status = status;
    try {
      this.save();
    } catch {}
  }
}

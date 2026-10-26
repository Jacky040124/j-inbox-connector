// The connector's Gmail side: the accounts (gmail.json + Keychain), one client and source per
// account, connecting a new account (gmail_connect), removing one (revoke at Google, forget),
// and the history poller.
import { GMAIL_NETWORK, gmailAccountID, makeError, normalizeGmailAddress, type Account, type ErrorBody, type EventFrame } from "@j-inbox/protocol";
import type { RequestContext } from "../actions.ts";
import type { SecretStore } from "../secrets.ts";
import { GmailAccounts } from "./accounts.ts";
import { createGmailClient, revokeAtGoogle, type RefreshFn } from "./client.ts";
import { GmailPoller } from "./poller.ts";
import { createGmailSource, type GmailSource } from "./source.ts";

export type GmailServiceOptions = {
  secrets: SecretStore;
  /** gmail.json (omit in tests for memory only). */
  path?: string;
  refresh: RefreshFn;
  gmailURL?: string;
  oauthURL?: string;
  fetchImpl?: typeof fetch;
  scan?: { maxPages?: number; budgetMs?: number };
  pollIntervalMs?: number;
  now?: () => number;
  log?: (msg: string, fields?: Record<string, string | number | boolean | null>) => void;
  /** Lifecycle notes for the local audit log (metadata only). */
  onLifecycle?: (event: "gmail.connected" | "gmail.removed" | "gmail.reauth") => void;
};

const err = (code: ErrorBody["code"], message: string) => ({ ok: false as const, error: makeError(code, message) });

export type GmailService = ReturnType<typeof createGmailService>;

export function createGmailService(o: GmailServiceOptions) {
  const accounts = new GmailAccounts({ path: o.path, secrets: o.secrets, now: o.now });
  const sources = new Map<string, GmailSource>();
  let poller: GmailPoller | null = null;

  function sourceFor(email: string): GmailSource {
    let s = sources.get(email);
    if (s) return s;
    const client = createGmailClient({
      email,
      refreshToken: () => accounts.refreshToken(email),
      refresh: o.refresh,
      baseURL: o.gmailURL,
      fetchImpl: o.fetchImpl,
      now: o.now,
      onReauth: () => {
        if (accounts.get(email)?.status !== "reconnect_required") {
          accounts.setStatus(email, "reconnect_required");
          o.onLifecycle?.("gmail.reauth");
          o.log?.("gmail: an account needs reconnecting");
        }
      },
      onHealthy: () => accounts.setStatus(email, "connected"),
    });
    s = createGmailSource({ email, client, scan: o.scan, now: o.now });
    sources.set(email, s);
    return s;
  }

  return {
    accounts,
    emails(): string[] {
      return accounts.list().map((a) => a.email);
    },
    has(email: string): boolean {
      return accounts.get(email) !== null;
    },
    status(email: string) {
      return accounts.get(email)?.status ?? null;
    },
    source(email: string): GmailSource | null {
      return accounts.get(email) ? sourceFor(email) : null;
    },
    sources(): GmailSource[] {
      return accounts.list().map((a) => sourceFor(a.email));
    },
    /** status.accounts entries. */
    statusAccounts(): Account[] {
      return accounts.list().map((a) => ({ accountID: gmailAccountID(a.email), network: GMAIL_NETWORK, status: a.status, name: a.email, removable: true }));
    },

    /**
     * gmail_connect: check the refresh token works and belongs to `email` (one users.getProfile),
     * then keep it. The token is not stored when the check fails.
     */
    async connect(rawEmail: string, refreshToken: string, ctx: RequestContext): Promise<{ ok: true; data: { accountID: string; connected: true } } | { ok: false; error: ErrorBody }> {
      const email = normalizeGmailAddress(rawEmail);
      if (!email) return err("BAD_PARAMS", "Not a Google account address.");
      const probe = createGmailSource({
        email,
        client: createGmailClient({ email, refreshToken: async () => refreshToken, refresh: o.refresh, baseURL: o.gmailURL, fetchImpl: o.fetchImpl, now: o.now }),
        now: o.now,
      });
      const p = await probe.profile(ctx);
      if (!p.ok) return p.error.code === "REAUTH_REQUIRED" ? err("NOT_ALLOWED", "Google did not accept this account's access. Try adding it again.") : p;
      if (normalizeGmailAddress(p.data.emailAddress) !== email) return err("NOT_ALLOWED", "This Gmail access belongs to a different account than the one that signed in.");
      try {
        await accounts.add(email, refreshToken);
      } catch {
        return err("INTERNAL", "The connector could not store the account in the Keychain.");
      }
      // A fresh client (a reconnect replaces the token) and a fresh history start.
      sources.delete(email);
      poller?.forget(email);
      o.onLifecycle?.("gmail.connected");
      void poller?.pollAll();
      return { ok: true, data: { accountID: gmailAccountID(email), connected: true } };
    },

    /** remove_account for Gmail: revoke J-Inbox's access at Google, then forget the account here. */
    async remove(email: string): Promise<{ ok: true; revoked: boolean } | { ok: false; error: ErrorBody }> {
      if (!accounts.get(email)) return err("NOT_FOUND", "No such Gmail account on this computer.");
      const token = await accounts.refreshToken(email).catch(() => null);
      const revoked = token ? await revokeAtGoogle({ token, oauthURL: o.oauthURL, fetchImpl: o.fetchImpl }) : true;
      try {
        await accounts.remove(email);
      } catch {
        return err("INTERNAL", "The connector could not delete the account from the Keychain.");
      }
      sources.delete(email);
      poller?.forget(email);
      o.onLifecycle?.("gmail.removed");
      return { ok: true, revoked };
    },

    startPolling(send: (f: EventFrame) => boolean) {
      poller ??= new GmailPoller({ sources: () => this.sources(), send, intervalMs: o.pollIntervalMs, log: o.log, skip: (e) => accounts.get(e)?.status === "reconnect_required" });
      poller.start();
    },
    pollNow(): Promise<void> {
      return poller?.pollAll() ?? Promise.resolve();
    },
    stopPolling() {
      poller?.stop();
    },
  };
}

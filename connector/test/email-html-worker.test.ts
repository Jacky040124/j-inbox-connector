// A hostile email's cost is spent off the main thread, with a deadline. Before this, a 100 KB email froze the
// whole connector for a minute: no heartbeat, no other request. The event loop is watched while each one is read.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { join } from "node:path";
import { createActions, createWriteDedupe } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { cloudTokenRefresher } from "../src/gmail/client.ts";
import { sanitizeEmailHtml } from "../src/gmail/email-html.ts";
import { compareInWorker, forgetStuckWorkers, sanitizeInWorker, stuckWorkers, workerPath } from "../src/gmail/email-html-run.ts";
import { createGmailService } from "../src/gmail/service.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { SLOW_EMAILS } from "./fixtures/hostile-emails.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const SPIN = join(import.meta.dir, "helpers", "spin-worker.ts");
const DEVICE_TOKEN = "jid_" + "A".repeat(43);
let fb: FakeBeeper;
let fg: RunningFakeGoogle;
let cloud: FakeCloud;

beforeAll(async () => {
  fb = await startFakeBeeper();
  fg = await startFakeGoogle();
  cloud = await startFakeCloud({ google: { url: fg.url, clientId: FAKE_GOOGLE_CLIENT.id, clientSecret: FAKE_GOOGLE_CLIENT.secret } });
});
afterAll(() => {
  fb.stop();
  fg.stop();
  cloud.stop();
});
beforeEach(() => fg.google.reset());

async function make() {
  const gmail = createGmailService({ secrets: new MemorySecretStore(), refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: DEVICE_TOKEN }), gmailURL: fg.url, oauthURL: fg.url });
  await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  const idempotency = createWriteDedupe();
  return createDispatcher({ actions: createActions(client, { assets, idempotency, connectorVersion: "0.1.0" }), client, assets, gmail, idempotency });
}

/** The longest the event loop stood still while `work` ran. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ stall: number; result: T }> {
  let last = performance.now();
  let stall = 0;
  const iv = setInterval(() => {
    const n = performance.now();
    stall = Math.max(stall, n - last);
    last = n;
  }, 10);
  const result = await work();
  await Bun.sleep(30);
  clearInterval(iv);
  return { stall, result };
}

describe("what used to freeze it", () => {
  for (const c of SLOW_EMAILS) {
    test(`${c.name}: the sanitizer alone is quick, and linear in its input`, () => {
      const t0 = performance.now();
      sanitizeEmailHtml(c.html);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
    test(`${c.name}: through get_email_html the event loop keeps going`, async () => {
      const d = await make();
      const m = fg.google.deliver(OWNER_EMAIL, { from: "Shop <shop@example.com>", subject: "Sale", text: "hi", html: c.html });
      const { stall, result } = await longestStall(() => d.dispatch("get_email_html", { chatID: `gmail:${OWNER_EMAIL}:${m.threadId}`, messageID: m.id }));
      expect(["res", "media"]).toContain(result.kind);
      expect(stall).toBeLessThan(500);
    });
  }
  test("ten times the size is about ten times the work, not a hundred", () => {
    const time = (n: number) => {
      const html = `<p>x</p><img src="https://images.example/x.png" style="width:${"0".repeat(n)}x"><div style="${"b:c;".repeat(n / 4)}">y</div>`;
      const t0 = performance.now();
      sanitizeEmailHtml(html);
      return performance.now() - t0;
    };
    time(20_000);
    expect(time(2_000_000)).toBeLessThan(2000);
  });
  test("past a cap, no pattern looks at it: the longest style and number are simply not kept", () => {
    expect(sanitizeEmailHtml(`<p style="width:${"0".repeat(40_000)}px">x</p>`)).toBe("<p>x</p>");
    expect(sanitizeEmailHtml(`<table width="${"1".repeat(33)}"></table>x`)).toBe("<table></table>x");
  });
  test("too many attributes on one element is too much: the page shows the text", () => {
    expect(sanitizeEmailHtml(`<div${Array.from({ length: 65 }, (_, i) => ` a${i}=1`).join("")}>x</div>`)).toBeNull();
    expect(sanitizeEmailHtml(`<div${Array.from({ length: 64 }, (_, i) => ` a${i}=1`).join("")}>x</div>`)).toBe("<div>x</div>");
  });
});

describe("the worker and its deadline", () => {
  test("from source, a worker answers", async () => {
    expect(workerPath()).toEndWith("/gmail/email-html-worker.ts");
    expect((await sanitizeInWorker("<script>x</script><p onclick=y>z</p>", new Map()))?.html).toBe("<p>z</p>");
  });
  test("compiled, it is the binary's own entry point (binary.test.ts runs it)", () => {
    expect(workerPath("file:///$bunfs/root/j-inbox")).toBe("/$bunfs/root/gmail/email-html-worker.js");
  });
  test("a worker that never answers is killed at its deadline: the answer is null, and the event loop never stood still", async () => {
    const t0 = performance.now();
    const { stall, result } = await longestStall(() => sanitizeInWorker("<p>x</p>", new Map(), { path: SPIN, deadlineMs: 300 }));
    expect(result).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(stall).toBeLessThan(200);
  });
  test("one that cannot start, or throws, is null too", async () => {
    expect(await sanitizeInWorker("<p>x</p>", new Map(), { path: "/nonexistent/worker.ts", deadlineMs: 2000 })).toBeNull();
  });
  test("the default deadline is about 3 s", async () => {
    const { SANITIZE_DEADLINE_MS } = await import("../src/gmail/email-html-run.ts");
    expect(SANITIZE_DEADLINE_MS).toBe(3000);
  });
  test("a killed JavaScript loop really ends: no thread is counted stuck", async () => {
    const before = stuckWorkers();
    await sanitizeInWorker("<p>x</p>", new Map(), { path: SPIN, deadlineMs: 100 });
    await Bun.sleep(2300);
    expect(stuckWorkers()).toBe(before);
  });
  test("a worker stuck in native code does not end when told: after three, no more are started, and the answer is the text", async () => {
    const NATIVE = join(import.meta.dir, "helpers", "native-spin-worker.ts");
    forgetStuckWorkers();
    await Promise.all([1, 2, 3].map(() => sanitizeInWorker("<p>x</p>", new Map(), { path: NATIVE, deadlineMs: 500 })));
    await Bun.sleep(2300);
    expect(stuckWorkers()).toBe(3);
    const t0 = performance.now();
    expect(await sanitizeInWorker("<p>x</p>", new Map())).toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
    forgetStuckWorkers();
    expect((await sanitizeInWorker("<p>x</p>", new Map()))?.html).toBe("<p>x</p>");
  }, 15_000);
  test("comparing: what finished before the deadline is kept, the rest stays as it was", async () => {
    const out = await compareInWorker([{ id: "a", html: "<p>the words the owner sees in this email are these</p>", plain: "something else altogether" }, { id: "b", html: "<p>same words</p>", plain: "same words" }, { id: "c", html: "<p>x</p>", plain: "x" }]);
    expect(out.get("a")).toBe("the words the owner sees in this email are these");
    expect(out.get("b")).toBeNull();
    expect((await compareInWorker([{ id: "a", html: "<p>x</p>", plain: "y" }], { path: SPIN, deadlineMs: 100 })).size).toBe(0);
  });
});

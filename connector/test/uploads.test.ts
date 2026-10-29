// Files sent through J-Inbox: the upload store keeps them on this computer only (0600 in a 0700
// directory, bounded, purged), the cloud's chunks arrive in order from their owner only, and a send
// uploads the file to Beeper (multipart) or into a multipart/mixed email, then forgets it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_IDS, startFakeBeeper, type FakeBeeper } from "@j-inbox/fake-beeper";
import { FAKE_GOOGLE_CLIENT, OWNER_EMAIL, PDF_BYTES, THREADS, startFakeGoogle, type RunningFakeGoogle } from "@j-inbox/fake-google";
import { DRAFT_KEEP_MS, UPLOAD_TTL_MS, encodeBase64, parseActionResult, type ActionName } from "@j-inbox/protocol";
import { createActions, createWriteDedupe } from "../src/actions.ts";
import { AssetAllowlist } from "../src/assets.ts";
import { createBeeperClient } from "../src/beeper-client.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { DraftStore } from "../src/drafts.ts";
import { cloudTokenRefresher } from "../src/gmail/client.ts";
import { attachmentHeaders, buildMessage, rfc2231 } from "../src/gmail/mime.ts";
import { createGmailService } from "../src/gmail/service.ts";
import { MemorySecretStore } from "../src/secrets.ts";
import { UploadError, UploadStore } from "../src/uploads.ts";
import { startFakeCloud, type FakeCloud } from "./helpers/fake-cloud.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jinbox-uploads-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const U = "upl_0123456789abcdef";
const OWNER = "o_owner_000000000000";
const OTHER = "o_other_000000000000";
const PDF = new Uint8Array(600 * 1024).map((_, i) => (i < 4 ? [0x25, 0x50, 0x44, 0x46][i]! : i % 251));
const NAME = "Quote – 报价 (final).pdf";
const chunks = (b: Uint8Array, n = 256 * 1024) => Array.from({ length: Math.ceil(b.length / n) || 1 }, (_, i) => encodeBase64(b.subarray(i * n, (i + 1) * n)));
const errCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof UploadError) return e.body.code;
    throw e;
  }
  return null;
};

function fill(s: UploadStore, id = U, bytes = PDF, owner = OWNER) {
  s.begin({ uploadId: id, owner, fileName: NAME, mimeType: "application/pdf", size: bytes.length });
  chunks(bytes).forEach((data, index) => s.chunk({ uploadId: id, owner, index, data }));
  return s.commit({ uploadId: id, owner });
}

describe("UploadStore", () => {
  test("a file in 256 KiB chunks, kept in a 0600 file in a 0700 directory; a new process reads the same", () => {
    const dir = join(tmp(), "data", "uploads");
    const s = new UploadStore({ dir });
    expect(fill(s)).toEqual({ uploadId: U, fileName: NAME, mimeType: "application/pdf", size: PDF.length });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${U}.bin`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "index.json")).mode & 0o777).toBe(0o600);
    expect(s.read(U).bytes).toEqual(PDF);
    expect(new UploadStore({ dir }).read(U).bytes).toEqual(PDF);
  });
  test("chunks only from the owner, in order, never past the size; commit only when every byte is there", () => {
    const s = new UploadStore();
    s.begin({ uploadId: U, owner: OWNER, fileName: "a.pdf", mimeType: "application/pdf", size: 6 });
    expect(errCode(() => s.begin({ uploadId: U, owner: OWNER, fileName: "a.pdf", mimeType: "application/pdf", size: 6 }))).toBe("CONFLICT");
    expect(errCode(() => s.chunk({ uploadId: U, owner: OTHER, index: 0, data: "JVBE" }))).toBe("NOT_FOUND");
    expect(errCode(() => s.chunk({ uploadId: U, owner: OWNER, index: 1, data: "JVBE" }))).toBe("BAD_PARAMS");
    s.chunk({ uploadId: U, owner: OWNER, index: 0, data: "JVBE" });
    expect(errCode(() => s.chunk({ uploadId: U, owner: OWNER, index: 0, data: "JVBE" }))).toBe("BAD_PARAMS");
    expect(errCode(() => s.commit({ uploadId: U, owner: OWNER }))).toBe("BAD_PARAMS");
    expect(errCode(() => s.chunk({ uploadId: U, owner: OWNER, index: 1, data: "JVBERi0x" }))).toBe("TOO_LARGE");
    expect(errCode(() => s.read(U))).toBe("NOT_FOUND");
    s.chunk({ uploadId: U, owner: OWNER, index: 1, data: "Ri0x" });
    expect(errCode(() => s.commit({ uploadId: U, owner: OTHER }))).toBe("NOT_FOUND");
    expect(s.commit({ uploadId: U, owner: OWNER }).size).toBe(6);
    expect(errCode(() => s.chunk({ uploadId: U, owner: OWNER, index: 2, data: "" }))).toBe("CONFLICT");
  });
  test("bounded in count and in bytes", () => {
    const s = new UploadStore({ max: 2, maxBytes: 100 });
    s.begin({ uploadId: "upl_a000000000000000", owner: OWNER, fileName: "a", mimeType: "text/plain", size: 60 });
    expect(errCode(() => s.begin({ uploadId: "upl_b000000000000000", owner: OWNER, fileName: "b", mimeType: "text/plain", size: 41 }))).toBe("TOO_LARGE");
    s.begin({ uploadId: "upl_b000000000000000", owner: OWNER, fileName: "b", mimeType: "text/plain", size: 40 });
    expect(errCode(() => s.begin({ uploadId: "upl_c000000000000000", owner: OWNER, fileName: "c", mimeType: "text/plain", size: 0 }))).toBe("TOO_LARGE");
  });
  test("forgotten after an hour unless on a draft, then with the draft; files no entry names are removed", () => {
    let now = 1_000_000;
    const dir = join(tmp(), "uploads");
    const alive = new Set(["drq_0123456789abcdef"]);
    const s = new UploadStore({ dir, now: () => now, draftAlive: (id) => alive.has(id) });
    fill(s, U);
    fill(s, "upl_fedcba9876543210");
    expect(s.claim(U, OTHER, "drq_0123456789abcdef", now)).toBe(false);
    expect(s.claim(U, OWNER, "drq_0123456789abcdef", now)).toBe(true);
    expect(s.claim(U, OWNER, "drq_another000000000", now)).toBe(false);
    expect(s.discard(U)).toBe(false);
    now += UPLOAD_TTL_MS;
    s.purge();
    expect(s.info("upl_fedcba9876543210")).toBeNull();
    expect(s.info(U)?.fileName).toBe(NAME);
    expect(readdirSync(dir).sort()).toEqual(["index.json", `${U}.bin`]);
    alive.clear();
    s.purge();
    expect(s.info(U)).toBeNull();
    expect(readdirSync(dir)).toEqual(["index.json"]);
    // At the latest, a draft's file goes when the draft would.
    const t = new UploadStore({ now: () => now });
    fill(t);
    t.claim(U, OWNER, "drq_0123456789abcdef", now);
    now += DRAFT_KEEP_MS;
    t.purge();
    expect(t.size).toBe(0);
  });
  test("a damaged index is ignored and the orphaned files are removed", async () => {
    const dir = join(tmp(), "uploads");
    fill(new UploadStore({ dir }));
    await Bun.write(join(dir, "index.json"), "{not json");
    const s = new UploadStore({ dir });
    expect(s.size).toBe(0);
    expect(readdirSync(dir)).toEqual(["index.json"]);
  });
});

describe("gmail MIME with a file", () => {
  test("multipart/mixed: the text, then the file with an RFC 2231 name for non-ASCII; reply headers kept", () => {
    const raw = buildMessage({ from: "jacky@example.com", to: [{ address: "a@example.com" }], cc: [], subject: "Re: Quote", text: "Here 👋", inReplyTo: "<m1@x>", references: "<m1@x>", attachment: { fileName: NAME, mimeType: "application/pdf", bytes: PDF_BYTES }, boundary: "=_jinbox_test" });
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="=_jinbox_test"');
    expect(raw).toContain("In-Reply-To: <m1@x>\r\nReferences: <m1@x>");
    expect(raw).toContain("--=_jinbox_test\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    expect(raw).toContain(`Content-Disposition: attachment; filename="Quote _ __ (final).pdf"; filename*=${rfc2231(NAME)}`);
    expect(raw.endsWith("--=_jinbox_test--\r\n")).toBe(true);
    expect(rfc2231("报价 a.pdf")).toBe("UTF-8''%E6%8A%A5%E4%BB%B7%20a.pdf");
    expect(attachmentHeaders({ fileName: "plain.pdf", mimeType: "application/pdf" })[1]).toBe('Content-Disposition: attachment; filename="plain.pdf"');
  });
  test("without a file nothing changes", () => {
    const raw = buildMessage({ from: "jacky@example.com", to: [{ address: "a@example.com" }], cc: [], subject: "s", text: "t" });
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).not.toContain("multipart");
  });
});

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
beforeEach(() => {
  fb.reset();
  fg.google.reset();
});

async function make(o: { gmail?: boolean } = {}) {
  const client = createBeeperClient({ baseURL: fb.url, token: fb.token, timeoutMs: 5000 });
  const assets = new AssetAllowlist();
  const idempotency = createWriteDedupe();
  const drafts = new DraftStore();
  const uploads = new UploadStore({ dir: join(tmp(), "uploads"), draftAlive: (id) => drafts.has(id) });
  let gmail = null;
  if (o.gmail) {
    gmail = createGmailService({ secrets: new MemorySecretStore(), refresh: cloudTokenRefresher({ cloudURL: cloud.url, deviceToken: "jid_" + "A".repeat(43) }), gmailURL: fg.url, oauthURL: fg.url });
    await gmail.accounts.add(OWNER_EMAIL, fg.google.issueRefreshToken(OWNER_EMAIL));
  }
  const d = createDispatcher({ actions: createActions(client, { assets, idempotency, connectorVersion: "0.1.0" }), client, assets, gmail, idempotency, drafts, uploads });
  const call = async (action: ActionName, params: unknown): Promise<any> => {
    const r = await d.dispatch(action, params);
    if (r.kind !== "res") throw new Error("media");
    if (r.ok) expect(parseActionResult(action, r.data).ok).toBe(true);
    return r;
  };
  const upload = async (bytes = PDF, owner = OWNER, id = U) => {
    expect((await call("upload_store_begin", { uploadId: id, owner, fileName: NAME, mimeType: "application/pdf", size: bytes.length })).ok).toBe(true);
    for (const [index, data] of chunks(bytes).entries()) expect((await call("upload_store_chunk", { uploadId: id, owner, index, data })).ok).toBe(true);
    return call("upload_store_commit", { uploadId: id, owner });
  };
  return { d, call, upload, uploads, drafts };
}

describe("sending a file to Beeper", () => {
  test("POST /v1/assets/upload (multipart, name and type), then the message with attachment {uploadID}; the file is gone after", async () => {
    const t = await make();
    expect((await t.upload()).data).toEqual({ uploadId: U, fileName: NAME, mimeType: "application/pdf", size: PDF.length });
    const r = await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "The quote", attachmentId: U, idempotencyKey: "key-0000000001" });
    expect(r.ok).toBe(true);
    const w = fb.writes();
    expect(w.map((c) => c.route)).toEqual(["POST /v1/assets/upload", "POST /v1/chats/{chatID}/messages"]);
    expect(w[0]!.body).toEqual({ fileName: NAME, mimeType: "application/pdf", fileSize: PDF.length });
    const uploadID = [...fb.state.uploads.keys()][0]!;
    expect(fb.state.uploads.get(uploadID)!.bytes).toEqual(PDF);
    expect(w[1]!.body).toEqual({ text: "The quote", attachment: { uploadID, fileName: NAME, mimeType: "application/pdf" } });
    expect(t.uploads.size).toBe(0);
    // The same key again replays the first answer: no second upload, no second message.
    expect((await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "The quote", attachmentId: U, idempotencyKey: "key-0000000001" })).data).toEqual(r.data);
    expect(fb.writes()).toHaveLength(2);
    // The same key with another file is another message: CONFLICT.
    expect((await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "The quote", attachmentId: "upl_fedcba9876543210", idempotencyKey: "key-0000000001" })).error.code).toBe("CONFLICT");
  });
  test("a file without text; a file that is gone is NOT_FOUND and nothing reaches Beeper", async () => {
    const t = await make();
    await t.upload(PDF_BYTES);
    const r = await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, attachmentId: U });
    expect(r.ok).toBe(true);
    expect(fb.writes()[1]!.body).not.toHaveProperty("text");
    const again = await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, attachmentId: U });
    expect(again.error.code).toBe("NOT_FOUND");
    expect(again.error.message).toContain("Attach it again");
    expect(fb.writes()).toHaveLength(2);
  });
  test("Beeper refuses the file: NOT_SUPPORTED with Beeper's own reason, the file stays to try again", async () => {
    const t = await make();
    await t.upload(PDF_BYTES);
    fb.failNext({ method: "POST", route: "/v1/chats/{chatID}/messages", status: 422, message: "This network does not support file attachments" });
    const r = await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "x", attachmentId: U, idempotencyKey: "key-0000000002" });
    expect(r.error.code).toBe("NOT_SUPPORTED");
    expect(r.error.message).toContain("This network does not support file attachments");
    expect(t.uploads.info(U)).not.toBeNull();
    fb.failNext({ method: "POST", route: "/v1/assets/upload", status: 413, message: "File too large" });
    expect((await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "x", attachmentId: U })).error.code).toBe("TOO_LARGE");
    // Beeper down while uploading: nothing was sent, so the same key may run again.
    await fb.pause();
    expect((await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "x", attachmentId: U, idempotencyKey: "key-0000000003" })).error.code).toBe("BEEPER_DOWN");
    await fb.resume();
    expect((await t.call("send_message", { chatID: CHAT_IDS.imessageAlice, text: "x", attachmentId: U, idempotencyKey: "key-0000000003" })).ok).toBe(true);
  });
});

describe("a file on an agent's draft", () => {
  test("only the agent's own finished upload; draft_store_get names it; draft_store_delete forgets it", async () => {
    const t = await make();
    const rid = "drq_0123456789abcdef";
    await t.call("draft_store_put", { requestId: rid, chatID: CHAT_IDS.imessageAlice, instruction: "x", deadline: new Date(Date.now() + 1800_000).toISOString() });
    await t.upload(PDF_BYTES);
    expect((await t.call("draft_store_set_text", { requestId: rid, text: "Here", attachmentId: U, owner: OTHER })).error.code).toBe("NOT_FOUND");
    expect((await t.call("draft_store_set_text", { requestId: rid, text: "Here", attachmentId: "upl_nothere000000000", owner: OWNER })).error.code).toBe("NOT_FOUND");
    expect((await t.call("draft_store_set_text", { requestId: rid, text: "Here", attachmentId: U, owner: OWNER })).ok).toBe(true);
    expect((await t.call("draft_store_get", { requestIds: [rid] })).data.items).toEqual([{ requestId: rid, chatID: CHAT_IDS.imessageAlice, instruction: "x", text: "Here", attachment: { uploadId: U, fileName: NAME, mimeType: "application/pdf", size: PDF_BYTES.length } }]);
    expect((await t.call("discard_upload", { uploadId: U })).data.deleted).toBe(false);
    await t.call("draft_store_delete", { requestIds: [rid] });
    expect(t.uploads.size).toBe(0);
  });
  test("a new draft text with another file forgets the first file", async () => {
    const t = await make();
    const rid = "drq_0123456789abcdef";
    await t.call("draft_store_put", { requestId: rid, chatID: CHAT_IDS.imessageAlice, instruction: "x", deadline: new Date(Date.now() + 1800_000).toISOString() });
    await t.upload(PDF_BYTES, OWNER, U);
    await t.upload(PDF_BYTES, OWNER, "upl_second0000000000");
    await t.call("draft_store_set_text", { requestId: rid, text: "a", attachmentId: U, owner: OWNER });
    await t.call("draft_store_set_text", { requestId: rid, text: "b", attachmentId: "upl_second0000000000", owner: OWNER });
    expect(t.uploads.info(U)).toBeNull();
    expect(t.uploads.size).toBe(1);
  });
  test("discard_upload forgets the owner's own file", async () => {
    const t = await make();
    await t.upload(PDF_BYTES);
    expect((await t.call("discard_upload", { uploadId: U })).data).toEqual({ uploadId: U, deleted: true });
    expect(t.uploads.size).toBe(0);
  });
});

describe("sending a file by email", () => {
  const box = () => fg.google;
  test("a reply-all with the file (multipart/mixed, in the thread); compose_email with a file and no text", async () => {
    const t = await make({ gmail: true });
    await t.upload(PDF_BYTES);
    const chatID = `gmail:${OWNER_EMAIL}:${THREADS.kickoff}`;
    const r = await t.call("send_message", { chatID, text: "The deck 👋", attachmentId: U });
    expect(r.ok).toBe(true);
    const sent = box().sent().at(-1)!;
    expect(sent.threadId).toBe(THREADS.kickoff);
    expect(sent.text).toBe("The deck 👋");
    expect(sent.attachments).toEqual([expect.objectContaining({ fileName: NAME, mimeType: "application/pdf", bytes: PDF_BYTES })]);
    expect(sent.headers.find((h) => h.name === "In-Reply-To")?.value).toBeTruthy();
    expect(t.uploads.size).toBe(0);
    await t.upload(PDF_BYTES, OWNER, "upl_second0000000000");
    const c = await t.call("compose_email", { accountID: `gmail:${OWNER_EMAIL}`, to: ["alice@example.com"], subject: "The report", attachmentId: "upl_second0000000000" });
    expect(c.ok).toBe(true);
    expect(box().sent().at(-1)!.attachments[0]!.fileName).toBe(NAME);
    expect(t.uploads.size).toBe(0);
  });
});

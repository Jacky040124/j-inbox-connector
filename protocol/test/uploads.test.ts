import { describe, expect, test } from "bun:test";
import { ACTIONS, coerceParams, parseActionParams } from "../src/actions.ts";
import { AGENT_META, buildRaftManifest, isAgentActionName } from "../src/agent.ts";
import { draftView, storedDraft } from "../src/drafts.ts";
import { CAPABILITIES, encodeFrame } from "../src/frames.ts";
import { MAX_CHUNK_BYTES, MAX_FRAME_BYTES, MAX_MEDIA_BYTES } from "../src/limits.ts";
import { parse, type Schema } from "../src/schema.ts";
import {
  AGENT_UPLOAD_FILE_BASE64_LENGTH,
  AGENT_UPLOAD_FILE_MAX_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_CHUNKS,
  UPLOAD_CHUNK_BASE64_LENGTH,
  UPLOAD_CHUNK_BYTES,
  cleanMimeType,
  fileName,
  fileSizeLabel,
  sanitizeFileName,
  uploadHead,
  uploadID,
  uploadInfo,
  uploadOwnerTag,
} from "../src/uploads.ts";
import { chatID } from "./fixtures/examples.ts";

const UPL = "upl_0123456789abcdef";

describe("limits", () => {
  test("25 MiB like get_media, in 256 KiB chunks; one upload_file stays well under a command line", () => {
    expect(MAX_UPLOAD_BYTES).toBe(MAX_MEDIA_BYTES);
    expect(UPLOAD_CHUNK_BYTES).toBe(MAX_CHUNK_BYTES);
    expect(MAX_UPLOAD_CHUNKS).toBe(100);
    expect(AGENT_UPLOAD_FILE_MAX_BYTES).toBe(512 * 1024);
    expect(AGENT_UPLOAD_FILE_BASE64_LENGTH).toBeLessThan(750_000);
  });
  test("the biggest chunk fits a req frame with room to spare", () => {
    const frame = encodeFrame({ type: "req", id: "r_0123456789ab", action: "upload_store_chunk", params: { uploadId: UPL, owner: "o_" + "A".repeat(32), index: MAX_UPLOAD_CHUNKS - 1, data: "A".repeat(UPLOAD_CHUNK_BASE64_LENGTH) } });
    expect(frame.ok).toBe(true);
    if (frame.ok) expect(frame.value.length).toBeLessThan(MAX_FRAME_BYTES / 2);
  });
});

describe("file names", () => {
  test("paths, hidden and reserved characters go; extensions stay", () => {
    expect(sanitizeFileName("/Users/jacky/Documents/Quote 2026.pdf")).toBe("Quote 2026.pdf");
    expect(sanitizeFileName("C:\\Temp\\..\\report.docx")).toBe("report.docx");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName(".env")).toBe("env");
    expect(sanitizeFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFileName("a\u0000b\r\nc.txt")).toBe("abc.txt");
    expect(sanitizeFileName('we"ird:<name>|?*.pdf')).toBe("weirdname.pdf");
    expect(sanitizeFileName("报价 – 最终版.pdf")).toBe("报价 – 最终版.pdf");
    expect(sanitizeFileName("  spaced   out  .pdf  ")).toBe("spaced out .pdf");
    expect(sanitizeFileName("\ud800lone.txt")).toBe("lone.txt");
    for (const v of [null, undefined, 5, "", "   ", "///", "\u200b"]) expect(sanitizeFileName(v)).toBe("file");
  });
  test("long names are cut to the limit, the extension kept, no split surrogate", () => {
    const long = sanitizeFileName("😀".repeat(300) + ".pdf");
    expect(long.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(parse(fileName, long).ok).toBe(true);
  });
  test("fileName accepts exactly what sanitizeFileName leaves alone", () => {
    for (const ok of ["a.pdf", "报价.pdf", "Quote (final) v2.PDF", "x"]) expect(parse(fileName, ok).ok).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", ".hidden", "trailing ", "x\u202e.pdf", "a\nb", "x".repeat(MAX_FILE_NAME_LENGTH + 1)]) expect(parse(fileName, bad).ok).toBe(false);
  });
  test("MIME types: lower case and valid, else octet-stream", () => {
    expect(cleanMimeType("Application/PDF")).toBe("application/pdf");
    expect(cleanMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    for (const v of ["", "pdf", "text/html\r\nX-Evil: 1", null, 3, "a/b c"]) expect(cleanMimeType(v)).toBe("application/octet-stream");
  });
  test("sizes as people read them", () => {
    expect([fileSizeLabel(0), fileSizeLabel(812), fileSizeLabel(14_200), fileSizeLabel(2_400_000), fileSizeLabel(25 * 1024 * 1024)]).toEqual(["0 B", "812 B", "14 KB", "2.3 MB", "25 MB"]);
  });
});

describe("shapes", () => {
  test("upload ids are the cloud's own (upl_)", () => {
    expect(parse(uploadID, UPL).ok).toBe(true);
    for (const bad of ["upl_", "upl_x", "drq_0123456789abcdef", "upl_has space x", "upl_" + "a".repeat(61)]) expect(parse(uploadID, bad).ok).toBe(false);
  });
  test("uploadInfo and the /api/upload head are strict", () => {
    expect(parse(uploadInfo, { uploadId: UPL, fileName: "a.pdf", mimeType: "application/pdf", size: 3 }).ok).toBe(true);
    expect(parse(uploadInfo, { uploadId: UPL, fileName: "a.pdf", mimeType: "application/pdf", size: 3, path: "/tmp/x" }).ok).toBe(false);
    expect(parse(uploadHead, { fileName: "a.pdf", mimeType: "application/pdf", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
    expect(parse(uploadHead, { fileName: "a.pdf", mimeType: "application/pdf", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
    expect(parse(uploadHead, { fileName: "../a.pdf", mimeType: "application/pdf", size: 1 }).ok).toBe(false);
  });
  test("a draft carries its attachment from the computer; the cloud's meta never does", () => {
    const att = { uploadId: UPL, fileName: "quote.pdf", mimeType: "application/pdf", size: 12 };
    expect(parse(storedDraft, { requestId: "drq_0123456789abcdef", chatID, instruction: "x", text: "y", attachment: att }).ok).toBe(true);
    const view = { requestId: "drq_0123456789abcdef", chatID, agent: { id: "a", name: null }, status: "drafted", createdAt: "2026-10-29T09:00:00.000Z", updatedAt: "2026-10-29T09:00:00.000Z", deadline: "2026-10-29T09:30:00.000Z", text: "y", attachment: att };
    expect(parse(draftView, view).ok).toBe(true);
  });
  test("owner tags: per caller, never the sub itself", async () => {
    const a = await uploadOwnerTag({ type: "agent", sub: "agent-1" });
    expect(a).toMatch(/^o_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toContain("agent-1");
    expect(await uploadOwnerTag({ type: "agent", sub: "agent-1" })).toBe(a);
    expect(await uploadOwnerTag({ type: "agent", sub: "agent-2" })).not.toBe(a);
    expect(await uploadOwnerTag({ type: "human", sub: "agent-1" })).not.toBe(a);
    await expect(uploadOwnerTag({ type: "agent", sub: "" })).rejects.toThrow();
  });
});

describe("actions", () => {
  test("send_message and compose_email: text, a file, or both", () => {
    expect(parseActionParams("send_message", { chatID, attachmentId: UPL }).ok).toBe(true);
    const none = parseActionParams("send_message", { chatID });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.issues[0]!.message).toContain("text is required");
    expect(parseActionParams("compose_email", { accountID: "gmail:a@example.com", to: ["b@example.com"], subject: "", attachmentId: UPL }).ok).toBe(true);
    expect(parseActionParams("compose_email", { accountID: "gmail:a@example.com", to: ["b@example.com"], subject: "" }).ok).toBe(false);
  });
  test("the upload store is cloud-only and owner-only; discard_upload is the owner's", () => {
    for (const n of ["upload_store_begin", "upload_store_chunk", "upload_store_commit", "upload_store_delete"] as const) expect([ACTIONS[n].humanOnly, (ACTIONS[n] as { cloudOnly?: boolean }).cloudOnly, ACTIONS[n].write]).toEqual([true, true, true]);
    expect([ACTIONS.discard_upload.humanOnly, (ACTIONS.discard_upload as { cloudOnly?: boolean }).cloudOnly]).toEqual([true, undefined]);
  });
  test("draft_store_set_text: a file goes with its owner tag", () => {
    expect(parseActionParams("draft_store_set_text", { requestId: "drq_0123456789abcdef", text: "x", attachmentId: UPL, owner: "o_0123456789abcdef" }).ok).toBe(true);
    expect(parseActionParams("draft_store_set_text", { requestId: "drq_0123456789abcdef", text: "x", attachmentId: UPL }).ok).toBe(false);
  });
  test("capability attachments.v1", () => expect(CAPABILITIES.attachments).toBe("attachments.v1"));
});

describe("agents", () => {
  test("upload_file, upload_begin, upload_chunk, upload_commit are agent meta actions in the manifest; the store is not", () => {
    for (const n of ["upload_file", "upload_begin", "upload_chunk", "upload_commit"]) expect(isAgentActionName(n)).toBe(true);
    for (const n of ["upload_store_begin", "upload_store_chunk", "upload_store_commit", "upload_store_delete", "discard_upload"]) expect(isAgentActionName(n)).toBe(false);
    const m = buildRaftManifest({ origin: "https://inbox.example.com", service: "j-inbox" });
    const names = m.actions.map((a) => a.name);
    for (const n of ["upload_file", "upload_begin", "upload_chunk", "upload_commit"]) expect(names).toContain(n);
    expect(names).not.toContain("upload_store_chunk");
    expect(m.description).toContain("attachmentId");
    const draft = m.actions.find((a) => a.name === "draft_reply")!;
    expect(draft.parameters.attachmentId).toEqual({ type: "string", description: expect.stringContaining("upload_file"), required: false });
    expect(m.actions.find((a) => a.name === "submit_draft")!.parameters.attachmentId!.required).toBe(false);
    expect(m.actions.find((a) => a.name === "upload_chunk")!.parameters.index!.type).toBe("integer");
  });
  test("upload_chunk params coerce from --param strings", () => {
    const shape = AGENT_META.upload_chunk.params.shape as Record<string, Schema<unknown>>;
    const out = coerceParams(shape, { uploadId: UPL, index: "3", data: "AAEC" });
    expect(out).toEqual({ uploadId: UPL, index: 3, data: "AAEC" });
    expect(parse(AGENT_META.upload_chunk.params, out).ok).toBe(true);
    expect(parse(AGENT_META.upload_chunk.params, { uploadId: UPL, index: 0, data: "A".repeat(UPLOAD_CHUNK_BASE64_LENGTH + 4) }).ok).toBe(false);
    expect(parse(AGENT_META.upload_file.params, { fileName: "a.pdf", data: "A".repeat(AGENT_UPLOAD_FILE_BASE64_LENGTH + 4) }).ok).toBe(false);
    expect(parse(AGENT_META.upload_begin.params, { fileName: "a.pdf", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
    expect(parse(AGENT_META.submit_draft.params, { requestId: "drq_0123456789abcdef", text: "x", attachmentId: UPL }).ok).toBe(true);
  });
});

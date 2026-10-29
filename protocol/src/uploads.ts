// Files sent from J-Inbox (since 2026-10-29, "attachments.v1"): the owner attaches one file to a
// message or an email, an agent attaches one to its draft. A file lives only on the owner's computer
// (the connector's upload store, by an upl_ id the cloud mints) from the moment it is uploaded until
// it is sent, discarded or expires; it only passes through the cloud, in chunks of at most
// MAX_CHUNK_BYTES (cloud-only connector actions upload_store_begin / _chunk / _commit, one req per
// chunk, each answered before the next: stop-and-wait flow control). The cloud keeps nothing of it:
// not the bytes, not the name, not the size. The file name and size are read back from the
// computer like a draft's text (draft_store_get).
import { base64, integer, object, optional, parse, refine, string, type Infer } from "./schema.ts";
import { MAX_CHUNK_BASE64_LENGTH, MAX_CHUNK_BYTES, MAX_MEDIA_BYTES, MEDIA_TIMEOUT_MS } from "./limits.ts";
import { mimeType } from "./model.ts";

/** Largest file J-Inbox sends (the same cap as files it relays, get_media). */
export const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES;
/** Raw bytes per chunk (agents' upload_chunk, the cloud's upload_store_chunk). */
export const UPLOAD_CHUNK_BYTES = MAX_CHUNK_BYTES;
export const UPLOAD_CHUNK_BASE64_LENGTH = MAX_CHUNK_BASE64_LENGTH;
/** Chunks of the largest file. */
export const MAX_UPLOAD_CHUNKS = Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_CHUNK_BYTES);
/**
 * upload_file (an agent's small file in one call). 512 KiB raw is about 700,000 base64 characters:
 * it stays well under macOS's 1 MiB limit for a command line (`raft integration invoke --data-json`).
 */
export const AGENT_UPLOAD_FILE_MAX_BYTES = 512 * 1024;
export const AGENT_UPLOAD_FILE_BASE64_LENGTH = Math.ceil(AGENT_UPLOAD_FILE_MAX_BYTES / 3) * 4;
/** An upload not attached to a draft (the owner's, or an agent's not used yet) is forgotten this long after it began. */
export const UPLOAD_TTL_MS = 60 * 60_000;
/** Uploads the connector keeps at once (open, ready or on a draft), and their total size. */
export const MAX_STORED_UPLOADS = 60;
export const MAX_UPLOAD_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_NAME_LENGTH = 200;
/** Per agent per minute (the cloud's caps on upload_begin + upload_file, and on upload_chunk). */
export const UPLOAD_BEGIN_PER_MINUTE = 10;
export const UPLOAD_CHUNK_PER_MINUTE = 240;
/** A send with a file: the connector uploads it to Beeper (or Gmail) first, so it gets longer than other requests. */
export const SEND_WITH_FILE_TIMEOUT_MS = 2 * MEDIA_TIMEOUT_MS;
/** POST /api/upload: the head line (uploadHead JSON + "\n") before the file's bytes is at most this long. */
export const UPLOAD_HEAD_MAX_BYTES = 2048;
export const DEFAULT_UPLOAD_MIME = "application/octet-stream";

/** An upload id, minted by the cloud. */
export const uploadID = string({ min: 8, max: 64, pattern: /^upl_[A-Za-z0-9_-]+$/, format: "upload-id" });
/** Who may use an upload in a draft: uploadOwnerTag(caller), never the caller's sub itself. */
export const uploadOwner = string({ min: 8, max: 64, pattern: /^o_[A-Za-z0-9_-]+$/, format: "upload-owner" });

// Path separators, the characters Windows and macOS refuse, controls, and bidi / zero-width
// formatting characters (a name like "invoice‮fdp.exe" must not read as a PDF).
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|​-‏‪-‮⁦-⁩⁠-⁤﻿]/;

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Any name (a browser's File.name, an agent's parameter) as a fileName: the last path segment,
 * hidden and reserved characters dropped, leading dots and spaces trimmed (no hidden files), at
 * most MAX_FILE_NAME_LENGTH (the extension kept), "file" when nothing is left.
 */
export function sanitizeFileName(raw: unknown): string {
  let s = typeof raw === "string" ? raw.slice(0, 4096) : "";
  s = s.replace(LONE_SURROGATES, "").split(/[/\\]/).pop() ?? "";
  s = s.replace(new RegExp(NAME_BAD.source, "gu"), "").replace(/\s+/g, " ").replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (s.length > MAX_FILE_NAME_LENGTH) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    let head = s.slice(0, MAX_FILE_NAME_LENGTH - ext.length);
    if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
    s = head.replace(/[\s.]+$/, "") + ext;
  }
  return s || "file";
}

/** A file name as J-Inbox keeps and sends it: what sanitizeFileName leaves unchanged (one plain line, no path, no hidden characters). */
export const fileName = refine(string({ min: 1, max: MAX_FILE_NAME_LENGTH, format: "file-name" }), (v) => (sanitizeFileName(v) === v ? null : "is not a plain file name"));

/** A MIME type as J-Inbox sends it: lower case, valid, else application/octet-stream. */
export function cleanMimeType(raw: unknown): string {
  const v = typeof raw === "string" ? raw.split(";")[0]!.trim().toLowerCase() : "";
  return parse(mimeType, v).ok ? v : DEFAULT_UPLOAD_MIME;
}

/** A finished upload, as the connector keeps it and answers it (upload_store_commit, draft_store_get). */
export const uploadInfo = object({ uploadId: uploadID, fileName, mimeType, size: integer({ min: 0, max: MAX_UPLOAD_BYTES }) });
export type UploadInfo = Infer<typeof uploadInfo>;

/** POST /api/upload: the first line of the body (JSON, then "\n", then exactly `size` bytes of the file). */
export const uploadHead = object({ fileName, mimeType, size: integer({ min: 0, max: MAX_UPLOAD_BYTES }) });
export type UploadHead = Infer<typeof uploadHead>;

/** An agent's upload_begin. mimeType defaults to application/octet-stream. */
export const uploadBeginParams = object({ fileName: string({ min: 1, max: 1024 }), mimeType: optional(string({ min: 1, max: 255 })), size: integer({ min: 0, max: MAX_UPLOAD_BYTES }) });
export const uploadChunkData = base64({ max: UPLOAD_CHUNK_BASE64_LENGTH });
export const uploadFileData = base64({ max: AGENT_UPLOAD_FILE_BASE64_LENGTH });

/**
 * The owner tag the connector keeps with an upload: a digest of the caller, so an agent can attach
 * to its draft only what it uploaded itself, and the computer never learns the caller's sub.
 */
export async function uploadOwnerTag(caller: { type: "human" | "agent"; sub: string }): Promise<string> {
  if (!caller || (caller.type !== "human" && caller.type !== "agent") || typeof caller.sub !== "string" || caller.sub.length < 1 || caller.sub.length > 128) throw new Error("invalid caller");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`j-inbox upload owner\u0000${caller.type}\u0000${caller.sub}`)));
  let bin = "";
  for (const b of digest.subarray(0, 24)) bin += String.fromCharCode(b);
  return "o_" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes as people read them (KB = 1024 bytes, like the web's file cards): "812 B", "14 KB", "2.4 MB". */
export function fileSizeLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

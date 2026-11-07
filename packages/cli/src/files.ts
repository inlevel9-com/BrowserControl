// Helpers shared by CLI commands and the MCP server: reading local files for upload, pulling
// daemon artifacts (recordings, downloads) to a local path, and rendering tables.
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { type ArtifactInfo, type ArtifactReadResult, RpcFailure, rpcError, type TableData, type WireFile } from "@browser-control/protocol";
import { rpc } from "./client";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".hwp": "application/x-hwp",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function readWireFiles(paths: string[]): WireFile[] {
  let total = 0;
  return paths.map((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new RpcFailure(rpcError("not_found", `file not found: ${abs}`, { reason: "local_file_missing" }));
    const st = statSync(abs);
    if (!st.isFile()) throw new RpcFailure(rpcError("invalid_params", `not a file: ${abs}`, { reason: "local_not_file" }));
    total += st.size;
    if (total > MAX_UPLOAD_BYTES) throw new RpcFailure(rpcError("invalid_params", `upload is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`, { reason: "upload_too_large" }));
    return { name: basename(abs), mime: mimeFor(abs), data: readFileSync(abs).toString("base64") };
  });
}

/**
 * Copy a daemon artifact to `out` (a file path, or an existing directory to keep the artifact's
 * name). Works the same for a local or a remote daemon. Returns the absolute path written.
 */
export async function fetchArtifact(a: ArtifactInfo, out: string): Promise<string> {
  let dest = resolve(out);
  if (existsSync(dest) && statSync(dest).isDirectory()) dest = join(dest, a.name);
  const tmp = `${dest}.part`;
  const fd = openSync(tmp, "w");
  try {
    let offset = 0;
    for (;;) {
      const r = await rpc<ArtifactReadResult>("artifact.read", { artifact_id: a.artifact_id, offset }, { timeoutMs: 120_000 });
      const buf = Buffer.from(r.data, "base64");
      if (buf.length) writeSync(fd, buf, 0, buf.length, offset);
      offset += buf.length;
      if (r.eof || buf.length === 0) break;
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  return dest;
}

// --------------------------------------------------------------------------- tables

export type TableFormat = "md" | "csv" | "tsv" | "json";

function csvCell(v: string, sep: string): string {
  if (sep === "\t") return v.replace(/[\t\r\n]+/g, " ");
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderTable(t: TableData, format: TableFormat): string {
  const hasHeaders = t.headers.some(Boolean);
  if (format === "json") {
    if (!hasHeaders) return JSON.stringify(t.rows, null, 2);
    const keys = t.headers.map((h, i) => h || `column_${i + 1}`);
    return JSON.stringify(t.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""]))), null, 2);
  }
  if (format === "csv" || format === "tsv") {
    const sep = format === "csv" ? "," : "\t";
    const lines = (hasHeaders ? [t.headers, ...t.rows] : t.rows).map((r) => r.map((c) => csvCell(c, sep)).join(sep));
    return lines.join("\n");
  }
  const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = hasHeaders ? t.headers : t.headers.map((_, i) => `col ${i + 1}`);
  const lines = [`| ${head.map(esc).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const r of t.rows) lines.push(`| ${r.map(esc).join(" | ")} |`);
  return lines.join("\n");
}

export function describeTable(t: TableData): string {
  return `table ${t.index} @${t.ref}${t.caption ? ` "${t.caption}"` : ""} — ${t.row_count} row(s) × ${t.column_count} column(s)${t.truncated ? `, showing first ${t.rows.length}` : ""}`;
}

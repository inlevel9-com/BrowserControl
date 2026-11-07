// Artifacts: files on the daemon's machine (recordings, downloads) that a CLI — local or remote —
// pulls in chunks with `artifact.read`. Ids are random and live only as long as the daemon.
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type ArtifactInfo, type ArtifactReadResult, RpcFailure, rpcError } from "@browser-control/protocol";

export const MAX_CHUNK = 4 * 1024 * 1024;

export class ArtifactStore {
  private items = new Map<string, ArtifactInfo>();

  add(a: Omit<ArtifactInfo, "artifact_id" | "created_at" | "size"> & { size?: number }): ArtifactInfo {
    const size = a.size ?? statSync(a.path).size;
    const info: ArtifactInfo = { ...a, size, artifact_id: `a_${randomBytes(9).toString("base64url")}`, created_at: new Date().toISOString() };
    this.items.set(info.artifact_id, info);
    return info;
  }

  get(id: string): ArtifactInfo {
    const a = this.items.get(id);
    if (!a) throw new RpcFailure(rpcError("not_found", `artifact ${id} not found`, { reason: "artifact_not_found", hint: "artifacts last until the daemon restarts; record or fetch the download again" }));
    return a;
  }

  list(sessionId?: string): ArtifactInfo[] {
    return Array.from(this.items.values()).filter((a) => !sessionId || a.session_id === sessionId);
  }

  read(id: string, offset = 0, length = MAX_CHUNK): ArtifactReadResult {
    const a = this.get(id);
    let size: number;
    try {
      size = statSync(a.path).size;
    } catch {
      throw new RpcFailure(rpcError("not_found", `artifact file ${a.path} no longer exists`, { reason: "artifact_file_missing" }));
    }
    const start = Math.max(0, Math.floor(offset));
    const len = Math.max(0, Math.min(Math.floor(length) || MAX_CHUNK, MAX_CHUNK, size - start));
    const buf = Buffer.alloc(len);
    if (len > 0) {
      const fd = openSync(a.path, "r");
      try {
        let got = 0;
        while (got < len) {
          const n = readSync(fd, buf, got, len - got, start + got);
          if (n <= 0) break;
          got += n;
        }
      } finally {
        closeSync(fd);
      }
    }
    return { artifact_id: id, offset: start, data: buf.toString("base64"), size, eof: start + len >= size };
  }
}

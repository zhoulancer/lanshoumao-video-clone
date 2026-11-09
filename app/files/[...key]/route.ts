import { NextRequest } from "next/server";
import fsp from "fs/promises";
import path from "path";

/**
 * 本地文件公开下载路由（支持 Range）
 * --------------------------------------------------------------
 * 关键：必须返回 Content-Length 并支持 HTTP Range，
 * 否则浏览器 <video> 会卡在 stalled / readyState=0，
 * 表现为「预览不出画面」「截首帧一直转圈」。
 *
 * 实现上采用整块读取 + 手动切片（本工具的视频都在 50MB 量级，
 * 流式 Response 在部分环境下会 stalled，这里以稳定优先）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".json": "application/json",
};

function resolveLocalPath(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\//g, path.sep);
  const absolute = path.resolve(STORAGE_DIR, normalized);
  const base = path.resolve(STORAGE_DIR) + path.sep;
  if (absolute !== path.resolve(STORAGE_DIR) && !absolute.startsWith(base)) {
    throw new Error("Invalid storage key");
  }
  return absolute;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  try {
    const { key } = await params;
    if (!key || key.length === 0) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }

    const localPath = resolveLocalPath(key.join("/"));
    let stat;
    try {
      stat = await fsp.stat(localPath);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === "ENOENT") {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }
      throw error;
    }
    if (!stat.isFile()) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }

    const size = stat.size;
    const contentType = MIME[path.extname(localPath).toLowerCase()] || "application/octet-stream";
    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      "Last-Modified": stat.mtime.toUTCString(),
    };

    const range = request.headers.get("range");
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= size) end = size - 1;
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
        const buf = await fsp.readFile(localPath);
        const slice = buf.subarray(start, end + 1);
        return new Response(new Uint8Array(slice), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(slice.length),
          },
        });
      }
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: { ...baseHeaders, "Content-Length": String(size) } });
    }

    const data = await fsp.readFile(localPath);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(data.length) },
    });
  } catch (error) {
    console.error("Local file read error:", error);
    return new Response(JSON.stringify({ error: "Failed to read file" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  return GET(request, { params });
}

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { resolveFfmpegPath } from "@/lib/video-processor/ffmpeg-path";

/**
 * 本地视频剪辑（纯本机 FFmpeg，不联网）
 * ------------------------------------------------------------------
 * GET  /api/video-cut   → 列出本地存储里可剪辑的视频
 * POST /api/video-cut   → { key, start, end, speed } 裁剪 / 变速，返回新文件地址
 *
 * 说明：原项目 /api/video-edit 依赖外部「自托管 FFmpeg 服务」+ DeepSeek 云端解析，
 * 单机离线包内不可用，因此这里改为直接调用本机 ffmpeg.exe。
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const VIDEO_DIR = path.join(STORAGE_DIR, "videos");
const OUTPUT_DIR = path.join(VIDEO_DIR, "clips");
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

function resolveLocalPath(key: string): string {
  // 列表返回的 key 是相对 data/storage/videos 的（如 xxx.mp4、clips/xxx.mp4）
  const normalized = key
    .replace(/^\/+/, "")
    .replace(/^files\//, "")
    .replace(/^videos\//, "")
    .replace(/\//g, path.sep);
  const absolute = path.resolve(VIDEO_DIR, normalized);
  const base = path.resolve(VIDEO_DIR) + path.sep;
  if (!absolute.startsWith(base)) throw new Error("非法的存储路径");
  return absolute;
}

async function listVideos(limit = 60) {
  const results: Array<{ key: string; name: string; size: number; mtime: number }> = [];

  async function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!VIDEO_EXT.test(entry.name)) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      results.push({ key: rel, name: entry.name, size: stat.size, mtime: stat.mtimeMs });
    }
  }

  await walk(VIDEO_DIR, "");
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `FFmpeg 退出码 ${code}：${stderr.split("\n").filter(Boolean).slice(-3).join(" ")}`,
          ),
        );
    });
  });
}

export async function GET() {
  const videos = await listVideos();
  return NextResponse.json({ ok: true, videos });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { key?: string; start?: number; end?: number; speed?: number }
    | null;

  const key = body?.key?.trim();
  if (!key) {
    return NextResponse.json({ ok: false, error: "请选择要剪辑的视频" }, { status: 400 });
  }

  const start = Number(body?.start ?? 0);
  const end = Number(body?.end ?? 0);
  const speed = Number(body?.speed ?? 1);

  if (!Number.isFinite(start) || start < 0) {
    return NextResponse.json({ ok: false, error: "起始时间不合法" }, { status: 400 });
  }
  if (!Number.isFinite(end) || end <= start) {
    return NextResponse.json({ ok: false, error: "结束时间必须大于起始时间" }, { status: 400 });
  }
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    return NextResponse.json({ ok: false, error: "倍速需在 0.25–4 之间" }, { status: 400 });
  }

  try {
    const input = resolveLocalPath(key);
    try {
      await fs.access(input);
    } catch {
      throw new Error("视频文件不存在");
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const base = path.basename(input, path.extname(input)).replace(/[^\w.\-]+/g, "_");
    const stamp = `${start.toFixed(1)}-${end.toFixed(1)}${speed !== 1 ? `_x${speed}` : ""}`.replace(
      /\./g,
      "p",
    );
    const outName = `${base}_${stamp}.mp4`;
    const output = path.join(OUTPUT_DIR, outName);

    const args = ["-y", "-ss", String(start), "-to", String(end), "-i", input];

    if (speed !== 1) {
      args.push(
        "-filter_complex",
        `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
      );
    }

    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      output,
    );

    await runFfmpeg(args);

    const stat = await fs.stat(output);
    return NextResponse.json({
      ok: true,
      url: `/files/videos/clips/${encodeURIComponent(outName)}`,
      name: outName,
      size: stat.size,
      duration: Math.round(((end - start) / speed) * 10) / 10,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

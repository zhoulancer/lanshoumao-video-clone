import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { resolveFfmpegPath } from "@/lib/video-processor/ffmpeg-path";
import { transcribeWithLocalWhisper } from "@/lib/audio-processor/local-whisper";
import { readLocalAiConfig } from "@/lib/config/local-ai";

/**
 * 字幕功能（本地）
 * ------------------------------------------------------------------
 * POST /api/subtitle
 *   { action: "recognize", key }                 → 用本地 Whisper 识别字幕
 *   { action: "srt", segments }                  → 返回 SRT 文本（前端下载）
 *   { action: "burn", key, segments, style? }    → 烧录硬字幕，输出新视频
 *
 * key 是相对 data/storage/videos 的路径。
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const VIDEO_DIR = path.join(STORAGE_DIR, "videos");
const OUTPUT_DIR = path.join(VIDEO_DIR, "clips");

interface SubSegment {
  start: number;
  end: number;
  text: string;
}

function resolveLocalPath(key: string): string {
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

/** 秒 → SRT 时间码 00:00:01,200 */
function srtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function buildSrt(segments: SubSegment[]): string {
  return segments
    .filter((s) => s.text.trim())
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
    .join("\n");
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-6000);
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

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        action?: string;
        key?: string;
        segments?: SubSegment[];
        style?: { fontSize?: number; color?: string; position?: string };
      }
    | null;

  if (!body?.action) {
    return NextResponse.json({ ok: false, error: "缺少 action" }, { status: 400 });
  }

  // ---- 导出 SRT 文本 ----
  if (body.action === "srt") {
    const segments = (body.segments || []).filter((s) => s && s.text?.trim());
    if (segments.length === 0) {
      return NextResponse.json({ ok: false, error: "没有可导出的字幕" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, srt: buildSrt(segments) });
  }

  const key = body.key?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "缺少视频 key" }, { status: 400 });

  try {
    const input = resolveLocalPath(key);
    await fs.access(input).catch(() => {
      throw new Error("视频文件不存在");
    });

    // ---- 识别字幕 ----
    if (body.action === "recognize") {
      const cfg = readLocalAiConfig();
      const result = await transcribeWithLocalWhisper(input, cfg.whisperModel || "small");
      return NextResponse.json({
        ok: true,
        language: result.language,
        duration: result.duration,
        segments: (result.segments || []).map((s) => ({
          start: Number(s.start.toFixed(2)),
          end: Number(s.end.toFixed(2)),
          text: s.text.trim(),
        })),
      });
    }

    // ---- 烧录硬字幕 ----
    if (body.action === "burn") {
      const segments = (body.segments || []).filter((s) => s && s.text?.trim());
      if (segments.length === 0) {
        return NextResponse.json({ ok: false, error: "没有可烧录的字幕" }, { status: 400 });
      }

      await fs.mkdir(OUTPUT_DIR, { recursive: true });

      const srtPath = path.join(os.tmpdir(), `pl-sub-${Date.now()}.srt`);
      await fs.writeFile(srtPath, buildSrt(segments), "utf8");

      const base = path.basename(input, path.extname(input)).replace(/[^\w.\-]+/g, "_");
      const outName = `${base}_sub_${Date.now().toString(36)}.mp4`;
      const output = path.join(OUTPUT_DIR, outName);

      const fontSize = Number(body.style?.fontSize ?? 20);
      // ASS 颜色格式：&HAABBGGRR（BGR），白色为 &HFFFFFF&，描边黑色
      const forceStyle = [
        "FontName=Microsoft YaHei",
        `FontSize=${fontSize}`,
        "PrimaryColour=&HFFFFFF&",
        "OutlineColour=&H000000&",
        "BorderStyle=1",
        "Outline=2",
        "Shadow=0",
        "MarginV=24",
        "Alignment=2",
      ].join(",");

      // Windows 路径在 subtitles 滤镜里要转义盘符冒号
      const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      const vf = `subtitles='${escapedSrt}':force_style='${forceStyle}'`;

      await runFfmpeg([
        "-y",
        "-i", input,
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        output,
      ]);

      const stat = await fs.stat(output);
      return NextResponse.json({
        ok: true,
        url: `/files/videos/clips/${encodeURIComponent(outName)}`,
        name: outName,
        size: stat.size,
      });
    }

    return NextResponse.json({ ok: false, error: "未知 action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import fsSync from "fs";
import { spawn } from "child_process";
import { resolveFfmpegPath } from "@/lib/video-processor/ffmpeg-path";

/**
 * 本地视频剪辑工作台（本机 FFmpeg · 增强版）
 * ------------------------------------------------------------------
 * GET  /api/video-studio   → 列出可剪辑的本地视频
 * POST /api/video-studio   → 执行剪辑，返回结果地址
 *
 * 能力：
 *   片段裁剪 / 多段拼接   segments: [{start,end}, ...]
 *   变速（音画同步）       speed: 0.25–4
 *   画面比例转换           aspect: 9:16 | 16:9 | 1:1 | 4:3 | 3:4
 *   调色                   color: { brightness, contrast, saturation }
 *   旋转 / 翻转            rotate: 90|180|270, flip: h|v
 *   音量 / 静音            volume: 0–2
 *   淡入淡出               fadeIn / fadeOut（秒）
 *   文字水印               text: { content, position, size, color }
 *   导出                   format: mp4 | gif | mp3
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const VIDEO_DIR = path.join(STORAGE_DIR, "videos");
const OUTPUT_DIR = path.join(VIDEO_DIR, "clips");
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

const ASPECTS: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:3": [1440, 1080],
  "3:4": [1080, 1440],
};

interface StudioBody {
  key?: string;
  segments?: Array<{ start: number; end: number }>;
  speed?: number;
  aspect?: string;
  color?: { brightness?: number; contrast?: number; saturation?: number };
  rotate?: number;
  flip?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  text?: { content?: string; position?: string; size?: number; color?: string };
  format?: string;
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

async function listVideos(limit = 80) {
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

/** atempo 单次只吃 0.5–2.0，超出要串联 */
function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let rest = speed;
  while (rest > 2.0001) {
    parts.push("atempo=2");
    rest /= 2;
  }
  while (rest < 0.4999) {
    parts.push("atempo=0.5");
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 0.001) parts.push(`atempo=${rest.toFixed(4)}`);
  return parts;
}

function findFont(): string | null {
  for (const c of [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/arial.ttf",
  ]) {
    try {
      if (fsSync.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function GET() {
  const videos = await listVideos();
  return NextResponse.json({ ok: true, videos });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as StudioBody | null;

  const key = body?.key?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "请选择要剪辑的视频" }, { status: 400 });

  const format = (body?.format || "mp4").toLowerCase();
  const speed = Number(body?.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    return NextResponse.json({ ok: false, error: "倍速需在 0.25–4 之间" }, { status: 400 });
  }

  const rawSegments = Array.isArray(body?.segments) ? body.segments : [];
  const segments = rawSegments
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: s.end }));
  const hasCut = segments.length > 0;

  try {
    const input = resolveLocalPath(key);
    try {
      await fs.access(input);
    } catch {
      throw new Error("视频文件不存在");
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const base = path.basename(input, path.extname(input)).replace(/[^\w.\-]+/g, "_");
    const ext = format === "gif" ? "gif" : format === "mp3" ? "mp3" : "mp4";
    const outName = `${base}_edit_${Date.now().toString(36)}.${ext}`;
    const output = path.join(OUTPUT_DIR, outName);

    const cutDuration = hasCut ? segments.reduce((sum, s) => sum + (s.end - s.start), 0) : 0;
    const approxDuration = cutDuration / speed;

    const buildArgs = (withAudio: boolean): string[] => {
      const args: string[] = ["-y", "-i", input];

      // MP3：只走音频链路，不能映射视频流（否则 -vn 冲突）
      if (format === "mp3") {
        const parts: string[] = [];
        let aLabel = "0:a";
        if (hasCut) {
          segments.forEach((seg, i) => {
            parts.push(
              `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[am${i}]`,
            );
          });
          parts.push(
            `${segments.map((_, i) => `[am${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[ca]`,
          );
          aLabel = "ca";
        }
        const chain: string[] = [];
        if (Math.abs(speed - 1) > 0.001) chain.push(...atempoChain(speed));
        const vol = Number(body?.volume ?? 1);
        if (vol === 0) chain.push("volume=0");
        else if (Math.abs(vol - 1) > 0.001) chain.push(`volume=${vol}`);

        parts.push(chain.length > 0 ? `[${aLabel}]${chain.join(",")}[aout]` : `[${aLabel}]anull[aout]`);
        args.push(
          "-filter_complex", parts.join(";"),
          "-map", "[aout]",
          "-vn", "-c:a", "libmp3lame", "-b:a", "192k",
          output,
        );
        return args;
      }
      const graph: string[] = [];
      let vLabel = "0:v";
      let aLabel = "0:a";

      // 1) 裁剪 / 拼接
      if (hasCut) {
        const parts: string[] = [];
        segments.forEach((seg, i) => {
          parts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
          if (withAudio) {
            parts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
          }
        });
        if (withAudio) {
          const pairs = segments.map((_, i) => `[v${i}][a${i}]`).join("");
          parts.push(`${pairs}concat=n=${segments.length}:v=1:a=1[cv][ca]`);
          aLabel = "ca";
        } else {
          const vs = segments.map((_, i) => `[v${i}]`).join("");
          parts.push(`${vs}concat=n=${segments.length}:v=1:a=0[cv]`);
        }
        graph.push(...parts);
        vLabel = "cv";
      }

      const vChain: string[] = [];
      const aChain: string[] = [];

      // 2) 变速
      if (Math.abs(speed - 1) > 0.001) {
        vChain.push(`setpts=PTS/${speed}`);
        if (withAudio) aChain.push(...atempoChain(speed));
      }

      // 3) 比例转换
      const aspect = body?.aspect && ASPECTS[body.aspect] ? body.aspect : "";
      if (aspect) {
        const [w, h] = ASPECTS[aspect];
        vChain.push(
          `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
          "setsar=1",
        );
      }

      // 4) 调色
      const color = body?.color || {};
      const bright = Number(color.brightness ?? 0);
      const contrast = Number(color.contrast ?? 1);
      const saturation = Number(color.saturation ?? 1);
      if (bright !== 0 || contrast !== 1 || saturation !== 1) {
        vChain.push(`eq=brightness=${bright}:contrast=${contrast}:saturation=${saturation}`);
      }

      // 5) 旋转 / 翻转
      const rotate = Number(body?.rotate ?? 0);
      if (rotate === 90) vChain.push("transpose=1");
      else if (rotate === 180) vChain.push("transpose=1,transpose=1");
      else if (rotate === 270) vChain.push("transpose=2");
      if (body?.flip === "h") vChain.push("hflip");
      if (body?.flip === "v") vChain.push("vflip");

      // 6) 淡入淡出
      const fadeIn = Number(body?.fadeIn ?? 0);
      const fadeOut = Number(body?.fadeOut ?? 0);
      if (fadeIn > 0) vChain.push(`fade=t=in:st=0:d=${fadeIn}`);
      if (fadeOut > 0 && approxDuration > fadeOut) {
        vChain.push(`fade=t=out:st=${(approxDuration - fadeOut).toFixed(2)}:d=${fadeOut}`);
      }

      // 7) 文字水印
      const textContent = (body?.text?.content || "").trim();
      if (textContent) {
        const font = findFont();
        const fontSize = Number(body?.text?.size ?? 36);
        const fontColor =
          (body?.text?.color || "white").replace(/[^a-zA-Z#0-9]/g, "") || "white";
        const posMap: Record<string, [string, string]> = {
          tl: ["20", "20"],
          tr: ["w-tw-20", "20"],
          bl: ["20", "h-th-20"],
          br: ["w-tw-20", "h-th-20"],
          center: ["(w-tw)/2", "(h-th)/2"],
          bottom: ["(w-tw)/2", "h-th-40"],
        };
        const [x, y] = posMap[body?.text?.position || "bottom"] || posMap.bottom;
        const safeText = textContent
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:")
          .replace(/'/g, "\\'")
          .replace(/%/g, "\\%");
        const fontPart = font ? `fontfile='${font}':` : "";
        vChain.push(
          `drawtext=${fontPart}text='${safeText}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=${fontColor}:borderw=2:bordercolor=black@0.8`,
        );
      }

      // 8) 音量
      const volume = Number(body?.volume ?? 1);
      if (withAudio) {
        if (volume === 0) aChain.push("volume=0");
        else if (Math.abs(volume - 1) > 0.001) aChain.push(`volume=${volume}`);
      }

      // 组装
      if (graph.length > 0 || vChain.length > 0 || aChain.length > 0) {
        graph.push(
          vChain.length > 0 ? `[${vLabel}]${vChain.join(",")}[vout]` : `[${vLabel}]null[vout]`,
        );
        if (withAudio) {
          graph.push(
            aChain.length > 0 ? `[${aLabel}]${aChain.join(",")}[aout]` : `[${aLabel}]anull[aout]`,
          );
        }
        args.push("-filter_complex", graph.join(";"), "-map", "[vout]");
        if (withAudio && format !== "gif") args.push("-map", "[aout]");
      }

      if (format === "gif") {
        args.push("-an", "-loop", "0", "-r", "12", output);
      } else if (format === "mp3") {
        args.push("-vn", "-c:a", "libmp3lame", "-b:a", "192k", output);
      } else {
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
      }
      return args;
    };

    // 先按带音轨处理；无声视频自动退回无声流程
    try {
      await runFfmpeg(buildArgs(format !== "mp3"));
    } catch (firstError) {
      try {
        await runFfmpeg(buildArgs(false));
      } catch {
        throw firstError;
      }
    }

    const stat = await fs.stat(output);
    return NextResponse.json({
      ok: true,
      url: `/files/videos/clips/${encodeURIComponent(outName)}`,
      name: outName,
      size: stat.size,
      format: ext,
      duration: Math.round((approxDuration || 0) * 10) / 10,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

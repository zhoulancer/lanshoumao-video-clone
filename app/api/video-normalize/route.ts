import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

/**
 * POST /api/video-normalize
 * 接收上传的视频，必要时转成浏览器可播放的 H.264。
 * 浏览器无法解码 HEVC/H.265 等编码：预览黑屏、canvas 抽帧全黑，
 * 导致「视频分析」只能描述纯黑空镜。所以抽帧前必须先归一化。
 */
export const runtime = "nodejs";
export const maxDuration = 600;

export const MAX_UPLOAD_MB = 20;
export const MAX_UPLOAD_SECONDS = 600; // 极端安全上限（10 分钟），正常一律截断到 15 秒
// 分析只取前 N 秒（H3 单条最多 15 秒，后面用不上）
export const ANALYZE_TRIM_SECONDS = 15;

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

function run(cmd: string, args: string[], timeoutMs = 600000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.stderr?.on("data", (d) => { err += d.toString(); });
    p.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: "spawn failed" }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

function safeName(name: string) {
  return (name || "upload.mp4").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(-80);
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "没有收到文件" }, { status: 400 });
    }

    const buf = Buffer.from(await (file as File).arrayBuffer());
    if (buf.length > MAX_UPLOAD_MB * 1024 * 1024) {
      return NextResponse.json(
        { ok: false, error: `文件 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_UPLOAD_MB}MB 上限` },
        { status: 413 },
      );
    }
    const dir = path.join(STORAGE_DIR, "uploads", "video");
    await fs.mkdir(dir, { recursive: true });

    const original = safeName((file as File).name || "upload.mp4");
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${original}`;
    const dest = path.join(dir, key);
    await fs.writeFile(dest, buf);

    // 时长限制：只处理短视频
    const durProbe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nk=1:nw=1", dest], 60000);
    const durationSec = parseFloat(durProbe.stdout.trim()) || 0;
    if (durationSec > MAX_UPLOAD_SECONDS + 0.5) {
      await fs.rm(dest, { force: true });
      return NextResponse.json(
        { ok: false, error: `视频 ${durationSec.toFixed(1)} 秒，超过 ${MAX_UPLOAD_SECONDS} 秒上限，请先裁剪` },
        { status: 413 },
      );
    }

    // 只保留前 N 秒：视频长于上限时自动截断，后面的不参与分析
    const trimParam = Number(request.nextUrl.searchParams.get("trim") || ANALYZE_TRIM_SECONDS);
    const trimSec = Number.isFinite(trimParam) && trimParam > 0 ? trimParam : ANALYZE_TRIM_SECONDS;
    let trimmed = false;
    let finalDuration = durationSec;
    if (durationSec > trimSec + 0.3) {
      const cut = dest + ".cut.mp4";
      const cutRes = await run("ffmpeg", ["-y", "-i", dest, "-t", String(trimSec),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", cut], 600000);
      if (cutRes.code === 0) {
        await fs.rm(dest, { force: true });
        await fs.rename(cut, dest);
        trimmed = true;
        finalDuration = trimSec;
      } else {
        await fs.rm(cut, { force: true });
      }
    }

    // 探测编码
    const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", dest], 60000);
    const [codec = "", pixFmt = ""] = probe.stdout.trim().split(",");
    const okCodec = codec === "h264";
    const okPix = !pixFmt || pixFmt === "yuv420p" || pixFmt === "yuvj420p";
    let transcoded = false;

    if (probe.code !== 0 || !okCodec || !okPix) {
      const tmp = dest + ".tmp.mp4";
      const res = await run("ffmpeg", ["-y", "-i", dest,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp]);
      if (res.code === 0) {
        await fs.rm(dest, { force: true });
        await fs.rename(tmp, dest);
        transcoded = true;
      } else {
        await fs.rm(tmp, { force: true });
        console.error("[normalize] 转码失败:", res.stderr.slice(-300));
      }
    }

    return NextResponse.json({
      ok: true,
      url: `/files/uploads/video/${encodeURIComponent(key)}`,
      name: key,
      transcoded,
      trimmed,
      durationSec: finalDuration,
      codec: codec || "unknown",
      pixFmt: pixFmt || "unknown",
    });
  } catch (error: any) {
    console.error("normalize error:", error);
    return NextResponse.json({ ok: false, error: error?.message || "归一化失败" }, { status: 500 });
  }
}

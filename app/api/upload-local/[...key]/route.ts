import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { auth } from "@/lib/auth";

/**
 * 本地上传路由（替代 R2 presigned PUT 直传）
 * --------------------------------------------------------------
 * 浏览器通过 XHR PUT 到 /api/upload-local/<key>，本路由把请求体
 * 直接写入本地存储目录，并返回 200。用于替代 R2 的签名直传。
 * 与 lib/cloudflare/r2.ts 的 getPresignedUploadUrl 保持一致。
 */


/** 运行外部命令，返回 { code, stdout, stderr } */
function run(cmd: string, args: string[], timeoutMs = 600000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.stderr?.on("data", (d) => { err += d.toString(); });
    p.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: "spawn failed" }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

/**
 * 浏览器兼容性归一化
 * HEVC/10bit/其它编码浏览器无法播放，且抽帧会得到全黑画面，
 * 导致「视频分析」只描述黑屏。上传后自动转成 H.264 + yuv420p + AAC。
 */
async function ensureBrowserPlayable(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (![".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(ext)) return;

  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", filePath], 60000);
  if (probe.code !== 0) return;

  const [codec = "", pixFmt = ""] = probe.stdout.trim().split(",");
  const okCodec = codec === "h264";
  const okPix = !pixFmt || pixFmt === "yuv420p" || pixFmt === "yuvj420p";
  if (okCodec && okPix) return;

  console.log(`[upload] 转码 ${path.basename(filePath)}：${codec}/${pixFmt} → h264/yuv420p`);
  const tmp = filePath + ".tmp" + ext;
  const res = await run("ffmpeg", ["-y", "-i", filePath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp]);

  if (res.code === 0) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tmp, filePath);
    console.log("[upload] 转码完成:", path.basename(filePath));
  } else {
    await fs.rm(tmp, { force: true });
    console.error("[upload] 转码失败:", res.stderr.slice(-300));
  }
}

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

/** 将 key 安全映射到本地绝对路径并阻止目录穿越。 */
function resolveLocalPath(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\//g, path.sep);
  const absolute = path.resolve(STORAGE_DIR, normalized);
  const base = path.resolve(STORAGE_DIR) + path.sep;
  if (absolute !== path.resolve(STORAGE_DIR) && !absolute.startsWith(base)) {
    throw new Error("Invalid storage key");
  }
  return absolute;
}

export async function PUT(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 从 URL 提取 key，如 /api/upload-local/users/xxx/video/abc.mp4
    const pathname = request.nextUrl.pathname;
    const prefix = "/api/upload-local/";
    if (!pathname.startsWith(prefix)) {
      return NextResponse.json({ error: "Invalid upload path" }, { status: 400 });
    }
    const key = decodeURIComponent(pathname.slice(prefix.length));
    if (!key) {
      return NextResponse.json({ error: "Invalid upload key" }, { status: 400 });
    }

    const localPath = resolveLocalPath(key);
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    // 读取请求体并写入本地文件
    const arrayBuffer = await request.arrayBuffer();
    await fs.writeFile(localPath, Buffer.from(arrayBuffer));

    // 浏览器不能播的编码（HEVC 等）自动转码，否则播放黑屏、抽帧全黑
    await ensureBrowserPlayable(localPath);

    return new NextResponse(null, { status: 200 });
  } catch (error: any) {
    console.error("Local upload error:", error);
    return NextResponse.json(
      { error: error?.message || "Local upload failed" },
      { status: 500 }
    );
  }
}

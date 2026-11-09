import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { db, videoGeneration } from "@/lib/db";

/**
 * 产品库：把生成的视频永久沉淀到本地，随时可在「产品库」页回看/下载。
 *
 * - 文件复制到 data/storage/library/<taskId>.mp4（不再依赖 H3 的临时链接）
 * - 同时抽取首帧作为封面 <taskId>.jpg
 * - 记录写入 video_generation 表（taskId 唯一，重复保存会更新）
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");
const LIBRARY_DIR = path.join(STORAGE_DIR, "library");

function run(cmd: string, args: string[], timeoutMs = 120000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: "spawn failed" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
  const r = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1", file]);
  const nums = r.stdout.trim().split(/\s+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  // 输出顺序：width, height, duration
  const [width = 0, height = 0, duration = 0] = nums;
  return { duration, width, height };
}

export interface SaveToLibraryInput {
  taskId: string;
  userId: string;
  prompt: string;
  /** 已在本地的视频文件绝对路径 */
  filePath: string;
  provider?: string;
  model?: string;
  extra?: Record<string, unknown>;
}

export async function saveToLibrary(input: SaveToLibraryInput): Promise<{ ok: boolean; url?: string; poster?: string; error?: string }> {
  try {
    await fs.mkdir(LIBRARY_DIR, { recursive: true });
    const safeId = input.taskId.replace(/[^\w.-]+/g, "_");
    const dest = path.join(LIBRARY_DIR, `${safeId}.mp4`);
    if (path.resolve(dest) !== path.resolve(input.filePath)) {
      await fs.copyFile(input.filePath, dest);
    }

    const info = await probe(dest);
    const posterFile = path.join(LIBRARY_DIR, `${safeId}.jpg`);
    const poster = await run("ffmpeg", ["-y", "-ss", "0", "-i", dest, "-frames:v", "1", "-update", "1",
      "-vf", "scale=480:-1", "-q:v", "3", posterFile]);
    const posterUrl = poster.code === 0 ? `/files/library/${safeId}.jpg` : null;
    const url = `/files/library/${safeId}.mp4`;

    await db
      .insert(videoGeneration)
      .values({
        userId: input.userId,
        taskId: input.taskId,
        prompt: input.prompt,
        duration: Math.round(info.duration),
        resolution: info.width && info.height ? `${info.width}x${info.height}` : null,
        model: input.model || "minimax-h3",
        provider: input.provider || "h3",
        status: "succeeded",
        progress: "100%",
        videoUrl: url,
        rawResponse: {
          width: info.width,
          height: info.height,
          duration: Math.round(info.duration * 10) / 10,
          poster: posterUrl,
          file: `${safeId}.mp4`,
          ...(input.extra || {}),
        },
      })
      .onConflictDoUpdate({
        target: videoGeneration.taskId,
        set: {
          videoUrl: url,
          status: "succeeded",
          prompt: input.prompt,
          duration: Math.round(info.duration),
          resolution: info.width && info.height ? `${info.width}x${info.height}` : null,
          rawResponse: {
            width: info.width,
            height: info.height,
            duration: Math.round(info.duration * 10) / 10,
            poster: posterUrl,
            file: `${safeId}.mp4`,
            ...(input.extra || {}),
          },
        },
      });

    return { ok: true, url, poster: posterUrl || undefined };
  } catch (error) {
    console.error("[library] 保存失败:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

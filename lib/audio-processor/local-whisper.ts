import path from "path";
import fs from "fs/promises";
import os from "os";
import { execFile } from "child_process";
import { resolveFfmpegPath } from "@/lib/video-processor/ffmpeg-path";

/**
 * 本地语音识别（faster-whisper）
 * ------------------------------------------------------------------
 * 用 Python 的 faster-whisper 在本机完成语音转写，替代 AssemblyAI 云服务。
 * 依赖：python 环境安装 faster-whisper（pip install faster-whisper）
 * 脚本：scripts/local-whisper.py
 *
 * 首次运行会自动下载所选模型（tiny≈39MB / base≈74MB / small≈244MB），
 * 之后命中本地缓存不再联网。
 */

export interface LocalWhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface LocalWhisperResult {
  language: string;
  duration: number;
  segments: LocalWhisperSegment[];
}

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const PYTHON = process.env.PYTHON_PATH || "python";

/** 把 /files/<key> 形式的公开 URL 还原成本地磁盘路径。 */
export function resolveLocalMediaPath(mediaUrl: string): string | null {
  try {
    // 允许相对路径（/files/xxx）与完整 URL 两种写法
    const parsed = new URL(mediaUrl, "http://localhost");
    if (!parsed.pathname.startsWith("/files/")) return null;
    const key = decodeURIComponent(parsed.pathname.slice("/files/".length));
    const absolute = path.resolve(STORAGE_DIR, key.replace(/\//g, path.sep));
    const base = path.resolve(STORAGE_DIR) + path.sep;
    // 阻止目录穿越
    if (absolute !== path.resolve(STORAGE_DIR) && !absolute.startsWith(base)) {
      return null;
    }
    return absolute;
  } catch {
    return null;
  }
}

/**
 * 调用本地 faster-whisper 转写音频。
 * @param audioPath 本地音频文件绝对路径
 * @param modelSize tiny | base | small | medium | large-v3
 */
export async function transcribeWithLocalWhisper(
  audioPath: string,
  modelSize: string = "small",
): Promise<LocalWhisperResult> {
  const script = path.join(process.cwd(), "scripts", "local-whisper.py");

  await fs.access(audioPath);
  await fs.access(script);

  // 先统一转成 16kHz 单声道 WAV：mp4/mov 等容器直接喂 whisper 容易解不出音轨
  let wavPath = audioPath;
  let tmpWav: string | null = null;
  if (!/\.wav$/i.test(audioPath)) {
    tmpWav = path.join(os.tmpdir(), `pl-whisper-${Date.now()}.wav`);
    await new Promise<void>((resolve, reject) => {
      execFile(
        resolveFfmpegPath(),
        ["-y", "-i", audioPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", tmpWav as string],
        { timeout: 10 * 60 * 1000 },
        (err, _out, errOut) => {
          if (err) reject(new Error(`音频提取失败: ${errOut || err.message}`));
          else resolve();
        },
      );
    });
    wavPath = tmpWav;
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      PYTHON,
      [script, wavPath, "--model", modelSize],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000, // 30 分钟上限
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          // 国内网络直连 huggingface.co 会超时，默认走镜像；
          // 模型下载过一次后会缓存到本地，之后完全离线可用。
          HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
        },
      },
      (err, out, errOut) => {
        if (err) {
          reject(new Error(`本地 whisper 执行失败: ${errOut || err.message}`));
          return;
        }
        resolve(out);
      },
    );
  }).finally(async () => {
    if (tmpWav) {
      try {
        await fs.unlink(tmpWav);
      } catch {
        /* 忽略 */
      }
    }
  });

  // 脚本最后一行是 JSON 结果，前面可能有日志
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as LocalWhisperResult;
      if (Array.isArray(parsed.segments)) return parsed;
    } catch {
      // 继续向上找
    }
  }

  throw new Error("本地 whisper 未返回有效 JSON");
}

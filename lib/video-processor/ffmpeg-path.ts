import path from "path";
import fsSync from "fs";

/**
 * 解析 FFmpeg 可执行文件路径。
 *
 * 兼容两种依赖布局：
 *  1. hoisted（pnpm nodeLinker: hoisted）：node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe
 *  2. 默认符号链接布局：node_modules/.pnpm/@ffmpeg-installer+win32-x64@4.1.0/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe
 *
 * 本地化部署使用 hoisted 布局，此处优先探测该路径。
 */
export function resolveFfmpegPath(): string {
  const cwd = process.cwd();
  const candidates = [
    // hoisted 布局（当前本地化部署采用）
    path.join(cwd, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"),
    // pnpm 默认符号链接布局（兼容原项目）
    path.join(
      cwd,
      "node_modules",
      ".pnpm",
      "@ffmpeg-installer+win32-x64@4.1.0",
      "node_modules",
      "@ffmpeg-installer",
      "win32-x64",
      "ffmpeg.exe"
    ),
    // 环境变量显式指定
    process.env.FFMPEG_PATH || null,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // ignore and continue
    }
  }

  // 最后兜底：交给 fluent-ffmpeg 自行查找（PATH 或默认位置）
  return "ffmpeg";
}

/** 设置 fluent-ffmpeg 的 FFmpeg 路径。 */
export function setupFfmpeg(ffmpeg: any): void {
  const resolved = resolveFfmpegPath();
  if (resolved !== "ffmpeg") {
    ffmpeg.setFfmpegPath(resolved);
  }
}

import { randomUUID } from "crypto";
import { readFile, unlink } from "fs/promises";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";

/**
 * 本地化存储实现（替代 Cloudflare R2）
 * ------------------------------------------------------------------
 * 本模块保持与 R2 版完全一致的导出函数签名，仅把底层存储从
 * S3/R2 换成本地磁盘目录。这样项目内所有 `@/lib/cloudflare/r2`
 * 的引用点都无需改动。
 *
 * 存储目录由环境变量 LOCAL_STORAGE_DIR 指定，默认：
 *   <项目根>/data/storage
 *
 * 公开 URL 使用环境变量 NEXT_PUBLIC_SITE_URL（默认
 * http://localhost:3000）+ 本地文件路由 /files/<key>。
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const PUBLIC_BASE =
  (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");

// 文件路由前缀，与 app/files/[...key]/route.ts 保持一致
const FILE_ROUTE_PREFIX = "/files";

/** 将存储 key 安全映射到本地磁盘绝对路径，并阻止目录穿越。 */
function resolveLocalPath(key: string): string {
  // 移除前导斜杠，按系统分隔符规整
  const normalized = key.replace(/^\/+/, "").replace(/\//g, path.sep);
  const absolute = path.resolve(STORAGE_DIR, normalized);
  const base = path.resolve(STORAGE_DIR) + path.sep;
  if (absolute !== path.resolve(STORAGE_DIR) && !absolute.startsWith(base)) {
    throw new Error("Invalid storage key");
  }
  return absolute;
}

/** 确保存储根目录存在。 */
async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

export function getR2PublicUrl(key: string): string {
  return `${PUBLIC_BASE}${FILE_ROUTE_PREFIX}/${key.replace(/^\/+/, "")}`;
}

export function extractR2Key(url: string): string | null {
  try {
    const parsed = new URL(url);
    // 本地文件路由 /files/<key>
    if (parsed.pathname.startsWith(FILE_ROUTE_PREFIX + "/")) {
      return decodeURIComponent(parsed.pathname.slice(FILE_ROUTE_PREFIX.length + 1));
    }
    // 若配置了自定义公开域名（NEXT_PUBLIC_SITE_URL），也支持匹配
    const base = new URL(PUBLIC_BASE);
    if (parsed.origin === base.origin && parsed.pathname.startsWith(FILE_ROUTE_PREFIX + "/")) {
      return decodeURIComponent(parsed.pathname.slice(FILE_ROUTE_PREFIX.length + 1));
    }
  } catch {
    return null;
  }
  return null;
}

export async function uploadToR2(
  file: Buffer | Uint8Array | string,
  key: string,
  contentType: string
): Promise<string> {
  try {
    const buffer = typeof file === "string" ? Buffer.from(file) : Buffer.from(file);
    const localPath = resolveLocalPath(key);
    await ensureStorageDir();
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return getR2PublicUrl(key);
  } catch (error: any) {
    console.error("Local storage upload error:", error);
    throw new Error(`Local storage upload failed: ${error?.message || error}`);
  }
}

export async function deleteFromR2(key: string): Promise<void> {
  try {
    const localPath = resolveLocalPath(key);
    await fs.unlink(localPath);
  } catch (error) {
    // 文件不存在视为已删除，不报错
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error("Local storage delete error:", error);
    throw new Error("Failed to delete file");
  }
}

export async function getFromR2(
  key: string,
  maxBytes = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const localPath = resolveLocalPath(key);
    // 文件大小预检（受 size 限制）
    const stat = await fs.stat(localPath);
    if (stat.size > maxBytes) throw new RangeError("Local storage object exceeds the size limit");

    // 分块读取以支持 maxBytes 限制与 abort
    const fileHandle = await fs.open(localPath, "r");
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const readSize = 64 * 1024;
      const buf = Buffer.alloc(readSize);
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await fileHandle.read(buf, 0, readSize, bytes);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > maxBytes) throw new RangeError("Local storage object exceeds the size limit");
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      }
      return Buffer.concat(chunks);
    } finally {
      await fileHandle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // 与 R2 的 NotFound 语义保持一致，供上层识别
      const notFound = new Error("Local storage key not found", { cause: error });
      (notFound as any).name = "NotFound";
      throw notFound;
    }
    if (error instanceof RangeError) throw error;
    console.error("Local storage get error:", error);
    throw new Error("Failed to get file", { cause: error });
  }
}

export async function getSignedUrlFromR2(key: string, expiresIn: number = 3600): Promise<string> {
  // 本地文件无需签名，直接返回公开地址
  return getR2PublicUrl(key);
}

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string> {
  // 本地化：浏览器直传改为 PUT 到本地上传路由
  return `${PUBLIC_BASE}/api/upload-local/${key.replace(/^\/+/, "")}`;
}

export function generateUserFilePath(
  userId: string,
  filename: string,
  type: "video" | "image"
): string {
  const ext = filename.split(".").pop();
  const uniqueName = `${randomUUID()}.${ext}`;
  return `users/${userId}/${type}/${uniqueName}`;
}

export async function uploadTempFile(
  filePath: string,
  filename: string
): Promise<string> {
  const fileBuffer = await readFile(filePath);
  const contentType = getContentType(filename);
  const key = `temp/${randomUUID()}-${filename}`;

  const url = await uploadToR2(fileBuffer, key, contentType);

  try {
    await unlink(filePath);
  } catch (error) {
    console.warn("Failed to delete local temp file:", error);
  }

  return url;
}

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}

export function isAllowedFileType(
  filename: string,
  allowedTypes: ("video" | "image")[]
): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  const allowedExtensions: Record<string, string[]> = {
    video: ["mp4", "mov", "avi", "mkv", "webm"],
    image: ["jpg", "jpeg", "png", "gif", "webp"],
  };

  return allowedTypes.some((type) =>
    allowedExtensions[type].includes(ext || "")
  );
}

export function isFileSizeValid(size: number, maxSizeMB: number = 100): boolean {
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  return size <= maxSizeBytes;
}

// 保留导出，供未来可能用到 R2 端点的场景
export { fsSync };

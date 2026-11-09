import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { saveToLibrary } from "@/lib/media/library";

/**
 * 把 H3 工作台生成的视频缓存到本地存储。
 *
 * 为什么需要：
 * Gradio 的 /gradio_api/file=... 只临时授权最近产物的路径，稍后（或工作台重启后）
 * 再访问会返回 403 {"detail":"File not allowed: ..."}，页面里的 <video> 就播不出来。
 * 生成完成时立刻下载一份到 data/storage/videos/，之后用 /files/videos/xxx.mp4
 * 稳定播放。
 */

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

const VIDEO_DIR = path.join(STORAGE_DIR, "videos");

function safeName(input: string): string {
  const base = path.basename(input.replace(/\\/g, "/"));
  const cleaned = base.replace(/[^\w.\-]+/g, "_");
  return cleaned || `video-${Date.now()}.mp4`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { url?: string; prompt?: string; mode?: string; taskId?: string }
    | null;
  const url = body?.url?.trim();

  if (!url) {
    return NextResponse.json({ ok: false, error: "缺少 url" }, { status: 400 });
  }

  // 只允许指向本机 H3 服务的地址，避免被当成任意 URL 代理
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: "url 必须是 http(s) 地址" }, { status: 400 });
  }

  try {
    const name = safeName(decodeURIComponent(url.split("file=").pop() || url));
    const target = path.join(VIDEO_DIR, name);

    // 已经缓存过就直接返回，避免重复下载
    try {
      const stat = await fs.stat(target);
      if (stat.size > 0) {
        let saved;
        try {
          const session = await auth.api.getSession({ headers: request.headers });
          if (session?.user) {
            saved = await saveToLibrary({
              taskId: body?.taskId || name.replace(/\.mp4$/i, ""),
              userId: session.user.id,
              prompt: body?.prompt || "(未记录提示词)",
              filePath: target,
              extra: { mode: body?.mode || "t2v", cached: true },
            });
          }
        } catch {
          /* 入库失败不影响播放 */
        }
        return NextResponse.json({ ok: true, url: `/files/videos/${name}`, cached: true, size: stat.size, library: saved });
      }
    } catch {
      // 未缓存，继续下载
    }

    const res = await fetch(url, { headers: { "User-Agent": "prompt-lens" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `拉取视频失败 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}` },
        { status: 502 },
      );
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      return NextResponse.json({ ok: false, error: "拉取到的视频为空" }, { status: 502 });
    }

    await fs.mkdir(VIDEO_DIR, { recursive: true });
    await fs.writeFile(target, buffer);

    let saved;
    try {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user) {
        saved = await saveToLibrary({
          taskId: body?.taskId || name.replace(/\.mp4$/i, ""),
          userId: session.user.id,
          prompt: body?.prompt || "(未记录提示词)",
          filePath: target,
          extra: { mode: body?.mode || "t2v" },
        });
      }
    } catch {
      /* 入库失败不影响播放 */
    }
    return NextResponse.json({ ok: true, url: `/files/videos/${name}`, library: saved, size: buffer.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

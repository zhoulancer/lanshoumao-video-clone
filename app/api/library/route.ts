import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db, videoGeneration } from "@/lib/db";

/**
 * 产品库：生成过的视频永久沉淀，随时回看/下载。
 *
 * GET    /api/library?search=&favorite=&limit=
 * PATCH  /api/library  { id, favorite?, note? }
 * DELETE /api/library?id=
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR
  ? path.resolve(process.env.LOCAL_STORAGE_DIR)
  : path.join(process.cwd(), "data", "storage");

type Raw = { poster?: string | null; width?: number; height?: number; duration?: number; favorite?: boolean; note?: string; mode?: string; total?: number; file?: string };

function shape(row: { id: string; taskId: string; prompt: string; videoUrl: string | null; duration: number | null; resolution: string | null; model: string | null; createdAt: Date; rawResponse: unknown }) {
  const raw = (row.rawResponse || {}) as Raw;
  return {
    id: row.id,
    taskId: row.taskId,
    prompt: row.prompt,
    videoUrl: row.videoUrl,
    poster: raw.poster || null,
    duration: raw.duration ?? row.duration ?? 0,
    width: raw.width ?? null,
    height: raw.height ?? null,
    resolution: row.resolution || (raw.width && raw.height ? `${raw.width}x${raw.height}` : ""),
    model: row.model || "minimax-h3",
    mode: raw.mode || "t2v",
    total: raw.total ?? null,
    favorite: Boolean(raw.favorite),
    note: raw.note || "",
    createdAt: row.createdAt,
  };
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search = (searchParams.get("search") || "").trim();
  const favorite = searchParams.get("favorite") === "true";
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "60", 10)));

  const conditions = [eq(videoGeneration.userId, session.user.id), eq(videoGeneration.status, "succeeded")];
  if (search) {
    conditions.push(or(ilike(videoGeneration.prompt, `%${search}%`), ilike(videoGeneration.taskId, `%${search}%`))!);
  }

  const rows = await db
    .select()
    .from(videoGeneration)
    .where(and(...conditions))
    .orderBy(desc(videoGeneration.createdAt))
    .limit(limit);

  const items = rows.map(shape);
  return NextResponse.json({
    items: favorite ? items.filter((i) => i.favorite) : items,
    total: items.length,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { id?: string; favorite?: boolean; note?: string } | null;
  if (!body?.id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const rows = await db.select().from(videoGeneration)
    .where(and(eq(videoGeneration.id, body.id), eq(videoGeneration.userId, session.user.id)))
    .limit(1);
  const row = rows[0];
  if (!row) return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });

  const raw = { ...((row.rawResponse || {}) as Raw) };
  if (typeof body.favorite === "boolean") raw.favorite = body.favorite;
  if (typeof body.note === "string") raw.note = body.note;

  await db.update(videoGeneration).set({ rawResponse: raw }).where(eq(videoGeneration.id, body.id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const rows = await db.select().from(videoGeneration)
    .where(and(eq(videoGeneration.id, id), eq(videoGeneration.userId, session.user.id)))
    .limit(1);
  const row = rows[0];
  if (!row) return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });

  const raw = (row.rawResponse || {}) as Raw;
  const file = raw.file;
  if (file) {
    for (const ext of [".mp4", ".jpg"]) {
      const p = path.join(STORAGE_DIR, "library", `${file.replace(/\.mp4$/i, "")}${ext}`);
      try {
        await fs.rm(p, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  await db.delete(videoGeneration).where(eq(videoGeneration.id, id));
  return NextResponse.json({ ok: true });
}

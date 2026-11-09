import { NextRequest, NextResponse } from "next/server";
import { readLocalAiConfig } from "@/lib/config/local-ai";

/**
 * POST /api/video-generate/h3-size
 *   { aspectRatio, resolution, width?, height? }
 *   -> { ok, width, height, resolutionChoices? }
 *
 * 完全按 H3 工作台自己的联动逻辑算尺寸：
 *   调用它的 update_resolution_for_aspect（比例变化时触发）
 *   ／ apply_resolution_preset（清晰度变化时触发）
 * 这样不会出现「32 的倍数」「比例对不上」这类差异。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Choice = [string, string] | string;

function toSpecs(raw: unknown): { value: string; label: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      return { label: String(item[0]), value: String(item[1]) };
    }
    return { label: String(item), value: String(item) };
  });
}

async function callGradio(base: string, name: string, data: unknown[]): Promise<unknown[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(`${base}/gradio_api/call/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const { event_id: eventId } = (await res.json()) as { event_id?: string };
    if (!eventId) return null;

    const stream = await fetch(`${base}/gradio_api/call/${name}/${eventId}`, {
      headers: { Accept: "text/event-stream" },
    });
    const text = await stream.text();
    let payload: unknown[] | null = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const raw = t.slice(5).trim();
      if (!raw || raw === "null") continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) payload = parsed;
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
    return payload;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { aspectRatio?: string; resolution?: string; width?: number; height?: number }
    | null;

  const aspectRatio = (body?.aspectRatio || "16:9").trim();
  const resolution = (body?.resolution || "544p").trim();
  const width = Number(body?.width) || 960;
  const height = Number(body?.height) || 544;

  const cfg = readLocalAiConfig();
  const base = (cfg.h3BaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json({ ok: false, error: "未配置 H3 服务地址" }, { status: 400 });
  }

  // 1) 先按「比例变化」问 H3：它会返回新的清晰度选项 + 对应宽高
  const byAspect = await callGradio(base, "update_resolution_for_aspect", [aspectRatio, resolution, width, height]);
  if (byAspect) {
    const resUpdate = byAspect[0] as { choices?: Choice[]; value?: string } | undefined;
    const w = Number(byAspect[1]);
    const h = Number(byAspect[2]);
    const specs = toSpecs(resUpdate?.choices);
    // 若清晰度不在新选项里（例如 21:9 下没有某个档），用 H3 给的默认值
    const effectiveResolution = specs.some((s) => s.value === resolution) ? resolution : (resUpdate?.value || resolution);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      // 2) 再按「清晰度变化」问一次，确保与当前清晰度档一致
      const byRes = await callGradio(base, "apply_resolution_preset", [aspectRatio, effectiveResolution, w, h]);
      const rw = byRes ? Number(byRes[0]) : NaN;
      const rh = byRes ? Number(byRes[1]) : NaN;
      return NextResponse.json({
        ok: true,
        width: Number.isFinite(rw) && rw > 0 ? rw : w,
        height: Number.isFinite(rh) && rh > 0 ? rh : h,
        resolution: effectiveResolution,
        resolutionChoices: specs,
        source: "h3",
      });
    }
  }

  // 3) 兜底：短边固定为预设值，长边按比例（同样保持 32 的倍数）
  const shortSide = resolution === "768p" ? 768 : resolution === "480p" ? 480 : 544;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio);
  let outW = width;
  let outH = height;
  if (m) {
    const ra = parseFloat(m[1]);
    const rb = parseFloat(m[2]);
    const longSide = Math.round((shortSide * Math.max(ra, rb)) / Math.min(ra, rb) / 32) * 32;
    outW = ra >= rb ? longSide : shortSide;
    outH = ra >= rb ? shortSide : longSide;
  }
  return NextResponse.json({ ok: true, width: outW, height: outH, resolution, source: "fallback" });
}

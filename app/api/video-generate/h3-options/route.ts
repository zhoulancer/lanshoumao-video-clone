import { NextResponse } from "next/server";
import { readLocalAiConfig } from "@/lib/config/local-ai";

/**
 * GET /api/video-generate/h3-options
 * 从 H3 工作台的 Gradio /config 里读出真实可选项：
 *   画面比例（slot 31）、清晰度（slot 32）
 * 这样界面下拉永远和工作台一致，不用手写死。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Choice = string;

function toChoices(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) return [];
  const out: Choice[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) out.push(String(item[1]));
    else if (typeof item === "string" || typeof item === "number") out.push(String(item));
  }
  return out;
}


/** 从标签里抠出基准尺寸，例如 "544P · 960×544" → [960,544] */
function parseSize(label: string): [number, number] | null {
  const m = /(\d{2,5})\s*[x×*]\s*(\d{2,5})/.exec(label || "");
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export async function GET() {
  const cfg = readLocalAiConfig();
  const base = (cfg.h3BaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json({ ok: false, error: "未配置 H3 服务地址" }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${base}/config`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfgJson = (await res.json()) as {
      components?: { id: number; props?: Record<string, unknown> }[];
      dependencies?: { api_name?: string; inputs?: number[] }[];
    };

    const dep = (cfgJson.dependencies || []).find((d) => d.api_name === "submit_minimax_from_slots");
    if (!dep?.inputs?.length) throw new Error("工作台没有 submit_minimax_from_slots");

    const comps = new Map<number, Record<string, unknown>>();
    for (const c of cfgJson.components || []) comps.set(c.id, c.props || {});

    const ratioProps = comps.get(dep.inputs[31]) || {};
    const resProps = comps.get(dep.inputs[32]) || {};

    const aspectRatios = toChoices(ratioProps.choices);
    const aspectSpecs = (Array.isArray(ratioProps.choices) ? (ratioProps.choices as unknown[]) : []).map((item) => ({
      value: Array.isArray(item) && item.length >= 2 ? String(item[1]) : String(item),
      label: Array.isArray(item) ? String(item[0]) : String(item),
    }));
    const rawRes = Array.isArray(resProps.choices) ? (resProps.choices as unknown[]) : [];
    const resolutionSpecs = rawRes.map((item) => {
      const label = Array.isArray(item) ? String(item[0]) : String(item);
      const value = Array.isArray(item) && item.length >= 2 ? String(item[1]) : String(item);
      const size = parseSize(label);
      return { value, label, width: size?.[0] ?? null, height: size?.[1] ?? null };
    });
    const resolutions = resolutionSpecs.map((r) => r.value);

    return NextResponse.json({
      ok: true,
      base,
      aspectRatios,
      aspectSpecs,
      resolutions,
      resolutionSpecs,
      defaultAspect: typeof ratioProps.value === "string" ? ratioProps.value : aspectRatios[0] || "16:9",
      defaultResolution: typeof resProps.value === "string" ? resProps.value : resolutions[0] || "544p",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `读取工作台选项失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

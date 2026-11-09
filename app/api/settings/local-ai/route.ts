import { NextRequest, NextResponse } from "next/server";
import { readLocalAiConfig, writeLocalAiConfig } from "@/lib/config/local-ai";

/**
 * 本地 AI 配置读写（单机模式，无需登录）
 * GET  -> 当前生效配置
 * POST -> 保存配置 { baseUrl, model, whisperModel }
 * POST { action: "test" } -> 探测该地址是否可用并返回模型列表
 */

export async function GET() {
  return NextResponse.json({ ok: true, config: readLocalAiConfig() });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        action?: string;
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        whisperModel?: string;
      }
    | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // 连通性测试：请求 /v1/models
  if (body.action === "test") {
    const cfg = readLocalAiConfig();
    const baseUrl = (body.baseUrl || cfg.baseUrl).trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    const apiKey = (body.apiKey !== undefined ? body.apiKey : cfg.apiKey).trim();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const headers: Record<string, string> = {};
      // 外部服务（DeepSeek 等）需要鉴权才能列出模型
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        return NextResponse.json(
          { ok: false, error: `HTTP ${response.status}` },
          { status: 200 },
        );
      }

      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data || []).map((m) => m.id).filter(Boolean) as string[];
      return NextResponse.json({ ok: true, baseUrl, models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ ok: false, error: message }, { status: 200 });
    }
  }

  // 保存配置
  const config = writeLocalAiConfig({
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    whisperModel: typeof body.whisperModel === "string" ? body.whisperModel : undefined,
    h3BaseUrl: typeof (body as { h3BaseUrl?: string }).h3BaseUrl === "string"
      ? (body as { h3BaseUrl?: string }).h3BaseUrl
      : undefined,
    corrections: typeof (body as { corrections?: string }).corrections === "string"
      ? (body as { corrections?: string }).corrections
      : undefined,
  });

  return NextResponse.json({ ok: true, config });
}

import { NextRequest, NextResponse } from "next/server";
import { checkH3Video, probeH3, resolveVideoSize, submitH3 } from "@/lib/video/h3-client";

/**
 * H3 视频生成接口（本机 Gradio 服务）
 * POST /api/video-generate/h3
 *   { action?: "submit" | "probe", prompt?, mode?, aspectRatio?, duration?, steps?, seed?, baseUrl? }
 *   action=submit -> { ok, eventId }
 *   action=probe  -> { ok, title } | { ok:false, error }
 * GET  /api/video-generate/h3  -> { ok, videoUrl, status }
 */

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        action?: "submit" | "probe";
        prompt?: string;
        mode?: string;
        aspectRatio?: string;
        resolution?: string;
        width?: number;
        firstFrame?: { dataUrl: string; fileName?: string };
        height?: number;
        duration?: string;
        steps?: number;
        seed?: number;
        baseUrl?: string;
      }
    | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.action === "probe") {
    const result = await probeH3(body.baseUrl || "");
    return NextResponse.json(result);
  }

  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: "提示词不能为空" }, { status: 400 });
  }

  try {
    const eventId = await submitH3({
      prompt: body.prompt.trim(),
      mode: body.mode,
      aspectRatio: body.aspectRatio,
      resolution: body.resolution,
      width: body.width,
      height: body.height,
      duration: body.duration,
      steps: body.steps,
      seed: body.seed,
      firstFrame: body.firstFrame,
    });
    const aspectRatio = body.aspectRatio || "16:9";
    const resolution = body.resolution || "544p";
    const autoSize = resolveVideoSize(aspectRatio, resolution);
    const size = { width: body.width ?? autoSize.width, height: body.height ?? autoSize.height };
    return NextResponse.json({
      ok: true,
      eventId,
      mode: body.firstFrame ? "i2v" : "t2v",
      aspectRatio,
      resolution,
      width: size.width,
      height: size.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function GET() {
  try {
    const result = await checkH3Video();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

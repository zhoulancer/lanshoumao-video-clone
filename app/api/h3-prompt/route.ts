import { NextRequest, NextResponse } from "next/server";
import { generateH3PromptWithLlm } from "@/lib/ai/h3-prompt";
import { ensureDialogueAligned, parseTimedDialogue } from "@/lib/utils/dialogue-align";

/**
 * POST /api/h3-prompt
 *   { analysis: string, dialogue?: string, durationSeconds?: number, mode?, voiceStyle? }
 *   -> { ok: true, prompt, dialogue?: { total, added, missing } } | { ok: false, error }
 *
 * 用本地 Qwen 把「视频分析 + 台词」重写成官方 MiniMax H3 提示词。
 * 模型输出后再做一次【确定性台词对齐】：重复台词不被合并、每句落在它时间所在的段落。
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { analysis?: string; dialogue?: string; durationSeconds?: number; mode?: "t2v" | "i2v"; voiceStyle?: string }
    | null;

  if (!body?.analysis?.trim()) {
    return NextResponse.json({ ok: false, error: "缺少 analysis" }, { status: 400 });
  }

  const result = await generateH3PromptWithLlm({
    mode: body.mode === "i2v" ? "i2v" : "t2v",
    voiceStyle: body.voiceStyle,
    analysis: body.analysis,
    dialogue: body.dialogue,
    durationSeconds:
      typeof body.durationSeconds === "number" && Number.isFinite(body.durationSeconds)
        ? body.durationSeconds
        : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

  // 确定性对齐：仅 T2V 分段脚本可用（按 [起-止秒｜…] 段落落位）
  let prompt = result.prompt;
  let dialogueInfo: { total: number; added: number; missing: number } | undefined;
  if ((body.mode ?? "t2v") === "t2v" && body.dialogue) {
    const lines = parseTimedDialogue(body.dialogue);
    if (lines.length > 0) {
      const aligned = ensureDialogueAligned(prompt, lines);
      prompt = aligned.prompt;
      dialogueInfo = { total: lines.length, added: aligned.added, missing: aligned.missing };
    }
  }

  return NextResponse.json({ ok: true, prompt, dialogue: dialogueInfo });
}

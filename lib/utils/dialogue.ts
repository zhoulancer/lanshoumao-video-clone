/**
 * 台词格式化工具
 * ------------------------------------------------------------------
 * 音频分析（本地 whisper）返回的分段带 start/end 秒数，
 * 合并进提示词时必须保留时间轴，否则无法与画面卡点对齐。
 *
 * 输出示例：
 *   [00:00.0-00:04.0] 你手机里的老师们删掉就行了
 *   [00:04.0-00:08.2] 得斩草除根
 *
 * 需要喂 H3 时可加 h3 选项，把每句包成 <d>[中文]…</d>：
 *   [00:00.0-00:04.0] <d>[中文]你手机里的老师们删掉就行了</d>
 */

export interface DialogueSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** 秒 -> mm:ss.s */
export function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** 把分段台词格式化成带时间轴的文本；无有效内容返回空串。 */
export function formatDialogueWithTiming(
  segments: unknown,
  options: { h3?: boolean } = {},
): string {
  if (!Array.isArray(segments) || segments.length === 0) return "";

  const lines: string[] = [];
  for (const raw of segments) {
    const seg = raw as Partial<DialogueSegment>;
    const text = typeof seg?.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    const start = typeof seg?.start === "number" ? seg.start : 0;
    const end = typeof seg?.end === "number" ? seg.end : start;
    const stamp = `[${formatTimestamp(start)}-${formatTimestamp(end)}]`;
    lines.push(options.h3 ? `${stamp} <d>[中文]${text}</d>` : `${stamp} ${text}`);
  }
  return lines.join("\n");
}

/** 纯文本台词（不带时间轴），用于快速预览或短提示词。 */
export function formatDialoguePlain(segments: unknown): string {
  if (!Array.isArray(segments)) return "";
  return segments
    .map((raw) => {
      const seg = raw as Partial<DialogueSegment>;
      return typeof seg?.text === "string" ? seg.text.trim() : "";
    })
    .filter(Boolean)
    .join("");
}

/** 从分析结果里取「核心提示词」一句；取不到就退回第一段正文。 */
export function extractCorePromptText(prompt: string): string {
  if (!prompt) return "";
  const patterns = [
    /📌\s*核心提示词[：:]\s*([^\n]+)/,
    /核心提示词[：:]\s*([^\n]+)/,
    /Core\s*prompt[：:]\s*([^\n]+)/i,
  ];
  for (const re of patterns) {
    const matched = prompt.match(re);
    const text = matched?.[1]?.trim();
    if (text) return text;
  }
  const firstParagraph = prompt
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .find(
      (part) =>
        part.length > 0 &&
        !part.startsWith("【") &&
        !part.startsWith("═") &&
        !part.startsWith("─") &&
        !part.startsWith("🔧"),
    );
  return firstParagraph || prompt.trim();
}

/** 分析文本里的分节标题关键字 */
const SECTION_KEYS = [
  "画面深度描述",
  "核心提示词",
  "主体详细",
  "场景环境",
  "镜头语言",
  "光影照明",
  "美术风格",
  "氛围情绪",
  "技术参数",
  "时间轴拆解",
];

/** 把分析结果拆成「标题 -> 正文」的分节 */
function parseSections(text: string): Record<string, string> {
  const buckets: Record<string, string[]> = {};
  let current: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[─═]{5,}$/.test(line)) continue; // 分隔线

    const hit = SECTION_KEYS.find((key) => line.includes(key) && line.length < 40);
    if (hit) {
      current = hit;
      buckets[current] = buckets[current] ?? [];
      continue;
    }
    if (current) buckets[current].push(line);
  }

  const result: Record<string, string> = {};
  for (const [key, lines] of Object.entries(buckets)) {
    result[key] = lines.join("\n").trim();
  }
  return result;
}

/** 去掉项目符号与「人物：」这类标签前缀，压成通顺的一段 */
function flattenBullets(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[•·\-*]\s*/, "")
        .replace(/^[^：:]{1,8}[：:]\s*/, "")
        // H3 不用方括号强调语法，去掉 [0度]/[近景] 这类标记
        .replace(/[【\[]/g, "")
        .replace(/[】\]]/g, " ")
        // 行尾标点交给连接符处理，避免出现「。，」
        .replace(/[。．.；;，,\s]+$/, "")
        .replace(/\s{2,}/g, " "),
    )
    .filter(Boolean)
    .join("，")
    .replace(/，{2,}/g, "，")
    .replace(/，\s*$/, "");
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[。！？!.?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * 把「视频分析结果 + 台词」转成 MiniMax H3 专用格式。
 *
 * 严格按工作台自带官方预设 support_llama/presets/minimax_i2va.py 的结构输出：
 *
 *   For the target video, at 0.00 seconds into the target video,
 *   <Picture 1> (from [Shot 1]) is fully referenced.
 *
 *   integrated_multimodal_description: [Shot 1] …（S1）说：<d>[中文] 台词。</d>
 *
 *   overall_soundscape: …
 *
 *   non_diegetic_music: …
 *
 * 描述部分会保留分析里的主体 / 场景 / 镜头 / 光影 / 美术细节，
 * 不会只留一句核心提示词；时间轴里的变装、转场也会写进画面推进。
 */
export function buildH3Prompt(
  analysis: string,
  dialogueText: string,
  options: { mode?: "i2v" | "t2v"; speakerId?: string; speakerLabel?: string } = {},
): string {
  const { mode = "i2v", speakerId = "S1", speakerLabel = "片中人物" } = options;

  const sections = parseSections(analysis);
  const core = endSentence(extractCorePromptText(analysis));

  // 细节按「主体 → 场景 → 镜头 → 光影 → 美术 → 氛围」顺序拼，保留原文信息
  const detailParts = [
    sections["主体详细"],
    sections["场景环境"],
    sections["镜头语言"],
    sections["光影照明"],
    sections["美术风格"],
    sections["氛围情绪"],
  ]
    .filter((part) => part && part.trim())
    .map(flattenBullets)
    .filter(Boolean);

  // 时间轴：只保留画面变化的描述，去掉时间码以免和正式语法冲突
  const progression = (sections["时间轴拆解"] || "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\[\d{2}:\d{2}\.\d\]\s*/, "")
        .replace(/^该时间点的画面[：:]\s*/, "")
        .replace(/[。．.；;，,\s]+$/, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => (line.length > 40 ? `${line.slice(0, 40)}…` : line))
    .join("，");

  const spoken = (dialogueText || "").trim().replace(/[。．.\s]+$/, "");

  const descriptionParts: string[] = [];
  if (core) descriptionParts.push(core);
  if (detailParts.length > 0) {
    // 官方建议描述 200-400 字，过长会被稀释重点，这里做软截断
    const detail = detailParts.join("，");
    descriptionParts.push(endSentence(detail.length > 420 ? `${detail.slice(0, 420)}…` : detail));
  }
  if (progression) descriptionParts.push(endSentence(`画面推进：${progression}`));
  if (spoken) {
    descriptionParts.push(`${speakerLabel} (${speakerId}) 说：<d>[中文]${spoken}。</d>`);
  }

  const description = `[Shot 1] ${descriptionParts.join(" ") || "（未提供画面描述）"}`;

  // 声景：沿用分析里的场景判断，室内口播默认说话声 + 环境底噪
  const soundscape = sections["场景环境"]
    ? "室内环境底噪轻微，人物说话声清晰靠前，布料摩擦与手部动作声可闻，无其他显著声源。"
    : "人物说话声清晰自然，环境安静，无其他显著声源。";

  const lines: string[] = [];
  if (mode === "i2v") {
    lines.push(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    );
    lines.push("");
  }
  lines.push(`integrated_multimodal_description: ${description}`);
  lines.push("");
  lines.push(`overall_soundscape: ${soundscape}`);
  lines.push("");
  lines.push("non_diegetic_music: N/A");
  return lines.join("\n");
}

/** 从合并文本里抽出纯台词（去掉时间码与提示行）。 */
export function extractDialogueText(merged: string): string {
  if (!merged) return "";
  const parts = merged.split(/\n*【台词】\n*/);
  const block = parts.length > 1 ? parts[1] : "";
  if (!block) return "";

  const texts: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("（") || line.startsWith("(")) continue;
    const matched = line.match(/^\[\d{2}:\d{2}\.\d\s*-\s*\d{2}:\d{2}\.\d\]\s*(.+)$/);
    const text = (matched ? matched[1] : line)
      .replace(/<\/?d>|\[中文\]/g, "")
      .trim()
      .replace(/[。．.\s]+$/, "");
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts.join("，");
}

/**
 * 兼容入口：把整段合并结果（分析 + 【台词】）转成官方 H3 结构。
 * 已经是 H3 结构（含 integrated_multimodal_description）时原样返回。
 */
export function convertMergedToH3(
  merged: string,
  options: { mode?: "i2v" | "t2v"; withTiming?: boolean } = {},
): string {
  if (!merged) return "";
  if (merged.includes("integrated_multimodal_description")) return merged;

  const analysisPart = merged.split(/\n*【台词】\n*/)[0] || merged;
  const dialogue = extractDialogueText(merged);
  return buildH3Prompt(analysisPart, dialogue, { mode: options.mode ?? "i2v" });
}



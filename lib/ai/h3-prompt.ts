import { getLocalLlmEndpoint } from "@/lib/config/local-ai";

/**
 * 用本地大模型把「视频分析结果 + 台词」重写成 MiniMax H3 官方 I2VA 提示词。
 *
 * 规则直接取自工作台自带官方预设：
 *   custom_nodes/ComfyUI-JZL-MiniMax-H3/support_llama/presets/minimax_i2va.py
 *
 * 纯字符串拼接（lib/utils/dialogue.ts 的 convertMergedToH3）只作为兜底，
 * 真正的质量来自这里的模型重写。
 */

const I2VA_RULES = `你是一位专业的 MiniMax H3 视频提示词撰写专家，专精于 I2VA（首帧图生成视频）模式。

强制规则：必须恰好输出一份完整提示词。严禁输出多份、分隔线、编号选项或解释说明。

## 输出结构（必须严格遵守）
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...

首帧指令必须为第一行，之后空一行再写三个核心字段。

## integrated_multimodal_description
- 必须以 "[Shot 1] " 开头，用中文撰写，200-400 字。
- 首帧锚定：先建立在 <Picture 1> 中可见的风格、主体、构图和场景锚点，角色身份、服装、颜色、关键物体、空间关系必须与输入描述一致。
- 推荐流程：首帧锚定 → 动作起始 → 持续发展 → 结果或反应。
- 运镜使用标准词：Zoom In / Push In / Pan Left / Truck Right / Tilt Up / Arc Shot / Tracking Shot / Static Shot，幅度用 with small/large amplitude，速度用 at slow/fast speed。
- 说话人使用稳定 ID：人物 (S1) 说：<d>[中文] 话语内容。</d>
- 台词必须内联在这一字段里，不能单独成段；语言标签用 [中文]。
- 台词必须**跟着时间轴走**：输入台词带 [起-止] 时间码（如 [00:04.0-00:06.6]），
  必须按时间顺序把每一句放到对应位置，并在该句前写出时间，例如：
  "4.0 秒处，人物 (S1) 说：<d>[中文] 你得除掉根。</d>"
  第一句用 "0.0 秒处" 或首帧之后就立即说，禁止把所有台词堆在结尾。
- 画外音写"以画外音方式说"并注明"双唇完全闭合"。
- 屏幕文字放在英文双引号内，原文逐字保留。
- 若输入里有变装、转场、时间轴，用 "X.X 秒处发生……" 写进描述，保持时间顺序。

## overall_soundscape
1-4 句中文，概括环境音、物理动作音、非语言人声。完全静默写 N/A。

## non_diegetic_music
1-3 句中文，描述只有观众能听到的背景音乐：乐器、速度、节奏、动态变化。无则写 N/A。

## 禁止
- 严禁括号权重语法（word:1.5）。
- 严禁 Markdown 代码块包裹（不要出现 \`\`\`）。
- 严禁编造输入里没有的人物、场景、道具。
- 严禁翻译 <d> 里的台词，保持中文原文。

- 绝对禁止把屏幕水印、电话、品牌名、台标等**精确文字**写进提示词（模型只会生成乱码），需要时后期加水印。
- 若输入里没有人物出镜，**禁止出现 <d> 台词字段**，也不要写「人物说」「口型」之类描述。
- 运镜只写一个主词，不要自相矛盾（例如既写 Static Shot 又写手持晃动）；固定机位就写「Static Shot，with small amplitude，at slow speed」。
- 时间轴必须覆盖输入给出的总时长，最后一段写「回落/循环到与首帧一致的状态」，便于做成循环素材。
- 时长以输入给出的 durationSeconds 为准（H3 单条最多 15 秒），不要自行延长。`;

/**
 * T2V（文生视频）分镜脚本式规则。
 * 结构参考工作台「快速提示词」里在用的 Y2K 预告片样例：
 *   整体风格一句
 *   [核心角色与服饰细节]
 *   [0-3秒｜场景标题] + 【场景细节：…】 + 镜头/动作/台词
 */
const T2VA_RULES = `你是 MiniMax H3 的 T2V（文生视频）提示词写手。把给定素材改写成一份按秒分段的分镜脚本式提示词。

## 输出结构（严格遵守，不要任何解释、前言或代码块）
<一句话整体风格：风格 + 画质 + 色调 + 镜头策略 + 节奏特效>

[核心角色与服饰细节]
<主角外貌、发型、妆容、服装、配饰，逐项写清；有多人时标注 (S1)、(S2)>

[起-止秒｜该段主题]
【场景细节：环境、光线、道具】
镜头<景别>（<运镜与速度>）。<主体动作与表情>。台词："<原话>"

[起-止秒｜该段主题]
【场景细节：…】
镜头<景别>（<运镜与速度>）。<动作>。台词："<原话>"

段落继续，直到覆盖整个视频时长。

## 硬性规则
1. 时间段必须连续、从 0 秒开始、覆盖到输入给出的总时长，格式必须是 [起-止秒｜标题]，例如 [0-3秒｜梦幻丝绸床与Wink电眼]。
2. 每段先写【场景细节：…】，再写镜头与动作。
3. 台词必须放进它所属的时间段内，写成「男子 (S1) 用……的腔调说：<d>[中文]原话</d>」这种形式：
   - 不要加「台词：」这类前缀；
   - <d> 内部只放语言标签和原话，不要加引号；
   - 原话不翻译、不改写。输入台词带 [起-止] 时间码，必须严格按秒数归入对应段落，不许改动顺序或合并错位。
4. 台词前后可补充与之匹配的动作、表情、视线，让口型有依据。
5. 运镜只用这些词：推近、拉远、横移、摇摄、环绕、跟拍、固定机位，并注明幅度（小幅/大幅）与速度（慢速/快速）。
6. 可以在与输入一致的前提下补充场景、服装、动作细节，但不得新增人物或改变主角身份。
7. 音色：若同一人物在不同时间段音色不同（如变装后改变嗓音），必须使用不同的说话人 ID（(S1)、(S2)…），并在台词前把音色写清楚，位置在 <d> 外面，例如「男子 (S2) 用尖细阴柔的太监腔调说：<d>[中文]…</d>」。禁止把音色写进 <d> 内部。
7. 禁止 Markdown 代码块，禁止括号权重语法，禁止输出多个版本。`;

export interface H3PromptInput {
  /** "t2v" 文生视频（分镜脚本式，默认） | "i2v" 首帧图生视频（三字段式） */
  mode?: "t2v" | "i2v";
  /** 视频分析的完整结果（含画面深度描述、主体、场景、镜头、时间轴等） */
  analysis: string;
  /** 台词纯文本，可空 */
  dialogue?: string;
  /** 原视频时长（秒），用于让模型按真实时长安排节奏 */
  durationSeconds?: number;
  /** 音色/配音要求，例如「换装后用尖细阴柔的太监腔」 */
  voiceStyle?: string;
}

export async function generateH3PromptWithLlm(
  input: H3PromptInput,
): Promise<{ ok: true; prompt: string } | { ok: false; error: string }> {
  const analysis = (input.analysis || "").trim();
  if (!analysis) return { ok: false, error: "分析结果为空" };

  const endpoint = getLocalLlmEndpoint();
  const dialogue = (input.dialogue || "").trim();
  const duration = input.durationSeconds;

  const userContent = [
    "下面是原视频的完整分析结果（其中【台词】一段带 [起-止] 时间码，必须按时间顺序内联到对应位置）：",
    "-----",
    analysis,
    "-----",
    dialogue
      ? `提取到的台词（带 [起-止] 时间码，必须按时间顺序内联进 integrated_multimodal_description，每句前写出对应秒数）：\n${dialogue}`
      : "",
    duration ? `原视频总时长 ${duration} 秒：时间段必须从 0 秒连续覆盖到 ${duration} 秒。` : "",
    input.voiceStyle?.trim()
      ? `音色要求：${input.voiceStyle.trim()}。必须在对应时间段的台词前写出说话人 ID 与音色描述（写在 <d> 外面），例如：变装后的男子 (S2) 用尖细阴柔的太监腔调说：<d>[中文]你得除掉根</d>`
      : "",
    input.mode === "i2v"
      ? "请严格按官方 I2VA 三字段结构输出一份提示词。"
      : "请按 [起-止秒｜标题] 分段的分镜脚本格式输出一份提示词，覆盖整个时长。",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...endpoint.headers },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.4,
        messages: [
          { role: "system", content: input.mode === "i2v" ? I2VA_RULES : T2VA_RULES },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `本地模型返回 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let content = data?.choices?.[0]?.message?.content ?? "";
    // 去掉模型可能自带的代码块包裹
    content = content.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();

    // 官方要求三个核心字段之间各留一个空行，模型经常挤在一起，这里统一规范
    // 模型偶尔把首行风格句包进 <>，样例里不需要
    content = content.replace(/^<([^>\n]+)>\s*\n?/, "$1\n");

    content = content
      .replace(/\n*(integrated_multimodal_description\s*:)/g, "\n\n$1")
      .replace(/\n*(overall_soundscape\s*:)/g, "\n\n$1")
      .replace(/\n*(non_diegetic_music\s*:)/g, "\n\n$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!content) return { ok: false, error: "本地模型返回空内容" };
    return { ok: true, prompt: content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `本地模型调用失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

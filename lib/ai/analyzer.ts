import { db } from "@/lib/db";
import { userApiKeys } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { decodeAnalyzeApiKey } from "@/lib/usage/trial-quota";
import { ANALYSIS_PROMPTS, extractCorePrompt } from "@/lib/ai/prompts";
import { describeAnalysisProviderError } from "@/lib/ai/provider-error";
import { requestKieChatCompletion } from "@/lib/ai/kie-chat-client";
import { buildKieAnalysisRequest } from "@/lib/ai/kie-analysis-request";
import { postJson } from "@/lib/http/json-client";
import type { Locale } from "@/i18n/config";
import { defaultLocale } from "@/i18n/config";
import { getLocalLlmEndpoint } from "@/lib/config/local-ai";

const KIE_BASE_URL = (process.env.KIE_AI_BASE_URL || process.env.KIE_API_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");

// 本地大模型配置改为运行时读取（支持网页「设置」里修改地址/模型），
// 见 @/lib/config/local-ai.ts

// API 配置
const API_CONFIGS = {
  zhipu: {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4v-plus",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent",
    model: "gemini-2.0-flash-exp",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemini-2.5-flash",
  },
  kie: {
    model: "gemini-3-5-flash-thinking",
  },
};

// 环境变量中的 API Keys
const ENV_API_KEYS = {
  zhipu: process.env.ZHIPU_API_KEY || null,
  openrouter: process.env.OPENROUTER_API_KEY || null,
  gemini: process.env.GEMINI_API_KEY || null,
  kie: process.env.KIE_AI_API_KEY || process.env.KIE_API_KEY || null,
  local: process.env.LOCAL_LLM_API_KEY || "local", // 本地模型不需要密钥
};

export type ApiProvider = "zhipu" | "gemini" | "openrouter" | "kie" | "local";

export interface AnalyzeOptions {
  userId: string;
  provider?: ApiProvider;
  frames: string[]; // base64 编码的图片数组
  mode: "single" | "batch";
  /** AI 输出语言（默认 zh，影响生成结果的文本语言） */
  outputLanguage?: Locale;
  /**
   * 每帧在原视频中的时间位置（秒），与 frames 一一对应。
   * 提供后会要求模型额外输出带时间码的「时间轴拆解」，
   * 这样才能和台词时间对齐。
   */
  frameTimestamps?: number[];
  /** Provider-specific model selected by the trusted server route. */
  model?: string;
  /** Platform key selected by the billing route; never accepted from clients. */
  apiKeyOverride?: string;
}

export interface AnalyzeResult {
  success: boolean;
  prompt?: string;
  corePrompt?: string;
  error?: string;
}

/**
 * 获取 API Key - 优先使用用户配置，其次使用平台环境变量
 */
async function getUserApiKey(
  userId: string,
  provider: ApiProvider
): Promise<string | null> {
  // OpenRouter is the platform-funded path. Never consume a user's saved key.
  if (provider === "openrouter") return ENV_API_KEYS.openrouter;
  // 本地模型使用环境变量端点，无需用户 key
  if (provider === "local") return ENV_API_KEYS.local;

  const records = await db.query.userApiKeys.findMany({
    where: and(
      eq(userApiKeys.userId, userId),
      eq(userApiKeys.provider, provider),
      eq(userApiKeys.isActive, true)
    ),
    orderBy: [desc(userApiKeys.updatedAt), desc(userApiKeys.createdAt)],
  });

  for (const record of records) {
    const apiKey = decodeAnalyzeApiKey(record.apiKey);
    if (apiKey) {
      console.log(`[Analyzer] Using user API key for ${provider}`);
      return apiKey;
    }
  }

  // KIE is BYOK-only for analysis. Platform KIE credentials must not be used here.
  const envKey = provider === "kie" ? null : ENV_API_KEYS[provider];
  if (envKey) {
    console.log(`[Analyzer] Using env API key for ${provider}`);
    return envKey;
  }

  return null;
}

/**
 * 调用智谱AI API
 */
async function callZhipuApi(
  apiKey: string,
  messages: any[]
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const payload = {
    model: API_CONFIGS.zhipu.model,
    messages: messages,
    max_tokens: 4096,
    temperature: 0.7,
  };

  const data = await postJson<any>(API_CONFIGS.zhipu.url, payload, {
    headers,
    timeoutMs: 180_000,
  });

  if (!data.choices || data.choices.length === 0) {
    throw new Error("API returned empty result");
  }

  const content = data.choices[0].message.content;
  if (!content) {
    const finishReason = data.choices[0].finish_reason;
    throw new Error(
      `API returned null content (finish_reason: ${finishReason}). The model may not support image input or rejected the request.`
    );
  }

  return content;
}

/**
 * 调用 Gemini API
 */
async function callGeminiApi(
  apiKey: string,
  images: string[],
  textPrompt: string
): Promise<string> {
  const contents = [];

  for (const img of images) {
    const inlineData = await loadGeminiImage(img);
    contents.push({
      role: "user",
      parts: [
        { inline_data: inlineData },
        { text: textPrompt },
      ],
    });
  }

  const payload = {
    contents,
    generationConfig: { maxOutputTokens: 4096 },
  };

  const url = `${API_CONFIGS.gemini.url}?key=${apiKey}`;
  const data = await postJson<any>(url, payload, {
    timeoutMs: 180_000,
  });

  if (!data.candidates || data.candidates.length === 0) {
    throw new Error("API returned empty result");
  }

  return data.candidates[0].content.parts[0].text;
}

async function loadGeminiImage(image: string) {
  const dataUrl = image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i);
  if (dataUrl) return { mime_type: dataUrl[1].toLowerCase(), data: dataUrl[2] };

  const response = await fetch(image, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Failed to load analysis frame (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 2 * 1024 * 1024) throw new Error("Analysis frame is too large");
  return {
    mime_type: response.headers.get("content-type")?.split(";")[0] || "image/jpeg",
    data: buffer.toString("base64"),
  };
}


/** 调用 KIE 对应模型的图片分析接口。 */
async function callKieAnalysisApi(
  apiKey: string,
  frames: string[],
  prompt: string,
  model: string,
): Promise<string> {
  const { path: channel, payload } = buildKieAnalysisRequest(model, frames, prompt);
  const result = await requestKieChatCompletion({
    url: `${KIE_BASE_URL}${channel}`,
    apiKey,
    payload,
  });
  console.log("[KIE] Response received", { model, channel });
  return result;
}
/**
 * 调用 OpenRouter API
 */
async function callOpenRouterApi(
  apiKey: string,
  messages: any[],
  model: string,
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://prompt-analyzer.com",
    "X-Title": "Prompt Analyzer",
  };

  const payload = {
    model,
    messages: messages,
    max_tokens: 4096,
  };

  console.log("[OpenRouter] Request:", { url: API_CONFIGS.openrouter.url, model, keyPrefix: apiKey.substring(0, 10) });

  const data = await postJson<any>(API_CONFIGS.openrouter.url, payload, {
    headers,
    timeoutMs: 180_000,
  });

  console.log("[OpenRouter] Response received", { model });

  if (!data.choices || data.choices.length === 0) {
    throw new Error("API returned empty result");
  }

  return data.choices[0].message.content;
}

/**
 * 调用本地大模型（OpenAI 兼容 /v1/chat/completions，支持图片输入）
 */
async function callLocalApi(
  messages: any[],
  model: string,
): Promise<string> {
  // 运行时读取端点与鉴权头（网页「设置」里可改地址 / 模型 / API Key）
  const localEndpoint = getLocalLlmEndpoint();
  const headers: Record<string, string> = { ...localEndpoint.headers };

  const payload = {
    model,
    messages: messages,
    max_tokens: 4096,
    temperature: 0.7,
  };

  console.log("[LocalLLM] Request:", {
    url: localEndpoint.url,
    model,
    auth: localEndpoint.apiKey ? "bearer" : "none",
  });

  const data = await postJson<any>(localEndpoint.url, payload, {
    headers,
    timeoutMs: 300_000,
  });

  if (!data.choices || data.choices.length === 0) {
    throw new Error("Local LLM returned empty result");
  }

  const content = data.choices[0].message?.content;
  if (!content) {
    const finishReason = data.choices[0].finish_reason;
    throw new Error(
      `Local LLM returned null content (finish_reason: ${finishReason}). The model may not support image input or rejected the request.`
    );
  }

  return content;
}

/**
 * 分析图片/帧
 */
/** 秒 -> MM:SS.S */
function clockTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * 在提示词末尾追加「帧时间轴」指令。
 * 只有拿到每帧的时间位置，模型才可能输出能和台词对齐的时间轴。
 */
function appendTimelineInstruction(prompt: string, timestamps?: number[]): string {
  if (!timestamps || timestamps.length === 0) return prompt;

  const list = timestamps
    .map((t, index) => `第${index + 1}帧 = ${clockTime(t)}`)
    .join("\n");

  return `${prompt}

───────────────────────────────────────────────
【帧时间轴（必须输出）】
下面按时间顺序给出了抽取的画面帧，以及每帧在原视频中的时间位置：
${list}

请在完成上面的分析之后，额外输出一节「⏱️ 时间轴拆解」，逐段描述画面随时间的变化。
格式必须严格如下（每行一段，时间码精确到 0.1 秒）：
[00:00.0] 该时间点的画面：人物 / 动作 / 造型 / 道具 / 场景
[00:04.0] …

要求：
1. 时间码只能使用上面列出的帧时间，禁止自己编造时间。
2. 相邻帧之间若发生明显变化（换装、换景、转场、动作切换），必须写明「X.X 秒处发生变装 / 转场」。
3. 这一节要能和台词时间轴对齐，所以必须写清「哪一秒画面上是什么」。
4. 时间轴放在全文最后。`;
}

export async function analyzeFrames(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { userId, provider = "openrouter", frames, mode, outputLanguage = defaultLocale } = options;
  const model =
    options.model ||
    (provider === "kie"
      ? API_CONFIGS.kie.model
      : provider === "local"
        ? getLocalLlmEndpoint().model
        : API_CONFIGS.openrouter.model);

  // 获取用户 API Key
  const apiKey = options.apiKeyOverride || await getUserApiKey(userId, provider);

  if (!apiKey) {
    const envKeyConfigured = ENV_API_KEYS[provider] ? " (env configured)" : "";
    return {
      success: false,
      error: `No API key found for ${provider}${envKeyConfigured}. Please configure your API key in settings or check .env file.`,
    };
  }

  // 按用户选择的语言注入对应 prompt 模板
  const promptTemplate = ANALYSIS_PROMPTS[outputLanguage];
  const promptBase = mode === "batch" ? promptTemplate.batch : promptTemplate.single;
  // 有帧时间戳时，额外要求模型输出带时间码的时间轴
  const prompt = appendTimelineInstruction(promptBase, options.frameTimestamps);

  try {
    let result: string;

    if (provider === "zhipu") {
      // 智谱AI
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...frames.map((frame) => ({
              type: "image_url",
              image_url: { url: frame },
            })),
          ],
        },
      ];
      result = await callZhipuApi(apiKey, messages);
    } else if (provider === "gemini") {
      // Gemini
      result = await callGeminiApi(apiKey, frames, prompt);
    } else if (provider === "kie") {
      result = await callKieAnalysisApi(apiKey, frames, prompt, model);
    } else if (provider === "local") {
      // 本地大模型（OpenAI 兼容，Qwen3.8 视觉模型，支持图片输入）
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...frames.map((frame) => ({
              type: "image_url",
              image_url: { url: frame },
            })),
          ],
        },
      ];
      result = await callLocalApi(messages, model);
    } else {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...frames.map((frame) => ({
              type: "image_url",
              image_url: { url: frame },
            })),
          ],
        },
      ];

      result = await callOpenRouterApi(apiKey, messages, model);
    }

    // 提取核心提示词（兼容中英文格式）
    const corePrompt = extractCorePrompt(result);

    return {
      success: true,
      prompt: result,
      corePrompt,
    };
  } catch (error: unknown) {
    console.error("AI Analysis error:", {
      provider,
      model,
      message: error instanceof Error ? error.message : "Analysis failed",
    });
    return {
      success: false,
      error: describeAnalysisProviderError(provider, error, outputLanguage),
    };
  }
}

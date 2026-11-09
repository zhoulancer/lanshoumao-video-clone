import fs from "fs";
import path from "path";

/**
 * 本地 AI 配置（单机模式）
 * ------------------------------------------------------------------
 * 允许在网页「设置」里直接填写本地大模型地址与模型名，无需改 .env 重启。
 * 配置保存在 <项目根>/data/local-ai.json，读取时优先级：
 *   1. data/local-ai.json（网页设置）
 *   2. 环境变量 LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL / WHISPER_MODEL_SIZE
 *   3. 内置默认值
 */

export interface LocalAiConfig {
  /** OpenAI 兼容端点根地址，例如 http://192.168.3.218:8080 或 https://api.deepseek.com */
  baseUrl: string;
  /** 模型名，例如 qwen3.8-flash-next-iq3_s 或 deepseek-chat */
  model: string;
  /** 可选 API Key。本地模型留空；使用 DeepSeek 等外部服务时填写 */
  apiKey: string;
  /** faster-whisper 模型大小：tiny/base/small/medium/large-v3 */
  whisperModel: string;
  /** H3 视频生成服务地址（Gradio 工作台），例如 http://192.168.3.100:7860 */
  h3BaseUrl: string;
  /**
   * 台词纠错表：多行文本，每行 `错误=正确`。
   * 语音识别对同音字常出错（如「戒色」被识别成「借色」），
   * 转写结果与历史记录返回时都会按这里的规则替换。
   */
  corrections: string;
}

const CONFIG_PATH = path.join(process.cwd(), "data", "local-ai.json");

const DEFAULTS: LocalAiConfig = {
  baseUrl: (process.env.LOCAL_LLM_BASE_URL || "http://192.168.3.218:8080").replace(/\/$/, ""),
  model: process.env.LOCAL_LLM_MODEL || "qwen3.8-flash-next-iq3_s",
  apiKey: process.env.LOCAL_LLM_API_KEY && process.env.LOCAL_LLM_API_KEY !== "local"
    ? process.env.LOCAL_LLM_API_KEY
    : "",
  whisperModel: process.env.WHISPER_MODEL_SIZE || "small",
  // 一键包内 H3 工作台由启动器在本机拉起，默认走 localhost:7860
  h3BaseUrl: (process.env.H3_BASE_URL || "http://localhost:7860").replace(/\/$/, ""),
  corrections: "",
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 读取当前生效的本地 AI 配置。文件不存在或损坏时回退到环境变量/默认值。 */
export function readLocalAiConfig(): LocalAiConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalAiConfig>;
    return {
      baseUrl: parsed.baseUrl ? normalizeBaseUrl(parsed.baseUrl) : DEFAULTS.baseUrl,
      model: parsed.model?.trim() || DEFAULTS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : DEFAULTS.apiKey,
      whisperModel: parsed.whisperModel?.trim() || DEFAULTS.whisperModel,
      h3BaseUrl: parsed.h3BaseUrl ? normalizeBaseUrl(parsed.h3BaseUrl) : DEFAULTS.h3BaseUrl,
      corrections: typeof parsed.corrections === "string" ? parsed.corrections : DEFAULTS.corrections,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 写入本地 AI 配置（局部更新），返回写入后的完整配置。 */
export function writeLocalAiConfig(patch: Partial<LocalAiConfig>): LocalAiConfig {
  const current = readLocalAiConfig();
  const next: LocalAiConfig = {
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    model: patch.model !== undefined ? patch.model.trim() : current.model,
    apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : current.apiKey,
    whisperModel: patch.whisperModel !== undefined ? patch.whisperModel.trim() : current.whisperModel,
    h3BaseUrl: patch.h3BaseUrl !== undefined ? normalizeBaseUrl(patch.h3BaseUrl) : current.h3BaseUrl,
    corrections: patch.corrections !== undefined ? patch.corrections : current.corrections,
  };
  if (!next.baseUrl) next.baseUrl = DEFAULTS.baseUrl;
  if (!next.model) next.model = DEFAULTS.model;

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** 取 OpenAI 兼容的 chat/completions 完整地址、模型名与鉴权头。 */
export function getLocalLlmEndpoint(): {
  url: string;
  model: string;
  apiKey: string;
  headers: Record<string, string>;
} {
  const cfg = readLocalAiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // 本地服务通常不校验；配了 Key 就带上（如 DeepSeek 等外部服务必需）
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return {
    url: `${cfg.baseUrl}/v1/chat/completions`,
    model: cfg.model,
    apiKey: cfg.apiKey,
    headers,
  };
}

/**
 * 应用台词纠错规则。
 * 规则来自设置里的多行文本，每行 `错误=正确`，忽略空行与 # 注释。
 * 语音识别对同音字很容易出错（例如把「戒色」识别成「借色」）。
 */
export function applyCorrections(text: string, rules?: string): string {
  if (!text) return text;
  const raw = rules !== undefined ? rules : readLocalAiConfig().corrections;
  if (!raw || !raw.trim()) return text;

  let result = text;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const from = trimmed.slice(0, idx).trim();
    const to = trimmed.slice(idx + 1).trim();
    if (!from) continue;
    result = result.split(from).join(to);
  }
  return result;
}

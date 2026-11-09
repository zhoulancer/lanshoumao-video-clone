import { readLocalAiConfig } from "@/lib/config/local-ai";

/**
 * MiniMax H3 视频生成客户端
 * ------------------------------------------------------------------
 * 对接 http://<h3>/gradio_api （Gradio 6）的 MiniMax H3 工作台。
 *
 * 提交： POST /gradio_api/call/submit_minimax_from_slots   body {"data":[...]}
 *        -> { event_id }
 * 结果： POST /gradio_api/call/check_and_get_video          body {"data":[]}
 *        -> { event_id }，再 GET /gradio_api/call/<name>/<event_id> 读 SSE
 *
 * submit_minimax_from_slots 需要 57 个位置参数，顺序已按工作台定义固定，
 * 这里用默认值填充，只暴露常用项（提示词、模式、比例、时长、步数、seed）。
 */

const API_PREFIX = "/gradio_api";

/** submit_minimax_from_slots 的 57 个参数默认值（顺序即位置） */
function buildSubmitArgs(overrides: {
  prompt: string;
  mode?: string;
  aspectRatio?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: string;
  steps?: number;
  seed?: number;
  firstFramePath?: string | null;
}): unknown[] {
  const {
    prompt,
    mode = "文生视频",
    aspectRatio = "16:9",
    resolution = "544p",
    width,
    height,
    duration = "5",
    steps = 8,
    seed = -1,
    firstFramePath = null,
  } = overrides;

  const args: unknown[] = [];
  // 0 生成模式（有首帧图就走图生视频）
  args.push(firstFramePath ? "图生视频（首帧/可选尾帧）" : mode);
  // 1 视频与音频提示词
  args.push(prompt);
  // 2 批量图生视频模式
  args.push("批量单图视频");
  // 3 上传批量图片
  args.push(null);
  // 4 批量提示词
  args.push("");
  // 5 首帧图片（图生视频时必填）
  args.push(firstFramePath ? { path: firstFramePath, meta: { _type: "gradio.FileData" } } : null);
  // 6 尾帧图片
  args.push(null);
  // 7 参考图处理尺寸
  args.push("match");
  // 8 模型模式
  args.push("high_quality");
  // 9 自定义文生/图生主模型
  args.push("__follow_model_mode__");
  // 10 自定义全能参考主模型
  args.push("__follow_model_mode__");
  // 11..30 LoRA 1..10 模型与强度
  const loraStrength = [0.8, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
  for (let i = 0; i < 10; i += 1) {
    args.push("__disable_lora__");
    args.push(loraStrength[i]);
  }
  // 31 画面比例
  args.push(aspectRatio);
  // 32 清晰度
  args.push(resolution);
  // 33/34 实际输出宽高
  // 必须按比例推导，否则选 9:16 也会输出成 960x544 横屏。
  const aSize = resolveVideoSize(aspectRatio, resolution);
  args.push(width ?? aSize.width);
  args.push(height ?? aSize.height);
  // 35 生成时长
  // 注意：工作台这个控件是 Radio，choices 是整数 [2..15]，
  // 传字符串 '5' 会被 gradio 的 radio.preprocess 拒绝：
  //   Value: '5' (type: <class 'str'>) is not in the list of choices: [2, 3, ..., 15]
  // 所以这里必须传数字。
  const durationSeconds = Number.parseInt(String(duration), 10);
  args.push(Number.isFinite(durationSeconds) ? durationSeconds : 5);
  // 36 视频质量模式（Radio，choices 是整数 [1,2,3]，必须传数字）
  args.push(2);
  // 37 推理步数
  args.push(steps);
  // 38 FlashVSR 高清放大
  args.push(false);
  // 39 FlashVSR 放大质量模式（Radio，字符串）
  args.push("tiny-long");
  // 40 FlashVSR 放大倍数（Radio，choices 是整数 [2,3,4]，必须传数字）
  args.push(2);
  // 41 Seed
  args.push(seed);
  // 42..50 参考图片 Picture 1..9
  for (let i = 0; i < 9; i += 1) args.push(null);
  // 51..53 参考视频 Video 1..3
  for (let i = 0; i < 3; i += 1) args.push(null);
  // 54..56 参考音频 Audio 1..3
  for (let i = 0; i < 3; i += 1) args.push(null);

  return args;
}

async function h3Base(): Promise<string> {
  return readLocalAiConfig().h3BaseUrl.replace(/\/+$/, "");
}

/** 提交生成任务，返回 event_id。 */

/** 清晰度预设 = H3 工作台「清晰度」下拉里的基准尺寸 */
const RES_BASE: Record<string, [number, number]> = {
  "480p": [864, 480],
  "544p": [960, 544],
  "768p": [1344, 768],
};

/** 按「清晰度预设 × 画面比例」推导实际输出宽高（宽高取 8 的倍数） */
export function resolveVideoSize(aspectRatio: string, resolution: string): { width: number; height: number } {
  const [baseW, baseH] = RES_BASE[resolution] ?? [960, 544];
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio || "");
  if (!m) return { width: baseW, height: baseH };
  const ra = parseFloat(m[1]);
  const rb = parseFloat(m[2]);
  if (!(ra > 0 && rb > 0)) return { width: baseW, height: baseH };
  // H3 要求宽高必须是 32 的倍数，否则报「视频宽度必须是 32 的倍数」
  const ROUND = 32;
  const scale = Math.sqrt((baseW * baseH) / (ra * rb));
  return {
    width: Math.max(ROUND, Math.round((ra * scale) / ROUND) * ROUND),
    height: Math.max(ROUND, Math.round((rb * scale) / ROUND) * ROUND),
  };
}


/** 把 data URL 图片上传到 H3 工作台，返回服务端文件路径 */
async function uploadToGradio(base: string, dataUrl: string, fileName: string): Promise<string> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!m) throw new Error("首帧数据格式不正确（需要 data:image/...;base64,...）");
  const buf = Buffer.from(m[2], "base64");
  const form = new FormData();
  form.append("files", new Blob([buf], { type: m[1] }), fileName || "first-frame.jpg");
  const res = await fetch(`${base}/gradio_api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`首帧上传失败 HTTP ${res.status}`);
  const arr = (await res.json()) as unknown;
  const first = Array.isArray(arr) ? arr[0] : arr;
  if (!first || typeof first !== "string") throw new Error("首帧上传未返回文件路径");
  return first;
}

export async function submitH3(params: {
  prompt: string;
  mode?: string;
  aspectRatio?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: string;
  steps?: number;
  seed?: number;
  /** 首帧图（data URL）；给了就自动切「图生视频（首帧/可选尾帧）」模式 */
  firstFrame?: { dataUrl: string; fileName?: string };
}): Promise<string> {
  const base = await h3Base();
  if (!base) throw new Error("未配置 H3 服务地址，请到「设置」里填写");

  const firstFramePath = params.firstFrame
    ? await uploadToGradio(base, params.firstFrame.dataUrl, params.firstFrame.fileName || "first-frame.jpg")
    : null;
  const args = buildSubmitArgs({ ...params, firstFramePath });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  const res = await fetch(`${base}${API_PREFIX}/call/submit_minimax_from_slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: args }),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`H3 提交失败 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const data = (await res.json()) as { event_id?: string };
  if (!data.event_id) throw new Error("H3 未返回 event_id");

  // 读一次提交事件的 SSE，取出工作台分配的「任务 ID」（形如 fe9c458c）。
  // 之后轮询用这个 ID 和监控日志比对，才能确定结果是不是本次任务的。
  // 注意：SSE 里的中文是 \uXXXX 转义的，直接对原文正则匹配不到「任务」，
  // 所以先用 lastDataPayload 解出 JSON，再在解码后的字符串里找。
  let taskId: string | null = null;
  try {
    const sub = await fetch(
      `${base}${API_PREFIX}/call/submit_minimax_from_slots/${data.event_id}`,
      { headers: { Accept: "text/event-stream" } },
    );
    const text = await sub.text();
    const payload = lastDataPayload(text);
    const decoded = Array.isArray(payload)
      ? payload.map((item) => String(item ?? "")).join("\n")
      : text;
    taskId =
      decoded.match(/任务\s*ID[:：]\s*([0-9a-zA-Z]+)/)?.[1] ??
      // 兜底：ID 前后的「ID:」是 ASCII，即使中文没解码也能抓
      text.match(/ID[:：]\s*([0-9a-fA-F]{6,})\s*\|/)?.[1] ??
      null;
  } catch {
    // 拿不到任务 ID 也不影响提交，只是轮询只能靠状态判断
  }

  setH3Job({
    eventId: data.event_id,
    taskId,
    baseUrl: base,
    submittedAt: Date.now(),
  });

  return data.event_id;
}

/** 当前跟踪的 H3 任务（存 globalThis，避免 dev 模式热重载丢状态） */
export interface H3Job {
  eventId: string;
  /** 工作台内部任务 ID，出现在监控日志里，用于确认结果归属 */
  taskId: string | null;
  baseUrl: string;
  submittedAt: number;
}

const H3_JOB_KEY = "__promptLensH3Job";

function jobSlot(): { current: H3Job | null } {
  const store = globalThis as unknown as Record<string, { current: H3Job | null } | undefined>;
  if (!store[H3_JOB_KEY]) store[H3_JOB_KEY] = { current: null };
  return store[H3_JOB_KEY]!;
}

export function setH3Job(job: H3Job | null): void {
  jobSlot().current = job;
}

export function getH3Job(): H3Job | null {
  return jobSlot().current;
}

/** 递归找出输出里第一个视频文件路径 */
function findVideoPath(node: unknown, depth = 0): string | null {
  if (depth > 8 || node == null) return null;
  if (typeof node === "string") {
    return /\.(mp4|webm|mov|mkv)(\?|$)/i.test(node) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findVideoPath(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["video", "url", "path", "name", "value"]) {
      const found = findVideoPath(obj[key], depth + 1);
      if (found) return found;
    }
    for (const value of Object.values(obj)) {
      const found = findVideoPath(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}


/**
 * 查询当前提交的任务是否完成。
 *
 * 只跟踪自己提交的 eventId（submit 时记录），不再读工作台界面上
 * 的 gallery —— 那里残留的是上一次运行导出的旧视频，
 * 之前正是它导致「一点开始生成就立刻显示旧视频」。
 */
export async function checkH3Video(): Promise<{
  videoUrl: string | null;
  status: string;
  failed?: boolean;
  eventId?: string;
}> {
  const job = getH3Job();

  // 没有提交过任务：绝不返回任何历史视频
  if (!job) {
    return { videoUrl: null, status: "无任务（尚未提交）" };
  }

  const base = job.baseUrl || (await h3Base());
  if (!base) throw new Error("未配置 H3 服务地址");

  // 真实进度和结果都在 check_and_get_video 里：
  //   [0] 画廊（完成后才出现视频）  [1] 状态  [2] 队列  [3] 资源  [4] 监控日志
  const payload = await queryCheckAndGetVideo(base);
  if (!payload) {
    return { videoUrl: null, status: "等待工作台响应…", eventId: job.eventId };
  }
  const gallery = payload[0];
  const statusText = typeof payload[1] === "string" ? payload[1] : "";
  const queueText = typeof payload[2] === "string" ? payload[2] : "";
  const logText = typeof payload[4] === "string" ? payload[4] : "";

  // 监控日志里同时混着历史任务：只截取「本次任务」那一段来判断失败
  // 否则上一次的 ❌（例如「视频宽度必须是 32 的倍数」）会把新任务误判成失败
  // 监控日志是【新的在上面】：本次任务只占最上面几行
  // （已提交 / 已连接监控 / 执行完毕 / 准备失败），绝不能扫到整段历史
  const logLines = logText.split("\n").filter((l) => l.trim());
  let anchorIdx = -1;
  if (job.taskId) {
    anchorIdx = logLines.findIndex((l) => l.includes(job.taskId));
  }
  const mine = anchorIdx >= 0;
  const mineLog = mine
    ? logLines.slice(0, anchorIdx + 2).join("\n")   // 含「监控连接」和它下面的「已提交」
    : logLines.slice(0, 3).join("\n");             // 还没拿到任务 ID 时只看最新的 3 行

  // 完成优先判断：本次任务执行完毕就是成功，历史失败记录与它无关
  const finished = !!job.taskId && mineLog.includes(`任务执行完毕: ${job.taskId}`);

  // 失败：只在本次任务那一段里找
  if (!finished && mine && /失败|❌/.test(mineLog)) {
    const line = mineLog.split("\n").find((l) => /失败|❌/.test(l));
    setH3Job(null);
    return {
      videoUrl: null,
      failed: true,
      status: `生成失败：${line?.trim() || "H3 报错"}`,
      eventId: job.eventId,
    };
  }
  if (finished) {
    const path = findVideoPath(gallery);
    setH3Job(null);
    if (path) {
      const videoUrl = /^https?:\/\//i.test(path)
        ? path
        : `${base}/gradio_api/file=${path.replace(/^\//, "")}`;
      return { videoUrl, status: "生成完成", eventId: job.eventId };
    }
    return {
      videoUrl: null,
      failed: true,
      status: "任务完成但没拿到视频文件",
      eventId: job.eventId,
    };
  }

  // 进度：状态里形如「SamplerCustomAdvanced: 3/8」
  const stepMatch = statusText.match(/:\s*(\d+)\s*\/\s*(\d+)/);
  if (stepMatch) {
    const done = Number(stepMatch[1]);
    const total = Number(stepMatch[2]) || 1;
    return {
      videoUrl: null,
      status: `生成中 ${Math.round((done / total) * 100)}%（${done}/${total}）`,
      eventId: job.eventId,
    };
  }
  if (statusText.includes("任务执行中")) {
    const node = statusText.split("\n").filter(Boolean).pop() || "";
    return { videoUrl: null, status: `生成中：${node}`, eventId: job.eventId };
  }
  return {
    videoUrl: null,
    status: `排队中（${queueText || "等待工作台"}）`,
    eventId: job.eventId,
  };
}

/** 调工作台的 check_and_get_video，返回 [画廊, 状态, 队列, 资源, 日志] */
async function queryCheckAndGetVideo(base: string): Promise<unknown[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${base}${API_PREFIX}/call/check_and_get_video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const { event_id } = (await res.json()) as { event_id?: string };
    if (!event_id) return null;

    const sse = await fetch(`${base}${API_PREFIX}/call/check_and_get_video/${event_id}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    const payload = lastDataPayload(await sse.text());
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 SSE 里最后一条可解析的 data: JSON */
function lastDataPayload(text: string): unknown {
  let payload: unknown = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "null") continue;
    try {
      payload = JSON.parse(raw);
    } catch {
      // 忽略非 JSON 行
    }
  }
  return payload;
}

/** 探测 H3 服务是否可用并返回应用标题。 */
export async function probeH3(baseUrl: string): Promise<{ ok: boolean; title?: string; error?: string }> {
  const base = (baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "地址为空" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`${base}/config`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const cfg = (await res.json()) as { components?: Array<{ props?: { value?: string } }> };
    const titleComp = (cfg.components || []).find((c) =>
      String(c?.props?.value || "").includes("H3"),
    );
    return { ok: true, title: titleComp?.props?.value?.replace(/<[^>]+>/g, "") || "H3" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

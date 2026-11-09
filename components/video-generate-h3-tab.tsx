"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Settings, RefreshCw } from "lucide-react";
import { convertMergedToH3, formatDialogueWithTiming } from "@/lib/utils/dialogue";

/**
 * 视频生成（MiniMax H3 专用）
 * ------------------------------------------------------------------
 * 只走本机 H3 工作台（Gradio），不再走 KIE 等云服务。
 * 服务地址在「设置 → H3 视频生成服务地址」里配置。
 *
 * 流程：提交 -> 拿到 eventId -> 轮询 check_and_get_video -> 拿到视频地址。
 */

const DURATIONS = ["5", "10"];
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

export function VideoGenerateH3Tab({
  onConfigureApiKey,
  initialPrompt = "",
  // 「用于视频生成」时带过来的视频地址（优先级最高，保证截到的是刚分析的那条）
  sourceMediaUrl = "",
}: {
  onConfigureApiKey: () => void;
  initialPrompt?: string;
  sourceMediaUrl?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  // 上框：从「用于视频生成」带入的合并原文（分析 + 台词），点① 才转成 H3 提示词
  const [rawInput, setRawInput] = useState(initialPrompt);
  const [duration, setDuration] = useState(5);
  // 输入框用文本态，避免每敲一个字符就被夹到 2-15 导致数字乱跳
  const [durationInput, setDurationInput] = useState("5");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("544p");
  // 实际输出宽高：随画面比例 / 清晰度自动联动，也可手动改
  const [outSize, setOutSize] = useState({ width: 960, height: 544 });
  // 画面比例 / 清晰度：从 H3 工作台接口实时读取，界面与工作台保持一致
  const [ratioOptions, setRatioOptions] = useState<string[]>([]);
  const [resolutionOptions, setResolutionOptions] = useState<string[]>([]);
  // H3 工作台原始 label（例如 "544P · 960×544"），界面上直接显示，证明是接口值

  // 与后端一致的尺寸推导：清晰度基准 × 画面比例，取 32 的倍数（H3 要求）
  const RES_BASE_SIZE: Record<string, [number, number]> = {
    "480p": [864, 480],
    "544p": [960, 544],
    "768p": [1344, 768],
  };
  const calcSize = (ratio: string, res: string) => {
    const [bw, bh] = RES_BASE_SIZE[res] ?? [960, 544];
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio || "");
    if (!m) return { width: bw, height: bh };
    const ra = parseFloat(m[1]);
    const rb = parseFloat(m[2]);
    if (!(ra > 0 && rb > 0)) return { width: bw, height: bh };
    const scale = Math.sqrt((bw * bh) / (ra * rb));
    return {
      width: Math.max(32, Math.round((ra * scale) / 32) * 32),
      height: Math.max(32, Math.round((rb * scale) / 32) * 32),
    };
  };

  const [ratioSpecs, setRatioSpecs] = useState<{ value: string; label: string }[]>([]);
  const [resolutionSpecs, setResolutionSpecs] = useState<{ value: string; label: string }[]>([]);
  const [steps, setSteps] = useState(8);
  const [seed, setSeed] = useState(-1);

  const [isGenerating, setIsGenerating] = useState(false);
  const [merging, setMerging] = useState(false);
  // 提示词模式：t2v 分镜脚本式（默认） / i2v 三字段式
  const [h3Mode, setH3Mode] = useState<"t2v" | "i2v">("t2v");
  // 音色要求（可选）：例如换装后改用太监腔
  const [voiceStyle, setVoiceStyle] = useState("");
  const h3Format = true;
  const [status, setStatus] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // 首帧图（转 I2V 用）与来源视频地址
  const [firstFrame, setFirstFrame] = useState<string | null>(null);
  const [sourceVideoUrl, setSourceVideoUrl] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [currentFrameAt, setCurrentFrameAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // 从「视频分析」点「用于视频生成」跳过来时，把提示词同步进输入框。
  // 只在外部传入新内容时覆盖，不会冲掉用户手改的内容。
  useEffect(() => {
    // 先本地秒出，再向 H3 要它自己的联动结果（含该比例下的清晰度选项）
    setOutSize(calcSize(aspectRatio, resolution));
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/video-generate/h3-size", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aspectRatio, resolution }),
        });
        const d = await res.json().catch(() => null);
        if (cancelled || !d?.ok) return;
        if (Number(d.width) > 0 && Number(d.height) > 0) {
          setOutSize({ width: Number(d.width), height: Number(d.height) });
        }
        if (Array.isArray(d.resolutionChoices) && d.resolutionChoices.length) {
          setResolutionSpecs(d.resolutionChoices);
        }
        if (d.resolution && d.resolution !== resolution) setResolution(d.resolution);
      } catch {
        /* 用本地推导值 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aspectRatio, resolution]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/video-generate/h3-options", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled || !data?.ok) return;
        if (Array.isArray(data.aspectSpecs)) setRatioSpecs(data.aspectSpecs);
        if (Array.isArray(data.resolutionSpecs)) setResolutionSpecs(data.resolutionSpecs);
        if (Array.isArray(data.aspectRatios) && data.aspectRatios.length) {
          setRatioOptions(data.aspectRatios);
          setAspectRatio((cur) => (data.aspectRatios.includes(cur) ? cur : data.aspectRatios[0]));
        }
        if (Array.isArray(data.resolutions) && data.resolutions.length) {
          setResolutionOptions(data.resolutions);
          setResolution((cur) => (data.resolutions.includes(cur) ? cur : (data.defaultResolution || data.resolutions[0])));
        }
      } catch {
        /* 读取失败就用内置默认值 */
      }
    })();
    return () => { cancelled = true; };
  }, []);


  // 外部带入的来源视频优先：保证「截首帧」用的是刚分析的那条视频
  useEffect(() => {
    if (!sourceMediaUrl) return;
    setSourceVideoUrl((prev) => {
      const fromProp = sourceMediaUrl;
      if (prev && prev !== fromProp) setFirstFrame(null);
      return fromProp;
    });
  }, [sourceMediaUrl]);

  useEffect(() => {
    if (!initialPrompt) return;
    // 只填入上框（合并原文），下框留空；点「① 合并并转为 H3 提示词」后才生成提示词
    setRawInput(initialPrompt);
    setPrompt("");
    setError(null);
    setStatus("已把分析结果 + 台词放进上框，点「① 合并并转为 H3 提示词」生成提示词");
  }, [initialPrompt]);

  // 生成时长默认跟随原视频：分析记录里存了 mediaDuration
  const [originalDuration, setOriginalDuration] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/history?limit=50", { cache: "no-store" });
        const data = await res.json();
        const list = Array.isArray(data?.history) ? data.history : [];

        const urlOf = (h?: { mediaUrl?: string; metadata?: { mediaUrl?: string } }) =>
          h?.mediaUrl || h?.metadata?.mediaUrl || "";

        // 1) 外部带入的地址（历史/分析结果点「用于视频生成」）
        // 2) 按 mediaUrl 精确匹配；3) 按上框文案前 60 字匹配；4) 最新一条
        const matchByUrl = sourceMediaUrl ? list.find((h) => urlOf(h) === sourceMediaUrl) : null;
        const probe = (initialPrompt || "").slice(0, 60).trim();
        const matchByPrompt =
          !matchByUrl && probe
            ? list.find((h: { prompt?: string }) => (h?.prompt || "").slice(0, 60).trim() === probe)
            : null;
        const rec = matchByUrl ?? matchByPrompt ?? list[0] ?? {};
        const recUrl = sourceMediaUrl || urlOf(rec) || "";

        if (!cancelled && recUrl) setSourceVideoUrl(recUrl);

        // 时长以「视频文件真实长度」为准，读不到才用存库值：
        // 这样无论历史里记的是 3.1 还是 15，界面都跟实际视频一致
        let realDuration = 0;
        if (recUrl) {
          realDuration = await new Promise<number>((resolve) => {
            const v = document.createElement("video");
            v.preload = "metadata";
            v.muted = true;
            const timer = setTimeout(() => resolve(0), 8000);
            v.onloadedmetadata = () => {
              clearTimeout(timer);
              resolve(Number.isFinite(v.duration) ? v.duration : 0);
            };
            v.onerror = () => {
              clearTimeout(timer);
              resolve(0);
            };
            v.src = recUrl;
            v.load();
          });
        }
        const stored = Number((rec as { metadata?: { mediaDuration?: number } })?.metadata?.mediaDuration);
        const original = realDuration > 0 ? realDuration : Number.isFinite(stored) ? stored : 0;

        if (!cancelled && Number.isFinite(original) && original > 0) {
          const auto = Math.min(15, Math.max(2, Math.round(original)));
          setOriginalDuration(Math.round(original * 10) / 10);
          setDuration(auto);
          setDurationInput(String(auto));
        }
      } catch {
        /* 取不到就保留默认值 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMediaUrl, initialPrompt]);
  const [h3Ready, setH3Ready] = useState<boolean | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCount = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // 打开页面就探测 H3 是否可用
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/local-ai", { cache: "no-store" });
        const data = await res.json();
        const baseUrl = data?.config?.h3BaseUrl || "";
        if (!baseUrl) {
          if (!cancelled) setH3Ready(false);
          return;
        }
        const probe = await fetch("/api/video-generate/h3", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "probe", baseUrl }),
        });
        const result = await probe.json();
        if (!cancelled) setH3Ready(Boolean(result?.ok));
      } catch {
        if (!cancelled) setH3Ready(false);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollCount.current = 0;
    pollTimer.current = setInterval(async () => {
      pollCount.current += 1;
      // 最多轮询 20 分钟（120 次 × 10 秒）
      if (pollCount.current > 120) {
        stopPolling();
        setIsGenerating(false);
        setStatus("等待超时，请到 H3 工作台查看任务队列");
        return;
      }
      try {
        const res = await fetch("/api/video-generate/h3", { cache: "no-store" });
        const data = await res.json();
        if (data?.failed) {
          // 服务端任务报错：立即停止轮询并显示真实失败原因
          stopPolling();
          setIsGenerating(false);
          setStatus("");
          setError(data?.status || data?.error || "生成失败");
          return;
        }
        if (data?.videoUrl) {
          stopPolling();
          setStatus("生成完成，正在缓存视频…");
          // Gradio 的 file= 链接会过期（403 File not allowed），
          // 立刻下载一份到本地，用 /files/... 稳定播放
          let finalUrl: string = data.videoUrl;
          try {
            const cacheRes = await fetch("/api/video-cache", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: data.videoUrl }),
            });
            const cacheData = await cacheRes.json().catch(() => null);
            if (cacheData?.ok && cacheData.url) {
              finalUrl = cacheData.url;
            } else if (cacheData?.error) {
              setError(`视频已生成，但本地缓存失败：${cacheData.error}`);
            }
          } catch {
            // 缓存失败就退回原始地址
          }
          setVideoUrl(finalUrl);
          setStatus("生成完成");
          setIsGenerating(false);
        } else if (data?.status) {
          setStatus(`H3：${data.status}`);
        }
      } catch {
        // 单次失败忽略，下一轮继续
      }
    }, 10_000);
  }, [stopPolling]);

  /**
   * 一键合并：把「视频分析提取的提示词」和「音频分析提取的台词」拼成一份。
   * 优先匹配同一个原始视频文件的记录，找不到就用各自最新的一条。
   */
  const handleMerge = async () => {
    setMerging(true);
    setError(null);
    try {
      const [histRes, audioRes] = await Promise.all([
        fetch("/api/history?limit=50", { cache: "no-store" }),
        fetch("/api/audio-analyze?limit=50", { cache: "no-store" }),
      ]);
      const hist = await histRes.json();
      const audio = await audioRes.json();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyses: any[] = hist?.history || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audios: any[] = audio?.data || [];

      if (analyses.length === 0 && !rawInput.trim()) {
        setError("还没有视频分析结果，请先到「视频分析」分析一次视频");
        return;
      }

      // mediaName 形如 <uuid>-<原文件名>，取最后一段作为同名匹配依据
      const fileKey = (name?: string) => (name || "").split("-").pop() || "";

      const latest = analyses[0];
      const sameFileAudio = audios.find((a) => fileKey(a.mediaName) === fileKey(latest.mediaName));
      const audioRec = sameFileAudio || audios[0];

      // 台词带时间轴，便于与画面卡点对齐
      const dialogue = formatDialogueWithTiming(audioRec?.transcription);

      const promptPart: string = latest.prompt || latest.corePrompt || "";
      // 上框已有内容（来自「用于视频生成」）就优先用它，不再拼历史
      const mergedRaw = rawInput.trim() || (dialogue
        ? `${promptPart}\n\n【台词】\n${dialogue}`
        : promptPart);

      // 优先让本地 AI 按官方 I2VA 规则重写；失败才退回本地拼接
      let merged = mergedRaw;
      let engine = "原文";

      if (h3Format) {
        setStatus("正在用本地 AI 生成 H3 提示词…");
        try {
          const res = await fetch("/api/h3-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // 完整原文（画面分析 + 带时间码的【台词】）整体交给模型，不做二次加工
              mode: h3Mode,
              voiceStyle: voiceStyle.trim() || undefined,
              analysis: mergedRaw,
              durationSeconds: originalDuration ?? undefined,
            }),
          });
          const data = await res.json().catch(() => null);
          if (data?.ok && data.prompt) {
            merged = data.prompt;
            engine = "本地 AI";
          } else {
            merged = convertMergedToH3(mergedRaw, { mode: h3Mode });
            engine = `本地拼接（AI 不可用：${data?.error || "未知原因"}）`;
          }
        } catch (err) {
          merged = convertMergedToH3(mergedRaw, { mode: h3Mode });
          engine = `本地拼接（AI 请求异常：${err instanceof Error ? err.message : String(err)}）`;
        }
      }

      setPrompt(merged);
      setStatus(
        dialogue
          ? `已由${engine}生成 H3 提示词（${merged.length} 字）${sameFileAudio ? "，台词取自同一视频" : "，台词取自最近一条音频记录"}。请检查或修改后再点「② 生成视频」`
          : `已填入提示词（${merged.length} 字），但没有找到台词记录（请先到「音频分析」转写一次）。检查后可点「② 生成视频」`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };


  /** 从来源视频截取首帧（或指定秒数的帧），并切到 I2V 模式 */
  /**
   * 从来源视频截取指定时间点的画面。
   * 注意两个坑（Firefox 尤其明显）：
   *   1) src 必须在事件绑定【之后】赋值，否则缓存视频的 loadeddata 会先触发、监听不到；
   *   2) 目标时间已经等于 currentTime（常见于截 0 秒）时不会再触发 seeked，必须直接绘制，
   *      同时加一个兜底定时器，避免 Promise 永远不 resolve（界面一直转圈）。
   */
  const captureFrameAt = (url: string, atSeconds: number) =>
    new Promise<string>((resolve, reject) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;

      let settled = false;
      let fallback: ReturnType<typeof setTimeout> | null = null;
      // 硬超时：任何情况下 15 秒都必须有结果，不能无限转圈
      const hardTimeout = setTimeout(
        () => done(undefined, new Error("截帧超时：视频没能成功加载（可能是文件损坏或格式不支持）")),
        15000,
      );

      const cleanup = () => {
        if (fallback) clearTimeout(fallback);
        clearTimeout(hardTimeout);
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        video.removeAttribute("src");
      };

      const done = (frame?: string, err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(frame as string);
      };

      const draw = () => {
        try {
          if (!video.videoWidth || !video.videoHeight) {
            done(undefined, new Error("视频还没解码出画面，请重试或换一个时间点"));
            return;
          }
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            done(undefined, new Error("无法创建画布"));
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL("image/jpeg", 0.92));
        } catch (e) {
          done(undefined, e instanceof Error ? e : new Error(String(e)));
        }
      };

      video.onerror = () => done(undefined, new Error("读取视频失败：可能是不支持的编码，或文件已被删除"));

      video.onloadeddata = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const seekTo = Math.max(0, Math.min(atSeconds, Math.max(0, duration - 0.05)));
        // 已经在目标位置（多半是 0 秒）：不会有 seeked 事件，直接画
        if (Math.abs(video.currentTime - seekTo) < 0.01) {
          draw();
          return;
        }
        video.onseeked = () => draw();
        try {
          video.currentTime = seekTo;
        } catch {
          done(undefined, new Error("定位视频时间点失败"));
          return;
        }
        // 兜底：某些浏览器/容器 seeked 不触发
        fallback = setTimeout(() => draw(), 1200);
      };

      // 先绑事件，再设 src
      video.src = url;
      video.load?.();
    });

  const captureFirstFrame = async (atSeconds = 0) => {
    if (!sourceVideoUrl) {
      setError("还没有可用的来源视频：请先在「视频分析」里分析一次视频");
      return;
    }
    setCapturing(true);
    setError(null);
    try {
      const frame = await captureFrameAt(sourceVideoUrl, atSeconds);
      setFirstFrame(frame);
      setH3Mode("i2v");
      setStatus(`已截取第 ${atSeconds.toFixed(1)} 秒画面作为首帧，已切换到 I2V 模式`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError("请先填写提示词");
      return;
    }
    setError(null);
    setVideoUrl(null);
    setStatus("正在提交到 H3…");
    setIsGenerating(true);

    try {
      const res = await fetch("/api/video-generate/h3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          prompt: prompt.trim(),
          duration: String(duration),
          aspectRatio,
          resolution,
          width: outSize.width,
          height: outSize.height,
          firstFrame: firstFrame ? { dataUrl: firstFrame, fileName: "first-frame.jpg" } : undefined,
          steps,
          seed,
        }),
      });
      const data = await res.json();

      if (!data?.ok) {
        setError(data?.error || "提交失败");
        setStatus("");
        setIsGenerating(false);
        return;
      }

      setStatus(
        data.aspectRatio
          ? `已提交 ${data.aspectRatio} · ${data.resolution || ""}${data.width ? ` · ${data.width}×${data.height}` : ""}，正在生成…`
          : "已提交，正在生成…（可离开页面，稍后回来查看）",
      );
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>视频生成（MiniMax H3 · 本机）</CardTitle>
          <div className="flex items-center gap-2">
            {h3Ready === false && (
              <span className="text-xs text-[#DC2626]">H3 服务未连接</span>
            )}
            {h3Ready === true && <span className="text-xs text-[#16A34A]">H3 已连接</span>}
            <Button type="button" variant="outline" size="sm" onClick={onConfigureApiKey}>
              <Settings className="w-4 h-4 mr-1" />
              服务设置
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-[#0E1726] block mb-2">
              合并原文（分析结果 + 台词时间轴）
            </label>
            <Textarea
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder="点「视频分析」结果里的「用于视频生成」会自动填入这里；也可以直接粘贴分析文本 + 【台词】"
              rows={8}
              className="bg-white border-[#C2CDDD] focus:border-[#2563EB] min-h-[160px] text-sm leading-relaxed"
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-[#8B95A7]">点「① 合并并转为 H3 提示词」后，下方才会生成提示词</span>
              <span className="text-xs text-[#8B95A7]">{rawInput.length} 字</span>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-[#0E1726] block mb-2">提示词</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述画面、人物、动作、镜头、光线、音效…"
              rows={14}
              className="bg-white border-[#C2CDDD] focus:border-[#2563EB] min-h-[280px] text-sm leading-relaxed"
            />
            <div className="flex justify-end mt-1">
              <span className="text-xs text-[#8B95A7]">{prompt.length} 字</span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">
                生成时长（秒）
                {originalDuration ? (
                  <span className="text-xs text-[#8B95A7] ml-1">原视频 {originalDuration}s</span>
                ) : null}
              </label>
              <Input
                type="number"
                min={2}
                max={15}
                step={1}
                value={durationInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  setDurationInput(raw);
                  const next = Number.parseInt(raw, 10);
                  if (Number.isFinite(next)) {
                    setDuration(Math.min(15, Math.max(2, next)));
                  }
                }}
                onBlur={() => {
                  const next = Number.parseInt(durationInput, 10);
                  const fixed = Number.isFinite(next) ? Math.min(15, Math.max(2, next)) : duration;
                  setDuration(fixed);
                  setDurationInput(String(fixed));
                }}
                className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
              />
            </div>
          <div className="rounded-lg border border-[#C2CDDD] bg-[#F7FAFF] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-[#0E1726]">首帧图（I2V 用）</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={capturing || !sourceVideoUrl}
                onClick={() => captureFirstFrame(0)}
              >
                {capturing ? <Spinner className="w-4 h-4 mr-1" /> : null}
                截取首帧并转 I2V
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={capturing || !sourceVideoUrl}
                onClick={() => captureFirstFrame(currentFrameAt)}
              >
                截取 {currentFrameAt.toFixed(1)} 秒处
              </Button>
              {firstFrame && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setFirstFrame(null)}>
                  清除首帧
                </Button>
              )}
              <span className="text-xs text-[#8B95A7]">
                {firstFrame
                  ? "已设首帧：将以该帧为起始画面生成"
                  : sourceVideoUrl
                    ? "从最近一次分析的视频里截取画面"
                    : "先去「视频分析」跑一次视频，才能截首帧"}
              </span>
            </div>
            {firstFrame && (
              <img src={firstFrame} alt="首帧预览" className="mt-2 h-32 rounded-md border border-[#C2CDDD]" />
            )}
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-[#55637A]">截取时间点（秒）</label>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.min(15, Math.round(originalDuration ?? 15)))}
                step={0.1}
                value={currentFrameAt}
                onChange={(e) => setCurrentFrameAt(Number(e.target.value))}
                className="w-40 accent-[#2563EB]"
              />
              <span className="text-xs text-[#55637A]">{currentFrameAt.toFixed(1)} 秒</span>
            </div>
          </div>

            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">画面比例</label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
              >
                {(ratioSpecs.length
                  ? ratioSpecs
                  : (ratioOptions.length ? ratioOptions : ASPECT_RATIOS).map((r) => ({ value: r, label: r }))
                ).map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">清晰度</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
              >
                {(resolutionSpecs.length
                  ? resolutionSpecs
                  : (resolutionOptions.length ? resolutionOptions : ["480p", "544p", "768p", "custom"]).map((r) => ({ value: r, label: r }))
                ).map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">
                输出宽高（32 的倍数）
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step={32}
                  min={256}
                  value={outSize.width}
                  onChange={(e) => setOutSize((s) => ({ ...s, width: Math.max(32, Math.round(Number(e.target.value) / 32) * 32) }))}
                  className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
                />
                <span className="text-[#8B95A7]">×</span>
                <input
                  type="number"
                  step={32}
                  min={256}
                  value={outSize.height}
                  onChange={(e) => setOutSize((s) => ({ ...s, height: Math.max(32, Math.round(Number(e.target.value) / 32) * 32) }))}
                  className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
                />
              </div>
              <p className="text-xs text-[#8B95A7] mt-1">切换比例或清晰度会自动重算，可手动微调</p>
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">
                推理步数：{steps}
              </label>
              <input
                type="range"
                min={4}
                max={30}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="w-full mt-3 accent-[#2563EB]"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">Seed</label>
              <Input
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
                className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
              />
              <p className="text-xs text-[#8B95A7] mt-1">-1 为随机</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-[#0E1726] block">
              音色 / 配音要求（可选）
            </label>
            <Input
              value={voiceStyle}
              onChange={(e) => setVoiceStyle(e.target.value)}
              placeholder="例如：前段正常男声，第 4 秒换装后改用尖细阴柔的太监腔"
              className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
            />
            <p className="text-xs text-[#8B95A7]">
              H3 靠「说话人 ID + 音色描述」控制声音；换音色会自动拆成 (S1)/(S2) 两个说话人，音色写在 &lt;d&gt; 外面
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleMerge}
              disabled={merging}
              title="把「视频分析」提取的提示词和「音频分析」提取的台词合并填入上面"
            >
              {merging ? "转换中…" : "① 合并并转为 H3 提示词"}
            </Button>
            <label className="flex items-center gap-2 text-sm text-[#55637A]">
              提示词格式
              <select
                value={h3Mode}
                onChange={(e) => setH3Mode(e.target.value === "i2v" ? "i2v" : "t2v")}
                className="h-9 px-2 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
              >
                <option value="t2v">T2V 分镜脚本（[0-3秒｜…]）</option>
                <option value="i2v">I2V 三字段（首帧图）</option>
              </select>
            </label>
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
              className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white"
            >
              {isGenerating ? <Spinner className="w-4 h-4 mr-2" /> : null}
              {isGenerating ? "生成中…" : "② 生成视频"}
            </Button>
            
            {isGenerating && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  stopPolling();
                  setIsGenerating(false);
                  setStatus("已停止本地轮询（H3 侧任务可能仍在跑）");
                }}
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                停止查看
              </Button>
            )}
          </div>
          {status && <div className="text-sm text-[#55637A]">{status}</div>}
          {error && (
            <div className="text-sm rounded-lg px-3 py-2 border border-[#DC2626]/40 bg-[#DC2626]/10 text-[#A0352C]">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {videoUrl && (
        <Card>
          <CardHeader>
            <CardTitle>生成结果</CardTitle>
          </CardHeader>
          <CardContent>
            <video src={videoUrl} controls className="w-full rounded-lg" />
            <p className="text-xs text-[#8B95A7] mt-2 break-all">{videoUrl}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession, signOut } from "@/lib/auth/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { HistoryList } from "@/components/history-list";
import { LocalAiSettings } from "@/components/local-ai-settings";
import { AudioAnalyzeTab } from "@/components/audio-analyze-tab";
import { VideoGenerateH3Tab } from "@/components/video-generate-h3-tab";
import { ServiceStatus } from "@/components/service-status";
import { VideoTimelineTab } from "@/components/video-timeline-tab";
import { VideoLibraryTab } from "@/components/video-library-tab";
import { FloatingChat } from "@/components/floating-chat";
import { createImageAnalysisFrame, extractVideoFramesWithTiming } from "@/lib/utils/frame-extractor";
import { uploadAnalysisFrames, uploadMediaToR2 } from "@/lib/r2-client";
import { formatDialogueWithTiming } from "@/lib/utils/dialogue";
import { cn } from "@/lib/utils";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import type { Locale } from "@/i18n/config";

type Tab = "analyze" | "audio" | "edit" | "video-gen" | "library" | "history" | "settings";

type TrialAccess = {
  limit: number;
  used: number;
  remaining: number | null;
  isAdmin: boolean;
  hasOwnApiKey: boolean;
};

export default function DashboardPage() {
  const { data: session, isPending } = useSession();
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("analyze");

  // 未登录时刷新 /dashboard 自动跳回登录页
  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace("/login");
    }
  }, [isPending, session, router]);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [normalizedUrl, setNormalizedUrl] = useState<string | null>(null);
  const [prepareMsg, setPrepareMsg] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [frameCount, setFrameCount] = useState(8);
  const [analyzeMode, setAnalyzeMode] = useState<"single" | "batch">("single");
  // 单机模式：只用本地 Qwen 视觉模型，不再提供云端模型选项
  const [analysisModel, setAnalysisModel] = useState<"local-qwen3.8">("local-qwen3.8");
  const [progress, setProgress] = useState("");
  const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [trialAccess, setTrialAccess] = useState<TrialAccess | null>(null);
  const [trialAccessLoading, setTrialAccessLoading] = useState(true);
  // 一键流程：分析完视频后自动提取台词并合并
  const [combineAudio, setCombineAudio] = useState(true);
  // 合并结果送去视频生成页的提示词
  const [generationPrompt, setGenerationPrompt] = useState("");
  // 「用于视频生成」时把这条分析记录的视频地址一起带过去，
  // 否则生成页会拿历史里最早/旧的那条视频去打首帧（曾出现一直截到旧的机械球视频）
  const [generationMediaUrl, setGenerationMediaUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshTrialAccess = useCallback(async () => {
    if (!session?.user) return;
    setTrialAccessLoading(true);
    try {
      const response = await fetch("/api/analyze/quota", { cache: "no-store" });
      if (response.ok) setTrialAccess(await response.json());
    } finally {
      setTrialAccessLoading(false);
    }
  }, [session?.user]);

  useEffect(() => {
    if (activeTab === "analyze") void refreshTrialAccess();
  }, [activeTab, refreshTrialAccess]);

  // 单机模式：本地模型无需平台 Key，也不消耗配额
  const usesPlatformKey = false;
  const platformTrialExhausted = Boolean(
    trialAccess && !trialAccess.isAdmin && trialAccess.remaining === 0,
  );

  const LIMIT_MB = 20;
  const LIMIT_SECONDS = 15;

  /** 读取视频时长（秒），HEVC 也能读到 metadata */
  const readVideoDuration = (file: File) =>
    new Promise<number>((resolve) => {
      const link = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        const d = v.duration;
        URL.revokeObjectURL(link);
        resolve(Number.isFinite(d) ? d : 0);
      };
      v.onerror = () => {
        URL.revokeObjectURL(link);
        resolve(0);
      };
      v.src = link;
    });

  // 选中文件后先上传到服务端归一化（HEVC 等浏览器解不了的编码自动转 H.264），
  // 否则预览黑屏、抽帧全黑、分析结果全是“纯黑空镜”。
  const prepareMedia = async (file: File) => {
    setSelectedFile(file);
    setResult(null);
    setNormalizedUrl(null);
    setPrepareMsg("");
    // 上传限制：≤ 20MB；时长 ≤ 15 秒，超过则截断为前 15 秒，超过 30 秒直接拒绝
    if (file.size > LIMIT_MB * 1024 * 1024) {
      setPrepareMsg(`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${LIMIT_MB}MB 上限，请先压缩`);
      setSelectedFile(null);
      setPreview(null);
      return;
    }
    if (!file.type.startsWith("video/")) {
      setPreview(URL.createObjectURL(file));
      return;
    }
    const durationSec = await readVideoDuration(file);
    // 视频：转码（必要时）完成前先转圈，不显示可能黑屏的预览
    setPreview(null);
    setPreparing(true);
    try {
      setPrepareMsg(
        durationSec > LIMIT_SECONDS + 0.3
          ? `视频 ${durationSec.toFixed(1)} 秒，超过 ${LIMIT_SECONDS} 秒，将截断为前 ${LIMIT_SECONDS} 秒分析…`
          : "正在准备视频（必要时自动转码）…",
      );
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/video-normalize", { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.url) {
        setNormalizedUrl(d.url);
        if (d.transcoded || d.trimmed) {
          setPreview(d.url);
          const notes: string[] = [];
          if (d.transcoded) notes.push(`原片是 ${d.codec || "不兼容"} 编码，已自动转成 H.264`);
          if (d.trimmed) notes.push(`已截取前 ${Math.round(d.durationSec ?? 15)} 秒用于分析`);
          setPrepareMsg(notes.join("；"));
        } else {
          setPreview(URL.createObjectURL(file));
          setPrepareMsg("");
        }
      } else {
        setPreview(URL.createObjectURL(file));
        setPrepareMsg("");
      }
    } catch {
      setPreview(URL.createObjectURL(file));
      setPrepareMsg("");
    } finally {
      setPreparing(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void prepareMedia(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type.startsWith("video/") || file.type.startsWith("image/"))) {
      void prepareMedia(file);
    }
  };

  const handleAnalyze = async () => {
    if (!selectedFile) return;
    if (usesPlatformKey && platformTrialExhausted) {
      setResult(`Error: ${t(trialAccess?.hasOwnApiKey ? "analyze.trialExhaustedWithKey" : "analyze.trialExhausted")}`);
      return;
    }
    // 单机模式：本地模型不需要任何 API Key，因此不再校验 hasOwnApiKey
    setIsLoading(true);
    setProgress(t("analyze.extractingFrames"));

    try {
      let frameFiles: File[];
      let frameTimestamps: number[] = [];
      let mediaDuration = 0;
      let mediaType: string;
      let mediaUrlForAnalysis: string | null = null;

      if (selectedFile.type.startsWith("video/")) {
        // 先从服务端取浏览器可播放的版本（HEVC 会转码），再从它抽帧
        let playableUrl = normalizedUrl;
        if (!playableUrl) {
          try {
            const fd = new FormData();
            fd.append("file", selectedFile);
            const prep = await fetch("/api/video-normalize", { method: "POST", body: fd });
            const prepData = await prep.json().catch(() => null);
            if (prep.ok && prepData?.url) playableUrl = prepData.url as string;
          } catch {
            /* 退回原文件 */
          }
        }
        mediaUrlForAnalysis = playableUrl;
        let sourceFile = selectedFile;
        if (playableUrl) {
          try {
            const blob = await fetch(playableUrl).then((r) => r.blob());
            sourceFile = new File([blob], selectedFile.name || "video.mp4", { type: "video/mp4" });
          } catch {
            /* 退回原文件 */
          }
        }
        const extracted = await extractVideoFramesWithTiming(sourceFile, frameCount, (current, total) => {
          setProgress(t("analyze.extractingFrameProgress", { current, total }));
        });
        frameFiles = extracted.files;
        frameTimestamps = extracted.timestamps;
        mediaDuration = Math.round(extracted.duration * 10) / 10;
        mediaType = "video";
      } else {
        frameFiles = [await createImageAnalysisFrame(selectedFile)];
        mediaType = "image";
      }

      setProgress(t("analyze.uploadingFile"));

      // 已按播放兼容格式上传过就不再重复上传
      if (!mediaUrlForAnalysis) {
        const uploadData = await uploadMediaToR2(selectedFile, (percentage) => {
          setProgress(t("analyze.uploadingProgress", { percent: Math.round(percentage) }));
        });
        mediaUrlForAnalysis = uploadData.url;
      }

      const frameUrls = await uploadAnalysisFrames(frameFiles, (current, total) => {
        setProgress(t("analyze.uploadingFrameProgress", { current, total }));
      });

      setProgress(t("analyze.aiAnalyzing"));

      // 发送帧给后端分析（透传当前 locale 给 AI 输出语言）
      const analyzeRes = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaUrl: mediaUrlForAnalysis,
          mediaType,
          frameUrls,
          frameTimestamps,
          mediaDuration,
          analyzeMode,
          analysisModel,
          outputLanguage: locale,
        }),
      });

      const data = await analyzeRes.json().catch(() => null);
      if (!analyzeRes.ok) {
        if (data?.code === "TRIAL_QUOTA_EXCEEDED") {
          setTrialAccess((current) => current ? { ...current, used: data.used, remaining: 0 } : current);
        }
        throw new Error(data?.error || t("analyze.analysisFailed"));
      }
      if (!data) throw new Error(t("analyze.analysisFailed"));

      let finalResult: string = data.prompt;

      // 一键流程：紧接着提取台词并合并进结果
      if (combineAudio) {
        setProgress("正在提取台词（本地 Whisper）…");
        try {
          const audioRes = await fetch("/api/audio-analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mediaUrl: mediaUrlForAnalysis,
              whisperModelSize: "local",
              llmProvider: "local",
            }),
          });
          const audioData = await audioRes.json().catch(() => null);

          if (audioRes.ok && audioData?.success) {
            // 台词带时间轴，便于与画面卡点对齐
            const dialogue = formatDialogueWithTiming(audioData.transcription);
            if (dialogue) {
              finalResult = `${data.prompt}\n\n【台词】\n${dialogue}`;
            } else {
              finalResult = `${data.prompt}\n\n【台词】\n（未识别到语音，可能是纯音乐或无人声）`;
            }
          } else {
            finalResult = `${data.prompt}\n\n【台词】\n（台词提取失败：${audioData?.error || "未知错误"}）`;
          }
        } catch (audioError) {
          finalResult = `${data.prompt}\n\n【台词】\n（台词提取失败：${
            audioError instanceof Error ? audioError.message : String(audioError)
          }）`;
        }
      }

      if (mediaUrlForAnalysis) setGenerationMediaUrl(mediaUrlForAnalysis);
      setResult(finalResult);
      setHistoryRefreshTrigger((prev) => prev + 1);
      if (usesPlatformKey) void refreshTrialAccess();
    } catch (error: any) {
      setResult(`Error: ${error.message}`);
    } finally {
      setIsLoading(false);
      setProgress("");
    }
  };

  const copyToClipboard = () => result && navigator.clipboard.writeText(result);

  const resetUpload = () => {
    setSelectedFile(null);
    setPreview(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="min-h-screen bg-anthropic">
      {/* 顶部导航 */}
      <header className="bg-[#F3F7FD]/90 backdrop-blur-md border-b border-[#D8E1EE] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-3 md:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 md:gap-3">
            <img
              src="/icon-180.png"
              alt="蓝手猫"
              className="w-8 md:w-9 h-8 md:h-9 rounded-lg shadow-sm object-cover bg-white"
            />
            <span className="text-base md:text-lg font-medium text-[#0E1726]" style={{ fontFamily: 'var(--font-heading)' }}>{t("dashboard.appName")}</span>
            <span className="hidden sm:inline text-[10px] md:text-[11px] px-2 py-0.5 rounded-full bg-[#2563EB]/10 text-[#2563EB] border border-[#2563EB]/20">
              本地一键包 v1.0
            </span>
          </div>

          <div className="flex items-center gap-2 md:gap-4">
            <ServiceStatus />
          </div>
        </div>
      </header>

      {/* 标签栏 - 移动端可横向滚动 */}
      <div className="bg-[#F3F7FD]/50 border-b border-[#D8E1EE] sticky top-[52px] md:top-[65px] z-40">
        <div className="max-w-7xl mx-0 md:mx-auto px-2 md:px-6">
          <nav className="flex gap-1 overflow-x-auto pb-px md:pb-0 -mx-2 px-2 md:mx-0 md:px-0">
            {[
              { key: "analyze", label: t("dashboard.tabs.analyze"), disabled: false, status: null },
              { key: "audio", label: t("dashboard.tabs.audio"), disabled: false, status: null },
              { key: "edit", label: t("dashboard.tabs.edit"), disabled: false, status: null },
              { key: "video-gen", label: t("dashboard.tabs.videoGen"), disabled: false, status: null },
              { key: "library", label: "作品库", disabled: false, status: null },
              { key: "history", label: t("dashboard.tabs.history"), disabled: false, status: null },
              { key: "settings", label: t("dashboard.tabs.settings"), disabled: false, status: null }
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as Tab)}
                disabled={tab.disabled}
                className={cn(
                  "px-3 md:px-5 py-2 md:py-3 text-xs md:text-sm font-medium rounded-t-lg transition-all duration-200 whitespace-nowrap min-h-[44px] inline-flex items-center gap-1.5",
                  tab.disabled && "cursor-not-allowed opacity-60",
                  activeTab === tab.key
                    ? "bg-[#F3F7FD] text-[#2563EB] border-t-2 border-[#2563EB]"
                    : tab.disabled
                      ? "text-[#55637A]"
                      : "text-[#55637A] hover:text-[#0E1726] hover:bg-[#F3F7FD]/50"
                )}
              >
                {tab.label}
                {tab.status && (
                  <span className="rounded-full bg-[#2563EB]/10 px-1.5 py-0.5 text-[10px] leading-none text-[#2563EB]">
                    {tab.status}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* 主内容区 */}
      <main className="max-w-7xl mx-auto px-3 md:px-6 py-6 md:py-8">
        {/* 分析页面 */}
        <div className={cn("grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-8", activeTab === "analyze" ? "block" : "hidden")}>
          {/* 左侧：上传区域 */}
          <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm animate-fade-in">
            <CardHeader className="pb-2 md:pb-0">
              <CardTitle className="text-base md:text-lg text-[#0E1726] flex items-center gap-2 md:gap-3" style={{ fontFamily: 'var(--font-display)' }}>
                <span className="w-8 md:w-10 h-8 md:h-10 rounded-lg md:rounded-xl bg-[#2563EB]/10 flex items-center justify-center text-[#2563EB]">
                  <svg className="w-4 md:w-5 h-4 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </span>
                {t("analyze.upload")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 md:space-y-5">
              {/* 拖拽上传区域 */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  "relative border-2 border-dashed rounded-xl p-6 md:p-10 text-center cursor-pointer transition-all duration-300 min-h-[180px] md:min-h-[220px] flex flex-col items-center justify-center",
                  isDragging ? "border-[#2563EB] bg-[#2563EB]/5" : "border-[#C2CDDD] hover:border-[#2563EB]/50",
                  (preview || preparing) && "border-transparent bg-[#E8EFF9]"
                )}
              >
                {preparing ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-6">
                    <div className="w-10 h-10 rounded-full border-4 border-[#2563EB]/20 border-t-[#2563EB] animate-spin" />
                    <p className="text-sm text-[#55637A]">{prepareMsg || "正在转码，请稍候…"}</p>
                  </div>
                ) : preview ? (
                  <div className="relative">
                    {selectedFile?.type.startsWith("video/") ? (
                      <video src={preview} className="max-h-40 md:max-h-56 rounded-lg shadow-md" controls />
                    ) : (
                      <img src={preview} alt="Preview" className="max-h-40 md:max-h-56 rounded-lg shadow-md" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); resetUpload(); }}
                      className="absolute -top-2 -right-2 w-7 h-7 bg-[#2563EB] text-white rounded-full flex items-center justify-center shadow-md hover:bg-[#1D4ED8] transition-colors"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="w-12 md:w-16 h-12 md:h-16 mx-auto mb-3 md:mb-4 rounded-xl md:rounded-2xl bg-[#2563EB]/10 flex items-center justify-center">
                      <svg className="w-6 md:w-8 h-6 md:h-8 text-[#2563EB]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <p className="text-[#0E1726] font-medium mb-1 text-sm md:text-base">{t("analyze.dropHere")}</p>
                    <p className="text-xs md:text-sm text-[#55637A]">{t("analyze.uploadHint")}</p>
                  </>
                )}
                <input ref={fileInputRef} type="file" accept="video/*,image/*" onChange={handleFileSelect} className="hidden" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#8B95A7]">
                <span>支持 MP4 / MOV（HEVC 自动转码）</span>
                <span>不超过 20MB</span>
                <span>不超过 15 秒</span>
                <span className="text-[#B45309]">超过 15 秒会截断，只分析前 15 秒</span>
              </div>
              {prepareMsg && (
                <p className="mt-2 text-xs md:text-sm text-[#2563EB]">{prepareMsg}</p>
              )}

              {selectedFile && (
                <div className="flex items-center justify-between bg-[#E8EFF9] rounded-lg px-4 py-2">
                  <span className="text-sm text-[#55637A] truncate">{selectedFile.name}</span>
                  <span className="text-xs text-[#2563EB] bg-[#2563EB]/10 px-2 py-1 rounded">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              )}

              {/* 设置选项 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-[#0E1726] block mb-2">{t("analyze.frameCount")}</label>
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={frameCount}
                    onChange={(e) => setFrameCount(Number(e.target.value))}
                    className="border-[#C2CDDD] focus:border-[#2563EB] bg-white"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-[#0E1726] block mb-2">{t("analyze.analyzeMode")}</label>
                  <select
                    value={analyzeMode}
                    onChange={(e) => setAnalyzeMode(e.target.value as any)}
                    className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg focus:border-[#2563EB] outline-none bg-white text-[#0E1726]"
                  >
                    <option value="single">{t("analyze.singleMode")}</option>
                    <option value="batch">{t("analyze.batchMode")}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-[#0E1726] block mb-2">{t("analyze.model")}</label>
                <select
                  value={analysisModel}
                  onChange={(e) => setAnalysisModel(e.target.value as typeof analysisModel)}
                  className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg focus:border-[#2563EB] outline-none bg-white text-[#0E1726]"
                >
                  <option value="local-qwen3.8">本地 Qwen3.8 视觉模型（本机）</option>
                </select>
                {!trialAccessLoading && trialAccess && (
                  <div className={`mt-2 flex flex-wrap items-center justify-between gap-2 text-sm ${platformTrialExhausted ? "text-[#DC2626]" : "text-[#55637A]"}`}>
                    <span>
                      {trialAccess.isAdmin
                        ? t("analyze.trialUnlimited")
                        : platformTrialExhausted
                          ? t(trialAccess.hasOwnApiKey ? "analyze.trialExhaustedWithKey" : "analyze.trialExhausted")
                          : t("analyze.trialRemaining", { remaining: trialAccess.remaining, limit: trialAccess.limit })}
                    </span>
                    {platformTrialExhausted && !trialAccess.hasOwnApiKey && (
                      <Button type="button" variant="outline" size="sm" onClick={() => setActiveTab("settings")}>
                        {t("analyze.configureKieKey")}
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={combineAudio}
                  onChange={(e) => setCombineAudio(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB]"
                />
                <span className="text-sm text-[#55637A]">
                  同时提取台词并合并（本地 Whisper，稍慢）
                </span>
              </label>

              <Button
                onClick={handleAnalyze}
                disabled={!selectedFile || isLoading || trialAccessLoading}
                className="w-full h-12 md:h-12 bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-xl font-medium text-base shadow-sm hover:shadow-md transition-all min-h-[48px]"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="sm" className="border-white" />
                    {progress || t("analyze.processing")}
                  </span>
                ) : (
                  t("analyze.startAnalyze")
                )}
              </Button>
            </CardContent>
          </Card>

          {/* 右侧：结果区域 */}
          <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm animate-fade-in">
            <CardHeader className="flex flex-row items-center justify-between pb-2 md:pb-0">
              <CardTitle className="text-base md:text-lg text-[#0E1726] flex items-center gap-2 md:gap-3" style={{ fontFamily: 'var(--font-display)' }}>
                <span className="w-8 md:w-10 h-8 md:h-10 rounded-lg md:rounded-xl bg-[#2563EB]/10 flex items-center justify-center text-[#2563EB]">
                  <svg className="w-4 md:w-5 h-4 md:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
                  </svg>
                </span>
                {t("analyze.result")}
              </CardTitle>
              {result && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      // 原样把分析原文（含【台词】时间轴）带过去，不做任何格式转换
                      setGenerationPrompt(result);
                      setActiveTab("video-gen");
                    }}
                    className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-lg text-xs md:text-sm"
                  >
                    用于视频生成
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyToClipboard} className="border-[#C2CDDD] text-[#55637A] hover:text-[#2563EB] hover:border-[#2563EB] rounded-lg text-xs md:text-sm">
                    {t("analyze.copy")}
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {result ? (
                <div className="bg-[#E8EFF9] rounded-xl p-4 md:p-5 max-h-[300px] md:max-h-[550px] overflow-y-auto">
                  <pre className="whitespace-pre-wrap text-xs md:text-sm text-[#0E1726] font-mono leading-relaxed">{result}</pre>
                </div>
              ) : (
                <div className="text-center py-10 md:py-16">
                  <div className="w-16 md:w-20 h-16 md:h-20 mx-auto mb-3 md:4 rounded-full bg-[#D8E1EE]/30 flex items-center justify-center">
                    <svg className="w-8 md:w-10 h-8 md:h-10 text-[#8B95A7]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <p className="text-[#55637A] text-sm md:text-base">{t("analyze.noResult")}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 音频分析页面 */}
        <AudioAnalyzeTab activeTab={activeTab} />

        {/* 视频剪辑页面（本地 FFmpeg，常驻挂载） */}
        <div className={cn(activeTab === "edit" ? "block animate-fade-in" : "hidden")}>
          <VideoTimelineTab activeTab={activeTab} />
        </div>

        {/* 视频生成页面
            常驻挂载（只用 CSS 隐藏），切 tab 不卸载，提示词/进度/视频都不会丢 */}
        <div className={cn(activeTab === "video-gen" ? "block animate-fade-in" : "hidden")}>
          <VideoGenerateH3Tab
            onConfigureApiKey={() => setActiveTab("settings")}
            initialPrompt={generationPrompt}
            sourceMediaUrl={generationMediaUrl}
          />
        </div>

        {/* 作品库（常驻挂载） */}
        <div className={cn(activeTab === "library" ? "block animate-fade-in" : "hidden")}>
          <VideoLibraryTab />
        </div>

        {/* 历史记录页面（常驻挂载） */}
        <div className={cn(activeTab === "history" ? "block animate-fade-in" : "hidden")}>
            <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
              <CardHeader>
                <CardTitle className="text-[#0E1726] flex items-center gap-3" style={{ fontFamily: 'var(--font-display)' }}>
                  <span className="w-10 h-10 rounded-xl bg-[#D8E1EE]/30 flex items-center justify-center text-[#55637A]">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  </span>
                  {t("dashboard.tabs.history")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <HistoryList
                  refreshTrigger={historyRefreshTrigger}
                  onUseForVideo={(item) => {
                    setGenerationPrompt(item.prompt || item.corePrompt || "");
                    if (item.mediaUrl) setGenerationMediaUrl(item.mediaUrl);
                    setActiveTab("video-gen");
                  }}
                />
              </CardContent>
            </Card>
        </div>

        {/* 设置页面（单机模式：仅本地 AI 配置，无需云端 Key） */}
        <div className={cn(activeTab === "settings" ? "block animate-fade-in space-y-6" : "hidden")}>
          <LocalAiSettings />
        </div>
      </main>

      {/* 悬浮聊天助手 */}
      <FloatingChat />
    </div>
  );
}
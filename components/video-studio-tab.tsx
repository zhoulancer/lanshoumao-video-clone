"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCw, Scissors, Plus, Trash2 } from "lucide-react";

/**
 * 视频剪辑工作台（本机 FFmpeg · 增强版）
 * --------------------------------------------------------------
 * 多段拼接 / 变速 / 比例转换 / 调色 / 旋转翻转 / 音量 / 淡入淡出 /
 * 文字水印 / 导出 GIF·MP3，全部本机完成。
 */

type VideoItem = { key: string; name: string; size: number; mtime: number };
type Segment = { start: string; end: string };

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [
  { label: "保持原样", value: "" },
  { label: "9:16 竖屏", value: "9:16" },
  { label: "16:9 横屏", value: "16:9" },
  { label: "1:1 方形", value: "1:1" },
  { label: "4:3", value: "4:3" },
  { label: "3:4", value: "3:4" },
];
const FORMATS = [
  { label: "MP4 视频", value: "mp4" },
  { label: "GIF 动图", value: "gif" },
  { label: "MP3 音频", value: "mp3" },
];
const TEXT_POS = [
  { label: "底部居中", value: "bottom" },
  { label: "左上", value: "tl" },
  { label: "右上", value: "tr" },
  { label: "左下", value: "bl" },
  { label: "右下", value: "br" },
  { label: "正中", value: "center" },
];

const selectCls =
  "w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]";
const labelCls = "text-sm font-medium text-[#0E1726] block mb-2";

export function VideoStudioTab({ activeTab }: { activeTab: string }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selected, setSelected] = useState("");

  const [segments, setSegments] = useState<Segment[]>([{ start: "0", end: "5" }]);
  const [speed, setSpeed] = useState(1);
  const [aspect, setAspect] = useState("");
  const [rotate, setRotate] = useState(0);
  const [flip, setFlip] = useState("none");
  const [brightness, setBrightness] = useState("0");
  const [contrast, setContrast] = useState("1");
  const [saturation, setSaturation] = useState("1");
  const [volume, setVolume] = useState("1");
  const [fadeIn, setFadeIn] = useState("0");
  const [fadeOut, setFadeOut] = useState("0");
  const [textContent, setTextContent] = useState("");
  const [textPos, setTextPos] = useState("bottom");
  const [textSize, setTextSize] = useState("36");
  const [format, setFormat] = useState("mp4");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/video-studio", { cache: "no-store" });
      const data = await res.json();
      const list: VideoItem[] = Array.isArray(data?.videos) ? data.videos : [];
      setVideos(list);
      setSelected((prev) => prev || (list[0]?.key ?? ""));
    } catch {
      setError("读取本地视频列表失败");
    }
  }, []);

  useEffect(() => {
    if (activeTab === "edit") void load();
  }, [activeTab, load]);

  const previewUrl = selected
    ? `/files/videos/${selected.split("/").map(encodeURIComponent).join("/")}`
    : "";

  const run = async () => {
    if (!selected) {
      setError("请先选择一个视频");
      return;
    }
    setBusy(true);
    setError(null);
    setResultUrl(null);
    setStatus("正在剪辑…");
    try {
      const res = await fetch("/api/video-studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: selected,
          segments: segments
            .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
            .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start),
          speed,
          aspect,
          rotate,
          flip,
          color: {
            brightness: Number(brightness) || 0,
            contrast: Number(contrast) || 1,
            saturation: Number(saturation) || 1,
          },
          volume: Number(volume),
          fadeIn: Number(fadeIn) || 0,
          fadeOut: Number(fadeOut) || 0,
          text: textContent.trim()
            ? { content: textContent.trim(), position: textPos, size: Number(textSize) || 36 }
            : undefined,
          format,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        setError(data?.error || "剪辑失败");
        setStatus("");
        return;
      }
      setResultUrl(data.url);
      setStatus(
        `完成：${data.name}（约 ${data.duration} 秒，${Math.round((data.size || 0) / 1024)} KB）`,
      );
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-[#0E1726] flex items-center gap-2">
            <Scissors className="w-5 h-5 text-[#2563EB]" />
            视频剪辑 · 本地 FFmpeg
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-4 h-4 mr-1" /> 刷新
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 选择视频 */}
          <div>
            <label className={labelCls}>选择视频</label>
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setDuration(null);
                setResultUrl(null);
                setStatus("");
              }}
              className={selectCls}
            >
              {videos.length === 0 && <option value="">（还没有本地视频，先生成一条）</option>}
              {videos.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}（{Math.round(v.size / 1024)} KB）
                </option>
              ))}
            </select>
          </div>

          {/* 片段 */}
          <div>
            <label className={labelCls}>剪辑片段（多段会自动拼接）</label>
            <div className="space-y-2">
              {segments.map((seg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-[#8B95A7] w-10">片段{i + 1}</span>
                  <Input
                    value={seg.start}
                    onChange={(e) =>
                      setSegments((prev) =>
                        prev.map((s, j) => (j === i ? { ...s, start: e.target.value } : s)),
                      )
                    }
                    placeholder="起始秒"
                    className="w-24"
                  />
                  <span className="text-[#8B95A7]">→</span>
                  <Input
                    value={seg.end}
                    onChange={(e) =>
                      setSegments((prev) =>
                        prev.map((s, j) => (j === i ? { ...s, end: e.target.value } : s)),
                      )
                    }
                    placeholder="结束秒"
                    className="w-24"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSegments((prev) => prev.filter((_, j) => j !== i))}
                    disabled={segments.length === 1}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setSegments((prev) => [...prev, { start: "0", end: "5" }])}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> 添加片段
            </Button>
            {duration !== null && (
              <p className="text-xs text-[#8B95A7] mt-2">原片时长约 {duration} 秒</p>
            )}
          </div>

          {/* 基础调节 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className={labelCls}>变速</label>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className={selectCls}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}x</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>画面比例</label>
              <select value={aspect} onChange={(e) => setAspect(e.target.value)} className={selectCls}>
                {ASPECTS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>旋转</label>
              <select value={rotate} onChange={(e) => setRotate(Number(e.target.value))} className={selectCls}>
                <option value={0}>不旋转</option>
                <option value={90}>顺时针 90°</option>
                <option value={180}>180°</option>
                <option value={270}>逆时针 90°</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>翻转</label>
              <select value={flip} onChange={(e) => setFlip(e.target.value)} className={selectCls}>
                <option value="none">不翻转</option>
                <option value="h">水平镜像</option>
                <option value="v">垂直翻转</option>
              </select>
            </div>
          </div>

          {/* 调色 */}
          <div className="grid grid-cols-3 md:grid-cols-5 gap-4">
            <div>
              <label className={labelCls}>亮度</label>
              <Input value={brightness} onChange={(e) => setBrightness(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>对比度</label>
              <Input value={contrast} onChange={(e) => setContrast(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>饱和度</label>
              <Input value={saturation} onChange={(e) => setSaturation(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>音量 0–2</label>
              <Input value={volume} onChange={(e) => setVolume(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>导出格式</label>
              <select value={format} onChange={(e) => setFormat(e.target.value)} className={selectCls}>
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 淡入淡出 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className={labelCls}>淡入（秒）</label>
              <Input value={fadeIn} onChange={(e) => setFadeIn(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>淡出（秒）</label>
              <Input value={fadeOut} onChange={(e) => setFadeOut(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className={labelCls}>文字位置</label>
              <select value={textPos} onChange={(e) => setTextPos(e.target.value)} className={selectCls}>
                {TEXT_POS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>字号</label>
              <Input value={textSize} onChange={(e) => setTextSize(e.target.value)} inputMode="numeric" />
            </div>
          </div>

          <div>
            <label className={labelCls}>文字水印（留空则不加）</label>
            <Input
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="例如：蓝手猫 AI"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void run()}
              disabled={busy || !selected}
              className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white"
            >
              {busy ? <Spinner className="w-4 h-4 mr-2" /> : <Scissors className="w-4 h-4 mr-2" />}
              {busy ? "处理中…" : "开始剪辑"}
            </Button>
            {status && <span className="text-sm text-[#16A34A]">{status}</span>}
            {error && <span className="text-sm text-[#DC2626]">{error}</span>}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
          <CardHeader><CardTitle className="text-base text-[#0E1726]">原片</CardTitle></CardHeader>
          <CardContent>
            {previewUrl ? (
              <video
                src={previewUrl}
                controls
                className="w-full rounded-lg bg-black"
                onLoadedMetadata={(e) =>
                  setDuration(Math.round(e.currentTarget.duration * 10) / 10)
                }
              />
            ) : (
              <p className="text-sm text-[#8B95A7]">未选择视频</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
          <CardHeader><CardTitle className="text-base text-[#0E1726]">结果</CardTitle></CardHeader>
          <CardContent>
            {resultUrl ? (
              <div className="space-y-2">
                {format === "mp3" ? (
                  <audio src={resultUrl} controls className="w-full" />
                ) : (
                  <video src={resultUrl} controls className="w-full rounded-lg bg-black" />
                )}
                <a href={resultUrl} download className="inline-block text-sm text-[#2563EB] underline">
                  下载到本地
                </a>
              </div>
            ) : (
              <p className="text-sm text-[#8B95A7]">还没有结果</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

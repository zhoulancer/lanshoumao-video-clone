"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCw, Scissors, Trash2, Plus, Play, Pause, GripVertical } from "lucide-react";
import { SubtitlePanel } from "@/components/subtitle-panel";

/**
 * 视频时间轴剪辑（剪映式操作）
 * --------------------------------------------------------------
 * - 时间轴可点击定位、拖动播放头
 * - 「标记入点 / 出点」按播放头位置建立保留片段
 * - 片段块可直接删除、拖动调整顺序
 * - 导出时把保留片段按顺序拼接（未选中的部分自动丢弃）
 */

type VideoItem = { key: string; name: string; size: number; mtime: number };
type Clip = { id: string; start: number; end: number };

const FORMATS = [
  { label: "MP4", value: "mp4" },
  { label: "GIF", value: "gif" },
  { label: "MP3", value: "mp3" },
];
const ASPECTS = [
  { label: "保持原样", value: "" },
  { label: "9:16", value: "9:16" },
  { label: "16:9", value: "16:9" },
  { label: "1:1", value: "1:1" },
];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

const selectCls =
  "w-full h-9 px-2 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726] text-sm";
const labelCls = "text-xs font-medium text-[#55637A] block mb-1";

export function VideoTimelineTab({ activeTab }: { activeTab: string }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selected, setSelected] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inPoint, setInPoint] = useState<number | null>(null);

  const [speed, setSpeed] = useState(1);
  const [aspect, setAspect] = useState("");
  const [format, setFormat] = useState("mp4");
  const [mute, setMute] = useState(false);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/video-studio", { cache: "no-store" });
      const data = await res.json();
      const list: VideoItem[] = Array.isArray(data?.videos) ? data.videos : [];
      setVideos(list);
      setSelected((prev) => prev || (list[0]?.key ?? ""));
    } catch {
      setError("读取视频列表失败");
    }
  }, []);

  useEffect(() => {
    if (activeTab === "edit") void load();
  }, [activeTab, load]);

  const src = selected ? `/files/videos/${selected.split("/").map(encodeURIComponent).join("/")}` : "";

  useEffect(() => {
    setClips([]);
    setCurrent(0);
    setDuration(0);
    setInPoint(null);
    setResultUrl(null);
    setStatus("");
    setError(null);
  }, [selected]);

  // 播放进度
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrent(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onLoaded = () => setDuration(v.duration || 0);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("loadedmetadata", onLoaded);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [src]);

  const keptDuration = useMemo(
    () => clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0),
    [clips],
  );

  const seekFromEvent = (clientX: number) => {
    const strip = stripRef.current;
    const v = videoRef.current;
    if (!strip || !v || duration <= 0) return;
    const rect = strip.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const t = ratio * duration;
    v.currentTime = t;
    setCurrent(t);
  };

  const markIn = () => setInPoint(current);

  const markOut = () => {
    if (inPoint === null) {
      setError("请先点「标记入点」");
      return;
    }
    if (current <= inPoint) {
      setError("出点要在入点之后");
      return;
    }
    setClips((prev) =>
      [...prev, { id: Math.random().toString(36).slice(2), start: inPoint, end: current }].sort(
        (a, b) => a.start - b.start,
      ),
    );
    setInPoint(null);
    setError(null);
  };

  const removeClip = (id: string) => setClips((prev) => prev.filter((c) => c.id !== id));

  const reorder = (from: number, to: number) => {
    setClips((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const run = async () => {
    if (!selected) {
      setError("请先选择视频");
      return;
    }
    if (clips.length === 0) {
      setError("请至少标记一个保留片段（标记入点 → 标记出点）");
      return;
    }
    setBusy(true);
    setError(null);
    setResultUrl(null);
    setStatus("正在按时间轴拼接…");
    try {
      const res = await fetch("/api/video-studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: selected,
          segments: clips.map((c) => ({ start: c.start, end: c.end })),
          speed,
          aspect,
          volume: mute ? 0 : 1,
          format,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        setError(data?.error || "导出失败");
        setStatus("");
        return;
      }
      setResultUrl(data.url);
      setStatus(
        `完成：${data.name}（${data.duration} 秒，${Math.round((data.size || 0) / 1024)} KB）`,
      );
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const pct = (t: number) => (duration > 0 ? `${(t / duration) * 100}%` : "0%");

  return (
    <div className="space-y-5">
      <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-[#0E1726] flex items-center gap-2">
            <Scissors className="w-5 h-5 text-[#2563EB]" />
            时间轴剪辑
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-4 h-4 mr-1" /> 刷新
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className={selectCls}>
            {videos.length === 0 && <option value="">（还没有本地视频）</option>}
            {videos.map((v) => (
              <option key={v.key} value={v.key}>
                {v.name}（{Math.round(v.size / 1024)} KB）
              </option>
            ))}
          </select>

          {src && (
            <video
              ref={videoRef}
              src={src}
              className="w-full max-h-[380px] rounded-lg bg-black"
              onClick={togglePlay}
            />
          )}

          {/* 时间轴 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-[#55637A]">
              <Button size="sm" variant="outline" onClick={togglePlay}>
                {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </Button>
              <span className="font-mono">{fmt(current)}</span>
              <span>/</span>
              <span className="font-mono">{fmt(duration)}</span>
              <span className="ml-2">保留 {keptDuration.toFixed(1)}s / 总 {duration.toFixed(1)}s</span>
            </div>

            <div
              ref={stripRef}
              onMouseDown={(e) => seekFromEvent(e.clientX)}
              className="relative h-14 rounded-lg bg-[#E8EFF9] border border-[#C2CDDD] cursor-crosshair overflow-hidden select-none"
            >
              {/* 保留片段 */}
              {clips.map((c, i) => (
                <div
                  key={c.id}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i);
                    setDragIndex(null);
                  }}
                  style={{ left: pct(c.start), width: pct(c.end - c.start) }}
                  className="absolute top-1 bottom-1 rounded bg-[#2563EB] text-white text-[10px] flex items-center justify-center gap-1 shadow"
                  title={`${c.start.toFixed(1)}s - ${c.end.toFixed(1)}s（拖动可调整顺序）`}
                >
                  <GripVertical className="w-3 h-3 opacity-70" />
                  <span className="truncate">{c.start.toFixed(1)}–{c.end.toFixed(1)}s</span>
                </div>
              ))}

              {/* 入点标记 */}
              {inPoint !== null && (
                <div
                  style={{ left: pct(inPoint) }}
                  className="absolute top-0 bottom-0 w-0.5 bg-[#16A34A]"
                  title={`入点 ${inPoint.toFixed(1)}s`}
                />
              )}

              {/* 播放头 */}
              <div
                style={{ left: pct(current) }}
                className="absolute top-0 bottom-0 w-0.5 bg-[#0E1726] pointer-events-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={markIn}>
                标记入点 ({fmt(current)})
              </Button>
              <Button size="sm" variant="outline" onClick={markOut} disabled={inPoint === null}>
                标记出点 → 生成片段
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setClips([])}
                disabled={clips.length === 0}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" /> 清空片段
              </Button>
            </div>
            {inPoint !== null && (
              <p className="text-xs text-[#16A34A]">
                入点已设 {inPoint.toFixed(1)}s，拖动时间轴到结束位置后点「标记出点」
              </p>
            )}
          </div>

          {/* 片段列表 */}
          {clips.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-[#55637A]">保留片段（按顺序拼接，拖动可调顺序）</p>
              {clips.map((c, i) => (
                <div
                  key={c.id}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i);
                    setDragIndex(null);
                  }}
                  className="flex items-center gap-2 text-sm bg-white border border-[#D8E1EE] rounded-lg px-2 py-1"
                >
                  <GripVertical className="w-3.5 h-3.5 text-[#8B95A7] cursor-grab" />
                  <span className="text-[#8B95A7] w-6">{i + 1}</span>
                  <span className="font-mono">{c.start.toFixed(1)}s → {c.end.toFixed(1)}s</span>
                  <span className="text-[#8B95A7] text-xs">（{(c.end - c.start).toFixed(1)}s）</span>
                  <button
                    onClick={() => removeClip(c.id)}
                    className="ml-auto text-[#DC2626] hover:bg-[#DC2626]/10 rounded p-1"
                    title="删除这个片段"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 导出选项 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className={labelCls}>变速</label>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className={selectCls}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}x</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>比例</label>
              <select value={aspect} onChange={(e) => setAspect(e.target.value)} className={selectCls}>
                {ASPECTS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>格式</label>
              <select value={format} onChange={(e) => setFormat(e.target.value)} className={selectCls}>
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-[#55637A]">
                <input
                  type="checkbox"
                  checked={mute}
                  onChange={(e) => setMute(e.target.checked)}
                  className="w-4 h-4 accent-[#2563EB]"
                />
                静音
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void run()}
              disabled={busy || clips.length === 0}
              className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white"
            >
              {busy ? <Spinner className="w-4 h-4 mr-2" /> : <Scissors className="w-4 h-4 mr-2" />}
              {busy ? "导出中…" : `导出（${clips.length} 个片段）`}
            </Button>
            {status && <span className="text-sm text-[#16A34A]">{status}</span>}
            {error && <span className="text-sm text-[#DC2626]">{error}</span>}
          </div>

          {resultUrl && (
            <div className="space-y-2 pt-2 border-t border-[#D8E1EE]">
              {format === "mp3" ? (
                <audio src={resultUrl} controls className="w-full" />
              ) : (
                <video src={resultUrl} controls className="w-full max-h-[320px] rounded-lg bg-black" />
              )}
              <a href={resultUrl} download className="text-sm text-[#2563EB] underline">
                下载到本地
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 字幕：识别 / 合并 / 导出 SRT / 烧录 */}
      <SubtitlePanel videoKey={selected} />
    </div>
  );
}

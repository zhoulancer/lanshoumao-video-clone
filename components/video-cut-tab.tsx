"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCw, Scissors } from "lucide-react";

/**
 * 视频剪辑（本地 FFmpeg · 离线）
 * --------------------------------------------------------------
 * 选本地已有片子 → 按起止时间裁剪 / 变速 → 结果存到 videos/clips。
 * 不依赖任何外部 FFmpeg 服务或云端 LLM。
 */

type VideoItem = { key: string; name: string; size: number; mtime: number };

const SPEEDS = [
  { label: "原速 1.0x", value: 1 },
  { label: "0.5 倍慢放", value: 0.5 },
  { label: "0.75 倍", value: 0.75 },
  { label: "1.5 倍", value: 1.5 },
  { label: "2.0 倍快放", value: 2 },
];

export function VideoCutTab({ activeTab }: { activeTab: string }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selected, setSelected] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("5");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/video-cut", { cache: "no-store" });
      const data = await res.json();
      const list: VideoItem[] = Array.isArray(data?.videos) ? data.videos : [];
      setVideos(list);
      setSelected((prev) => prev || (list[0]?.key ?? ""));
      loadedRef.current = true;
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

  const runCut = async () => {
    if (!selected) {
      setError("请先选择一个视频");
      return;
    }
    setBusy(true);
    setError(null);
    setResultUrl(null);
    setStatus("正在剪辑…");
    try {
      const res = await fetch("/api/video-cut", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: selected, start: Number(start), end: Number(end), speed }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        setError(data?.error || "剪辑失败");
        setStatus("");
        return;
      }
      setResultUrl(data.url);
      setStatus(
        `剪辑完成：${data.name}（约 ${data.duration} 秒，${Math.round((data.size || 0) / 1024)} KB）`,
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
            视频剪辑（本地 FFmpeg）
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-4 h-4 mr-1" /> 刷新列表
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-[#0E1726] block mb-2">选择视频</label>
            <select
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setDuration(null);
                setResultUrl(null);
                setStatus("");
                setStart("0");
              }}
              className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
            >
              {videos.length === 0 && <option value="">（还没有本地视频，先生成一条）</option>}
              {videos.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.name}（{Math.round(v.size / 1024)} KB）
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">起始（秒）</label>
              <Input value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">结束（秒）</label>
              <Input value={end} onChange={(e) => setEnd(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#0E1726] block mb-2">倍速</label>
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className="w-full h-10 px-3 border border-[#C2CDDD] rounded-lg bg-white text-[#0E1726]"
              >
                {SPEEDS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                onClick={() => void runCut()}
                disabled={busy || !selected}
                className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white"
              >
                {busy ? <Spinner className="w-4 h-4 mr-2" /> : null}
                {busy ? "剪辑中…" : "开始剪辑"}
              </Button>
            </div>
          </div>

          {duration !== null && <p className="text-xs text-[#8B95A7]">原片时长约 {duration} 秒</p>}
          {status && <p className="text-sm text-[#16A34A]">{status}</p>}
          {error && <p className="text-sm text-[#DC2626]">{error}</p>}
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
                onLoadedMetadata={(e) => setDuration(Math.round(e.currentTarget.duration * 10) / 10)}
              />
            ) : (
              <p className="text-sm text-[#8B95A7]">未选择视频</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
          <CardHeader><CardTitle className="text-base text-[#0E1726]">剪辑结果</CardTitle></CardHeader>
          <CardContent>
            {resultUrl ? (
              <div className="space-y-2">
                <video src={resultUrl} controls className="w-full rounded-lg bg-black" />
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

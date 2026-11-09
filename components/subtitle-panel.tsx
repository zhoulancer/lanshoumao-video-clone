"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Captions, Merge, Trash2, Download, Film } from "lucide-react";

/**
 * 字幕面板：识别 / 编辑 / 合并 / 导出 SRT / 烧录到视频
 * --------------------------------------------------------------
 * 识别走后端本地 Whisper；合并与编辑在前端即时完成。
 */

export type SubItem = { id: string; start: number; end: number; text: string; checked?: boolean };

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function SubtitlePanel({
  videoKey,
  onBurned,
}: {
  videoKey: string;
  onBurned?: (url: string) => void;
}) {
  const [items, setItems] = useState<SubItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [burning, setBurning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [burnedUrl, setBurnedUrl] = useState<string | null>(null);
  const [gapThreshold, setGapThreshold] = useState("0.4");
  const [fontSize, setFontSize] = useState("20");

  // 换视频就清空
  useEffect(() => {
    setItems([]);
    setStatus("");
    setError(null);
    setBurnedUrl(null);
  }, [videoKey]);

  const recognize = useCallback(async () => {
    if (!videoKey) {
      setError("请先在上方选择视频");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("正在识别语音（本地 Whisper）…");
    try {
      const res = await fetch("/api/subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recognize", key: videoKey }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        setError(data?.error || "识别失败");
        setStatus("");
        return;
      }
      const list: SubItem[] = (data.segments || []).map(
        (s: { start: number; end: number; text: string }) => ({
          id: Math.random().toString(36).slice(2),
          start: s.start,
          end: s.end,
          text: s.text,
          checked: false,
        }),
      );
      setItems(list);
      setStatus(
        list.length > 0
          ? `识别完成：${list.length} 条字幕（语言 ${data.language || "?"}，时长 ${data.duration}s）`
          : "没识别到语音，这个视频可能没有人声",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [videoKey]);

  const updateText = (id: string, text: string) =>
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));

  const toggle = (id: string) =>
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, checked: !s.checked } : s)));

  const remove = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id));

  /** 合并选中的多条 */
  const mergeSelected = () => {
    const picked = items.filter((s) => s.checked);
    if (picked.length < 2) {
      setError("请至少勾选两条字幕再合并");
      return;
    }
    const start = Math.min(...picked.map((s) => s.start));
    const end = Math.max(...picked.map((s) => s.end));
    const text = picked.map((s) => s.text.trim()).filter(Boolean).join("，");
    const firstIndex = items.findIndex((s) => s.id === picked[0].id);
    const merged: SubItem = {
      id: Math.random().toString(36).slice(2),
      start,
      end,
      text,
      checked: false,
    };
    setItems((prev) => {
      const rest = prev.filter((s) => !s.checked);
      const insertAt = rest.findIndex((_, i) => i >= firstIndex) === -1 ? rest.length : firstIndex;
      const next = [...rest];
      next.splice(clamp(insertAt, 0, next.length), 0, merged);
      return next.sort((a, b) => a.start - b.start);
    });
    setError(null);
    setStatus(`已合并 ${picked.length} 条为 1 条`);
  };

  /** 按间隔阈值合并相邻碎片 */
  const mergeAdjacent = () => {
    if (items.length < 2) return;
    const gap = Number(gapThreshold);
    const sorted = [...items].sort((a, b) => a.start - b.start);
    const out: SubItem[] = [];
    for (const seg of sorted) {
      const last = out[out.length - 1];
      const shortText = seg.text.trim().replace(/[。，,.]$/, "").length <= 6;
      const shouldMerge =
        last &&
        (seg.start - last.end <= gap || shortText) &&
        (seg.end - last.start) <= 12; // 合并后不超过 12 秒
      if (shouldMerge) {
        last.end = seg.end;
        last.text = `${last.text.trim().replace(/[。，,.]$/, "")}，${seg.text.trim()}`;
      } else {
        out.push({ ...seg });
      }
    }
    setItems(out);
    setStatus(`相邻合并：${sorted.length} 条 → ${out.length} 条（间隔阈值 ${gap}s）`);
  };

  const downloadSrt = async () => {
    const list = items.filter((s) => s.text.trim());
    if (list.length === 0) {
      setError("还没有字幕");
      return;
    }
    try {
      const res = await fetch("/api/subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "srt",
          segments: list.map((s) => ({ start: s.start, end: s.end, text: s.text })),
        }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setError(data?.error || "导出失败");
        return;
      }
      const blob = new Blob([data.srt], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "subtitle.srt";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("SRT 已下载");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const burn = async () => {
    const list = items.filter((s) => s.text.trim());
    if (!list.length) {
      setError("还没有字幕");
      return;
    }
    setBurning(true);
    setError(null);
    setBurnUrl(null);
    setStatus("正在烧录字幕到视频…");
    try {
      const res = await fetch("/api/subtitle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "burn",
          key: videoKey,
          segments: list.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          style: { fontSize: Number(fontSize) || 20 },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        setError(data?.error || "烧录失败");
        setStatus("");
        return;
      }
      setBurnedUrl(data.url);
      setStatus(`已生成带字幕视频（${Math.round((data.size || 0) / 1024)} KB）`);
      onBurned?.(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBurning(false);
    }
  };

  const setBurnUrl = setBurnedUrl;

  return (
    <Card className="bg-[#F3F7FD] border-[#D8E1EE] shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-[#0E1726] flex items-center gap-2 text-base">
          <Captions className="w-5 h-5 text-[#2563EB]" />
          字幕识别与合并
        </CardTitle>
        <Button size="sm" onClick={() => void recognize()} disabled={busy || !videoKey}>
          {busy ? <Spinner className="w-4 h-4 mr-1" /> : null}
          {busy ? "识别中…" : "识别字幕"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-[#8B95A7]">
            点右上角「识别字幕」，用本地 Whisper 提取台词与时间码，然后可合并、改写、导出 SRT 或烧录进画面。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={mergeSelected}>
                <Merge className="w-3.5 h-3.5 mr-1" /> 合并选中
              </Button>
              <Button size="sm" variant="outline" onClick={mergeAdjacent}>
                <Merge className="w-3.5 h-3.5 mr-1" /> 合并相邻
              </Button>
              <Input
                value={gapThreshold}
                onChange={(e) => setGapThreshold(e.target.value)}
                className="w-16 h-8"
                title="相邻间隔小于该秒数就合并"
              />
              <span className="text-xs text-[#8B95A7]">秒内合并</span>
              <Button size="sm" variant="outline" onClick={() => void downloadSrt()}>
                <Download className="w-3.5 h-3.5 mr-1" /> 导出 SRT
              </Button>
              <Input
                value={fontSize}
                onChange={(e) => setFontSize(e.target.value)}
                className="w-16 h-8"
                title="烧录字号"
              />
              <Button size="sm" variant="outline" onClick={() => void burn()} disabled={burning}>
                {burning ? <Spinner className="w-3.5 h-3.5 mr-1" /> : <Film className="w-3.5 h-3.5 mr-1" />}
                烧录到视频
              </Button>
            </div>

            <div className="max-h-[320px] overflow-y-auto space-y-1">
              {items.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 bg-white border border-[#E2EAF4] rounded-lg px-2 py-1"
                >
                  <input
                    type="checkbox"
                    checked={!!s.checked}
                    onChange={() => toggle(s.id)}
                    className="w-3.5 h-3.5 accent-[#2563EB]"
                  />
                  <span className="font-mono text-[11px] text-[#8B95A7] w-24 shrink-0">
                    {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                  </span>
                  <Input
                    value={s.text}
                    onChange={(e) => updateText(s.id, e.target.value)}
                    className="h-8 text-sm"
                  />
                  <button
                    onClick={() => remove(s.id)}
                    className="text-[#DC2626] hover:bg-[#DC2626]/10 rounded p-1"
                    title="删除这条字幕"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {status && <p className="text-sm text-[#16A34A]">{status}</p>}
        {error && <p className="text-sm text-[#DC2626]">{error}</p>}

        {burnedUrl && (
          <div className="space-y-2 pt-2 border-t border-[#D8E1EE]">
            <video src={burnedUrl} controls className="w-full max-h-[320px] rounded-lg bg-black" />
            <a href={burnedUrl} download className="text-sm text-[#2563EB] underline">
              下载带字幕视频
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

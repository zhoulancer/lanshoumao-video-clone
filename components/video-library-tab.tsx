"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

interface LibItem {
  id: string;
  taskId: string;
  prompt: string;
  videoUrl: string | null;
  poster: string | null;
  duration: number;
  resolution: string;
  mode: string;
  total: number | null;
  favorite: boolean;
  note: string;
  createdAt: string;
}

/**
 * 产品库：所有生成过的视频都在这里，随时回看、下载、收藏、删除。
 * 文件已复制到 data/storage/library/，不依赖 H3 工作台的临时链接。
 */
export function VideoLibraryTab() {
  const [items, setItems] = useState<LibItem[]>([]);
  const [search, setSearch] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (kw = "", fav = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (kw.trim()) qs.set("search", kw.trim());
      if (fav) qs.set("favorite", "true");
      const res = await fetch(`/api/library?${qs.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || "读取失败");
      setItems(data.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleFav = async (item: LibItem) => {
    await fetch("/api/library", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, favorite: !item.favorite }),
    });
    void load(search, favOnly);
  };

  const remove = async (item: LibItem) => {
    if (!window.confirm("从产品库删除这条视频？文件也会一并删除。")) return;
    await fetch(`/api/library?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
    void load(search, favOnly);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>产品库</span>
            <span className="text-xs text-[#8B95A7]">共 {items.length} 条 · 文件已存本地</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索提示词或任务 ID"
              className="max-w-sm"
            />
            <Button variant="outline" onClick={() => load(search, favOnly)} disabled={loading}>
              {loading ? <Spinner className="w-4 h-4 mr-1" /> : null}
              搜索
            </Button>
            <Button
              variant={favOnly ? "default" : "outline"}
              onClick={() => {
                const next = !favOnly;
                setFavOnly(next);
                void load(search, next);
              }}
            >
              {favOnly ? "只看收藏" : "全部"}
            </Button>
          </div>
          {error && <div className="text-sm text-[#A0352C]">{error}</div>}

          {items.length === 0 && !loading && (
            <p className="text-sm text-[#55637A]">
              还没有作品。生成成功的视频会自动进来（单条、首帧 I2V、长视频都会保存）。
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((item) => (
              <div key={item.id} className="rounded-xl border border-[#C2CDDD] overflow-hidden bg-white">
                <div className="relative bg-[#0E1726] aspect-[9/16] flex items-center justify-center">
                  {playing === item.id && item.videoUrl ? (
                    <video src={item.videoUrl} controls autoPlay className="w-full h-full object-contain" />
                  ) : item.poster ? (
                    <img src={item.poster} alt="封面" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xs text-white/60">无封面</span>
                  )}
                  <span className="absolute right-2 top-2 text-[11px] px-1.5 py-0.5 rounded bg-black/60 text-white">
                    {item.duration ? `${item.duration}s` : "—"}
                  </span>
                  {item.mode === "long" && (
                    <span className="absolute left-2 top-2 text-[11px] px-1.5 py-0.5 rounded bg-[#1D4ED8] text-white">
                      长视频 {item.total ?? ""}段
                    </span>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <p className="text-xs text-[#0E1726] line-clamp-2" title={item.prompt}>
                    {item.prompt}
                  </p>
                  <p className="text-[11px] text-[#8B95A7]">
                    {item.resolution || "—"} · {new Date(item.createdAt).toLocaleString()}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {playing === item.id ? (
                      <Button size="sm" variant="outline" onClick={() => setPlaying(null)}>
                        收起
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setPlaying(item.id)} disabled={!item.videoUrl}>
                        播放
                      </Button>
                    )}
                    <a href={item.videoUrl || "#"} download className="inline-flex">
                      <Button size="sm" variant="outline">下载</Button>
                    </a>
                    <Button size="sm" variant="outline" onClick={() => toggleFav(item)}>
                      {item.favorite ? "★ 已收藏" : "☆ 收藏"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(item)} className="text-[#A0352C]">
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 本地 AI 设置（单机模式）
 * ------------------------------------------------------------------
 * 直接在这里填写本地大模型地址与模型名，保存后立即生效（无需重启）：
 *  - baseUrl：OpenAI 兼容端点根地址，例如 http://192.168.3.218:8080
 *  - model：模型名，例如 qwen3.8-flash-next-iq3_s
 *  - whisperModel：本地语音识别模型大小
 * 「测试连接」会请求 <baseUrl>/v1/models 并列出可用模型。
 */

type Config = {
  baseUrl: string;
  model: string;
  apiKey: string;
  whisperModel: string;
  h3BaseUrl: string;
  corrections: string;
};

const WHISPER_OPTIONS = [
  { value: "tiny", label: "tiny（最快，约 39MB）" },
  { value: "base", label: "base（快，约 74MB）" },
  { value: "small", label: "small（平衡，约 244MB）" },
  { value: "medium", label: "medium（准，约 769MB）" },
  { value: "large-v3", label: "large-v3（最准，约 1550MB）" },
];

export function LocalAiSettings() {
  const [config, setConfig] = useState<Config>({
    baseUrl: "",
    model: "",
    apiKey: "",
    whisperModel: "small",
    h3BaseUrl: "",
    corrections: "",
  });
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  /** 拉取服务端模型列表；autoSelect 时自动把模型名补进当前值 */
  const fetchModels = useCallback(async (baseUrl: string, apiKey: string, autoSelect = true) => {
    if (!baseUrl?.trim()) return;
    setModelsLoading(true);
    try {
      const res = await fetch("/api/settings/local-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", baseUrl, apiKey }),
      });
      const data = await res.json();

      if (data?.ok) {
        const list: string[] = Array.isArray(data.models) ? data.models : [];
        setModels(list);
        if (list.length === 0) {
          setMessage({ type: "err", text: "连接成功，但服务端未返回模型列表" });
          return;
        }
        setConfig((c) => {
          if (autoSelect && (!c.model || !list.includes(c.model))) {
            return { ...c, model: list[0] };
          }
          return c;
        });
        setMessage({ type: "ok", text: `已连接，自动获取到 ${list.length} 个模型` });
      } else {
        setMessage({ type: "err", text: `连接失败：${data?.error || "未知错误"}` });
      }
    } catch (error) {
      setMessage({
        type: "err",
        text: `连接失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/local-ai", { cache: "no-store" });
        const data = await res.json();
        if (cancelled || !data?.config) return;
        setConfig(data.config);
        // 打开设置页就自动拉一次模型列表
        void fetchModels(data.config.baseUrl, data.config.apiKey ?? "", true);
      } catch {
        if (!cancelled) setMessage({ type: "err", text: "读取配置失败" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchModels]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/local-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data?.ok) {
        setConfig(data.config);
        setMessage({ type: "ok", text: "已保存，立即生效" });
      } else {
        setMessage({ type: "err", text: data?.error || "保存失败" });
      }
    } catch (error) {
      setMessage({ type: "err", text: `保存失败：${error instanceof Error ? error.message : error}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMessage(null);
    // 复用 fetchModels：既测试连通性，也刷新模型下拉列表
    await fetchModels(config.baseUrl, config.apiKey, true);
    setTesting(false);
  };

  if (loading) {
    return <div className="text-sm text-[#55637A]">正在读取本地 AI 配置…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-[#0E1726] mb-1">本地 AI 服务</h3>
        <p className="text-sm text-[#55637A]">
          填写本机或局域网内的 OpenAI 兼容服务地址，用于视频/图片分析与音频分段。全部在本机运行，速度稳定。
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-[#0E1726] block mb-2">服务地址</label>
          <Input
            value={config.baseUrl}
            onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
            onBlur={(e) => {
              const url = e.target.value.trim();
              if (url) void fetchModels(url, config.apiKey, true);
            }}
            placeholder="http://192.168.3.218:8080"
            className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
          />
          <p className="text-xs text-[#8B95A7] mt-1">
            只填到端口，不要带 /v1；失焦后自动拉取模型
          </p>
        </div>
        <div>
          <label className="text-sm font-medium text-[#0E1726] block mb-2">
            模型名称
            {modelsLoading && <span className="ml-2 text-xs text-[#8B95A7]">获取中…</span>}
          </label>
          <div className="flex gap-2">
            <select
              value={models.includes(config.model) ? config.model : ""}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              className="flex-1 h-10 px-3 border border-[#C2CDDD] rounded-lg focus:border-[#2563EB] outline-none bg-white text-[#0E1726]"
            >
              <option value="">
                {models.length ? "请选择模型" : "（填好地址后自动获取）"}
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {config.model && !models.includes(config.model) && (
                <option value={config.model}>{config.model}（当前值）</option>
              )}
            </select>
            <Button
              type="button"
              variant="outline"
              onClick={() => fetchModels(config.baseUrl, config.apiKey, true)}
              disabled={modelsLoading || !config.baseUrl}
            >
              刷新
            </Button>
          </div>
          <p className="text-xs text-[#8B95A7] mt-1">需支持图片输入的视觉模型</p>
        </div>
        <div className="md:col-span-2">
          <label className="text-sm font-medium text-[#0E1726] block mb-2">
            API Key（可选）
          </label>
          <Input
            type="password"
            value={config.apiKey}
            onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
            placeholder="本地服务留空；使用 DeepSeek 等外部服务时填写"
            className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
          />
          <p className="text-xs text-[#8B95A7] mt-1">
            填写后请求会带 Authorization: Bearer &lt;key&gt;，保存在本机 data/local-ai.json
          </p>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-[#0E1726] block mb-2">本地语音识别模型</label>
        <select
          value={config.whisperModel}
          onChange={(e) => setConfig((c) => ({ ...c, whisperModel: e.target.value }))}
          className="w-full md:w-1/2 h-10 px-3 border border-[#C2CDDD] rounded-lg focus:border-[#2563EB] outline-none bg-white text-[#0E1726]"
        >
          {WHISPER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-[#8B95A7] mt-1">首次使用会自动下载模型，之后无需联网</p>
      </div>

      <div className="pt-2 border-t border-[#D8E1EE]">
        <label className="text-sm font-medium text-[#0E1726] block mb-2">H3 视频生成服务地址</label>
        <Input
          value={config.h3BaseUrl}
          onChange={(e) => setConfig((c) => ({ ...c, h3BaseUrl: e.target.value }))}
          placeholder="http://192.168.3.100:7860"
          className="bg-white border-[#C2CDDD] focus:border-[#2563EB]"
        />
        <p className="text-xs text-[#8B95A7] mt-1">
          MiniMax H3 视频生成工作台（Gradio）地址，视频生成功能走这个服务
        </p>
      </div>

      <div className="pt-2 border-t border-[#D8E1EE]">
        <label className="text-sm font-medium text-[#0E1726] block mb-2">台词纠错</label>
        <textarea
          value={config.corrections}
          onChange={(e) => setConfig((c) => ({ ...c, corrections: e.target.value }))}
          placeholder={"每行一条，格式 错误=正确，例如：\n借色=戒色\n老师们=老片子"}
          rows={4}
          className="w-full px-3 py-2 border border-[#C2CDDD] rounded-lg focus:border-[#2563EB] outline-none bg-white text-[#0E1726] text-sm font-mono"
        />
        <p className="text-xs text-[#8B95A7] mt-1">
          语音识别常见同音字错误，写在这里会自动替换（新转写和历史记录都生效）
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white"
        >
          {saving ? "保存中…" : "保存"}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
          {testing ? "测试中…" : "测试连接"}
        </Button>
      </div>

      {message && (
        <div
          className={`text-sm rounded-lg px-3 py-2 border ${
            message.type === "ok"
              ? "border-[#16A34A]/40 bg-[#16A34A]/10 text-[#3F6B3E]"
              : "border-[#DC2626]/40 bg-[#DC2626]/10 text-[#A0352C]"
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}

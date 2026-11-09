"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * 服务状态条（一键包风格）
 * --------------------------------------------------------------
 * 顶栏右侧显示四个状态灯：本程序 / H3 工作台 / ComfyUI / 本地大模型。
 * 红点说明对应服务没起来，鼠标悬停看地址。
 */

type Service = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export function ServiceStatus() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/service-status", { cache: "no-store" });
      const data = await res.json();
      if (Array.isArray(data?.services)) setServices(data.services);
    } catch {
      // 忽略单次失败
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex flex-wrap items-center gap-2 md:gap-3">
      {services.map((s) => (
        <span
          key={s.key}
          title={`${s.label}：${s.detail}`}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/70 border border-[#D8E1EE] text-xs text-[#55637A]"
        >
          <span
            className={`w-2 h-2 rounded-full ${s.ok ? "bg-[#16A34A]" : "bg-[#DC2626]"}`}
          />
          {s.label}
        </span>
      ))}
      {services.length === 0 && (
        <span className="text-xs text-[#8B95A7]">{loading ? "检测服务…" : "状态未知"}</span>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        title="重新检测"
        className="p-1.5 rounded-lg border border-[#D8E1EE] text-[#55637A] hover:text-[#2563EB] hover:border-[#2563EB]"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

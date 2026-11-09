import { NextResponse } from "next/server";
import path from "path";
import fsSync from "fs";
import os from "os";
import { readLocalAiConfig } from "@/lib/config/local-ai";

/**
 * GET /api/service-status
 * 顶栏状态灯：本程序 / H3 工作台 / 音频识别(Whisper) / 本地大模型
 * （ComfyUI 不再检测：H3 可能跑在别的机器上，本地探测没有意义）
 */

async function checkHttp(url: string, pathname: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${pathname}`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function checkWhisper(model: string): { ok: boolean; detail: string } {
  const script = path.join(process.cwd(), "scripts", "local-whisper.py");
  const scriptOk = fsSync.existsSync(script);

  const roots = [
    path.join(os.homedir(), ".cache", "huggingface", "hub"),
    path.join(process.env.LOCALAPPDATA || "", "huggingface", "hub"),
    path.join(process.env.USERPROFILE || "", ".cache", "huggingface", "hub"),
  ].filter(Boolean);

  const dirName = `models--Systran--faster-whisper-${model}`;
  const modelOk = roots.some((root) => {
    try {
      return fsSync.existsSync(path.join(root, dirName));
    } catch {
      return false;
    }
  });

  if (!scriptOk) return { ok: false, detail: "缺少 local-whisper.py" };
  if (!modelOk) return { ok: false, detail: `${model}（模型未下载，首次识别会自动下载）` };
  return { ok: true, detail: `faster-whisper ${model}` };
}

export async function GET() {
  const cfg = readLocalAiConfig();
  const h3Base = (cfg.h3BaseUrl || "").replace(/\/+$/, "");
  const llmBase = (cfg.baseUrl || "").replace(/\/+$/, "");
  const whisper = checkWhisper(cfg.whisperModel || "small");

  const h3 = h3Base ? await checkHttp(h3Base, "/config") : false;
  const llm = llmBase ? await checkHttp(llmBase, "/v1/models") : false;

  return NextResponse.json({
    ok: true,
    services: [
      { key: "web", label: "本程序", ok: true, detail: "3000" },
      { key: "h3", label: "H3 工作台", ok: h3, detail: h3Base || "未配置" },
      { key: "whisper", label: "音频识别", ok: whisper.ok, detail: whisper.detail },
      { key: "llm", label: "本地大模型", ok: llm, detail: llmBase || "未配置" },
    ],
  });
}

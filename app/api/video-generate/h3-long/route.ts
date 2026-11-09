import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { checkH3Video, submitH3 } from "@/lib/video/h3-client";

/**
 * POST /api/video-generate/h3-long
 * 一键长视频：H3 单条只出 2-15 秒，这里把提示词按时间段自动拆成若干段，
 * 逐段提交生成 → 全部完成后用 ffmpeg 自动拼接成一条成片。
 *
 * GET /api/video-generate/h3-long?id=xxx  → 进度 / 结果
 */

// 说明：该能力已实现但【未在界面启用】，等确认后再接按钮。
export const runtime = "nodejs";
export const maxDuration = 3600;

const MAX_PART_SECONDS = 15;
const PART_TIMEOUT_MS = 35 * 60 * 1000;

type Part = { index: number; from: number; to: number; prompt: string; status: string; url?: string; file?: string };
type Job = {
  id: string;
  status: "running" | "done" | "error";
  message: string;
  total: number;
  done: number;
  parts: Part[];
  finalUrl?: string;
  error?: string;
  createdAt: number;
};

const g = globalThis as unknown as { __h3LongJobs?: Map<string, Job> };
if (!g.__h3LongJobs) g.__h3LongJobs = new Map<string, Job>();
const jobs = g.__h3LongJobs;

function run(cmd: string, args: string[], timeoutMs = 600000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = ""; let err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, timeoutMs);
    p.stdout?.on("data", (d) => { out += d.toString(); });
    p.stderr?.on("data", (d) => { err += d.toString(); });
    p.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: "spawn failed" }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 把带 [起-止秒｜主题] 的分镜脚本按 ≤15 秒分组；没有时间标记就按总时长均分 */
function splitPrompt(prompt: string, totalSeconds: number): Part[] {
  const headerEnd = prompt.search(/\[\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*秒/);
  const header = headerEnd > 0 ? prompt.slice(0, headerEnd).trim() : "";

  const markRe = /\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*秒[^\]]*\]/g;
  const marks: { from: number; to: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(prompt)) !== null) {
    marks.push({ from: parseFloat(m[1]), to: parseFloat(m[2]), start: m.index });
  }

  if (marks.length === 0) {
    const count = Math.max(1, Math.ceil(totalSeconds / MAX_PART_SECONDS));
    const span = totalSeconds / count;
    return Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      from: Math.round(i * span * 10) / 10,
      to: Math.round((i + 1) * span * 10) / 10,
      prompt,
      status: "待生成",
    }));
  }

  const parts: Part[] = [];
  let curFrom = marks[0].from;
  let curText = "";
  for (let i = 0; i < marks.length; i++) {
    const blockEnd = i + 1 < marks.length ? marks[i + 1].start : prompt.length;
    const block = prompt.slice(marks[i].start, blockEnd).trim();
    const wouldBe = marks[i].to - curFrom;
    if (curText && wouldBe > MAX_PART_SECONDS) {
      parts.push({ index: parts.length + 1, from: curFrom, to: marks[i - 1].to, prompt: [header, curText].filter(Boolean).join("\n\n"), status: "待生成" });
      curFrom = marks[i].from;
      curText = block;
    } else {
      curText = curText ? `${curText}\n\n${block}` : block;
    }
  }
  if (curText) {
    parts.push({ index: parts.length + 1, from: curFrom, to: marks[marks.length - 1].to, prompt: [header, curText].filter(Boolean).join("\n\n"), status: "待生成" });
  }
  return parts;
}

async function waitForVideo(jobStartedAt: number): Promise<{ url?: string; error?: string }> {
  while (Date.now() - jobStartedAt < PART_TIMEOUT_MS) {
    const r = await checkH3Video().catch(() => null);
    if (!r) { await sleep(5000); continue; }
    if (r.failed) return { error: r.status };
    if (r.videoUrl) return { url: r.videoUrl };
    await sleep(5000);
  }
  return { error: "单段等待超时" };
}

async function processJob(job: Job, opts: { aspectRatio?: string; steps?: number; mode?: string }) {
  const outDir = path.join(process.cwd(), "data", "storage", "videos", "long");
  await fs.mkdir(outDir, { recursive: true });

  for (const part of job.parts) {
    try {
      part.status = "提交中";
      job.message = `第 ${part.index}/${job.total} 段：提交到 H3（${part.from}s-${part.to}s，${Math.min(MAX_PART_SECONDS, Math.ceil(part.to - part.from))} 秒）`;
      const secs = Math.max(2, Math.min(MAX_PART_SECONDS, Math.round(part.to - part.from)));
      await submitH3({ prompt: part.prompt, duration: String(secs), aspectRatio: opts.aspectRatio, steps: opts.steps, mode: opts.mode });
      part.status = "生成中";
      job.message = `第 ${part.index}/${job.total} 段：H3 生成中（约 3-10 分钟）`;

      const started = Date.now();
      const result = await waitForVideo(started);
      if (!result.url) throw new Error(result.error || "未拿到视频");

      part.status = "下载中";
      const res = await fetch(result.url);
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(outDir, `${job.id}_p${part.index}.mp4`);
      await fs.writeFile(file, buf);
      part.file = file;
      part.url = `/files/videos/long/${path.basename(file)}`;
      part.status = "完成";
      job.done = part.index;
    } catch (e) {
      part.status = "失败";
      job.status = "error";
      job.error = `第 ${part.index} 段失败：${e instanceof Error ? e.message : String(e)}`;
      job.message = job.error;
      return;
    }
  }

  // 拼接
  try {
    job.message = "全部分段完成，正在拼接…";
    const listFile = path.join(outDir, `${job.id}_list.txt`);
    await fs.writeFile(listFile, job.parts.map((p) => `file '${(p.file || "").replace(/\\/g, "/")}'`).join("\n"), "utf-8");
    const finalPath = path.join(outDir, `${job.id}.mp4`);
    const r = await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath], 900000);
    if (r.code !== 0) throw new Error(r.stderr.slice(-200));
    job.finalUrl = `/files/videos/long/${path.basename(finalPath)}`;
    job.status = "done";
    job.message = `完成：${job.total} 段已拼接`;
  } catch (e) {
    job.status = "error";
    job.error = `拼接失败：${e instanceof Error ? e.message : String(e)}`;
    job.message = job.error;
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { prompt?: string; totalDuration?: number; aspectRatio?: string; steps?: number; mode?: string }
    | null;

  const prompt = body?.prompt?.trim();
  if (!prompt) return NextResponse.json({ ok: false, error: "提示词不能为空" }, { status: 400 });

  // 用提示词里的最后一个时间点推算总时长，没有就用传入值
  const marks = [...prompt.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*秒/g)];
  const promptEnd = marks.length ? parseFloat(marks[marks.length - 1][2]) : 0;
  const totalSeconds = Math.max(promptEnd || 0, Number(body?.totalDuration) || 0, 2);

  const parts = splitPrompt(prompt, totalSeconds);
  if (parts.length === 0) return NextResponse.json({ ok: false, error: "无法拆分提示词" }, { status: 400 });

  const id = `long-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job: Job = {
    id,
    status: "running",
    message: `已拆成 ${parts.length} 段，开始生成`,
    total: parts.length,
    done: 0,
    parts,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  void processJob(job, { aspectRatio: body?.aspectRatio, steps: body?.steps, mode: body?.mode });

  return NextResponse.json({
    ok: true,
    id,
    total: parts.length,
    parts: parts.map((p) => ({ index: p.index, from: p.from, to: p.to })),
  });
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") || "";
  const job = jobs.get(id);
  if (!job) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    id: job.id,
    status: job.status,
    message: job.message,
    done: job.done,
    total: job.total,
    finalUrl: job.finalUrl,
    error: job.error,
    parts: job.parts.map((p) => ({ index: p.index, from: p.from, to: p.to, status: p.status, url: p.url })),
  });
}

/**
 * 台词与分镜段落的确定性对齐
 * ------------------------------------------------------------------
 * 本地模型会：① 把重复短台词合并；② 把台词放进时间不匹配的段落。
 * 这里做确定性兜底：全局计数 + 严格区间归段，缺几句补几句，不多补。
 */

export interface TimedLine {
  start: number;
  end: number;
  text: string;
}

/** 解析带时间码的台词行 */
export function parseTimedDialogue(input: string): TimedLine[] {
  if (!input) return [];
  const out: TimedLine[] = [];
  const re = /\[\s*(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*-\s*(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*\]\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const start = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    const end = parseInt(m[3], 10) * 60 + parseFloat(m[4]);
    let text = m[5].trim();
    text = text.replace(/^<d>\s*(\[中文\])?\s*/i, "").replace(/<\/d>$/i, "").trim();
    if (!text) continue;
    out.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, text });
  }
  return out;
}

interface SegHeader {
  from: number;
  to: number;
  lineIndex: number;
}

export function findSegmentHeaders(prompt: string): SegHeader[] {
  const lines = prompt.split("\n");
  const res: SegHeader[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*秒/);
    if (m) res.push({ from: parseFloat(m[1]), to: parseFloat(m[2]), lineIndex: i });
  });
  return res;
}

const clean = (s: string) => s.replace(/[\s，。、,.!！?？"“”「」<>/d]/g, "");

function countOccurrences(haystack: string, needle: string): number {
  const h = clean(haystack);
  const n = clean(needle);
  if (!n) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = h.indexOf(n, pos)) !== -1) {
    count += 1;
    pos += n.length;
  }
  return count;
}

/**
 * 补齐台词（全局计数版）：
 *   - 每句台词在整份输出里应出现 expected 次（重复台词按次数算）
 *   - 缺几次补几次，补到时间所在段落的末尾
 */
export function ensureDialogueAligned(
  prompt: string,
  dialogue: TimedLine[],
  options: { speaker?: string } = {},
): { prompt: string; added: number; missing: number } {
  if (!prompt || dialogue.length === 0) return { prompt, added: 0, missing: 0 };

  const speaker = options.speaker || "人物 (S1)";
  const headers = findSegmentHeaders(prompt);
  if (headers.length === 0) return { prompt, added: 0, missing: dialogue.length };

  const expected = new Map<string, number>();
  for (const d of dialogue) expected.set(d.text, (expected.get(d.text) || 0) + 1);

  // 缺口 = 期望次数 - 输出里已有次数
  const deficit = new Map<string, number>();
  for (const [text, want] of expected) {
    const have = countOccurrences(prompt, text);
    if (want > have) deficit.set(text, want - have);
  }

  const lines = prompt.split("\n");
  const insertions: { at: number; text: string }[] = [];

  for (const d of dialogue) {
    const left = deficit.get(d.text) || 0;
    if (left <= 0) continue;
    // 严格区间：start 落在哪一段
    let segIdx = headers.findIndex((h) => d.start >= h.from - 0.05 && d.start < h.to);
    if (segIdx < 0) {
      // 落在最后一段之后：挂到最近的一段
      segIdx = headers.length - 1;
      for (let i = 0; i < headers.length; i++) {
        if (d.start < headers[i].to) { segIdx = i; break; }
      }
    }
    const segEnd = segIdx + 1 < headers.length ? headers[segIdx + 1].lineIndex : lines.length;
    insertions.push({
      at: segEnd,
      text: `${d.start.toFixed(1)} 秒处，${speaker} 说：<d>[中文]${d.text}</d>`,
    });
    deficit.set(d.text, left - 1);
  }

  insertions.sort((a, b) => b.at - a.at);
  for (const ins of insertions) lines.splice(ins.at, 0, ins.text);

  const joined = lines.join("\n");
  let missing = 0;
  for (const [text, want] of expected) {
    if (countOccurrences(joined, text) < want) missing += 1;
  }

  return { prompt: joined, added: insertions.length, missing };
}

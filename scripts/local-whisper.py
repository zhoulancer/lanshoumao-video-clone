#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
本地语音识别脚本 - faster-whisper（逐句带时间码版）

要点：
  - word_timestamps=True 拿到每个字/词的时间
  - 按标点（。！？，；、）和停顿切句，输出【逐句】时间码
  - 这样台词才能和画面时间轴精确对齐；整段合并会导致后面无法落位
"""
import sys
import json
import argparse
import io
import re
from faster_whisper import WhisperModel

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

PUNCT = "。！？!?；;，,、…"
MAX_CHARS = 22        # 单句最长字数
MAX_GAP = 0.55        # 词间停顿超过这个秒数就断句
MAX_SPAN = 6.0        # 单句最长秒数


def split_segment(words):
    """把一个 whisper 段按标点/停顿切成多句，保留真实起止时间"""
    out = []
    buf, start_t, last_end = [], None, None

    def flush(end_t):
        nonlocal buf, start_t, last_end
        text = "".join(w[0] for w in buf).strip()
        text = text.strip(PUNCT + " ")
        if text:
            out.append({"start": round(start_t, 2), "end": round(max(end_t, start_t + 0.2), 2), "text": text})
        buf, start_t, last_end = [], None, None

    for w in words:
        word, w_start, w_end = w
        if start_t is None:
            start_t = w_start
        # 停顿过大 → 先断句
        if last_end is not None and w_start - last_end > MAX_GAP and buf:
            flush(last_end)
            start_t = w_start
        buf.append((word, w_start, w_end))
        last_end = w_end

        text_so_far = "".join(x[0] for x in buf)
        hit_punct = word and word[-1] in PUNCT
        too_long = len(re.sub(r"\s", "", text_so_far)) >= MAX_CHARS
        too_span = (w_end - start_t) >= MAX_SPAN
        if hit_punct or too_long or too_span:
            flush(w_end)

    if buf:
        flush(last_end if last_end is not None else start_t)
    return out


def transcribe(audio_path, model_size="small"):
    print(f"Loading model: {model_size}", file=sys.stderr)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    print(f"Transcribing: {audio_path}", file=sys.stderr)
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        beam_size=5,
        word_timestamps=True,
    )
    print(f"Language: {info.language}, Duration: {info.duration}", file=sys.stderr)

    result = {"language": info.language or "zh", "duration": info.duration or 0, "segments": []}
    for seg in segments:
        words = []
        for w in (seg.words or []):
            word = (w.word or "").strip()
            if word:
                words.append((word, float(w.start), float(w.end)))
        if not words:
            text = (seg.text or "").strip()
            if text:
                result["segments"].append({"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text})
            continue
        result["segments"].extend(split_segment(words))

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="本地语音识别")
    parser.add_argument("audio", help="音频文件路径")
    parser.add_argument("--model", default="small", help="模型大小: tiny, base, small, medium, large-v3")
    args = parser.parse_args()
    try:
        transcribe(args.audio, args.model)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

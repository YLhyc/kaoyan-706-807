#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
batch_synth_micro_audio.py
为 706 (42篇) + 807 (40篇) 轨道二「逻辑微缩版」全量合成与轨道一完全同源的
阿里云通义语音大模型原生音色 (model="qwen-audio-3.1-tts-flash", voice="longanlang_v3.1" 龙安朗)：
1. 与轨道一完全同源的 qwen-audio-3.1-tts-flash + longanlang_v3.1 音色与原生响度基准（不额外叠加人工增益），彻底消除双轨音色割裂；
2. 挂载 706 + 807 全量文史专有名词与生僻多音字 HotFix 词典（直接使用规范汉字原文，杜绝假借谐音词干扰语调）；
3. 基于 CosyVoice word_timestamp_enabled 词级时间戳 + 字符流精确序列对齐（SequenceMatcher），
   彻底免疫 `；` 分句或数字展开（2022->二零二二）造成的跨槽错并；
4. 无损 PCM 声学静音检测 + 跨槽位气口校准（常规槽界 >=540ms、标题/分点/防混/抽查等结构界 >=720ms）；
5. 统一输出 44100 Hz / Mono / 96 kbps 高清 MP3，与轨道一音频品质及电平完全对齐；
6. 支持 --limit N / --ids id1,id2 / --workers 3 / --force / --apply-manifests。
"""

import argparse
import concurrent.futures
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import wave
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

import dashscope
from dashscope.audio.tts_v2 import AudioFormat, ResultCallback, SpeechSynthesizer
from dashscope.audio.tts_v2.speech_synthesizer import HotFix

ROOT = Path(r"D:\AI_file\706_807专业课背诵手卷")
SCRIPTS_PATH = ROOT / "data" / "micro_spoken_scripts.json"
MANIFEST_706 = ROOT / "data" / "kaoyan_706_manifest.json"
MANIFEST_807 = ROOT / "data" / "kaoyan_807_manifest.json"
MANIFEST_ALL = ROOT / "data" / "kaoyan_all_manifest.json"

MODEL_NAME = "qwen-audio-3.1-tts-flash"
VOICE_NAME = "longanlang_v3.1"
SAMPLE_RATE = 44100

HOT_FIX = HotFix(pronunciation=[
    # --- 706 古代文学专有名词与多音词 ---
    {"纪传体": "ji4 zhuan4 ti3"},
    {"列传": "lie4 zhuan4"},
    {"经传": "jing1 zhuan4"},
    {"左传": "zuo3 zhuan4"},
    {"左氏传": "zuo3 shi4 zhuan4"},
    {"外传": "wai4 zhuan4"},
    {"传记": "zhuan4 ji4"},
    {"别传": "bie2 zhuan4"},
    {"内传": "nei4 zhuan4"},
    {"正传": "zheng4 zhuan4"},
    {"小传": "xiao3 zhuan4"},
    {"本传": "ben3 zhuan4"},
    {"他传": "ta1 zhuan4"},
    {"史传": "shi3 zhuan4"},
    {"立传": "li4 zhuan4"},
    {"自叙传": "zi4 xu4 zhuan4"},
    {"公羊传": "gong1 yang2 zhuan4"},
    {"谷梁传": "gu3 liang2 zhuan4"},
    {"世家列传": "shi4 jia1 lie4 zhuan4"},
    {"呼兰河传": "hu1 lan2 he2 zhuan4"},
    {"阿Q正传": "a1 Q zheng4 zhuan4"},
    {"水浒传": "shui3 hu3 zhuan4"},
    {"莺莺传": "ying1 ying1 zhuan4"},
    {"长恨歌传": "chang2 hen4 ge1 zhuan4"},
    {"太史公自序": "tai4 shi3 gong1 zi4 xu4"},
    {"乐府": "yue4 fu3"},
    {"汉乐府": "han4 yue4 fu3"},
    {"新乐府": "xin1 yue4 fu3"},
    {"古乐府": "gu3 yue4 fu3"},
    {"乐府诗": "yue4 fu3 shi1"},
    {"乐府双璧": "yue4 fu3 shuang1 bi4"},
    {"礼乐": "li3 yue4"},
    {"雅乐": "ya3 yue4"},
    {"燕歌行": "yan1 ge1 xing2"},
    {"便娟": "pian2 juan1"},
    {"便娟婉约": "pian2 juan1 wan3 yue1"},
    {"单于": "chan2 yu2"},
    {"长歌当哭": "chang2 ge1 dang4 ku1"},
    {"长恨歌": "chang2 hen4 ge1"},
    {"重章叠句": "chong2 zhang1 die2 ju4"},
    {"温庭筠": "wen1 ting2 yun2"},
    {"谢朓": "xie4 tiao3"},
    {"鲍照": "bao4 zhao4"},
    {"庾信": "yu3 xin4"},
    {"行卷": "xing2 juan4"},
    {"行乐": "xing2 le4"},
    {"自度曲": "zi4 duo4 qu3"},
    {"骚体": "sao1 ti3"},
    {"楚辞": "chu3 ci2"},
    {"离骚": "li2 sao1"},
    {"赋比兴": "fu4 bi3 xing4"},
    {"兴寄": "xing4 ji4"},
    {"寄兴": "ji4 xing4"},
    {"兴象": "xing4 xiang4"},
    {"起兴": "qi3 xing4"},
    {"拗救": "ao4 jiu4"},
    {"拗体": "ao4 ti3"},
    {"押韵": "ya1 yun4"},
    {"押官韵": "ya1 guan1 yun4"},
    {"平仄": "ping2 ze4"},
    {"关陇": "guan1 long3"},
    {"掉书袋": "diao4 shu1 dai4"},
    {"数见不鲜": "shuo4 jian4 bu4 xian1"},
    {"数奇": "shu4 ji1"},
    {"宁有种乎": "ning4 you3 zhong3 hu1"},
    {"应制": "ying4 zhi4"},
    {"辟易": "bi4 yi4"},
    {"跌宕": "die2 dang4"},
    {"俶傥": "ti4 tang3"},
    {"俶尔": "chu4 er3"},
    {"沉郁顿挫": "chen2 yu4 dun4 cuo4"},
    {"黍离之悲": "shu3 li2 zhi1 bei1"},
    {"伛偻": "yu3 lv3"},
    {"曾几": "zeng1 ji3"},
    {"尤袤": "you2 mao4"},
    {"刘知幾": "liu2 zhi1 ji1"},
    {"邲之战": "bi4 zhi1 zhan4"},
    {"崤之战": "xiao2 zhi1 zhan4"},
    {"城濮之战": "cheng2 pu2 zhi1 zhan4"},
    {"桃杌": "tao2 wu4"},
    {"坎廪": "kan3 lin3"},
    {"渔阳鼙鼓": "yu2 yang2 pi2 gu3"},
    {"霓裳": "ni2 chang2"},
    {"卮言": "zhi1 yan2"},
    {"不葺": "bu4 qi4"},
    {"阮大铖": "ruan3 da4 cheng2"},
    {"买椟还珠": "mai3 du2 huan2 zhu1"},
    {"诗薮": "shi1 sou3"},
    {"沾溉": "zhan1 gai4"},
    {"说难": "shui4 nan2"},
    {"游说": "you2 shui4"},
    {"复沓": "fu4 ta4"},
    # --- 807 现当代文学专有名词与多音词 ---
    {"蘩漪": "fan2 yi1"},
    {"繁漪": "fan2 yi1"},
    {"周萍": "zhou1 ping2"},
    {"鲁侍萍": "lu3 shi4 ping2"},
    {"周朴园": "zhou1 pu3 yuan2"},
    {"傩送": "nuo2 song4"},
    {"茶峒": "cha2 dong4"},
    {"碧溪岨": "bi4 xi1 ju3"},
    {"天保": "tian1 bao3"},
    {"老舍": "lao3 she3"},
    {"郁达夫": "yu4 da2 fu1"},
    {"穆旦": "mu4 dan4"},
    {"艾青": "ai4 qing1"},
    {"汪曾祺": "wang1 zeng1 qi2"},
    {"仇虎": "chou2 hu3"},
    {"焦大星": "jiao1 da4 xing1"},
    {"荷花淀": "he2 hua1 dian4"},
    {"荷花淀派": "he2 hua1 dian4 pai4"},
    {"白洋淀": "bai2 yang2 dian4"},
    {"祁老人": "qi2 lao3 ren2"},
    {"冠晓荷": "guan1 xiao3 he2"},
    {"钱玄同": "qian2 xuan2 tong2"},
    {"茅盾": "mao2 dun4"},
    {"吴荪甫": "wu2 sun1 fu3"},
    {"周作人": "zhou1 zuo4 ren2"},
    {"叶圣陶": "ye4 sheng4 tao2"},
    {"郑振铎": "zheng4 zhen4 duo2"},
    {"戴望舒": "dai4 wang4 shu1"},
    {"卞之琳": "bian4 zhi1 lin2"},
    {"冯至": "feng2 zhi4"},
    {"李劼人": "li3 jie2 ren2"},
    {"贾平凹": "jia3 ping2 wa1"},
    {"邓幺姑": "deng4 yao1 gu1"},
    {"谌容": "shen4 rong2"},
    {"唐湜": "tang2 shi2"},
    {"阿垅": "a1 long3"},
    {"杜运燮": "du4 yun4 xie4"},
    {"从维熙": "cong2 wei2 xi1"},
    {"胡先骕": "hu2 xiān su4".replace("ā", "a1")},
    {"吴宓": "wu2 mi4"},
    {"魏连殳": "wei4 lian2 shu1"},
    {"吕纬甫": "lv3 wei3 fu3"},
    {"苏文纨": "su1 wen2 wan2"},
    {"施蛰存": "shī zhe2 cun2".replace("ī", "i1")},
    {"钱杏邨": "qian2 xing4 cun1"},
    {"茹志鹃": "ru2 zhi4 juan1"},
    {"陈奂生": "chen2 huan4 sheng1"},
    {"刘家峧": "liu2 jia1 jiao1"},
    {"大淖记事": "da4 nao4 ji4 shi4"},
    {"三闾大学": "san1 lv2 da4 xue2"},
    {"奇肱飞车": "ji1 gong1 fei1 che1"},
    {"湘累": "xiang1 lei4"},
    {"发轫": "fa1 ren4"},
    {"冷隽": "leng3 jun4"},
    {"嬗变": "shan4 bian4"},
    {"端参汤": "duan1 shen1 tang1"},
    {"调级": "tiao2 ji2"},
    {"几欲": "ji1 yu4"},
    {"木讷": "mu4 ne4"},
    {"龃龉": "ju3 yu3"},
    {"白鹿原": "bai2 lu4 yuan2"},
    {"陈忠实": "chen2 zhong1 shi2"},
    {"死水微澜": "si3 shui3 wei1 lan2"},
])

_HOTFIX_PY_TO_HANZI: dict[str, str] = {}
for _item in HOT_FIX.pronunciation:
    for _hz, _py in _item.items():
        _clean_py = re.sub(r"[1-5\s]", "", _py).lower()
        if _clean_py:
            _HOTFIX_PY_TO_HANZI[_clean_py] = _hz


def _strip_pinyin_tones(s: str) -> str:
    nfkd = unicodedata.normalize("NFKD", s.replace("ü", "v").replace("ǖ", "v").replace("ǘ", "v").replace("ǚ", "v").replace("ǜ", "v"))
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch)).lower()


def _decode_cosy_brackets(w_text: str) -> str:
    """将 CosyVoice HotFix 返回的 `[y][uè][f][ǔ]` 音标括号序列还原为对应汉字词，确保字符流 1:1 精确对齐。"""
    if "[" not in (w_text or ""):
        return w_text or ""

    def _sub_run(m):
        run = m.group(0)
        syls = re.findall(r"\[([^\]]+)\]", run)
        py = _strip_pinyin_tones("".join(syls))
        if py in _HOTFIX_PY_TO_HANZI:
            return _HOTFIX_PY_TO_HANZI[py]
        # 贪心切分组合 HotFix 词
        out_hz = []
        pos = 0
        while pos < len(py):
            matched = None
            for end in range(len(py), pos, -1):
                sub = py[pos:end]
                if sub in _HOTFIX_PY_TO_HANZI:
                    matched = _HOTFIX_PY_TO_HANZI[sub]
                    pos = end
                    break
            if matched:
                out_hz.append(matched)
            else:
                out_hz.append(py[pos])
                pos += 1
        return "".join(out_hz)

    return re.sub(r"(?:\[[^\]]+\])+", _sub_run, w_text)


def ffprobe_duration(audio_path: Path) -> float:
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(audio_path)],
            capture_output=True, text=True, check=True,
        )
        return float(json.loads(res.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def detect_silences_wav(wav_path: Path, noise_db: int = -34, min_dur: float = 0.06) -> list[dict]:
    cmd = [
        "ffmpeg", "-i", str(wav_path),
        "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr = proc.stderr.decode("utf-8", errors="ignore")
    silences = []
    cur_start = None
    for line in stderr.splitlines():
        if "silence_start:" in line:
            m = re.search(r"silence_start:\s*([\d\.]+)", line)
            if m:
                cur_start = float(m.group(1))
        elif "silence_end:" in line:
            m = re.search(r"silence_end:\s*([\d\.]+)\s*\|\s*silence_duration:\s*([\d\.]+)", line)
            if m and cur_start is not None:
                silences.append({
                    "start": cur_start,
                    "end": float(m.group(1)),
                    "dur": float(m.group(2)),
                })
                cur_start = None
    return silences


_DIGIT_CN = str.maketrans("0123456789", "零一二三四五六七八九")


def _align_norm(s: str) -> str:
    """将汉字/英文/数字规范化为紧凑字符流，用于与 CosyVoice words 精确序列对齐（含四位年份展开兼容）。"""
    t = (s or "").translate(_DIGIT_CN)
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", t).upper()


class CosyCollector(ResultCallback):
    def __init__(self):
        self.audio = bytearray()
        self.words: list[dict] = []
        self.err = None
        self.done = threading.Event()

    def on_data(self, data: bytes):
        self.audio.extend(data)

    def on_complete(self):
        self.done.set()

    def on_error(self, message):
        self.err = str(message)
        self.done.set()

    def on_event(self, message):
        try:
            msg = json.loads(message)
            out = msg.get("payload", {}).get("output", {})
            if out.get("type") == "sentence-end":
                sent = out.get("sentence", {})
                for w in (sent.get("words") or []):
                    if w.get("begin_time") is not None and w.get("end_time") is not None:
                        self.words.append(w)
        except Exception:
            pass


def _merge_bracket_words(words: list[dict]) -> list[dict]:
    """将 CosyVoice 按字符拆开的 `[`, `y`, `]`, `[`, `u`, `è`, `]` 音标括号序列合拢为整体 HotFix 词元。"""
    merged: list[dict] = []
    i = 0
    n = len(words)
    while i < n:
        t = words[i].get("text", "")
        if t == "[" or (t.startswith("[") and not t.endswith("]")):
            bt = words[i]["begin_time"]
            et = words[i]["end_time"]
            parts = []
            depth = 0
            while i < n:
                wt = words[i].get("text", "")
                if not parts or depth > 0 or wt.startswith("["):
                    parts.append(wt)
                    et = words[i]["end_time"]
                    depth += wt.count("[") - wt.count("]")
                    i += 1
                    if depth <= 0 and (i >= n or not words[i].get("text", "").startswith("[")):
                        break
                else:
                    break
            merged.append({"text": "".join(parts), "begin_time": bt, "end_time": et})
        else:
            merged.append(words[i])
            i += 1
    return merged


def _align_batch_words_to_clauses(
    words: list[dict],
    batch_clauses: list[dict],
) -> list[tuple[float, float]]:
    """
    通过字符级 SequenceMatcher 将一个批次内的全部 CosyVoice words（含毫秒起止坐标）
    直接精确映射到该批每一个 UI clause，彻底免疫 `;` 分句拆分、HotFix 音标括号与逗号吞音错位。
    """
    if not words:
        raise RuntimeError("CosyVoice 未返回任何 word 时间戳")

    merged_words = _merge_bracket_words(words)

    # 仅保留真实发声字/词 token（排除纯标点）并记录其后紧随标点的末尾时间（防止 CosyVoice 将整句语音时常堆在标点 token 上）
    spoken_words: list[dict] = []
    trailing_punc_end: list[float] = []
    wb_chars: list[str] = []
    char_word_idx: list[int] = []
    for w in merged_words:
        wn = _align_norm(_decode_cosy_brackets(w.get("text", "")))
        if not wn:
            if spoken_words:
                trailing_punc_end[-1] = max(trailing_punc_end[-1], w["end_time"] / 1000.0)
            continue
        wi = len(spoken_words)
        spoken_words.append(w)
        trailing_punc_end.append(w["end_time"] / 1000.0)
        for ch in wn:
            wb_chars.append(ch)
            char_word_idx.append(wi)
    wb_stream = "".join(wb_chars)

    exp_chunks = [_align_norm(c["tts_text"]) for c in batch_clauses]
    exp_stream = "".join(exp_chunks)
    n_exp = len(exp_stream)
    n_wb = len(wb_stream)

    if n_wb == 0 or n_exp == 0:
        raise RuntimeError(f"字符流为空: exp={n_exp}, wb={n_wb}")

    # 用 SequenceMatcher 构建 exp_stream[k] -> wb_stream[j] 单调映射
    sm = difflib.SequenceMatcher(None, exp_stream, wb_stream, autojunk=False)
    exp_to_wb: list[int | None] = [None] * n_exp
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                exp_to_wb[i1 + k] = j1 + k
        elif tag == "replace":
            span_e = i2 - i1
            span_w = j2 - j1
            for k in range(span_e):
                rel = int(round((k + 0.5) * span_w / max(1, span_e) - 0.5))
                exp_to_wb[i1 + k] = min(j2 - 1, max(j1, j1 + rel))

    # 线性插补偶发 None（例如极少数字读法微差 “二零” vs “二十”）
    last_j = 0
    for i in range(n_exp):
        if exp_to_wb[i] is not None:
            last_j = exp_to_wb[i]
        else:
            # 向前找下一个已匹配位置
            nxt_j = n_wb - 1
            for p in range(i + 1, n_exp):
                if exp_to_wb[p] is not None:
                    nxt_j = exp_to_wb[p]
                    break
            exp_to_wb[i] = min(nxt_j, max(last_j, last_j + (1 if last_j < nxt_j else 0)))
            last_j = exp_to_wb[i]

    spans: list[tuple[float, float]] = []
    cursor = 0
    for chunk in exp_chunks:
        clen = len(chunk)
        if clen == 0:
            pe = spans[-1][1] if spans else 0.0
            spans.append((pe, pe + 0.08))
            continue
        j_start = exp_to_wb[cursor]
        j_end = exp_to_wb[cursor + clen - 1]
        if j_end < j_start:
            j_end = j_start
        wi_start = char_word_idx[j_start]
        wi_end = char_word_idx[j_end]
        st = spoken_words[wi_start]["begin_time"] / 1000.0
        en = spoken_words[wi_end]["end_time"] / 1000.0
        punc_en = trailing_punc_end[wi_end]
        if punc_en - en > 0.45 and (clen / max(0.01, en - st)) > 9.5:
            en = max(en, punc_en - 0.14)

        # 若紧邻两分句共享同一多字词 token，按字数居中无重叠切分
        if spans and st < spans[-1][1]:
            if cursor > 0 and char_word_idx[exp_to_wb[cursor - 1]] == wi_start:
                w_st = spoken_words[wi_start]["begin_time"] / 1000.0
                w_en = spoken_words[wi_start]["end_time"] / 1000.0
                mid_t = (w_st + w_en) * 0.5
                spans[-1] = (spans[-1][0], max(spans[-1][0] + 0.06, mid_t - 0.008))
                st = max(spans[-1][1] + 0.012, mid_t + 0.004)
            else:
                st = spans[-1][1] + 0.012
        if en <= st:
            en = st + 0.08
        spans.append((st, en))
        cursor += clen

    return spans


def _synth_cosy_batch(batch_slots: list[str]) -> tuple[bytes, list[dict]]:
    cb = CosyCollector()
    syn = SpeechSynthesizer(
        model=MODEL_NAME,
        voice=VOICE_NAME,
        format=AudioFormat.MP3_48000HZ_MONO_256KBPS,
        callback=cb,
        hot_fix=HOT_FIX,
        additional_params={"word_timestamp_enabled": True},
    )
    for st in batch_slots:
        syn.streaming_call(st)
    syn.streaming_complete()
    if not cb.done.wait(timeout=120):
        raise RuntimeError("CosyVoice 批次合成超时")
    if cb.err:
        raise RuntimeError(f"CosyVoice 错误: {cb.err}")
    if len(cb.audio) < 2000:
        raise RuntimeError(f"CosyVoice 音频过小: {len(cb.audio)}")
    if not cb.words:
        raise RuntimeError("CosyVoice 未返回任何词级时间戳")
    return bytes(cb.audio), cb.words


def synthesize_cosy_track2(
    slot_metas: list[dict],
) -> tuple[bytes, list[tuple[float, float]]]:
    """
    按安全字符预算分批流式合成 CosyVoice 龙安朗 Track 2，
    拼接为连续 44.1kHz s16 mono PCM，并直接返回每条 UI clause 的对齐起止秒。
    """
    if not os.environ.get("DASHSCOPE_API_KEY"):
        raise RuntimeError("DASHSCOPE_API_KEY 未设置")
    dashscope.api_key = os.environ["DASHSCOPE_API_KEY"]

    # 分批（每批 <= 550 字 且 <= 10 槽），确保 WebSocket 零超时与高对齐精度
    batches: list[list[dict]] = []
    cur_batch: list[dict] = []
    cur_chars = 0
    for sl in slot_metas:
        st_txt = sl["slot_tts_text"]
        if cur_batch and (cur_chars + len(st_txt) > 550 or len(cur_batch) >= 10):
            batches.append(cur_batch)
            cur_batch = []
            cur_chars = 0
        cur_batch.append(sl)
        cur_chars += len(st_txt)
    if cur_batch:
        batches.append(cur_batch)

    all_pcm_parts: list[bytes] = []
    all_raw_spans: list[tuple[float, float]] = []
    cum_sec = 0.0
    frame_bytes = 2  # s16 mono

    with tempfile.TemporaryDirectory(prefix="t2_cosy_b_") as tmpdir:
        tmp = Path(tmpdir)
        for bi, b_slots in enumerate(batches):
            slot_strs = [sl["slot_tts_text"] for sl in b_slots]
            b_clauses = [c for sl in b_slots for c in sl["clauses"]]

            b_mp3_bytes, b_words = _synth_cosy_batch(slot_strs)
            b_mp3 = tmp / f"b_{bi}.mp3"
            b_wav = tmp / f"b_{bi}.wav"
            b_mp3.write_bytes(b_mp3_bytes)
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(b_mp3), "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", str(b_wav)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
            )
            with wave.open(str(b_wav), "rb") as wf:
                b_pcm = wf.readframes(wf.getnframes())
            b_dur_sec = (len(b_pcm) // frame_bytes) / float(SAMPLE_RATE)

            b_spans = _align_batch_words_to_clauses(b_words, b_clauses)
            for st_s, en_s in b_spans:
                all_raw_spans.append((st_s + cum_sec, en_s + cum_sec))

            all_pcm_parts.append(b_pcm)
            cum_sec += b_dur_sec

    return b"".join(all_pcm_parts), all_raw_spans


def align_and_pad_cosy_track2(
    raw_pcm_bytes: bytes,
    raw_spans: list[tuple[float, float]],
    clause_metas: list[dict],
    out_mp3: Path,
) -> list[dict]:
    """
    保留每个逻辑槽位内部 100% 龙安朗自然呼吸流，仅在跨槽位（title/hook/intro/段落/步骤/防混/抽查）
    边界校准静默停顿，最终以与轨道一完全一致的 44.1kHz / Mono / 96kbps（原生响度无人工增益）输出 MP3。
    """
    n = len(clause_metas)
    slot_groups: list[tuple[int, int]] = []
    cur_s = 0
    for i in range(1, n):
        if clause_metas[i]["slot_key"] != clause_metas[cur_s]["slot_key"]:
            slot_groups.append((cur_s, i - 1))
            cur_s = i
    slot_groups.append((cur_s, n - 1))
    num_slots = len(slot_groups)

    with tempfile.TemporaryDirectory(prefix="t2_cosy_pad_") as tmpdir:
        tmp = Path(tmpdir)
        raw_wav = tmp / "raw.wav"
        pad_wav = tmp / "padded.wav"
        tmp_out = out_mp3.with_suffix(".tmp.mp3")

        with wave.open(str(raw_wav), "wb") as wf_raw:
            wf_raw.setnchannels(1)
            wf_raw.setsampwidth(2)
            wf_raw.setframerate(SAMPLE_RATE)
            wf_raw.writeframes(raw_pcm_bytes)

        silences = detect_silences_wav(raw_wav, noise_db=-34, min_dur=0.05)
        if len(silences) < max(1, num_slots // 2):
            silences = detect_silences_wav(raw_wav, noise_db=-26, min_dur=0.03)

        pcm = raw_pcm_bytes
        sampwidth = 2
        nchannels = 1
        fr = SAMPLE_RATE
        frame_bytes = sampwidth * nchannels
        total_frames = len(pcm) // frame_bytes
        total_dur = total_frames / float(fr)

        cuts = []
        for s_idx in range(num_slots - 1):
            _, end_ci = slot_groups[s_idx]
            nxt_ci, _ = slot_groups[s_idx + 1]
            gap_lo = raw_spans[end_ci][1]
            gap_hi = raw_spans[nxt_ci][0]
            cur_gap = max(0.0, gap_hi - gap_lo)

            win_lo = max(0.0, gap_lo - 0.05)
            win_hi = min(total_dur, gap_hi + 0.05)
            best_sil = None
            best_dist = 1e9
            target_mid = (gap_lo + gap_hi) * 0.5
            for sil in silences:
                s_mid = (sil["start"] + sil["end"]) * 0.5
                if win_lo <= s_mid <= win_hi:
                    d = abs(s_mid - target_mid)
                    if d < best_dist:
                        best_dist = d
                        best_sil = sil

            if best_sil is not None:
                cut_t = min(max((best_sil["start"] + best_sil["end"]) * 0.5, gap_lo), max(gap_lo, gap_hi))
                real_gap = max(cur_gap, best_sil["end"] - best_sil["start"])
            else:
                cut_t = min(max(target_mid, gap_lo), total_dur)
                real_gap = cur_gap

            cur_part = clause_metas[end_ci].get("part", "")
            nxt_part = clause_metas[nxt_ci].get("part", "")
            if cur_part == "title" or nxt_part in ("section_title", "noun_title", "conclusion", "guard") or (cur_part != "drill" and nxt_part == "drill"):
                target_gap = 0.72
            else:
                target_gap = 0.54

            pad_needed = max(0.0, target_gap - real_gap)
            cuts.append({"cut_t": cut_t, "pad_sec": pad_needed})

        first_sp_start = max(0.0, raw_spans[0][0] - 0.02)
        lead_pad_frames = max(0, int(round(0.14 * fr)) - int(round(first_sp_start * fr)))
        pcm_parts = [b"\x00" * (lead_pad_frames * frame_bytes)]
        lead_shift = lead_pad_frames / float(fr)

        cut_frames = [int(round(c["cut_t"] * fr)) for c in cuts]
        for idx in range(1, len(cut_frames)):
            if cut_frames[idx] < cut_frames[idx - 1]:
                cut_frames[idx] = cut_frames[idx - 1]

        prev_frame = 0
        slot_shift = [0.0] * num_slots
        running_pad = lead_shift
        for s_idx in range(num_slots):
            slot_shift[s_idx] = running_pad
            if s_idx < num_slots - 1:
                cf = cut_frames[s_idx]
                pcm_parts.append(pcm[prev_frame * frame_bytes : cf * frame_bytes])
                pad_f = int(round(cuts[s_idx]["pad_sec"] * fr))
                if pad_f > 0:
                    pcm_parts.append(b"\x00" * (pad_f * frame_bytes))
                    running_pad += pad_f / float(fr)
                prev_frame = cf

        pcm_parts.append(pcm[prev_frame * frame_bytes :])
        pcm_parts.append(b"\x00" * (int(round(0.28 * fr)) * frame_bytes))

        with wave.open(str(pad_wav), "wb") as wf_out:
            wf_out.setnchannels(nchannels)
            wf_out.setsampwidth(sampwidth)
            wf_out.setframerate(fr)
            wf_out.writeframes(b"".join(pcm_parts))

        # 保持原生 龙安朗 响度基准（与轨道一 resynth_track1_clean.py 完全对齐）
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(pad_wav),
                "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-b:a", "96k",
                "-map_metadata", "-1", str(tmp_out),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True,
        )
        tmp_out.replace(out_mp3)

    actual_dur = ffprobe_duration(out_mp3)
    clause_to_slot = [0] * n
    for s_idx, (c_lo, c_hi) in enumerate(slot_groups):
        for ci in range(c_lo, c_hi + 1):
            clause_to_slot[ci] = s_idx

    sent_rows = []
    for i in range(n):
        c_meta = clause_metas[i]
        shift = slot_shift[clause_to_slot[i]]
        st_sec = max(0.0, raw_spans[i][0] + shift - 0.006)
        en_sec = max(st_sec + 0.08, raw_spans[i][1] + shift + 0.006)
        if sent_rows and st_sec < sent_rows[-1]["end"] + 0.015:
            mid_edge = (sent_rows[-1]["end"] + st_sec) * 0.5
            if sent_rows[-1]["end"] - sent_rows[-1]["start"] >= 0.08 and en_sec - st_sec >= 0.08:
                sent_rows[-1]["end"] = round(max(sent_rows[-1]["start"] + 0.06, min(sent_rows[-1]["end"], mid_edge - 0.008)), 3)
                sent_rows[-1]["duration"] = round(max(0.0, sent_rows[-1]["end"] - sent_rows[-1]["start"]), 3)
            st_sec = max(st_sec, sent_rows[-1]["end"] + 0.015)
            en_sec = max(st_sec + 0.08, en_sec)
        if actual_dur > 0 and en_sec > actual_dur:
            en_sec = actual_dur
        sent_rows.append({
            "id": c_meta["sent_id"],
            "dom_key": c_meta["sent_id"],
            "text": c_meta["text"],
            "start": round(st_sec, 3),
            "end": round(en_sec, 3),
            "duration": round(max(0.0, en_sec - st_sec), 3),
        })
    return sent_rows


def synthesize_one_item(script_item: dict, target_mp3_rel: str, force: bool = False) -> tuple[bool, str]:
    out_mp3 = ROOT / target_mp3_rel
    out_sent = out_mp3.with_suffix(".sentences.json")
    out_mp3.parent.mkdir(parents=True, exist_ok=True)

    slot_metas = []
    clause_metas = []
    for sl in script_item["slots"]:
        sl_clauses = []
        for c in sl["clauses"]:
            cm = {
                **c,
                "slot_key": sl["slot_key"],
                "part": sl.get("part", ""),
            }
            clause_metas.append(cm)
            sl_clauses.append(cm)
        slot_txt = (sl.get("slot_tts_text") or "".join(c["tts_text"] for c in sl["clauses"])).strip()
        slot_metas.append({
            "slot_key": sl["slot_key"],
            "part": sl.get("part", ""),
            "slot_tts_text": slot_txt,
            "clauses": sl_clauses,
        })

    if not force and out_mp3.exists() and out_sent.exists() and out_mp3.stat().st_size > 20000:
        try:
            existing = json.loads(out_sent.read_text(encoding="utf-8"))
            if len(existing) == len(clause_metas) and all("dom_key" in x for x in existing):
                return True, f"SKIP ({len(existing)} 句已就绪)"
        except Exception:
            pass

    for attempt in range(1, 5):
        try:
            raw_pcm_bytes, raw_spans = synthesize_cosy_track2(slot_metas)
            sent_rows = align_and_pad_cosy_track2(raw_pcm_bytes, raw_spans, clause_metas, out_mp3)
            out_sent.write_text(json.dumps(sent_rows, ensure_ascii=False, indent=2), encoding="utf-8")
            last_end = sent_rows[-1]["end"] if sent_rows else 0
            actual_dur = ffprobe_duration(out_mp3)
            min_gap = min(
                ((sent_rows[k + 1]["start"] - sent_rows[k]["end"]) * 1000.0 for k in range(len(sent_rows) - 1)),
                default=999.0,
            )
            return True, (
                f"OK ({len(sent_rows)} 句, 句末={last_end:.1f}s, ffprobe={actual_dur:.1f}s, "
                f"min_gap={min_gap:.0f}ms, {out_mp3.stat().st_size/1024:.0f}KB)"
            )
        except Exception as exc:
            if attempt == 4:
                return False, f"FAIL: {exc}"
            time.sleep(2 * attempt)
    return False, "FAIL"


def get_micro_rel_path(manifest_item: dict) -> str:
    t1_audio = (manifest_item.get("track1") or {}).get("audio", "")
    if t1_audio.endswith("_exam.mp3"):
        return t1_audio[:-9] + "_micro.mp3"
    base, _ = os.path.splitext(t1_audio)
    return base + "_micro.mp3"


def apply_to_manifests(scripts_by_id: dict):
    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))

    updated = 0
    for items in (m706, m807):
        for it in items:
            micro_rel = get_micro_rel_path(it)
            sent_rel = micro_rel.replace(".mp3", ".sentences.json")
            if (ROOT / micro_rel).exists() and (ROOT / sent_rel).exists():
                sc = scripts_by_id.get(it["id"])
                it["track2"]["audio"] = micro_rel
                it["track2"]["sentences_file"] = sent_rel
                it["track2"]["has_audio"] = True
                it["track2"]["dedicated_voice"] = True
                it["track2"]["char_count"] = sc["tts_chars"] if sc else it["track2"].get("char_count", 0)
                if sc:
                    it["track2"]["micro_slots"] = [
                        {
                            "slot_key": sl["slot_key"],
                            "part": sl["part"],
                            "clauses": [
                                {"sent_id": c["sent_id"], "text": c["text"], "html": c["html"]}
                                for c in sl["clauses"]
                            ],
                        }
                        for sl in sc["slots"]
                    ]
                updated += 1

    MANIFEST_706.write_text(json.dumps(m706, ensure_ascii=False, indent=2), encoding="utf-8")
    MANIFEST_807.write_text(json.dumps(m807, ensure_ascii=False, indent=2), encoding="utf-8")

    from build_kaoyan_bundle import sync_all_manifests_and_bundle
    sync_all_manifests_and_bundle(sync_t1_html=False)
    print(f"Manifests updated: {updated}/82 items linked to *_micro.mp3 & *_micro.sentences.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--ids", type=str, default="")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--apply-manifests", action="store_true")
    args = parser.parse_args()

    scripts = json.loads(SCRIPTS_PATH.read_text(encoding="utf-8"))
    scripts_by_id = {s["id"]: s for s in scripts}
    m706 = json.loads(MANIFEST_706.read_text(encoding="utf-8"))
    m807 = json.loads(MANIFEST_807.read_text(encoding="utf-8"))
    manifest_by_id = {it["id"]: it for it in (m706 + m807)}

    tasks = []
    filter_ids = {x.strip() for x in args.ids.split(",") if x.strip()} if args.ids else None
    for sc in scripts:
        if filter_ids and sc["id"] not in filter_ids:
            continue
        it = manifest_by_id[sc["id"]]
        tasks.append((sc, get_micro_rel_path(it)))
    if args.limit > 0:
        tasks = tasks[:args.limit]

    print(f"Starting Track 2 Aliyun CosyVoice ({VOICE_NAME}, 44.1kHz 96kbps) synthesis: {len(tasks)} items, workers={args.workers}")
    ok_cnt = 0
    fail_list = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        fut_map = {ex.submit(synthesize_one_item, sc, rel, args.force): (sc, rel) for sc, rel in tasks}
        for idx, fut in enumerate(concurrent.futures.as_completed(fut_map), 1):
            sc, rel = fut_map[fut]
            try:
                ok, msg = fut.result()
            except Exception as exc:
                ok, msg = False, str(exc)
            tag = "OK" if ok else "FAIL"
            print(f"[{idx:02d}/{len(tasks):02d}] {tag} {sc['id'][:34]} -> {msg}", flush=True)
            if ok:
                ok_cnt += 1
            else:
                fail_list.append((sc["id"], msg))

    print(f"\nFinished: {ok_cnt}/{len(tasks)} succeeded.")
    if fail_list:
        print("Failures:")
        for fid, fmsg in fail_list:
            print(f" - {fid}: {fmsg}")

    if args.apply_manifests:
        apply_to_manifests(scripts_by_id)


if __name__ == "__main__":
    main()

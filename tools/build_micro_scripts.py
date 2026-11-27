#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_micro_scripts.py
从 706 (42篇) 与 807 (40篇) 的 relay_micro 生成与 PDF 微缩版严格对齐的口播脚本与 1:1 dom_key 句表，
并输出统计摘要与抽检报告。
"""

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from tts_prosody import insert_prosody_commas_for_tts

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(r"D:\AI_file\706_807专业课背诵手卷")
OUT_JSON = ROOT / "data" / "micro_spoken_scripts.json"
OUT_PREVIEW_MD = ROOT / "docs" / "micro_spoken_scripts_preview.md"

CN_NUMS = [
    "零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
]


def to_cn_num(n: int) -> str:
    if 0 <= n < len(CN_NUMS):
        return CN_NUMS[n]
    return str(n)


def strip_html(html_str: str) -> str:
    txt = re.sub(r"<[^>]+>", "", html_str or "")
    return re.sub(r"\s+", " ", txt).strip()


def _has_open_delimiter(s: str) -> bool:
    """判断当前片段是否存在尚未闭合的中文引号、括号或书名号。"""
    if s.count("“") > s.count("”"):
        return True
    if s.count("‘") > s.count("’"):
        return True
    if s.count("（") > s.count("）"):
        return True
    if s.count("(") > s.count(")"):
        return True
    if s.count("《") > s.count("》"):
        return True
    if s.count("〈") > s.count("〉"):
        return True
    if s.count("【") > s.count("】"):
        return True
    return False


def _plain_char_len(s: str) -> int:
    return len(re.sub(r"[\s，。！？；：、“”‘’（）《》〈〉【】·—…,.!?;:()\-→]+", "", s or ""))


def _split_top_level_units(text: str, break_chars: set[str], also_before_arrow: bool = False) -> list[str]:
    """仅在引号/括号/书名号完全闭合的顶层位置按断句符切分，绝不拦腰截断引文或书名。"""
    units: list[str] = []
    buf: list[str] = []
    dq = 0
    sq = 0
    paren = 0
    book = 0
    ang = 0
    brk = 0

    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        if ch == "“":
            dq += 1
        elif ch == "”":
            dq = max(0, dq - 1)
        elif ch == "‘":
            sq += 1
        elif ch == "’":
            sq = max(0, sq - 1)
        elif ch in ("（", "("):
            paren += 1
        elif ch in ("）", ")"):
            paren = max(0, paren - 1)
        elif ch == "《":
            book += 1
        elif ch == "》":
            book = max(0, book - 1)
        elif ch == "〈":
            ang += 1
        elif ch == "〉":
            ang = max(0, ang - 1)
        elif ch == "【":
            brk += 1
        elif ch == "】":
            brk = max(0, brk - 1)

        in_nested = (dq > 0 or sq > 0 or paren > 0 or book > 0 or ang > 0 or brk > 0)

        if also_before_arrow and not in_nested and ch == "→" and buf:
            seg = "".join(buf)
            if _plain_char_len(seg) >= 8:
                units.append(seg)
                buf = [ch]
                i += 1
                continue

        buf.append(ch)

        if not in_nested and ch in break_chars:
            # 吸收紧随其后的连续同类标点以及右引号/右括号
            while i + 1 < n and text[i + 1] in ("。", "！", "？", "；", ";", "，", ",", "：", ":", "”", "’", "）", ")", "》", "〉", "】"):
                i += 1
                nxt = text[i]
                if nxt == "”":
                    dq = max(0, dq - 1)
                elif nxt == "’":
                    sq = max(0, sq - 1)
                elif nxt in ("）", ")"):
                    paren = max(0, paren - 1)
                elif nxt == "》":
                    book = max(0, book - 1)
                elif nxt == "〉":
                    ang = max(0, ang - 1)
                elif nxt == "】":
                    brk = max(0, brk - 1)
                buf.append(nxt)
            seg = "".join(buf)
            # 避免“《书名》：”或短导语在冒号处孤立切出
            if ch in ("：", ":") and (seg.rstrip().endswith(("》：", "》:", "”：", "”:", "）：", "):")) or _plain_char_len(seg) <= 16):
                i += 1
                continue
            units.append(seg)
            buf = []
        i += 1

    if buf:
        units.append("".join(buf))
    return [u for u in units if u.strip()]


def split_plain_to_clauses(text: str, max_len: int = 44) -> list[str]:
    """按句号/分号/平衡逗号顶层切分 UI 高亮子句，绝不切断引号、括号、书名号或对偶语义单元。"""
    text = re.sub(r"[ \t\r\n]+", " ", text).strip()
    if not text:
        return []

    clauses: list[str] = []
    # 1. 顶层句末标点切分（。！？）
    sents = _split_top_level_units(text, {"。", "！", "？"})

    for sent in sents:
        if len(sent) <= max_len + 8:
            clauses.append(sent)
            continue

        # 2. 顶层分号切分（；;），并将过短的相邻分号段自然归并
        raw_semi = _split_top_level_units(sent, {"；", ";"})
        semi_parts: list[str] = []
        for seg in raw_semi:
            if semi_parts and (_plain_char_len(semi_parts[-1]) < 12 or _plain_char_len(seg) < 12) and len(semi_parts[-1]) + len(seg) <= max_len + 10:
                semi_parts[-1] += seg
            else:
                semi_parts.append(seg)

        for sub in semi_parts:
            if len(sub) <= max_len + 6:
                clauses.append(sub)
                continue

            # 3. 顶层逗号/冒号切分，优先在中心附近语义断点平衡切分（不在 → 前强砍）
            pieces = _split_top_level_units(sub, {"，", ",", "：", ":"}, also_before_arrow=False)
            if len(pieces) <= 1:
                pieces = _split_top_level_units(sub, {"，", ",", "：", ":"}, also_before_arrow=True)

            # 若整段仅有 2~3 个片段且总长接近，寻找最平衡、不留 <=10 字碎尾的切点
            total_sub_len = len(sub)
            buf = ""
            for p_idx, piece in enumerate(pieces):
                if not piece.strip():
                    continue
                rem_len = sum(len(x) for x in pieces[p_idx:])
                cur_is_short = _plain_char_len(buf) < 12
                rem_would_dangle = rem_len <= 12
                can_fit = (len(buf) + len(piece) <= max_len) or rem_would_dangle
                # 对较长句在接近半长且有 >=14 字前缀时才断开，避免 AB,CDE 被拆成 A,BCDE 或 ABC,DE
                if buf and (_has_open_delimiter(buf) or cur_is_short or can_fit):
                    if (
                        not _has_open_delimiter(buf)
                        and not cur_is_short
                        and rem_len >= 14
                        and len(buf) >= max(16, int(total_sub_len * 0.42))
                        and len(buf) + len(piece) > max_len
                    ):
                        clauses.append(buf)
                        buf = piece
                    elif (
                        not _has_open_delimiter(buf)
                        and not cur_is_short
                        and len(buf) + len(piece) > max_len + 8
                        and rem_len >= 13
                    ):
                        clauses.append(buf)
                        buf = piece
                    else:
                        buf += piece
                else:
                    if buf:
                        clauses.append(buf)
                    buf = piece
            if buf:
                clauses.append(buf)

    # 4. 合并孤立标点或过短残片（<= 10 个有效汉字，绝不在句尾留下孤立短尾）
    merged: list[str] = []
    for c in clauses:
        c_strip = c.strip()
        if not c_strip:
            continue
        is_lone_title = bool(re.fullmatch(r"《[^》]+》[：:，,。！？；;、]*", c_strip))
        if merged and (
            _has_open_delimiter(merged[-1])
            or c_strip[0] in ("”", "’", "）", ")", "》", "〉", "】", "，", "。", "；", "：", "→")
            or is_lone_title
            or _plain_char_len(c_strip) <= 10
        ):
            merged[-1] += c
        else:
            merged.append(c)

    if len(merged) >= 2 and (_plain_char_len(merged[0]) <= 8 or re.fullmatch(r"《[^》]+》[：:，,。！？；;、]*", merged[0].strip())):
        merged[1] = merged[0] + merged[1]
        merged.pop(0)
    return merged


class TagCharMapper(HTMLParser):
    """将带 <strong class="kw-red"> 等标签的 HTML 按纯文本切分点无损切为多段合法 HTML。"""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.tokens: list[tuple[str, str]] = []  # ("tag"|"text", content)

    def handle_starttag(self, tag, attrs):
        attr_str = "".join(f' {k}="{v}"' for k, v in attrs)
        self.tokens.append(("tag_open", f"<{tag}{attr_str}>", tag))

    def handle_endtag(self, tag):
        self.tokens.append(("tag_close", f"</{tag}>", tag))

    def handle_data(self, data):
        for ch in data:
            self.tokens.append(("char", ch, ""))

    def handle_entityref(self, name):
        self.tokens.append(("char", f"&{name};", ""))

    def handle_charref(self, name):
        self.tokens.append(("char", f"&#{name};", ""))


def split_html_by_plain_clauses(html_str: str, plain_clauses: list[str]) -> list[str]:
    """根据纯文本子句长度将原始 HTML 切分为等长的安全 HTML 片段，保留内部 <strong> 等标签。"""
    if not html_str or len(plain_clauses) <= 1:
        return [html_str] if html_str else []

    parser = TagCharMapper()
    parser.feed(html_str)
    parser.close()

    # 归一化空白后，逐字符对应 plain_clauses
    target_lengths = [len(re.sub(r"\s+", "", c)) for c in plain_clauses]
    # 建立 (plain_char_index) 到 token 切分的流
    chunks: list[str] = []
    open_stack: list[tuple[str, str]] = []  # [(tag, open_html)]
    cur_buf: list[str] = []
    cur_chars = 0
    clause_idx = 0

    def flush_chunk():
        nonlocal cur_buf, cur_chars, clause_idx
        closing = "".join(f"</{t}>" for t, _ in reversed(open_stack))
        chunks.append("".join(cur_buf) + closing)
        reopen = "".join(oh for _, oh in open_stack)
        cur_buf = [reopen] if reopen else []
        cur_chars = 0
        clause_idx += 1

    for kind, content, tag in parser.tokens:
        if kind == "tag_open":
            open_stack.append((tag, content))
            cur_buf.append(content)
        elif kind == "tag_close":
            cur_buf.append(content)
            for idx in range(len(open_stack) - 1, -1, -1):
                if open_stack[idx][0] == tag:
                    open_stack.pop(idx)
                    break
        else:
            if content.isspace():
                if cur_chars > 0:
                    cur_buf.append(content)
                continue
            cur_buf.append(content)
            cur_chars += 1
            if clause_idx < len(target_lengths) - 1 and cur_chars >= target_lengths[clause_idx]:
                flush_chunk()

    if cur_buf or clause_idx < len(target_lengths):
        closing = "".join(f"</{t}>" for t, _ in reversed(open_stack))
        chunks.append("".join(cur_buf) + closing)

    # 清理空的成对标签如 <strong class="kw-red"></strong>
    cleaned = [re.sub(r"<strong[^>]*>\s*</strong>", "", c).strip() for c in chunks]
    return [c for c in cleaned if c]


def _replace_outside_books(text: str, repl_fn) -> str:
    """仅对《...》《...》/〈...〉之外的文本执行替换，保护书名号内部结构不被破坏。"""
    parts = re.split(r"(《[^》]+》|〈[^〉]+〉)", text)
    out = []
    for idx, part in enumerate(parts):
        if idx % 2 == 1:
            out.append(part)
        else:
            out.append(repl_fn(part))
    return "".join(out)


def _format_arrow_outside(seg: str) -> str:
    """将逻辑箭头 → 转为自然口播衔接（保留连贯语流，不强断成句号）。"""
    # →① →② 类编号步骤
    seg = re.sub(r"\s*→\s*(?=[①②③④⑤⑥⑦⑧⑨⑩])", "；", seg)
    # 若是“甲→乙→丙→丁”连续短术语链：2项读作“甲到乙”，3+项读作“甲、乙到丙”更自然
    def _chain_cb(m):
        parts = [p.strip() for p in m.group(0).split("→") if p.strip()]
        if parts and all(len(p) <= 6 for p in parts):
            if len(parts) >= 3:
                return "、".join(parts[:-1]) + "到" + parts[-1]
            return "到".join(parts)
        out = []
        for idx, p in enumerate(parts):
            if idx == 0:
                out.append(p)
            elif len(parts[idx - 1]) <= 5 and len(p) <= 6:
                out.append("到" + p)
            else:
                out.append("，再到" + p)
        return "".join(out)

    seg = re.sub(r"(?:[^，。；：！？→\s（()）“”]{1,16}(?:\s*→\s*[^，。；：！？→\s（()）“”]{1,16})+)", _chain_cb, seg)
    seg = re.sub(r"\s*→\s*", "，再到", seg)
    return seg


def _convert_small_classifiers(s: str) -> str:
    cn_map = {"1": "一", "2": "两", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九"}
    return re.sub(
        r"(?<![0-9])([1-9])(?=[核幕诗派传维例则家讽首词组篇场脉大步段事人项角站名重])",
        lambda m: cn_map[m.group(1)],
        s,
    )


def normalize_for_tts(text: str, is_slot_end: bool = True) -> str:
    """将书面微缩文本清洗为保留原标点韵律的自然 Edge TTS (zh-CN-YunyangNeural) 口播文本。"""
    t = strip_html(text)
    t = t.replace("；；", "；")
    if not t:
        return "。" if is_slot_end else ""

    # 年代与考试年份简称还原（绝不把 20–40s 误读为“秒”）
    t = re.sub(r"(\d{2})\s*[–\-—]\s*(\d{2})s\b", r"\1至\2年代", t)
    t = re.sub(r"\b(\d{2})s\b", r"\1年代", t)
    t = re.sub(r"([（(])((?:1[5-9]|2[0-9])(?:\s*/\s*(?:1[5-9]|2[0-9]))+)([）)])", r"\1\2年\3", t)
    t = re.sub(r"([（(])(2[0-9])([）)])", r"\1\2年\3", t)

    # 相邻书名号与多字引号之间加轻顿号停顿，防止剥离或粘连；单字引号连用如“风”“骨”保持合一
    t = re.sub(r"》\s*《", "》、《", t)

    def _adj_quote_cb(m):
        q1, q2 = m.group(1), m.group(2)
        if len(q1) <= 1 and len(q2) <= 1:
            return f"“{q1}”“{q2}”"
        return f"“{q1}”、“{q2}”"

    t = re.sub(r"“([^”]+)”\s*“([^”]+)”", _adj_quote_cb, t)
    t = re.sub(r"“([^”]+)”\s*“([^”]+)”", _adj_quote_cb, t)

    # 保护书名号内部结构，仅转换书名号外的间隔号、箭头与斜杠
    def _clean_outer(seg: str) -> str:
        # 一落·二落 / 鲁·沈 等极短对举直连或顿号
        seg = re.sub(r"([一-龥]{1,2})[·•]([一-龥]{1,2})", r"\1\2", seg)
        seg = re.sub(r"\s*[·•]\s*", "，", seg)
        seg = _format_arrow_outside(seg)
        seg = re.sub(r"\s*/\s*", "、", seg)
        return seg

    t = _replace_outside_books(t, _clean_outer)

    # 列表序号与圆圈序号
    t = re.sub(r"(?<![0-9.])([1-9]\d?)\.(?![0-9])", r"\1、", t)
    for sym, word in [
        ("①", "第一，"), ("②", "第二，"), ("③", "第三，"), ("④", "第四，"), ("⑤", "第五，"),
        ("⑥", "第六，"), ("⑦", "第七，"), ("⑧", "第八，"), ("⑨", "第九，"), ("⑩", "第十，"),
    ]:
        t = t.replace(sym, word)

    t = re.sub(r"\s*=\s*", "，即", t)
    t = re.sub(r"(\d+)\s*\+\s*(\d+)", r"\1加\2", t)
    t = re.sub(r"\s*[+&]\s*", "与", t)
    t = re.sub(r"\s*vs\.?\s*", "对比", t, flags=re.IGNORECASE)
    t = re.sub(r"×(\d+)", r"乘\1", t)
    t = t.replace("×", "乘")
    t = re.sub(r"(\d+)\s*[–-]\s*(\d+)", r"\1到\2", t)
    t = re.sub(r"([一-龥])—([一-龥])", r"\1到\2", t)
    t = re.sub(r"——+", "，", t)
    t = t.replace("—", "，").replace("……", "，").replace("…", "，")
    t = re.sub(r"\bO\.K\.?", "OK", t)
    t = _convert_small_classifiers(t)

    # 清除方括号壳，保留圆括号（（））和书名号（《》）及引号（“”）供 Edge TTS 识别停顿与分词边界
    t = re.sub(r"[【】〔〕〈〉]", "", t)
    t = re.sub(r"[，,]{2,}", "，", t)
    t = re.sub(r"([：:；;])\s*([，,、])", r"\1", t)
    t = re.sub(r"([，,、：:；;])\s*([。！？])", r"\2", t)
    t = t.lstrip("，,：:、；; ").rstrip()

    if not t:
        return "。" if is_slot_end else ""

    t = insert_prosody_commas_for_tts(t)

    if not is_slot_end:
        # 非槽尾子句：严禁强改逗号/分号为句号，保持原句语流与气口
        if t[-1] in ("。", "！", "？", "，", "、", "；", "：", "”", "’", "）", "》"):
            return t
        return f"{t}，"

    # 槽尾：以规范终结标点收束（保留句末引号/括号配对后的收束，统一确保有终结符）
    if t.endswith(("。", "！", "？", "。”", "！”", "？”", "。）", "。”", "！’", "？’")):
        return t
    if t[-1] in ("，", ",", "；", ";", "：", ":", "、"):
        t = t[:-1].rstrip("，,；;：:、 ")
    return f"{t}。" if t else "。"


def clean_item_title_for_tts(item: dict, is_noun: bool) -> str:
    raw = strip_html(item.get("title") or "")
    sec_cnt = len((item.get("relay_micro") or {}).get("sections") or [])
    raw = _replace_outside_books(raw, lambda s: re.sub(r"\s*[·•]\s*", "，", s))
    if is_noun and sec_cnt > 0:
        return f"{raw}，共{to_cn_num(sec_cnt)}题。"
    return f"{raw}。"


def clean_step_label_for_tts(lbl: str) -> str:
    t = strip_html(lbl)
    if not t:
        return ""
    t = re.sub(r"(\d{2})\s*[–\-—]\s*(\d{2})s\b", r"\1至\2年代", t)
    t = re.sub(r"\b(\d{2})s\b", r"\1年代", t)
    t = re.sub(r"([一-龥A-Za-z0-9])\s*[–—-]\s*([一-龥A-Za-z0-9])", r"\1到\2", t)
    for sym, word in [
        ("①", "第一，"), ("②", "第二，"), ("③", "第三，"), ("④", "第四，"), ("⑤", "第五，"),
    ]:
        t = t.replace(sym, word)
    t = re.sub(r"[（(]([^）)]+)[）)]", r"，\1", t)
    t = _convert_small_classifiers(t)
    # “定性·两核 / 例证·三篇 / 例证·《理水》”紧凑标签连读，避免中间机械停顿；“一落·二落”用顿号
    t = _replace_outside_books(t, lambda s: re.sub(r"[·•](?=[一二两三四五六七八九十\d]+[核幕诗派传维例则家讽首词组篇场脉大步段事人项角站名重])", "", s))
    t = re.sub(r"^([一-龥]{1,4})[·•](《[^》]+》)", r"\1\2", t)
    t = _replace_outside_books(t, lambda s: re.sub(r"([一-龥]{1,2})[·•]([一-龥]{1,2})", r"\1、\2", s))
    t = _replace_outside_books(t, lambda s: re.sub(r"\s*[·•]\s*", "，", s))
    t = re.sub(r"\s*vs\.?\s*", "对比", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*/\s*", "、", t)
    t = re.sub(r"[，,]{2,}", "，", t).strip("，,：:、；; ")
    return t


def clean_section_title_for_tts(title: str, idx_1based: int, is_noun: bool) -> str:
    t = strip_html(title)
    t = re.sub(r"^\d+\s*[·.、]\s*", "", t).strip()
    if not is_noun:
        # 分论点标题中由顿号连接两个 >=4 字的动宾短语时（如“颠覆古典章法、立白话短篇文体范式”），转轻逗号以保流畅气口
        t = re.sub(r"([一-龥“”《》]{4,})、([一-龥“”《》]{4,})", r"\1，\2", t)
    if is_noun:
        return f"第{to_cn_num(idx_1based)}题，{t}。"
    return f"第{to_cn_num(idx_1based)}点，{t}。"


def make_slot(
    slot_key: str,
    part: str,
    raw_html: str,
    tts_prefix: str = "",
    tts_override: str = None,
    step_label: str = "",
):
    """构造一个带子句切分的口播单元；整槽内部保留原句标点连贯语流，仅在槽尾落句号。"""
    clean_html = (raw_html or "").replace("；；", "；").strip()
    plain_text = strip_html(clean_html)
    plain_clauses = split_plain_to_clauses(plain_text)
    if not plain_clauses:
        return None
    html_clauses = split_html_by_plain_clauses(clean_html, plain_clauses)
    if len(html_clauses) != len(plain_clauses):
        plain_clauses = [plain_text]
        html_clauses = [clean_html]

    clauses = []
    n_clauses = len(plain_clauses)
    for k, (pc, hc) in enumerate(zip(plain_clauses, html_clauses)):
        is_last = (k == n_clauses - 1)
        if tts_override is not None and n_clauses == 1:
            tts_raw = tts_override
        elif k == 0 and tts_prefix:
            tts_raw = f"{tts_prefix}{pc}"
        else:
            tts_raw = pc
        pc_strip = pc.strip()
        pause_kind = "period" if (is_last or pc_strip.endswith(("。", "！", "？", "。”", "！”", "？”", "。）"))) else "comma"
        clauses.append({
            "sent_id": f"{slot_key}_c{k}",
            "text": pc,
            "html": hc,
            "tts_text": normalize_for_tts(tts_raw, is_slot_end=is_last),
            "pause_kind": pause_kind,
        })
    slot_obj = {
        "slot_key": slot_key,
        "part": part,
        "raw_html": clean_html,
        "slot_tts_text": "".join(c["tts_text"] for c in clauses),
        "clauses": clauses,
    }
    if step_label:
        slot_obj["step_label"] = step_label
    return slot_obj


def build_item_script(subj: str, item: dict) -> dict:
    rm = item["relay_micro"]
    is_noun = bool(rm.get("is_noun_collection"))
    slots = []

    # 0. 篇目主标题与作者题名（解决锁屏/盲听时不知当前讲哪位作家或篇目的问题）
    raw_title = (item.get("title") or "").strip()
    if raw_title:
        s_title = make_slot(
            "title",
            "title",
            raw_title,
            tts_override=clean_item_title_for_tts(item, is_noun),
        )
        if s_title:
            slots.append(s_title)

    # 1. 记忆主线 (可选开篇总纲)
    if rm.get("narrative_hook"):
        s = make_slot("hook", "hook", rm["narrative_hook"], tts_prefix="记忆主线：")
        if s:
            slots.append(s)

    # 2. 总起微缩
    if rm.get("intro"):
        s = make_slot("intro", "intro", rm["intro"])
        if s:
            slots.append(s)

    # 3. 主体各段
    for si, sec in enumerate(rm.get("sections", [])):
        sec_title = sec.get("title", "")
        tts_title = clean_section_title_for_tts(sec_title, si + 1, is_noun)
        t_slot = make_slot(
            f"sec{si}_title",
            "noun_title" if is_noun else "section_title",
            sec_title,
            tts_override=tts_title,
        )
        if t_slot:
            slots.append(t_slot)

        if is_noun:
            for col_key, col_prefix in [
                ("s1", "时空界定："),
                ("s2", "核心特质："),
                ("s3", "文学史定位："),
            ]:
                val = sec.get(col_key)
                if val:
                    s = make_slot(f"sec{si}_{col_key}", f"noun_{col_key}", val, tts_prefix=col_prefix)
                    if s:
                        slots.append(s)
        else:
            for st_i, (st_lbl, st_html) in enumerate(sec.get("steps", [])):
                lbl_spoken = clean_step_label_for_tts(st_lbl)
                plain_body = strip_html(st_html)
                prefix = ""
                if lbl_spoken and not plain_body.startswith(lbl_spoken):
                    prefix = f"{lbl_spoken}："
                s = make_slot(
                    f"sec{si}_step{st_i}",
                    "step",
                    st_html,
                    tts_prefix=prefix,
                    step_label=(st_lbl or "").strip(),
                )
                if s:
                    slots.append(s)

    # 4. 结语微缩
    if rm.get("conclusion"):
        s = make_slot("concl", "conclusion", rm["conclusion"])
        if s:
            slots.append(s)

    # 5. 易混防混提示（固定多句首句也保留前缀，不因拆分而丢失提示词）
    if rm.get("guard"):
        g_clean = re.sub(r"^防混[：:]\s*", "", rm["guard"].strip())
        s = make_slot("guard", "guard", g_clean if g_clean else rm["guard"], tts_prefix="防混提示：")
        if s:
            if s["clauses"] and rm["guard"].strip().startswith("防混"):
                s0 = s["clauses"][0]
                if not s0["text"].startswith("防混"):
                    prefix_src = "防混："
                    s0["text"] = prefix_src + s0["text"]
                    s0["html"] = prefix_src + s0["html"]
            slots.append(s)

    # 6. 合书闭眼抽查（多句也保留“闭眼抽查第X问”首句提示）
    for di, d_html in enumerate(rm.get("drills", [])):
        d_clean = re.sub(r"^[①②③④⑤⑥⑦⑧⑨⑩]\s*", "", d_html.strip())
        s = make_slot(
            f"drill{di}",
            "drill",
            d_clean if d_clean else d_html,
            tts_prefix=f"闭眼抽查第{to_cn_num(di + 1)}问，",
        )
        if s:
            if s["clauses"]:
                m_num = re.match(r"^([①②③④⑤⑥⑦⑧⑨⑩]\s*)", d_html.strip())
                if m_num:
                    s0 = s["clauses"][0]
                    if not s0["text"].startswith(m_num.group(1)):
                        s0["text"] = m_num.group(1) + s0["text"]
                        s0["html"] = m_num.group(1) + s0["html"]
            slots.append(s)

    all_clauses = [c for sl in slots for c in sl["clauses"]]
    tts_chars = sum(len(re.sub(r"\s+", "", c["tts_text"])) for c in all_clauses)
    est_sec = round(tts_chars / 4.6, 1)

    return {
        "id": item["id"],
        "subject": subj,
        "title": item["title"],
        "level": item.get("level", ""),
        "is_noun_collection": is_noun,
        "clause_count": len(all_clauses),
        "tts_chars": tts_chars,
        "est_duration_sec": est_sec,
        "slots": slots,
    }


def main():
    all_scripts = []
    for subj, rel in [
        ("706", "data/kaoyan_706_manifest.json"),
        ("807", "data/kaoyan_807_manifest.json"),
    ]:
        items = json.loads((ROOT / rel).read_text(encoding="utf-8"))
        for it in items:
            all_scripts.append(build_item_script(subj, it))

    OUT_JSON.write_text(json.dumps(all_scripts, ensure_ascii=False, indent=2), encoding="utf-8")

    total_clauses = sum(s["clause_count"] for s in all_scripts)
    total_chars = sum(s["tts_chars"] for s in all_scripts)
    total_min = sum(s["est_duration_sec"] for s in all_scripts) / 60.0

    # 生成核对预览文档（含全量统计 + 4类典型样本完整口播展示）
    lines = [
        "# 706 / 807 轨道二微缩口播脚本核对报告\n",
        f"- 覆盖篇目：**{len(all_scripts)} 篇**（706 42 篇 + 807 40 篇）",
        f"- 切分句标总计：**{total_clauses} 句**（平均每篇 {total_clauses / len(all_scripts):.1f} 句）",
        f"- 口播总字数：**{total_chars:,} 字**（预计总音频时长约 **{total_min:.1f} 分钟**，单篇平均约 {total_min * 60 / len(all_scripts):.0f} 秒）\n",
        "## 各篇预估时长与句数总表\n",
        "| # | 科目 | 篇目 | 类型 | 句数 | 字数 | 预估时长 |",
        "| :--- | :--- | :--- | :--- | ---: | ---: | ---: |",
    ]
    for idx, sc in enumerate(all_scripts, 1):
        typ = "名解合辑" if sc["is_noun_collection"] else "论述/简答"
        lines.append(
            f"| {idx:02d} | {sc['subject']} | {sc['title']} | {typ} | {sc['clause_count']} | {sc['tts_chars']} | {sc['est_duration_sec']:.0f}s |"
        )

    sample_ids = [
        "706_01_T0_01_杜甫_沉郁顿挫艺术风格与诗史性质_30分论述",
        "807_01_T0_曹禺_01_雷雨思想意蕴与艺术成就_30分论述",
        "807_00_807核心名词解释_01_现代文学社团思潮与经典概念_5分名解合辑",
    ]
    lines.append("\n## 典型篇目口播脚本抽检\n")
    for sc in all_scripts:
        if sc["id"] in sample_ids:
            lines.append(f"### {sc['subject']} · {sc['title']}（{sc['clause_count']} 句 / 约 {sc['est_duration_sec']:.0f}s）\n")
            seq = 0
            for sl in sc["slots"][:16]:
                for c in sl["clauses"]:
                    seq += 1
                    lines.append(f"{seq:02d}. `{c['sent_id']}` {c['tts_text']}")
            if sc["clause_count"] > seq:
                lines.append(f"\n> ……（共 {sc['clause_count']} 句，此处节选前 {seq} 句；末尾含防混与抽查问）\n")

    OUT_PREVIEW_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_PREVIEW_MD.write_text("\n".join(lines), encoding="utf-8")

    print(f"Saved: {OUT_JSON} ({len(all_scripts)} items, {total_clauses} clauses, {total_chars} chars, ~{total_min:.1f} min)")
    print(f"Preview: {OUT_PREVIEW_MD}")


if __name__ == "__main__":
    main()

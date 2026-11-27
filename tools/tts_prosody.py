#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts_prosody.py
统一服务于 706 / 807 轨道一与轨道二 Edge TTS (zh-CN-YunyangNeural) 的正音与汉语句法韵律加标点引擎。
原则：
1. 仅作用于 TTS 输入文本流，严格保持 _norm_chars（汉字/数字/字母）序列 1:1 等长，绝不改动前端展示文本。
2. 全量文史专有名词与多音词正音（纪传/列传/呼兰河传/阿Q正传/乐府/燕歌行/李劼人/贾平凹/邓幺姑/谌容/唐湜/阿垅等）。
3. 针对 >= 18 字的无标点长句，在不破坏专名、书名、引号与“的”字定语结构的前提下，仅在高置信度句法界（时间状语后、长主语《书名》后、状中短语后、并列/转折/承接谓语前）补充轻量口播逗号，消除 Edge TTS 随机错切语义的断句问题。
"""

import re
import jieba
import jieba.posseg as pseg

# 高频易错词保护，防止 jieba 拆散（如 中和 / 中下层 / 处世 / 声律）
for _w in (
    "中和", "中下层", "中上层", "中后期", "中前期", "中唐", "盛唐", "初唐", "晚唐",
    "晚清", "现代主义", "现实主义", "浪漫主义", "象征主义", "新历史小说", "话本小说",
    "志怪小说", "新乐府", "新感觉派", "山药蛋派", "荷花淀派", "寻根文学", "伤痕文学",
    "反思文学", "改革文学", "朦胧诗", "先锋小说", "京派", "海派", "左翼", "七月派",
    "九叶派", "茶馆", "雷雨", "日出", "原野", "北京人", "狂人日记", "阿Q正传",
    "故事新编", "呐喊", "彷徨", "朝花夕拾", "野草", "子夜", "女神", "凤凰涅槃",
    "边城", "长河", "萧萧", "围城", "倾城之恋", "金锁记", "传奇", "呼兰河传",
    "生死场", "骆驼祥子", "四世同堂", "太阳照在桑干河上", "暴风骤雨", "小二黑结婚",
    "受戒", "大淖记事", "沉沦", "春风沉醉的晚上", "死水", "红烛", "再别康桥",
    "新月派", "现代评论派", "语丝派", "创造社", "文学研究会", "沉郁顿挫", "即事名篇",
    "重章叠句", "赋比兴", "建安风骨", "正始之音", "太康诗风", "玄言诗", "山水田园",
    "边塞诗", "古文运动", "江西诗派", "花间词", "豪放派", "婉约派", "世家列传",
    "纪传体", "编年体", "互见法", "三吏三别", "儒家", "道家", "法家", "禅宗",
    "新文学", "白话小说", "纯文学", "现代文学", "当代文学", "古典诗歌", "诗歌总集",
    "悲愤喷薄", "处世心态", "乌鸦炸酱面", "奇肱国飞车", "古今杂糅", "虚实相生",
):
    jieba.add_word(_w, freq=20000)


# 仅作用于 TTS 语音流的文史专有名词与多音词正音字典（严格保持字数 1:1 等长以便 WordBoundary 精准对齐）
PRONUNCIATION_FIXES = [
    ("世家列传", "世家列撰"),
    ("宁有种乎", "凝有种乎"),
    ("长恨歌传", "长恨歌撰"),
    ("呼兰河传", "呼兰河撰"),
    ("阿Q正传", "阿Q正撰"),
    ("便娟婉约", "骈娟婉约"),
    ("长歌当哭", "长歌荡哭"),
    ("重章叠句", "虫章叠句"),
    ("数见不鲜", "朔见不鲜"),
    ("乐府双璧", "月府双璧"),
    ("纪传体", "纪撰体"),
    ("公羊传", "公羊撰"),
    ("谷梁传", "谷梁撰"),
    ("左氏传", "左氏撰"),
    ("水浒传", "水浒撰"),
    ("莺莺传", "莺莺撰"),
    ("自叙传", "自叙撰"),
    ("汉乐府", "汉月府"),
    ("新乐府", "新月府"),
    ("古乐府", "古月府"),
    ("乐府诗", "月府诗"),
    ("燕歌行", "烟歌行"),
    ("温庭筠", "温庭云"),
    ("自度曲", "自舵曲"),
    ("赋比兴", "赋比性"),
    ("李劼人", "李洁人"),
    ("贾平凹", "贾平洼"),
    ("邓幺姑", "邓腰姑"),
    ("列传", "列撰"),
    ("经传", "经撰"),
    ("左传", "左撰"),
    ("外传", "外撰"),
    ("别传", "别撰"),
    ("内传", "内撰"),
    ("传记", "撰记"),
    ("正传", "正撰"),
    ("小传", "小撰"),
    ("本传", "本撰"),
    ("他传", "他撰"),
    ("史传", "史撰"),
    ("立传", "立撰"),
    ("乐府", "月府"),
    ("礼乐", "礼月"),
    ("雅乐", "雅月"),
    ("行乐", "形乐"),
    ("行卷", "形卷"),
    ("便娟", "骈娟"),
    ("单于", "缠于"),
    ("谢朓", "谢眺"),
    ("鲍照", "暴照"),
    ("庾信", "雨信"),
    ("关陇", "关垄"),
    ("辟易", "避易"),
    ("俶傥", "惕傥"),
    ("伛偻", "雨吕"),
    ("兴寄", "性寄"),
    ("寄兴", "寄性"),
    ("兴象", "性象"),
    ("起兴", "起性"),
    ("拗救", "傲救"),
    ("拗体", "傲体"),
    ("说难", "税难"),
    ("游说", "游税"),
    ("谌容", "慎容"),
    ("唐湜", "唐时"),
    ("阿垅", "阿垄"),
    ("数奇", "树机"),
    ("应制", "映制"),
]


def apply_pronunciation_fixes(text: str) -> str:
    res = text
    for word, fixed in PRONUNCIATION_FIXES:
        res = res.replace(word, fixed)
    return res


def _spoken_len(s: str) -> int:
    return len(re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", s or ""))


# 独立高置信句首时间/背景状语，其后可自然微顿
_TIME_FRONT_RE = re.compile(
    r"^(五四时期|五四以来|新中国成立后|抗战爆发后|抗战时期|抗战相持阶段|"
    r"改革开放后|战国中期|战国时期|汉武帝时期|建安时期|盛唐时期|中唐时期|"
    r"晚唐时期|北宋时期|南宋时期|明清时期|晚清时期|二十年代中期|二十年代初|"
    r"三十年代|四十年代|八十年代初|八十年代中后期|九十年代|长期以来|在此基础上)"
)

# 强粘连禁止在其前断开的词或字（防止“的、了、中、周刊、初、末、期”被切到后句）
_FORBID_RIGHT_START = set("的了着过得地之所等中和与及并上下前后内外间里者们家派体周报刊集序传记初末期")
_FORBID_LEFT_END = set("的了着过得地之所在于从把被将对向为以与和及并最更很已正仍就才都既")

# 允许在长分句内部作为第二谓语/并列连词前导的清晰句法界标（严禁拆散状中修饰“深刻确立”）
_CLAUSE_PIVOTS = (
    "并深入", "并先后", "并以此", "并借", "并把", "并将", "并以", "并对", "并为",
    "从而", "进而", "因此", "因而", "同时", "最终", "共同",
    "树立起", "开拓了", "奠定了", "打破了", "营造出", "表现出", "展现出", "揭示出",
    "写出了", "写出", "写尽", "反映出", "使之", "使其", "令读者",
)


def _split_protected_tokens(seg: str) -> list[tuple[str, bool]]:
    """
    将短语切分为原子片段列表：[(piece_text, is_atomic_protected)]。
    绝不拆开《...》及紧跟其后的“周刊/杂志/报/派/序/传”，也绝不拆开短引号“...”。
    """
    pattern = re.compile(r"(《[^》]+》(?:周刊|杂志|日报|副刊|报|派|集|序|题词)?|“[^”]{1,12}”|（[^）]{1,14}）)")
    parts = pattern.split(seg)
    out = []
    for i, p in enumerate(parts):
        if not p:
            continue
        out.append((p, i % 2 == 1))
    return out


def _find_safe_comma_index(seg: str) -> int | None:
    """
    给定一段 >=18 有效字且不含标点的中文分句 seg，返回最安全的一个句法逗号插入下标；
    若找不到高置信句法断点则返回 None（宁缺毋滥，绝不制造 AB,CDE -> A,BCDE 错断）。
    """
    n = len(seg)
    if _spoken_len(seg) < 18:
        return None

    # 1. 若句首是独立时间状语且后段仍有 >= 9 字，且不紧跟“的/之”与动宾“的”链
    m_time = _TIME_FRONT_RE.match(seg)
    if m_time:
        pos = m_time.end()
        if pos < n and seg[pos] not in _FORBID_RIGHT_START and _spoken_len(seg[pos:]) >= 9:
            return pos

    # 计算不可拆分的原子区间（《...》及其紧跟后缀、短引号、括号）
    locked = [False] * (n + 1)
    cursor = 0
    for txt, is_atom in _split_protected_tokens(seg):
        tlen = len(txt)
        if is_atom:
            for k in range(cursor + 1, cursor + tlen):
                locked[k] = True
        cursor += tlen

    # 2. 若句首是书名号主语且紧随主谓核心动词（且句后非简短定语），先在主谓界处停顿（仅限总长 >= 24）
    if _spoken_len(seg) >= 24:
        m_subj = re.match(r"^(《[^》]+》)", seg)
        if m_subj:
            pos = m_subj.end()
            if pos < n and seg[pos] in "是写" and _spoken_len(seg[pos:]) >= 13 and not locked[pos]:
                return pos

    # 3. 检查明确句法枢纽词（避免拆词与粘连字，以及“把…为…”误拆）
    mid = n // 2
    candidates: list[tuple[int, int]] = []  # (score, pos)

    for piv in _CLAUSE_PIVOTS:
        for m in re.finditer(re.escape(piv), seg):
            pos = m.start()
            if locked[pos] or pos <= 5 or pos >= n - 6:
                continue
            l_sp = _spoken_len(seg[:pos])
            r_sp = _spoken_len(seg[pos:])
            if l_sp < 7 or r_sp < 6:
                continue
            if seg[pos - 1] in _FORBID_LEFT_END or seg[pos] in _FORBID_RIGHT_START:
                continue
            # 防止把“的/之”前面的动词短语拆开
            if piv in ("写出", "写出了", "写尽") and pos >= 2 and seg[pos - 1] not in ("中", "后", "间", "情", "景", "法", "笔", "下", "上", "线", "势", "调", "路", "史", "体", "格"):
                # 若前面紧跟“以…情怀/以…笔法/用…”，允许在介宾状语后停顿
                if not re.search(r"(情怀|笔法|手法|视角|语言|形式|姿态|白描|细节|反讽|对照|意象)$", seg[:pos]):
                    continue
            dist_penalty = abs(pos - mid)
            candidates.append((100 - dist_penalty, pos))

    # 4. 使用 jieba 词性识别高置信状语/介宾后边界（绝不拆“改写为”“寄托对…的”“的”前短定语）
    if _spoken_len(seg) >= 20:
        words = list(pseg.cut(seg))
        pos = 0
        for wi, w in enumerate(words):
            w_end = pos + len(w.word)
            if wi + 1 < len(words):
                nxt = words[wi + 1]
                if not locked[w_end] and 7 <= _spoken_len(seg[:w_end]) and 7 <= _spoken_len(seg[w_end:]):
                    left_ch = seg[w_end - 1]
                    right_ch = seg[w_end]
                    if left_ch not in _FORBID_LEFT_END and right_ch not in _FORBID_RIGHT_START:
                        # 仅当在清晰名词性状语/时代短语结尾，且前后均为完整结构（非动词+了紧跟或定中“新时期当代”）时才切
                        is_ctx_end = (
                            w.word.endswith(("年代", "阶段", "基础上", "背景下", "语境下", "诗歌史上", "文学史上", "小说史上", "词史上"))
                            or (w.word in ("史上", "过程中", "格局下", "视野下"))
                        )
                        # 纯主语/宾语前置后的“把/将/共同/分别”谓语边界（要求左词为纯名词，非动词，杜绝“改写，为…”）
                        is_clean_subj_vp = (
                            w.flag in ("n", "nz", "nr", "ns")
                            and not w.word.endswith(("的", "之"))
                            and nxt.word in ("把", "将", "共同", "分别", "率先", "逐步", "始终", "进而")
                        )
                        if is_ctx_end or is_clean_subj_vp:
                            dist_penalty = abs(w_end - mid)
                            bonus = 92 if is_ctx_end else 84
                            candidates.append((bonus - dist_penalty, w_end))
            pos = w_end

    if not candidates:
        return None
    candidates.sort(key=lambda x: (-x[0], abs(x[1] - mid)))
    return candidates[0][1]


def insert_prosody_commas_for_tts(tts_text: str) -> str:
    """
    在不改变任何有效文字（汉字/数字/字母）序列的前提下，
    对不含标点且 >= 18 字的长分句补充 1 处（极长 >= 34 字最多 2 处）高置信句法轻逗号，
    引导 Edge TTS 严格沿语法边界换气而不强断专名或偏正短语。
    """
    if not tts_text:
        return tts_text

    # 切分已有标点（包含引号与括号边界，不在内部乱插）
    parts = re.split(r"([，。；：！？、（）()《》“”‘’\n])", tts_text)
    out = []
    in_dq = False
    in_book = False
    in_par = False

    for part in parts:
        if not part:
            continue
        if part in ("“", "”", "《", "》", "（", "）", "(", ")", "，", "。", "；", "：", "！", "？", "、", "\n", "‘", "’"):
            if part == "“":
                in_dq = True
            elif part == "”":
                in_dq = False
            elif part == "《":
                in_book = True
            elif part == "》":
                in_book = False
            elif part in ("（", "("):
                in_par = True
            elif part in ("）", ")"):
                in_par = False
            out.append(part)
            continue

        # 引号/书名号/括号内部绝不插逗号
        if in_dq or in_book or in_par or _spoken_len(part) < 18:
            out.append(part)
            continue

        # 对顶级无标点片段最多插入 1~2 处逗号
        cur = part
        for _ in range(2):
            segs = cur.split("，")
            changed = False
            new_segs = []
            for sg in segs:
                if _spoken_len(sg) >= 18:
                    pos = _find_safe_comma_index(sg)
                    if pos is not None and 5 <= pos <= len(sg) - 5:
                        new_segs.append(sg[:pos] + "，" + sg[pos:])
                        changed = True
                        continue
                new_segs.append(sg)
            cur = "，".join(new_segs)
            if not changed:
                break
        out.append(cur)

    return "".join(out)

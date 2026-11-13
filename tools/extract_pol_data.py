# -*- coding: utf-8 -*-
"""
extract_pol_data.py
V3.0.3 终极整合规范：考研政治数据无损提取器
输出路径: D:\AI_file\706_807专业课背诵手卷\data\kaoyan_data_pol.js
"""

import os
import sys
import re
import json
import subprocess
from bs4 import BeautifulSoup

sys.stdout.reconfigure(encoding='utf-8')

HANDBOOK_HTML = r"D:\AI_file\背诵手册\handbook\index.html"
ANLANG_DIR = r"D:\AI_file\背诵手册\handbook\audio_xutao"
OUTPUT_JS = r"D:\AI_file\706_807专业课背诵手卷\data\kaoyan_data_pol.js"

STAR_SVG = '<svg class="ui-svg xs" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'

CAT_MAP = {
    "my": "马克思主义基本原理",
    "mzt": "毛泽东思想和中国特色社会主义理论体系概论",
    "xsx": "习近平新时代中国特色社会主义思想概论",
    "sg": "中国近现代史纲要",
    "sx": "思想道德与法治"
}

def get_audio_duration(file_path):
    if not os.path.exists(file_path):
        return 0.0
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file_path
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return float(res.stdout.strip())
    except Exception:
        return 0.0

def normalize_pane_html(soup_el, soup):
    """
    移除所有 .doubt-panel 元素；
    规范化 <table>（添加 .xt-table 类，缺少外层包裹时补全 <div class="xt-table-wrap">，剥离 th/td 硬编码背景色）；
    剥离 inline onclick 属性（如 seekChapterReciteSentence, seekReciteSentence, togglePlayCardAudio）。
    """
    if soup_el is None:
        return ""
    # 剥离所有就地标疑面板
    for dp in soup_el.find_all(class_=re.compile(r'doubt-panel')):
        dp.decompose()

    # 表格规范化与包裹
    for table in soup_el.find_all("table"):
        classes = table.get("class") or []
        if isinstance(classes, str):
            classes = [classes]
        if "xt-table" not in classes:
            classes.append("xt-table")
            table["class"] = classes

        parent = table.parent
        parent_classes = parent.get("class", []) if parent else []
        if isinstance(parent_classes, str):
            parent_classes = [parent_classes]
        if "xt-table-wrap" not in parent_classes:
            wrap = soup.new_tag("div", attrs={"class": "xt-table-wrap"})
            table.wrap(wrap)

        for cell in table.find_all(["th", "td"]):
            style = cell.get("style", "")
            if style:
                # 剥离硬编码背景色（如 #e0f7fa 等），保障深色模式自适应
                new_style = re.sub(r'background-color:\s*#[a-fA-F0-9]{3,8}\s*;?', '', style, flags=re.I).strip()
                if new_style:
                    cell["style"] = new_style
                else:
                    del cell["style"]

    # 剥离 inline onclick 冲突属性
    for el in soup_el.find_all(True):
        onclick = el.get("onclick", "")
        if onclick and any(fn in onclick for fn in ["seekChapterReciteSentence", "seekReciteSentence", "togglePlayCardAudio"]):
            del el["onclick"]

    html_str = str(soup_el)
    # 替换 ★ 字符为 100% 纯矢量 SVG 星标
    if "★" in html_str:
        html_str = html_str.replace("★", STAR_SVG)
    return html_str

def main():
    print(f"Reading {HANDBOOK_HTML} ...")
    with open(HANDBOOK_HTML, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. 解析 Script 中的原生 JSON 结构
    print("Parsing JS constants from script tags...")
    m_recite = re.search(r'const CHAPTER_RECITE_SENTENCES\s*=\s*({[\s\S]*?});\s*(?:const|let|var|function)', content)
    CHAPTER_RECITE_SENTENCES = json.loads(m_recite.group(1)) if m_recite else {}

    m_card = re.search(r'const CARD_SENTENCES\s*=\s*({[\s\S]*?});\s*(?:const|let|var|function)', content)
    CARD_SENTENCES = json.loads(m_card.group(1)) if m_card else {}

    m_xt = re.search(r'const xtAllDaysData\s*=\s*(\[[\s\S]*?\]);\s*(?:const|let|var|function)', content)
    xtAllDaysData = json.loads(m_xt.group(1)) if m_xt else []

    m_tj = re.search(r'const tjAllDaysData\s*=\s*(\[[\s\S]*?\]);\s*(?:const|let|var|function)', content)
    tjAllDaysData = json.loads(m_tj.group(1)) if m_tj else []

    print(f"Loaded: RECITE_SENTENCES keys={len(CHAPTER_RECITE_SENTENCES)}, CARD_SENTENCES keys={len(CARD_SENTENCES)}, xtDays={len(xtAllDaysData)}, tjDays={len(tjAllDaysData)}")

    # 2. BeautifulSoup 解析 47 章 DOM
    print("Parsing chapters HTML with BeautifulSoup...")
    soup = BeautifulSoup(content, "html.parser")
    articles = soup.find_all("article", class_="chapter-page")
    print(f"Found {len(articles)} chapter-page articles.")

    chapters47 = []
    total_subcards = 0

    for idx, art in enumerate(articles):
        ch_id = art.get("id")
        parts = ch_id.split("_")
        cat = parts[1] if len(parts) > 1 else "my"
        cat_name = CAT_MAP.get(cat, "马克思主义基本原理")
        ch_num = art.get("data-chapter-num", f"第{idx+1}章")
        ch_title = art.get("data-chapter-title", "")
        
        chap_tag = art.find("span", class_="book-page-chap-tag")
        tag_text = chap_tag.get_text(strip=True) if chap_tag else ""

        # 剥离 article 内部所有 .doubt-panel
        for dp in art.find_all(class_=re.compile(r'doubt-panel')):
            dp.decompose()

        # 轨道一：背诵部分 + 理解部分
        recite_box = art.find("div", class_="xt-part-recite")
        understand_box = art.find("div", class_="xt-part-understand")

        raw_recite_sentences = CHAPTER_RECITE_SENTENCES.get(ch_id, [])
        processed_recite_sentences = []

        # 检查并补全/前置 recite-part-badge 至 recite_box 顶端
        badge_sent = None
        for s in raw_recite_sentences:
            if s.get("domId", "").startswith("recite_badge_"):
                badge_sent = s
                break

        if badge_sent and recite_box:
            badge_el = recite_box.find(class_=lambda c: c and ('xt-part-badge' in c or 'recite-part-badge' in c))
            if not badge_el:
                badge_el_art = art.find(class_=lambda c: c and ('xt-part-badge' in c or 'recite-part-badge' in c))
                if badge_el_art:
                    badge_row = badge_el_art.find_parent(class_='xt-part-badge-row')
                    if badge_row:
                        recite_box.insert(0, badge_row)
                    else:
                        new_row = soup.new_tag('div', attrs={'class': 'xt-part-badge-row'})
                        new_row.append(badge_el_art)
                        recite_box.insert(0, new_row)

        # 清除模板中的历史旧戳印，杜绝残留属性污染
        for el in art.find_all(True):
            if 'data-sent-idx' in el.attrs:
                del el['data-sent-idx']
            if 'data-sent-id' in el.attrs:
                del el['data-sent-id']
            if 'data-start' in el.attrs:
                del el['data-start']
            if 'data-end' in el.attrs:
                del el['data-end']
            classes = el.get('class', [])
            if isinstance(classes, list) and 'recite-sent-item' in classes:
                classes.remove('recite-sent-item')
                if classes:
                    el['class'] = classes
                else:
                    del el['class']

        boxes = [b for b in [recite_box, understand_box] if b]

        # 预处理：在 td, th, p 中若存在 <br/> 分隔的多句，将其包裹为 span.xt-subline 以便精准高光和独立点读
        for b in boxes:
            for cell in b.find_all(["td", "th", "p"]):
                if cell.find("br") and not cell.find("table"):
                    new_contents = []
                    cur_span = None
                    for child in list(cell.contents):
                        if getattr(child, "name", None) == "br":
                            cur_span = None
                            new_contents.append(child)
                        else:
                            txt = child.get_text() if hasattr(child, "get_text") else str(child)
                            if not txt.strip():
                                continue
                            if cur_span is None:
                                cur_span = soup.new_tag("span", attrs={"class": "xt-subline"})
                                new_contents.append(cur_span)
                            cur_span.append(child)
                    cell.clear()
                    for nc in new_contents:
                        cell.append(nc)

        claimed = set()

        # 为 Track 1 的每一句进行 DOM 锚点精准匹配与戳印
        for s_idx, s in enumerate(raw_recite_sentences):
            did = s.get("domId", "")
            start = float(s.get("start", 0.0))
            end = float(s.get("end", 0.0))
            stext = s.get("text", "")
            sent_id = f"sent_{ch_id}_{s_idx:03d}"

            s_copy = dict(s)
            s_copy["idx"] = s_idx
            s_copy["id"] = sent_id
            s_copy["domId"] = sent_id
            s_copy["origDomId"] = did
            s_copy["start"] = round(start, 3)
            s_copy["end"] = round(end, 3)
            processed_recite_sentences.append(s_copy)

            clean_s = re.sub(r'[\s,，.。:：()（）/、:—\-$+*★✦➔\d一二三四五六七八九十①②③④⑤⑥⑦⑧⑨⑩]+', '', stext)
            target_el = None

            # 0: 标题锚点
            if s_idx == 0:
                target_el = art.find("span", class_="recite-bar-title") or art.find(class_="recite-bar-title")
            # 1: 音频栏徽章锚点
            elif s_idx == 1:
                target_el = art.find("span", class_="recite-bar-badge") or art.find(class_="recite-audio-bar")
            # 2: 导引标签锚点
            elif s_idx == 2 or (did and did.startswith("recite_badge_")):
                target_el = art.find(class_=lambda c: c and ("xt-part-badge" in c or "recite-part-badge" in c))

            # 3. 按原始 did 直接匹配未认领节点
            if not target_el and did:
                for b in boxes:
                    cand = b.find(id=did)
                    if cand and id(cand) not in claimed:
                        target_el = cand
                        break

            # 4. 相邻兄弟节点认领（应对 did 重复覆盖的连续序号行）
            if not target_el and did:
                for b in boxes:
                    cand = b.find(id=did)
                    if cand:
                        nxt = cand.find_next_sibling()
                        while nxt:
                            if id(nxt) not in claimed and nxt.name in ["div", "p", "h4", "tr", "li", "strong", "table", "span"]:
                                if nxt.name == "table" or nxt.find("table"):
                                    tbl = nxt if nxt.name == "table" else nxt.find("table")
                                    for r in tbl.find_all("tr"):
                                        if id(r) not in claimed:
                                            target_el = r
                                            break
                                    if target_el: break
                                else:
                                    target_el = nxt
                                    break
                            nxt = nxt.find_next_sibling()
                        if target_el: break

            # 5. 全局未认领元素文本相似度匹配
            if not target_el and clean_s:
                best_cand = None
                best_score = 0
                for b in boxes:
                    for cand in b.find_all(["div", "p", "h4", "tr", "li", "strong", "td", "th", "span"]):
                        if id(cand) in claimed: continue
                        if cand.find(["p", "div", "tr", "h4", "table", "td", "th"]): continue
                        ctext = re.sub(r'[\s,，.。:：()（）/、:—\-$+*★✦➔\d一二三四五六七八九十①②③④⑤⑥⑦⑧⑨⑩]+', '', cand.get_text())
                        if not ctext: continue
                        if ctext in clean_s or clean_s in ctext:
                            score = min(len(ctext), len(clean_s)) + 10
                        else:
                            score = sum(3 for i in range(len(ctext) - 2) if ctext[i:i+3] in clean_s)
                        if score > best_score and score >= 3:
                            best_score = score
                            best_cand = cand
                if best_cand:
                    target_el = best_cand

            # 6. 兜底匹配：在已有节点或相邻父级内嵌入独立内联 span，确保 100% 具备唯一锚点
            if not target_el:
                parent_cand = None
                if did:
                    for b in boxes:
                        cand = b.find(id=did)
                        if cand:
                            parent_cand = cand
                            break
                if not parent_cand and clean_s:
                    for b in boxes:
                        for cand in b.find_all(["div", "p", "tr", "td", "th", "h4"]):
                            ctext = re.sub(r'[\s,，.。:：()（）/、:—\-$+*★✦➔\d一二三四五六七八九十①②③④⑤⑥⑦⑧⑨⑩]+', '', cand.get_text())
                            if clean_s[:10] in ctext or (len(clean_s) >= 4 and clean_s in ctext):
                                parent_cand = cand
                                break
                        if parent_cand: break

                if not parent_cand and boxes:
                    parent_cand = boxes[0]

                if parent_cand:
                    sub_span = soup.new_tag("span", attrs={
                        "id": sent_id,
                        "class": "recite-sent-item xt-inline-sent",
                        "data-sent-id": sent_id,
                        "data-sent-idx": str(s_idx),
                        "data-start": f"{start:.3f}",
                        "data-end": f"{end:.3f}"
                    })
                    sub_span.string = stext
                    parent_cand.append(sub_span)
                    target_el = sub_span

            # 盖戳到匹配到的 DOM 节点
            if target_el:
                claimed.add(id(target_el))
                target_el["id"] = sent_id
                target_el["data-sent-id"] = sent_id
                target_el["data-sent-idx"] = str(s_idx)
                target_el["data-start"] = f"{start:.3f}"
                target_el["data-end"] = f"{end:.3f}"
                classes = target_el.get("class", [])
                if isinstance(classes, str):
                    classes = [classes]
                if "recite-sent-item" not in classes:
                    classes.append("recite-sent-item")
                    target_el["class"] = classes

        recite_html = normalize_pane_html(recite_box, soup)
        understand_html = normalize_pane_html(understand_box, soup)

        # 轨道二：名师深度伴读版
        lecture_pane = art.find("div", id=f"pane_lecture_{ch_id}")
        sub_cards = []

        if lecture_pane:
            chips = lecture_pane.find_all("button", class_="playlist-chip-btn")
            for c in chips:
                m_call = re.search(r"selectChapterAudioCard\(['\"]([^'\"]+)['\"],\s*['\"]([^'\"]+)['\"]\)", c.get("onclick", ""))
                card_id = m_call.group(2) if m_call else c.get("id", "").replace(f"chip_{ch_id}_", "")

                # 特殊修正：导论章节 ch_xsx_00 内部 DOM 为 xsx_00，无独立音频
                if ch_id == "ch_xsx_00":
                    card_id = "xsx_00"

                chip_label = c.get_text(strip=True)

                stream_pane = lecture_pane.find("div", id=f"stream_pane_{ch_id}_{card_id}")
                if not stream_pane and ch_id == "ch_xsx_00":
                    stream_pane = lecture_pane.find("div", id=f"stream_pane_{ch_id}_xsx_01")

                card_title = ""
                card_tags = []
                lecture_html = ""

                raw_sub_sentences = CARD_SENTENCES.get(card_id, [])
                if not raw_sub_sentences and card_id == "xsx_00":
                    raw_sub_sentences = CARD_SENTENCES.get("xsx_01", [])

                processed_sub_sentences = []

                if stream_pane:
                    title_el = stream_pane.find(class_=re.compile(r'sub-card-title|stream-pane-title'))
                    if title_el:
                        card_title = title_el.get_text(strip=True)
                    else:
                        card_title = chip_label

                    tag_els = stream_pane.find_all(class_=re.compile(r'badge|tag'))
                    card_tags = [t.get_text(strip=True) for t in tag_els if t.get_text(strip=True)]

                    # 为 Track 2 微考点内的句子打上精准锚点
                    recite_spans = stream_pane.find_all(class_="recite-sentence")
                    ds_span_map = {span.get("data-sent-idx"): span for span in recite_spans if span.get("data-sent-idx")}

                    for s_idx, s in enumerate(raw_sub_sentences):
                        sent_id = f"sent_{card_id}_{s_idx}"
                        s_copy = dict(s)
                        s_copy["idx"] = s_idx
                        s_copy["id"] = sent_id
                        processed_sub_sentences.append(s_copy)

                        span = ds_span_map.get(str(s_idx))
                        if not span and s_idx < len(recite_spans):
                            span = recite_spans[s_idx]

                        if span:
                            span["id"] = sent_id
                            span["data-sent-id"] = sent_id
                            span["data-sent-idx"] = str(s_idx)
                            span["data-start"] = str(s.get("start", 0.0))
                            span["data-end"] = str(s.get("end", 0.0))

                    lecture_html = normalize_pane_html(stream_pane, soup)

                # 音频白名单与规范：若 xsx_00 无音频则为 null
                if card_id == "xsx_00":
                    card_audio = None
                else:
                    card_audio = f"audio_cards/pol/{card_id}.mp3"

                sub_cards.append({
                    "cardId": card_id,
                    "chipLabel": chip_label,
                    "title": card_title or chip_label,
                    "tags": card_tags,
                    "audio": card_audio,
                    "lectureHtml": lecture_html,
                    "sentences": processed_sub_sentences
                })

        total_subcards += len(sub_cards)

        chapters47.append({
            "id": ch_id,
            "subject": "pol",
            "polSubMode": "recite47",
            "category": cat,
            "categoryName": cat_name,
            "chapterNum": ch_num,
            "title": ch_title,
            "importance": tag_text or "必背考点",
            "track1": {
                "audio": f"audio_cards/pol/{ch_id}_recite.mp3",
                "reciteHtml": recite_html,
                "understandHtml": understand_html,
                "sentences": processed_recite_sentences
            },
            "track2": {
                "subCards": sub_cards
            }
        })

    print(f"Processed 47 chapters with {total_subcards} subCards in total.")

    # 3. 处理模块二：徐涛 26 天选择题带背（加载高精度 608 考点纯净库与双音轨时间戳）
    print("Processing 徐涛 26 天 (xutao16) with pristine 608 points and authentic dual timestamps...")
    processed_xt16 = []
    xt_final_path = r"D:\AI_file\背诵手册\xutao_26days_final.json"
    if os.path.exists(xt_final_path):
        with open(xt_final_path, "r", encoding="utf-8") as f:
            final_xt_days = json.load(f)
        for day_data in final_xt_days:
            day_num = day_data.get("day", 1)
            points = []
            for p in day_data.get("points", []):
                p_html = p.get("html", "")
                if "★" in p_html:
                    p_html = p_html.replace("★", STAR_SVG)
                points.append({
                    "id": p.get("id", f"pol_xt_d{day_num:02d}_p{p.get('num', 1):02d}"),
                    "num": p.get("num", 1),
                    "tag": p.get("tag", "核心考点"),
                    "html": p_html,
                    "voice_start": float(p.get("voice_start", 0.0)),
                    "voice_end": float(p.get("voice_end", 0.0)),
                    "anlang_start": float(p.get("anlang_start", 0.0)),
                    "anlang_end": float(p.get("anlang_end", 0.0))
                })
            processed_xt16.append({
                "id": f"pol_xt_d{day_num:02d}",
                "day": day_num,
                "title": day_data.get("title", f"Day {day_num:02d}"),
                "subtitle": day_data.get("subtitle") or day_data.get("desc", ""),
                "subject": day_data.get("subject", "马原"),
                "duration_sec": int(day_data.get("duration_sec", 120)),
                "anlang_audio": f"audio_xutao/xt_anlang_d{day_num:02d}.mp3",
                "voice_audio": f"audio_xutao/xt_voice_d{day_num:02d}.mp3",
                "points": points
            })
    else:
        print(f"  ❌ Error: {xt_final_path} not found!")

    # 4. 处理模块三：腿姐 11 天冲刺背诵
    print("Processing 腿姐 11 天 (tuijie11)...")
    processed_tj11 = []
    for day_data in tjAllDaysData:
        day_num = day_data.get("day", 1)
        subtitle = day_data.get("subtitle") or day_data.get("sub", "")
        audio = day_data.get("audio") or day_data.get("audio_src") or f"audio_tuijie/tuijie_d{day_num:02d}.mp3"
        timestamps = day_data.get("timestamps", [])
        sentences = day_data.get("sentences", [])

        dur_str = day_data.get("duration_str")
        if not dur_str:
            if timestamps:
                end_sec = timestamps[-1].get("end", 0.0)
                dur_str = f"{int(end_sec // 60):02d}:{int(end_sec % 60):02d}"
            else:
                dur_str = "00:00"

        resolved_timestamps = []
        for idx, ts in enumerate(timestamps):
            s_text = sentences[idx] if idx < len(sentences) else ts.get("text", "")
            resolved_timestamps.append({
                "start": ts.get("start", 0.0),
                "end": ts.get("end", 0.0),
                "text": ts.get("text") or s_text
            })

        raw_points = day_data.get("points", [])
        processed_points = []
        for p in raw_points:
            if isinstance(p, dict):
                p_text = p.get("text", "")
                if "★" in p_text:
                    p["text"] = p_text.replace("★", STAR_SVG)
                processed_points.append(p)
            elif isinstance(p, str):
                if "：" in p:
                    lbl, txt = p.split("：", 1)
                elif ":" in p:
                    lbl, txt = p.split(":", 1)
                else:
                    lbl, txt = "核心考点", p
                if "★" in txt:
                    txt = txt.replace("★", STAR_SVG)
                processed_points.append({"label": lbl.strip(), "text": txt.strip()})

        # Check for orphan sentences not referenced in any section's sent_indices
        all_referenced = set()
        for sec in day_data.get("sections", []):
            for s_idx in sec.get("sent_indices", []):
                all_referenced.add(s_idx)
        orphan_indices = [i for i in range(len(sentences)) if i not in all_referenced]

        processed_sections = []
        raw_sections = day_data.get("sections", [])
        for s_i, sec in enumerate(raw_sections):
            sec_obj = dict(sec)
            sent_indices = list(sec.get("sent_indices", []))
            # 自动将末尾遗漏未编入 section 的孤儿句子补齐至末尾 section (Fix 2: Day 05 sent 19, 20)
            if s_i == len(raw_sections) - 1 and orphan_indices:
                print(f"  Day {day_num:02d}: Appending orphan sentence indices {orphan_indices} to last section '{sec.get('title')}'")
                sent_indices.extend(orphan_indices)
                sec_obj["sent_indices"] = sent_indices

            resolved_sents = []
            for idx in sent_indices:
                if 0 <= idx < len(sentences):
                    t_start = timestamps[idx]["start"] if idx < len(timestamps) else 0.0
                    t_end = timestamps[idx]["end"] if idx < len(timestamps) else 0.0
                    s_text = sentences[idx]
                    resolved_sents.append({
                        "idx": idx,
                        "start": t_start,
                        "end": t_end,
                        "text": s_text
                    })
            sec_obj["resolved_sentences"] = resolved_sents
            processed_sections.append(sec_obj)

        processed_tj11.append({
            "id": f"pol_tj_d{day_num:02d}",
            "day": day_num,
            "title": day_data.get("title", f"Day {day_num:02d}"),
            "subtitle": subtitle,
            "audio": audio,
            "duration_str": dur_str,
            "sentences": sentences,
            "timestamps": resolved_timestamps,
            "points": processed_points,
            "sections": processed_sections
        })

    # 5. 组合为 window.KAOYAN_POL_DATA 并序列化
    output_obj = {
        "version": "3.0.4",
        "chapters47": chapters47,
        "xutao16": processed_xt16,
        "tuijie11": processed_tj11
    }

    print(f"Writing to {OUTPUT_JS} ...")
    os.makedirs(os.path.dirname(OUTPUT_JS), exist_ok=True)
    json_str = json.dumps(output_obj, ensure_ascii=False, indent=2)
    with open(OUTPUT_JS, "w", encoding="utf-8") as f:
        f.write("window.KAOYAN_POL_DATA = ")
        f.write(json_str)
        f.write(";\n")

    size_mb = os.path.getsize(OUTPUT_JS) / (1024 * 1024)
    print(f"Successfully generated {OUTPUT_JS}! Size: {size_mb:.2f} MB")

if __name__ == "__main__":
    main()

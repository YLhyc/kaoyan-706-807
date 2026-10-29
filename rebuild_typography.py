import os
import sys
import json
import re
from pathlib import Path

work_dir = Path(r"D:\AI_file\706_807专业课背诵手卷")
src_807 = Path(r"D:\AAA考研\807复习助手\outputs\双轨随身背诵库")
src_706 = Path(r"D:\AAA考研\706复习助手\outputs\双轨随身背诵库")

manifest_path = work_dir / "data" / "kaoyan_all_manifest.json"
data = json.loads(manifest_path.read_text(encoding="utf-8"))

def clean_txt(t):
    return re.sub(r'[\s\*\(\)（）《》“”‘’——\-\.\,\?\!，。？！、；：0-9一二三四五六七八九十百千万]+', '', t)

def split_sentences_proper(text):
    raw_sents = [s.strip() for s in re.split(r'([。？！]+)', text) if s.strip()]
    merged = []
    i = 0
    while i < len(raw_sents):
        s = raw_sents[i]
        if i + 1 < len(raw_sents) and re.match(r'^[。？！]+$', raw_sents[i+1]):
            merged.append(s + raw_sents[i+1])
            i += 2
        else:
            merged.append(s)
            i += 1
    return merged

def extract_meta_and_keywords(fpath):
    txt = fpath.read_text(encoding="utf-8")
    
    t_m = re.search(r'\*\*题型\*\*：?([^\n]+)', txt)
    s_m = re.search(r'\*\*分值\*\*：?([^\n]+)', txt)
    tm_m = re.search(r'\*\*建议用时\*\*：?([^\n]+)', txt)
    w_m = re.search(r'\*\*目标字数\*\*：?([^\n]+)', txt)
    
    q_type = t_m.group(1).strip() if t_m else ('论述题' if '30分' in str(fpath) else '简答题')
    score = s_m.group(1).strip() if s_m else ('30 分' if '30分' in str(fpath) else '20 分')
    time_est = tm_m.group(1).strip() if tm_m else ('约 35 分钟' if '30分' in str(fpath) else '约 20 分钟')
    words = w_m.group(1).strip() if w_m else ('约 1000~1200 字' if '30分' in str(fpath) else '约 500~600 字')
    words = words.replace('，完全符合考场高分规范）', '').replace('（', '').replace('）', '').strip()
    
    bold_terms = [b.strip() for b in re.findall(r'\*\*([^*]+)\*\*', txt) if len(b.strip()) > 1]
    
    keywords = []
    skip_prefixes = ['题型', '分值', '建议', '目标', '第一', '第二', '第三', '第四', '第五', '首先', '其次', '再次', '最后', '综上', '总之', '具体表述']
    for b in bold_terms:
        if 2 <= len(b) <= 12 and not any(b.startswith(x) for x in skip_prefixes):
            keywords.append(b)
            
    seen = set()
    uniq_kw = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            uniq_kw.append(k)
            
    return q_type, score, time_est, words, uniq_kw

def highlight_html(text, keywords):
    sorted_kw = sorted(keywords, key=len, reverse=True)
    res = text
    for kw in sorted_kw:
        if len(kw) < 2:
            continue
        pattern = re.compile(rf'(?<![<"\']){re.escape(kw)}(?![>"\'])')
        res = pattern.sub(f'<strong class="kw-red">{kw}</strong>', res)
    return res

def parse_track1_sections_from_md(md_path):
    txt = md_path.read_text(encoding="utf-8")
    
    # Precise Heading Match
    t1_match = re.search(r'^#{1,3}\s*【?第[一1][部轨][分道轨]?】?.*?\n([\s\S]*?)(?=^#{1,3}\s*【?第[二2][部轨][分道轨]?】?|\Z)', txt, re.MULTILINE)
    if not t1_match:
        t1_match = re.search(r'#+.*?(?:第一部分|第一轨道|第一轨).*?\n([\s\S]*?)(?:#+.*?(?:第二部分|第二轨道|第二轨)|\Z)', txt)
    if not t1_match:
        return []
        
    t1_text = t1_match.group(1).strip()
    headers = re.findall(r'####\s*([^\n]+)', t1_text)
    sections = []
    
    if headers and len(headers) >= 2:
        parts = re.split(r'####\s*[^\n]+', t1_text)
        intro_text = '\n'.join([l for l in parts[0].strip().splitlines() if not l.startswith('>') and not l.startswith('#') and not l.startswith('---')]).strip()
        sections.append({
            'badge': '【引论 · 立论破题】',
            'desc': '确立宏观文学史定位 · 凝练论述核心立论',
            'type': 'intro',
            'text': intro_text
        })
        for h, part in zip(headers, parts[1:]):
            p_clean = part.strip()
            h_clean = h.strip()
            h_title = h_clean.split('：')[0].strip() if '：' in h_clean else h_clean[:6].strip()
            if '综上所述' in p_clean:
                sub_parts = re.split(r'(?=综上所述)', p_clean)
                sections.append({
                    'badge': f'【本论 · {h_title}】',
                    'desc': h_clean,
                    'type': 'point',
                    'text': sub_parts[0].strip()
                })
                sections.append({
                    'badge': '【结语 · 总结升华】',
                    'desc': '融汇全篇论据 · 提炼终极经典地位',
                    'type': 'conclusion',
                    'text': sub_parts[1].strip()
                })
            else:
                sections.append({
                    'badge': f'【本论 · {h_title}】',
                    'desc': h_clean,
                    'type': 'point',
                    'text': p_clean
                })
    else:
        paras = [p.strip() for p in t1_text.split('\n\n') if p.strip() and not p.strip().startswith('>') and not p.strip().startswith('#') and not p.strip().startswith('---')]
        num_map = {1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七'}
        for i, p in enumerate(paras):
            if i == 0:
                badge = '【引论 · 立论破题】'
                desc = '确立宏观文学史定位 · 凝练论述核心立论'
                stype = 'intro'
            elif i == len(paras) - 1:
                badge = '【结语 · 总结升华】'
                desc = '融汇全篇论据 · 提炼终极经典地位'
                stype = 'conclusion'
            else:
                badge = f'【本论 · 分论点{num_map.get(i, str(i))}】'
                desc = '核心要旨深化 · 纵深多维展开'
                stype = 'point'
            sections.append({
                'badge': badge,
                'desc': desc,
                'type': stype,
                'text': p
            })
            
    return sections

def build_clean_track1_html(item, sents, meta, md_path):
    q_type, score, time_est, words, keywords = meta
    
    spec_html = f"""
    <div class="exam-spec-banner">
      <div class="spec-chip chip-type">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        <span>{q_type}</span>
      </div>
      <div class="spec-chip chip-score">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
        <span>满分：{score}</span>
      </div>
      <div class="spec-chip chip-time">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        <span>建议用时：{time_est}</span>
      </div>
      <div class="spec-chip chip-words">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line></svg>
        <span>考场篇幅：{words}</span>
      </div>
    </div>
    <div class="exam-title-box">
      <span class="title-seal">答题手卷</span>
      <h2 class="exam-title-h2">【{q_type}】{item['title']}</h2>
    </div>
    """
    
    sections = parse_track1_sections_from_md(md_path)
    if not sections:
        sections = [{
            'badge': '【考场答题完整版】',
            'desc': '核心要旨展开',
            'type': 'point',
            'text': ''
        }]
        
    assigned_sections = [[] for _ in range(len(sections))]
    sec_cleans = [clean_txt(s['text']) for s in sections]
    sec_ptr = 0
    
    for s in sents:
        s_cl = clean_txt(s['text'])
        if sec_ptr + 1 < len(sections):
            next_sec_cl = sec_cleans[sec_ptr + 1]
            match = False
            if len(next_sec_cl) >= 6:
                for k in range(0, min(24, len(next_sec_cl) - 5)):
                    if next_sec_cl[k:k+6] in s_cl:
                        match = True
                        break
            if not match and len(s_cl) >= 6:
                for k in range(0, min(20, len(s_cl) - 5)):
                    if s_cl[k:k+6] in next_sec_cl[:45]:
                        match = True
                        break
            if match:
                sec_ptr += 1
        assigned_sections[sec_ptr].append(s)
        
    cards_html = []
    for i, sec in enumerate(sections):
        a_sents = assigned_sections[i] if i < len(assigned_sections) else []
            
        if sec['type'] == 'intro':
            pill_label = '【立论破题句】'
        elif sec['type'] == 'conclusion':
            pill_label = '【总结升华句】'
        else:
            pill_label = '【论述中心句】'
            
        if a_sents:
            topic_chunks = []
            body_chunks = []
            found_period = False
            
            for s in a_sents:
                if not found_period:
                    topic_chunks.append(s)
                    if any(p in s['text'] for p in ['。', '！', '？']):
                        found_period = True
                else:
                    body_chunks.append(s)
                    
            if not found_period:
                topic_chunks = a_sents
                body_chunks = []
        else:
            # Fallback for sections without audio sentences
            s_list = split_sentences_proper(sec['text'])
            if s_list:
                topic_chunks = [{'id': f"txt_{i}_0", 'text': s_list[0], 'start': '', 'end': ''}]
                body_chunks = [{'id': f"txt_{i}_{idx_b}", 'text': b, 'start': '', 'end': ''} for idx_b, b in enumerate(s_list[1:], 1)]
            else:
                topic_chunks = [{'id': f"txt_{i}_0", 'text': sec['text'], 'start': '', 'end': ''}]
                body_chunks = []
            
        topic_spans = []
        for idx_t, s in enumerate(topic_chunks):
            txt_fmt = highlight_html(s['text'], keywords)
            # EXACTLY ONE pill per section!
            pill_tag = f'<span class="thesis-pill">{pill_label}</span>' if idx_t == 0 else ''
            sid = s['id']
            sstart = s['start']
            send = s['end']
            topic_spans.append(f'<span class="recite-sent thesis-sent" data-sent-id="{sid}" data-start="{sstart}" data-end="{send}">{pill_tag}{txt_fmt}</span>')
            
        thesis_box_html = f"""
        <div class="section-thesis-box">
          {"".join(topic_spans)}
        </div>
        """
        
        body_spans = []
        for s in body_chunks:
            txt_fmt = highlight_html(s['text'], keywords)
            sid = s['id']
            sstart = s['start']
            send = s['end']
            body_spans.append(f'<span class="recite-sent" data-sent-id="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>')
            
        body_box_html = f"""
        <div class="section-body-text">
          {"".join(body_spans)}
        </div>
        """ if body_spans else ""
        
        card_html = f"""
        <section class="exam-section-card card-{sec['type']}">
          <div class="section-card-header">
            <span class="sec-badge badge-{sec['type']}">{sec['badge']}</span>
            <span class="sec-desc">{sec['desc']}</span>
          </div>
          <div class="section-card-content">
            {thesis_box_html}
            {body_box_html}
          </div>
        </section>
        """
        cards_html.append(card_html)
        
    return f"""<div class="paper-track1-wrap">{spec_html}{"".join(cards_html)}</div>"""

def detect_t2_block(txt):
    t = txt.strip()
    
    # Exclude non-heading sentences
    if '：采分点为' in t or '（约一百' in t or '（约100' in t or '（约150' in t or '（约200' in t:
        return False, ''
    if t.startswith('第二是') or t.startswith('第三是') or t.startswith('第四是'):
        return False, ''
    if '必须' in t or '应该从' in t or '到底要' in t or '到底在问' in t:
        return False, ''
    if '论证推演逻辑' in t or '具体表述到答题语句' in t:
        return False, ''
        
    # 1. 篇头 / 宏观破题 / 全局破题
    if any(t.startswith(x) for x in ['篇头：', '篇头:', '一、全题宏观破题', '全题宏观破题', '全局宏观破题', '一、宏观结构推演']):
        return True, '全题宏观破题与立论逻辑'
        
    # 2. 篇尾 / 逻辑链总括
    if any(t.startswith(x) for x in ['篇尾：', '篇尾:', '整道大题的内在逻辑链总括', '整道大题内在逻辑链总括']):
        return True, '整道大题内在逻辑链总括'
        
    # 3. 板块 (e.g. 第一板块：..., 、第二板块：..., 二、第一板块)
    if '板块：' in t or '板块:' in t or ('板块' in t and len(t) <= 35 and any(c in t for c in ['一', '二', '三', '四', '五', '六'])):
        name = re.sub(r'^[、\s0-9一二三四五六七八九十•\-·]+', '', t).split('：')[0].split(':')[0].strip('。')
        return True, name
        
    # 4. 包含分论点 (e.g. 第二段：第一分论点... or 第一分论点...)
    m_para = re.search(r'(第?[一二三四五六七八九十]段[：:]?\s*)?第[一二三四五六七八九十]分论点[，：:]?\s*([^。！\n]+)', t)
    if m_para:
        clean_t = t[t.find(m_para.group(0)):].split('。')[0]
        return True, clean_t.strip('、-• ')
        
    # 5. 第X段：首段破题 / 尾段收官
    m_para_edge = re.search(r'第?[一二三四五六七八九十]段[：:]\s*(首段破题|尾段收官|破题与概念定性|尾段收束)[^。！\n]*', t)
    if m_para_edge:
        return True, m_para_edge.group(0).strip('、-• ')
        
    # 6. 部分 (e.g. 第一部分：..., 一部分：..., 二部分：...)
    m_part = re.search(r'(?:[、\s0-9一二三四五六七八九十•\-·]*)第?[一二三四五六七八九十]部分[：:]\s*([^。！\n]+)', t)
    if m_part and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 7. 支柱 (e.g. 第一支柱：..., 一支柱：..., 二支柱：...)
    m_pillar = re.search(r'(?:第?[一二三四五六七八九十])支柱[：:]\s*([^。！\n]+)', t)
    if m_pillar and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 8. 要点 / 点一 / 点二 / 点三 (e.g. 要点一：..., 点二：...)
    m_point = re.search(r'(?:要?点[一二三四五六七八九十])[：:]\s*([^。！\n]+)', t)
    if m_point and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 9. 破题段 / 总领段 / 总结提升段 / 结语段
    if any(t.startswith(x) for x in ['破题段：', '总领段：', '总结提升段：', '结语段：', '结提升段：']):
        return True, t.split('。')[0].strip('、-• ')
        
    return False, ''

connectors = ['具体表述到答题语句就是：', '具体表述到答题语句就是', '答题原句就是：', '答题原句就是', '答题原句：', '所以表述为：', '所以表述为']

def format_quote_chunk(txt, is_first, keywords):
    formatted = txt
    if is_first:
        for c in connectors:
            if c in formatted:
                parts = formatted.split(c, 1)
                before = parts[0]
                after = parts[1]
                before_fmt = highlight_html(before, keywords)
                after_fmt = highlight_html(after, keywords)
                before_html = f'<span class="quote-prompt-lead">{before_fmt}</span>' if before else ''
                badge_html = f'<span class="quote-connector-badge">{c}</span>'
                return f'{before_html}{badge_html}<strong class="quote-gold-core">{after_fmt}</strong>'
    return f'<strong class="quote-gold-core">{highlight_html(txt, keywords)}</strong>'

def build_clean_track2_html(item, sents2, meta):
    q_type, score, time_est, words, keywords = meta
    
    html_parts = []
    
    html_parts.append(f"""
    <div class="exam-spec-banner" style="background: linear-gradient(135deg, rgba(160, 90, 44, 0.08) 0%, rgba(200, 140, 60, 0.05) 100%); border-color: rgba(160, 90, 44, 0.2);">
      <div class="spec-chip" style="background: rgba(160, 90, 44, 0.12); color: #8A4B1A;">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
        <span>名师逻辑精解版</span>
      </div>
      <div class="spec-chip chip-type">
        <span>逐句因果咬合</span>
      </div>
      <div class="spec-chip chip-score">
        <span>考场原句黄金提取</span>
      </div>
    </div>
    <div class="exam-title-box">
      <span class="title-seal" style="border-color: #8A4B1A; color: #8A4B1A;">逻辑解构</span>
      <h2 class="exam-title-h2">【思路推导】{item['title']}</h2>
    </div>
    """)
    
    blocks = []
    current_block = {
        'title': '全题宏观破题与立论逻辑',
        'items': []
    }
    
    for s in sents2:
        txt = s['text'].strip()
        is_new_block, new_title = detect_t2_block(txt)
            
        if is_new_block and current_block['items']:
            blocks.append(current_block)
            current_block = {'title': new_title, 'items': []}
            
        current_block['items'].append(s)
        
    if current_block['items']:
        blocks.append(current_block)
        
    for b in blocks:
        block_items_html = []
        items = b['items']
        i = 0
        while i < len(items):
            s = items[i]
            txt = s['text'].strip()
            
            is_quote = any(c in txt for c in connectors)
            is_qa = any(txt.startswith(x) for x in ['1.', '2.', '3.', '4.', '一、这道题', '二、应该从', '三、从哪些', '四、这三个', '这道题到底', '应该从什么', '从哪些方面', '内在逻辑是', '问题一', '问题二', '问题三', '问题四'])
            
            if is_qa:
                txt_fmt = highlight_html(s['text'], keywords)
                sid = s['id']
                sstart = s['start']
                send = s['end']
                block_items_html.append(f"""
                <div class="framework-qa-card">
                  <div class="qa-badge">📌 审题指引与立意维度</div>
                  <span class="recite-sent" data-sent-id="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                </div>
                """)
                i += 1
            elif is_quote:
                quote_chunks = [s]
                # Collect continuation chunks until sentence terminator (。！？)
                while not any(p in items[i]['text'] for p in ['。', '！', '？']) and i + 1 < len(items):
                    next_txt = items[i+1]['text'].strip()
                    if any(c in next_txt for c in connectors) or next_txt.startswith('【') or '板块：' in next_txt:
                        break
                    i += 1
                    quote_chunks.append(items[i])
                    
                quote_spans = []
                for idx_qc, qc in enumerate(quote_chunks):
                    qc_fmt = format_quote_chunk(qc['text'], idx_qc == 0, keywords)
                    sid = qc['id']
                    sstart = qc['start']
                    send = qc['end']
                    quote_spans.append(f'<span class="recite-sent gold-sent-active" data-sent-id="{sid}" data-start="{sstart}" data-end="{send}">{qc_fmt}</span>')
                    
                block_items_html.append(f"""
                <div class="gold-quote-box">
                  <div class="gold-quote-header">
                    <span class="gold-badge">考场对应答题原句</span>
                    <span class="gold-tip">黄金得分点 · 考场需一字不差记忆</span>
                  </div>
                  <div class="gold-quote-body">
                    {"".join(quote_spans)}
                  </div>
                </div>
                """)
                i += 1
            else:
                txt_fmt = highlight_html(s['text'], keywords)
                sid = s['id']
                sstart = s['start']
                send = s['end']
                block_items_html.append(f"""
                <div class="teacher-explain-row">
                  <span class="recite-sent" data-sent-id="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                </div>
                """)
                i += 1
                
        block_html = f"""
        <div class="logic-block-card">
          <div class="logic-block-title">
            <span class="logic-sec-pill">逻辑剖析</span>
            <h3>{b['title']}</h3>
          </div>
          <div class="logic-block-body">
            {"".join(block_items_html)}
          </div>
        </div>
        """
        html_parts.append(block_html)
        
    return f"""<div class="paper-track2-wrap">{"".join(html_parts)}</div>"""

# Batch processing all 36 items
all_items = data.get("items_807", []) + data.get("items_706", [])
print(f"Starting processing {len(all_items)} items...")

all_sentences_map = {}

for idx, item in enumerate(all_items):
    sub = item.get("subject", "807")
    src_dir = src_807 if sub == "807" else src_706
    
    clean_id = item["id"].replace("807_", "").replace("706_", "")
    md_matches = list(src_dir.glob(f"{clean_id}*.md"))
    if not md_matches:
        parts = clean_id.split("_")
        if len(parts) >= 3:
            md_matches = list(src_dir.glob(f"*{parts[2]}*.md"))
        if not md_matches:
            md_matches = list(src_dir.glob(f"*{item['title'][:4]}*.md"))
            
    md_path = md_matches[0] if md_matches else None
    if not md_path:
        print(f"[{idx+1:02d}] ERROR: Cannot find md for {item['id']}")
        continue
        
    meta = extract_meta_and_keywords(md_path)
    
    # Track 1
    t1_sfile = item["track1"]["sentences_file"]
    t1_path = work_dir / t1_sfile
    if t1_path.exists():
        t1_sents = json.loads(t1_path.read_text(encoding="utf-8"))
        all_sentences_map[t1_sfile.replace("\\", "/")] = t1_sents
        item["track1"]["html"] = build_clean_track1_html(item, t1_sents, meta, md_path)
        
    # Track 2
    t2_sfile = item["track2"]["sentences_file"]
    t2_path = work_dir / t2_sfile
    if t2_path.exists():
        t2_sents = json.loads(t2_path.read_text(encoding="utf-8"))
        all_sentences_map[t2_sfile.replace("\\", "/")] = t2_sents
        item["track2"]["html"] = build_clean_track2_html(item, t2_sents, meta)
        
    p_count = item["track1"]["html"].count("thesis-pill")
    sec_count = item["track1"]["html"].count("exam-section-card")
    t2_b_count = item["track2"]["html"].count("logic-block-card")
    t2_q_count = item["track2"]["html"].count("gold-quote-box")
    print(f"[{idx+1:02d}] {sub} {item['title'][:16]:<16} | T1 sec: {sec_count} | T2 blocks: {t2_b_count} | T2 quotes: {t2_q_count}")

# Save updated manifests
manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

m807_path = work_dir / "data" / "kaoyan_807_manifest.json"
m706_path = work_dir / "data" / "kaoyan_706_manifest.json"
m807_path.write_text(json.dumps(data.get("items_807", []), ensure_ascii=False, indent=2), encoding="utf-8")
m706_path.write_text(json.dumps(data.get("items_706", []), ensure_ascii=False, indent=2), encoding="utf-8")
print("Saved all manifests!")

# Generate data/kaoyan_data.js
js_bundle_path = work_dir / "data" / "kaoyan_data.js"
js_content = f"""// 2027 考研专业课双轨随身背诵手卷 · 离线全量数据与高保真研读包
// 彻底免疫浏览器 file:/// 下的 CORS 限制，双击即可秒开
window.KAOYAN_MANIFEST = {json.dumps(data, ensure_ascii=False)};

window.KAOYAN_SENTENCES = {json.dumps(all_sentences_map, ensure_ascii=False)};
"""
js_bundle_path.write_text(js_content, encoding="utf-8")
print(f"Generated data/kaoyan_data.js successfully! Size: {js_bundle_path.stat().st_size / (1024*1024):.2f} MB")

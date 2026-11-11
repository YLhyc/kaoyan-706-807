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
    
    if "00_807核心名词解释" in str(fpath):
        q_type = "名词解释合辑"
        score = "单题 5 分 × 16 题"
        time_est = "约 60 分钟（单题 3~4 分钟）"
        words = "单题 80~120 字（共 16 题）"
    else:
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
    
    # 1. Noun Explanation Collections (807_00_01, 807_00_02)
    if "00_807核心名词解释" in str(md_path) or ("### 1." in txt and "合辑" in str(md_path)):
        raw_terms = re.findall(r'###\s*(\d+)\.\s*([^\n（(]+)(?:[（(]([^\n）)]+)[）)])?\s*\n+([\s\S]*?)(?=###|\Z)', txt)
        sections = []
        for m in raw_terms:
            num = int(m[0])
            if num > 16:
                continue
            title = m[1].strip()
            tag = m[2].strip() if m[2] else ""
            body = m[3].strip()
            body = re.sub(r'\n*---+\s*$', '', body).strip()
            sections.append({
                'badge': f'【名词解释 {num:02d}】{title}',
                'desc': f'真题考频：{tag}' if tag else '西华师大 807 核心必考名词解释',
                'type': 'point',
                'term_num': num,
                'term_title': title,
                'text': body
            })
        if sections:
            return sections

    # 2. Precise Heading Match with 第一部分 / 第一轨
    t1_match = re.search(r'^#{1,3}\s*【?第[一1][部轨][分道轨]?】?.*?\n([\s\S]*?)(?=^#{1,3}\s*【?第[二2][部轨][分道轨]?】?|\Z)', txt, re.MULTILINE)
    if not t1_match:
        t1_match = re.search(r'#+.*?(?:第一部分|第一轨道|第一轨).*?\n([\s\S]*?)(?:#+.*?(?:第二部分|第二轨道|第二轨)|\Z)', txt)
    
    if t1_match:
        t1_text = t1_match.group(1).strip()
        headers = re.findall(r'####\s*([^\n]+)', t1_text)
        sections = []
        
        if headers and len(headers) >= 2:
            parts = re.split(r'####\s*[^\n]+', t1_text)
            intro_text = '\n'.join([l for l in parts[0].strip().splitlines() if not l.startswith('>') and not l.startswith('#') and not l.startswith('---')]).strip()
            intro_text = re.sub(r'\*{1,2}', '', intro_text)
            sections.append({
                'badge': '【引论 · 立论破题】',
                'desc': '确立宏观文学史定位 · 凝练论述核心立论',
                'type': 'intro',
                'text': intro_text
            })
            for h, part in zip(headers, parts[1:]):
                p_clean = re.sub(r'\*{1,2}', '', part.strip())
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
                        'desc': '融汇全篇论据 · 提炼权威学术定评',
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
            return sections
        else:
            paras = [re.sub(r'\*{1,2}', '', p.strip()) for p in t1_text.split('\n\n') if p.strip() and not p.strip().startswith('>') and not p.strip().startswith('#') and not p.strip().startswith('---')]
            num_map = {1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七'}
            for i, p in enumerate(paras):
                if i == 0:
                    badge = '【引论 · 立论破题】'
                    desc = '确立宏观文学史定位 · 凝练论述核心立论'
                    stype = 'intro'
                elif i == len(paras) - 1:
                    badge = '【结语 · 总结升华】'
                    desc = '融汇全篇论据 · 提炼权威学术定评'
                    stype = 'conclusion'
                    m_title = re.search(r'【(?:第?[0-9一二三四五六七八九十]+[、.： ]+)?(?:总结升华[：:]\s*)?([^】]+)】', p)
                    if m_title:
                        desc = m_title.group(1).strip()
                        p = re.sub(r'【[^】]+】\s*', '', p)
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

    # 3. Essay questions without 第一部分 (contains ## 考场高分示范作答 or markdown paragraphs)
    essay_text = re.sub(r'[\s\S]*?##\s*考场高分示范作答[^\n]*\n', '', txt).strip()
    paras = [re.sub(r'\*{1,2}', '', p.strip()) for p in essay_text.split('\n\n') if p.strip() and not p.strip().startswith('>') and not p.strip().startswith('#') and not p.strip().startswith('---')]
    
    num_map = {1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七'}
    sections = []
    for i, p in enumerate(paras):
        if i == 0:
            sections.append({
                'badge': '【引论 · 立论破题】',
                'desc': '确立宏观文学史定位 · 凝练论述核心立论',
                'type': 'intro',
                'text': p
            })
        elif '综上所述' in p:
            if p.startswith('综上所述') or p.startswith('综上'):
                sections.append({
                    'badge': '【结语 · 总结升华】',
                    'desc': '融汇全篇论据 · 提炼权威学术定评',
                    'type': 'conclusion',
                    'text': p
                })
            else:
                sub_parts = re.split(r'(?=综上所述)', p)
                m = re.match(r'^(第[一二三四五六七八九十]+[，、:][^。！？]+)', sub_parts[0])
                h_desc = m.group(1).strip() if m else f'核心要旨深化 · 分论点{num_map.get(i, str(i))}'
                h_title = re.sub(r'^[第0-9一二三四五六七八九十、，： ]+', '', h_desc).split('，')[0].split('：')[0].strip()
                sections.append({
                    'badge': f'【本论 · {h_title[:8]}】',
                    'desc': h_desc[:35],
                    'type': 'point',
                    'text': sub_parts[0].strip()
                })
                sections.append({
                    'badge': '【结语 · 总结升华】',
                    'desc': '融汇全篇论据 · 提炼权威学术定评',
                    'type': 'conclusion',
                    'text': sub_parts[1].strip()
                })
        else:
            m = re.match(r'^(第[一二三四五六七八九十]+[，、:][^。！？]+)', p)
            h_desc = m.group(1).strip() if m else f'核心要旨深化 · 分论点{num_map.get(i, str(i))}'
            h_title = re.sub(r'^[第0-9一二三四五六七八九十、，： ]+', '', h_desc).split('，')[0].split('：')[0].strip()
            sections.append({
                'badge': f'【本论 · {h_title[:8]}】',
                'desc': h_desc[:35],
                'type': 'point',
                'text': p
            })
            
    return sections

def build_clean_track1_html(item, sents, meta, md_path):
    q_type, score, time_est, words, keywords = meta
    
    sections = parse_track1_sections_from_md(md_path)
    if not sections:
        sections = [{
            'badge': '【考场答题完整版】',
            'desc': '核心要旨展开',
            'type': 'point',
            'text': ''
        }]
        
    is_noun = bool(sections and sections[0].get('term_num'))
    
    if is_noun:
        spec_html = f"""
    <div class="exam-spec-banner">
      <div class="spec-chip chip-type">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        <span>名词解释合辑</span>
      </div>
      <div class="spec-chip chip-score">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
        <span>分值：单题 5 分 × 16 题</span>
      </div>
      <div class="spec-chip chip-time">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
        <span>用时：约 60 分钟（单题 3~4 分钟）</span>
      </div>
      <div class="spec-chip chip-words">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line></svg>
        <span>篇幅：单题 80~120 字（共 16 题）</span>
      </div>
    </div>
    <div class="exam-title-box">
      <span class="title-seal">答题手卷</span>
      <h2 class="exam-title-h2">【名词解释合辑】{item['title']}</h2>
    </div>
    """
    else:
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
    
    assigned_sections = [[] for _ in range(len(sections))]
    header_sents = []
    
    if is_noun:
        curr_term = 0
        for s in sents:
            m = re.match(r'^([0-9]{1,2})\.\s*', s['text'].strip())
            if m:
                curr_term = int(m.group(1))
            if curr_term == 0:
                header_sents.append(s)
            elif 1 <= curr_term <= len(sections):
                assigned_sections[curr_term - 1].append(s)
    else:
        sec_cleans = [clean_txt(s['text']) for s in sections]
        sec_ptr = 0
        
        for s in sents:
            s_cl = clean_txt(s['text'])
            if sec_ptr + 1 < len(sections):
                min_req = 4 if sec_ptr == 0 else 2
                if len(assigned_sections[sec_ptr]) >= min_req:
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
                    if not match and len(s_cl) >= 4 and s_cl in next_sec_cl[:len(s_cl)+2]:
                        match = True
                    if match:
                        sec_ptr += 1
            assigned_sections[sec_ptr].append(s)
            
    lead_banner_html = ""
    if header_sents:
        hdr_spans = []
        for s in header_sents:
            txt_fmt = highlight_html(s['text'], keywords)
            sid = s['id']
            sstart = s['start']
            send = s['end']
            hdr_spans.append(f'<span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>')
        lead_banner_html = f"""
        <div class="noun-lead-banner">
          <div class="noun-lead-header">
            <span class="noun-lead-badge">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
              <span>导读说明</span>
            </span>
            <span class="noun-lead-tip">西华师大 807 名词解释规范要求 · 4题×5分=20分</span>
          </div>
          <div class="noun-lead-body">
            {"".join(hdr_spans)}
          </div>
        </div>
        """
        
    cards_html = []
    for i, sec in enumerate(sections):
        a_sents = assigned_sections[i] if i < len(assigned_sections) else []
            
        if is_noun:
            pill_label = '【名词核心】'
        elif sec['type'] == 'intro':
            pill_label = '【立论破题句】'
        elif sec['type'] == 'conclusion':
            pill_label = '【总结升华句】'
        else:
            pill_label = '【论述中心句】'
            
        if a_sents:
            if is_noun:
                # First sent is term name (e.g. 1. 文学研究会。), second sent is primary definition
                if len(a_sents) >= 2:
                    topic_chunks = a_sents[:2]
                    body_chunks = a_sents[2:]
                else:
                    topic_chunks = a_sents
                    body_chunks = []
            else:
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
            if is_noun:
                pill_tag = f'<span class="thesis-pill">{pill_label}</span>' if idx_t == 0 else '<span class="thesis-pill" style="background: rgba(184, 134, 11, 0.15); color: #B8860B;">【时空界定】</span>'
            else:
                pill_tag = f'<span class="thesis-pill">{pill_label}</span>' if idx_t == 0 else ''
            sid = s['id']
            sstart = s['start']
            send = s['end']
            topic_spans.append(f'<span class="recite-sent thesis-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{pill_tag}{txt_fmt}</span>')
            
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
            body_spans.append(f'<span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>')
            
        body_box_html = f"""
        <div class="section-body-text">
          {"".join(body_spans)}
        </div>
        """ if body_spans else ""
        
        card_cls = f"exam-section-card card-{sec['type']}"
        if is_noun:
            card_cls += " noun-card"
            
        card_html = f"""
        <section class="{card_cls}">
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
        
    return f"""<div class="paper-track1-wrap">{spec_html}{lead_banner_html}{"".join(cards_html)}</div>"""

def detect_t2_block(txt):
    t = txt.strip()
    
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
        
    # 3. 板块
    if '板块：' in t or '板块:' in t or ('板块' in t and len(t) <= 35 and any(c in t for c in ['一', '二', '三', '四', '五', '六'])):
        name = re.sub(r'^[、\s0-9一二三四五六七八九十•\-·]+', '', t).split('：')[0].split(':')[0].strip('。')
        return True, name
        
    # 4. 包含分论点
    m_para = re.search(r'(第?[一二三四五六七八九十]段[：:]?\s*)?第[一二三四五六七八九十]分论点[，：:]?\s*([^。！\n]+)', t)
    if m_para:
        clean_t = t[t.find(m_para.group(0)):].split('。')[0]
        return True, clean_t.strip('、-• ')
        
    # 5. 第X段：首段破题 / 尾段收官
    m_para_edge = re.search(r'第?[一二三四五六七八九十]段[：:]\s*(首段破题|尾段收官|破题与概念定性|尾段收束)[^。！\n]*', t)
    if m_para_edge:
        return True, m_para_edge.group(0).strip('、-• ')
        
    # 6. 部分
    m_part = re.search(r'(?:[、\s0-9一二三四五六七八九十•\-·]*)第?[一二三四五六七八九十]部分[：:]\s*([^。！\n]+)', t)
    if m_part and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 7. 支柱
    m_pillar = re.search(r'(?:第?[一二三四五六七八九十])支柱[：:]\s*([^。！\n]+)', t)
    if m_pillar and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 8. 要点
    m_point = re.search(r'(?:要?点[一二三四五六七八九十])[：:]\s*([^。！\n]+)', t)
    if m_point and len(t) <= 50:
        return True, t.split('。')[0].strip('、-• ')
        
    # 9. 破题段 / 总领段 / 总结提升段 / 结语段
    if any(t.startswith(x) for x in ['破题段：', '总领段：', '总结提升段：', '结语段：', '结提升段：']):
        return True, t.split('。')[0].strip('、-• ')
        
    return False, ''

connectors = ['具体表述到答题语句就是：', '具体表述到答题语句就是', '答题原句就是：', '答题原句就是', '答题原句：', '所以表述为：', '所以表述为']
fake_pattern = re.compile(r'(?:第[一二三四五六七八九十]+句|[首次末尾][句段]|句严格界定|句阐明|句总结|句概括|句剖析|句指出|句引入|句展开|句推导|句进一步|句收束|句宣告|句调取|句直接|思路总结|完整版为|答题思路|论证推演|采分点|到底要回答|应该从什么)')

def is_fake_quote(txt):
    for c in connectors:
        if c in txt:
            after = txt.split(c, 1)[1].strip()
            if fake_pattern.search(after):
                return True
            if len(after) == 0:
                return True
    return False

def should_stop_quote(txt):
    t = txt.strip()
    if any(c in t for c in connectors):
        return True
    if any(t.startswith(x) for x in ['【', '一、', '二、', '三、', '四、', '五、', '六、', '板块：', '板块:', '论证推演逻辑', '审题指引', '本段纯净完整答题版本', '纯净完整答题版本']):
        return True
    if any(p in t for p in ['论证推演逻辑', '采分点为', '到底要回答什么', '应该从什么方向']):
        return True
    return False

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

def build_clean_track2_html(item, sents2, meta, md_path=None, t1_sections=None):
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
    
    total_real_quotes = 0
    for s in sents2:
        txt = s['text'].strip()
        if any(c in txt for c in connectors) and not is_fake_quote(txt):
            total_real_quotes += 1
            
    needs_t1_linking = (total_real_quotes == 0)
    if not t1_sections and md_path:
        t1_sections = parse_track1_sections_from_md(md_path)
        
    is_noun = bool(t1_sections and t1_sections[0].get('term_num'))
    
    # Check if standard block detection yields multiple blocks
    blocks = []
    current_block = {'title': '全题宏观破题与立论逻辑', 'items': []}
    for s in sents2:
        txt = s['text'].strip()
        is_new_block, new_title = detect_t2_block(txt)
        if is_new_block and current_block['items']:
            blocks.append(current_block)
            current_block = {'title': new_title, 'items': []}
        current_block['items'].append(s)
    if current_block['items']:
        blocks.append(current_block)
        
    # If block detection collapsed into <= 1 block and we have structured t1_sections:
    # Elegantly partition Track 2 across t1_sections!
    if len(blocks) <= 1 and t1_sections and len(t1_sections) > 1:
        if is_noun:
            header_sents = []
            assigned_sections = [[] for _ in range(len(t1_sections))]
            curr_term = 0
            for s in sents2:
                m = re.match(r'^([0-9]{1,2})\.\s*', s['text'].strip())
                if m:
                    curr_term = int(m.group(1))
                if curr_term == 0:
                    header_sents.append(s)
                elif 1 <= curr_term <= len(t1_sections):
                    assigned_sections[curr_term - 1].append(s)
                    
            if header_sents:
                hdr_spans = []
                for s in header_sents:
                    txt_fmt = highlight_html(s['text'], keywords)
                    sid = s['id']
                    sstart = s['start']
                    send = s['end']
                    hdr_spans.append(f'<span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>')
                html_parts.append(f"""
                <div class="noun-lead-banner">
                  <div class="noun-lead-header">
                    <span class="noun-lead-badge">导读序言</span>
                    <span class="noun-lead-tip">西华师大 807 名词解释背诵逻辑导学</span>
                  </div>
                  <div class="noun-lead-body">
                    {"".join(hdr_spans)}
                  </div>
                </div>
                """)
                
            for i, sec in enumerate(t1_sections):
                a_sents = assigned_sections[i]
                sents_html = []
                for s in a_sents:
                    txt_fmt = highlight_html(s['text'], keywords)
                    sid = s['id']
                    sstart = s['start']
                    send = s['end']
                    sents_html.append(f"""
                    <div class="teacher-explain-row">
                      <span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                    </div>
                    """)
                block_html = f"""
                <div class="logic-block-card noun-logic-card">
                  <div class="logic-block-title">
                    <span class="logic-sec-pill">
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                      <span>名解逻辑</span>
                    </span>
                    <h3>{sec['badge']}</h3>
                  </div>
                  <div class="logic-block-body">
                    <div class="framework-qa-card">
                      <div class="qa-badge">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
                        <span>{sec['desc']}</span>
                      </div>
                    </div>
                    {"".join(sents_html)}
                  </div>
                </div>
                """
                html_parts.append(block_html)
            return f"""<div class="paper-track2-wrap">{"".join(html_parts)}</div>"""

        else:
            # Essay or standard item: partition sents2 across t1_sections using substring match
            assigned_sections = [[] for _ in range(len(t1_sections))]
            sec_cleans = [clean_txt(s['text']) for s in t1_sections]
            sec_ptr = 0
            for s in sents2:
                s_cl = clean_txt(s['text'])
                if sec_ptr + 1 < len(t1_sections):
                    min_req = 4 if sec_ptr == 0 else 2
                    if len(assigned_sections[sec_ptr]) >= min_req:
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
                        if not match and len(s_cl) >= 4 and s_cl in next_sec_cl[:len(s_cl)+2]:
                            match = True
                        if match:
                            sec_ptr += 1
                assigned_sections[sec_ptr].append(s)
                
            for b_idx, sec in enumerate(t1_sections):
                items = assigned_sections[b_idx]
                block_items_html = []
                
                # QA guidance pill
                block_items_html.append(f"""
                <div class="framework-qa-card">
                  <div class="qa-badge">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
                    <span>逻辑维度 · {sec['badge']}</span>
                  </div>
                  <span class="recite-sent" style="color: var(--ink-secondary); font-size: 13.5px;">{sec['desc']}</span>
                </div>
                """)
                
                for s in items:
                    txt_fmt = highlight_html(s['text'], keywords)
                    sid = s['id']
                    sstart = s['start']
                    send = s['end']
                    block_items_html.append(f"""
                    <div class="teacher-explain-row">
                      <span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                    </div>
                    """)
                    
                # Link gold quote from T1 section
                if sec.get('text'):
                    s_list = split_sentences_proper(sec['text'])
                    t1_spans = []
                    for idx_s, st in enumerate(s_list):
                        st_clean = re.sub(r'^[、\-\*•\s]+', '', st).replace('**', '').replace('*', '').strip()
                        if not st_clean:
                            continue
                        st_fmt = highlight_html(st_clean, keywords)
                        pill = f'<span class="thesis-pill">{sec["badge"]}</span>' if idx_s == 0 else ''
                        t1_spans.append(f'<span class="recite-sent gold-sent-active t1-linked-sent">{pill}<strong class="quote-gold-core">{st_fmt}</strong></span>')
                    if t1_spans:
                        block_items_html.append(f"""
                        <div class="gold-quote-box linked-t1-quote">
                          <div class="gold-quote-header">
                            <span class="gold-badge">
                              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                              <span>考场对应正式答题原句 · {sec['badge']}</span>
                            </span>
                            <span class="gold-tip">联动 Track 1 高分卷面 · 考场一字不差背诵</span>
                          </div>
                          <div class="gold-quote-body">
                            {"".join(t1_spans)}
                          </div>
                        </div>
                        """)
                        
                block_html = f"""
                <div class="logic-block-card">
                  <div class="logic-block-title">
                    <span class="logic-sec-pill">
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                      <span>逻辑剖析</span>
                    </span>
                    <h3>{sec['badge']} · {sec['desc']}</h3>
                  </div>
                  <div class="logic-block-body">
                    {"".join(block_items_html)}
                  </div>
                </div>
                """
                html_parts.append(block_html)
                
            return f"""<div class="paper-track2-wrap">{"".join(html_parts)}</div>"""

    # Multi-block mode with real quotes
    for b_idx, b in enumerate(blocks):
        block_items_html = []
        items = b['items']
        i = 0
        has_real_quote = False
        
        while i < len(items):
            s = items[i]
            txt = s['text'].strip()
            
            is_quote = any(c in txt for c in connectors) and not is_fake_quote(txt)
            is_qa = any(txt.startswith(x) for x in ['1.', '2.', '3.', '4.', '一、这道题', '二、应该从', '三、从哪些', '四、这三个', '这道题到底', '应该从什么', '从哪些方面', '内在逻辑是', '问题一', '问题二', '问题三', '问题四'])
            
            if is_qa:
                txt_fmt = highlight_html(s['text'], keywords)
                sid = s['id']
                sstart = s['start']
                send = s['end']
                block_items_html.append(f"""
                <div class="framework-qa-card">
                  <div class="qa-badge">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>
                    <span>审题指引与立意维度</span>
                  </div>
                  <span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                </div>
                """)
                i += 1
            elif is_quote:
                has_real_quote = True
                quote_chunks = [s]
                while i + 1 < len(items):
                    next_s = items[i+1]
                    next_txt = next_s['text'].strip()
                    if should_stop_quote(next_txt):
                        break
                    if any(clean_txt(next_txt) == clean_txt(qc['text']) for qc in quote_chunks if len(clean_txt(qc['text'])) > 8):
                        break
                    i += 1
                    quote_chunks.append(items[i])
                    
                quote_spans = []
                for idx_qc, qc in enumerate(quote_chunks):
                    qc_fmt = format_quote_chunk(qc['text'], idx_qc == 0, keywords)
                    sid = qc['id']
                    sstart = qc['start']
                    send = qc['end']
                    quote_spans.append(f'<span class="recite-sent gold-sent-active" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{qc_fmt}</span>')
                    
                block_items_html.append(f"""
                <div class="gold-quote-box">
                  <div class="gold-quote-header">
                    <span class="gold-badge">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      <span>考场对应答题原句</span>
                    </span>
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
                row_cls = "teacher-explain-row"
                if any(c in txt for c in connectors) and is_fake_quote(txt):
                    row_cls += " teacher-guidance-lead"
                block_items_html.append(f"""
                <div class="{row_cls}">
                  <span class="recite-sent" data-sent-id="{sid}" data-sent-idx="{sid}" data-start="{sstart}" data-end="{send}">{txt_fmt}</span>
                </div>
                """)
                i += 1
                
        if needs_t1_linking and t1_sections:
            target_sec = None
            if b_idx == 0:
                target_sec = t1_sections[0]
            elif b_idx >= len(blocks) - 1:
                target_sec = t1_sections[-1]
            else:
                point_secs = [s for s in t1_sections if s['type'] == 'point']
                if point_secs:
                    pt_idx = min(b_idx - 1, len(point_secs) - 1)
                    target_sec = point_secs[pt_idx]
                elif b_idx < len(t1_sections):
                    target_sec = t1_sections[b_idx]
                    
            if target_sec and target_sec.get('text'):
                s_list = split_sentences_proper(target_sec['text'])
                t1_spans = []
                for idx_s, st in enumerate(s_list):
                    st_clean = re.sub(r'^[、\-\*•\s]+', '', st).replace('**', '').replace('*', '').strip()
                    if not st_clean:
                        continue
                    st_fmt = highlight_html(st_clean, keywords)
                    pill = f'<span class="thesis-pill">{target_sec["badge"]}</span>' if idx_s == 0 else ''
                    t1_spans.append(f'<span class="recite-sent gold-sent-active t1-linked-sent">{pill}<strong class="quote-gold-core">{st_fmt}</strong></span>')
                    
                block_items_html.append(f"""
                <div class="gold-quote-box linked-t1-quote">
                  <div class="gold-quote-header">
                    <span class="gold-badge">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      <span>考场对应正式答题原句 · {target_sec['badge']}</span>
                    </span>
                    <span class="gold-tip">联动 Track 1 高分卷面 · 考场一字不差背诵</span>
                  </div>
                  <div class="gold-quote-body">
                    {"".join(t1_spans)}
                  </div>
                </div>
                """)
                
        block_html = f"""
        <div class="logic-block-card">
          <div class="logic-block-title">
            <span class="logic-sec-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
              <span>逻辑剖析</span>
            </span>
            <h3>{b['title']}</h3>
          </div>
          <div class="logic-block-body">
            {"".join(block_items_html)}
          </div>
        </div>
        """
        html_parts.append(block_html)
        
    return f"""<div class="paper-track2-wrap">{"".join(html_parts)}</div>"""

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except Exception:
            pass

    all_items = data.get("items_807", []) + data.get("items_706", [])
    print(f"Starting processing {len(all_items)} items...")

    all_sentences_map = {}

    for idx, item in enumerate(all_items):
        sub = item.get("subject", "807")
        src_dir = src_807 if sub == "807" else src_706
        
        clean_id = item["id"].replace("807_", "").replace("706_", "")
        parts = clean_id.split("_")
        
        md_matches = list(src_dir.glob(f"{clean_id}*.md"))
        if not md_matches:
            if parts[0] == "00":
                md_matches = list(src_dir.glob(f"00_807*_{parts[2]}_*.md"))
            elif len(parts) >= 4:
                md_matches = list(src_dir.glob(f"{parts[0]}_*_{parts[2]}_{parts[3]}_*.md"))
            if not md_matches and len(parts) >= 3:
                md_matches = list(src_dir.glob(f"{parts[0]}_*_{parts[2]}*.md"))
            if not md_matches:
                md_matches = list(src_dir.glob(f"{parts[0]}_*.md"))
                
        md_path = md_matches[0] if md_matches else None
        if not md_path:
            print(f"[{idx+1:02d}] ERROR: Cannot find md for {item['id']}")
            continue
            
        meta = extract_meta_and_keywords(md_path)
        t1_sections = parse_track1_sections_from_md(md_path)
        
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
            item["track2"]["html"] = build_clean_track2_html(item, t2_sents, meta, md_path, t1_sections)
            
        sec_count = item["track1"]["html"].count("exam-section-card")
        t2_b_count = item["track2"]["html"].count("logic-block-card")
        print(f"[{idx+1:02d}] {sub} {item['title'][:16]:<16} | T1 sec: {sec_count:<2} | T2 blocks: {t2_b_count:<2}")

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

    # Node --check 编译期静态语法防白屏门禁
    import subprocess

    print("\n[Gate] Running node --check static syntax verification...")
    checks = [
        ("data/kaoyan_data.js", js_bundle_path),
        ("app.js", work_dir / "app.js"),
        ("sw.js", work_dir / "sw.js")
    ]

    for label, file_path in checks:
        if file_path.exists():
            res = subprocess.run(["node", "--check", str(file_path)], capture_output=True, text=True)
            if res.returncode != 0:
                print(f"[GATE FAIL] Syntax check failed on {label}:\n{res.stderr}", file=sys.stderr)
                sys.exit(1)
            print(f"  [PASS] {label}: syntax check passed")
    print("[GATE PASS] All JavaScript bundles verified with zero syntax errors!\n")

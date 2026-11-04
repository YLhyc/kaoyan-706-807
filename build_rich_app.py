import os
import sys
import json
import re
from pathlib import Path

BASE_DIR = Path(r"D:\AI_file\706_807专业课背诵手卷")
SRC_807 = Path(r"D:\AAA考研\807复习助手\outputs\双轨随身背诵库")
SRC_706 = Path(r"D:\AAA考研\706复习助手\outputs\双轨随身背诵库")

MANIFEST_PATH = BASE_DIR / "data" / "kaoyan_all_manifest.json"
manifest = json.load(open(MANIFEST_PATH, encoding="utf-8"))

def clean_norm(t):
    return re.sub(r'[\s\*\(\)（）《》“”‘’—\-\.\,\?\!，。？！、；：·0-9一二三四五六七八九十百千万]+', '', t)

def extract_metadata_and_terms(fpath):
    txt = open(fpath, encoding='utf-8').read()
    t_m = re.search(r'\*\*题型\*\*：([^\n]+)', txt)
    s_m = re.search(r'\*\*分值\*\*：([^\n]+)', txt)
    tm_m = re.search(r'\*\*建议用时\*\*：([^\n]+)', txt)
    w_m = re.search(r'\*\*目标字数\*\*：([^\n]+)', txt)
    
    q_type = t_m.group(1).strip() if t_m else ('论述题' if '30分' in str(fpath) else '简答题')
    score = s_m.group(1).strip() if s_m else ('30分' if '30分' in str(fpath) else '20分')
    time_est = tm_m.group(1).strip() if tm_m else ('约 35 分钟' if '30分' in str(fpath) else '约 20 分钟')
    words = w_m.group(1).strip() if w_m else ('约 1000~1200 字' if '30分' in str(fpath) else '约 500~600 字')
    words = words.replace('，完全符合考场高分规范！', '').strip()
    
    bold_terms = [b.strip() for b in re.findall(r'\*\*([^*]+)\*\*', txt) if len(b.strip()) > 1]
    
    # Thesis sentences: long bold terms
    thesis_sents = [b for b in bold_terms if len(b) >= 12]
    keywords = [b for b in bold_terms if 2 <= len(b) < 12 and not any(b.startswith(x) for x in ['题型', '分值', '建议', '目标', '第一', '第二', '第三', '第四'])]
    
    return q_type, score, time_est, words, thesis_sents, keywords

def highlight_html(text, keywords):
    sorted_kw = sorted(list(set(keywords)), key=len, reverse=True)
    res = text
    for kw in sorted_kw:
        if len(kw) < 2:
            continue
        pattern = re.compile(rf'(?<![<"\']){re.escape(kw)}(?![>"\'])')
        res = pattern.sub(f'<strong class="kw-red">{kw}</strong>', res)
    return res

def build_track1_html(item, sents, meta):
    q_type, score, time_est, words, thesis_sents, keywords = meta
    
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
    
    sections = []
    current_sec = {
        'badge': '【引论 · 立论破题】',
        'desc': '确立宏观文学史定位 · 凝练论述核心中心句',
        'type': 'intro',
        'sents': []
    }
    
    for s in sents:
        txt = s['text'].strip()
        is_new_point = False
        point_badge = ''
        point_desc = ''
        sec_type = 'point'
        
        if any(txt.startswith(p) for p in ['第一，', '第一、', '首先，', '首先、', '一、']):
            is_new_point = True
            point_badge = '【本论 · 分论点一】'
            point_desc = '核心要旨深化 · 思想维度纵深展开'
        elif any(txt.startswith(p) for p in ['第二，', '第二、', '其次，', '其次、', '二、']):
            is_new_point = True
            point_badge = '【本论 · 分论点二】'
            point_desc = '多维向度剖析 · 人物与文本肌理细读'
        elif any(txt.startswith(p) for p in ['第三，', '第三、', '再次，', '再次、', '三、']):
            is_new_point = True
            point_badge = '【本论 · 分论点三】'
            point_desc = '审美形式审视 · 艺术结构与文体革新'
        elif any(txt.startswith(p) for p in ['第四，', '第四、', '四、']):
            is_new_point = True
            point_badge = '【本论 · 分论点四】'
            point_desc = '范式飞跃 · 文学史价值终极升华'
        elif any(txt.startswith(p) for p in ['综上所述', '总之', '总而言之', '结语']):
            is_new_point = True
            point_badge = '【结语 · 总结升华】'
            point_desc = '融汇全篇论据 · 提炼终极经典地位'
            sec_type = 'conclusion'
            
        if is_new_point and current_sec['sents']:
            sections.append(current_sec)
            current_sec = {
                'badge': point_badge,
                'desc': point_desc,
                'type': sec_type,
                'sents': []
            }
            
        current_sec['sents'].append(s)
        
    if current_sec['sents']:
        sections.append(current_sec)
        
    cards_html = []
    for sec in sections:
        sec_card = f"""
        <section class="exam-section-card card-{sec['type']}">
          <div class="section-card-header">
            <span class="sec-badge badge-{sec['type']}">{sec['badge']}</span>
            <span class="sec-desc">{sec['desc']}</span>
          </div>
          <div class="section-card-content">
        """
        
        sent_spans = []
        for s in sec['sents']:
            txt = s['text']
            is_thesis = False
            s_clean = clean_norm(txt)
            for ts in thesis_sents:
                ts_clean = clean_norm(ts)
                if len(s_clean) >= 6 and (s_clean in ts_clean or ts_clean in s_clean or ts_clean[:8] in s_clean):
                    is_thesis = True
                    break
                    
            formatted_text = highlight_html(txt, keywords)
            thesis_class = " thesis-statement" if is_thesis else ""
            thesis_tag = '<span class="thesis-pill">论述中心句</span>' if is_thesis else ''
            
            sent_spans.append(f"""<span class="recite-sent{thesis_class}" data-sent-id="{s['id']}" data-start="{s['start']}" data-end="{s['end']}">{thesis_tag}{formatted_text}</span> """)
            
        sec_card += "".join(sent_spans)
        sec_card += """
          </div>
        </section>
        """
        cards_html.append(sec_card)
        
    return f"""<div class="paper-track1-wrap">{spec_html}{"".join(cards_html)}</div>"""

def build_track2_html(item, sents2, meta):
    q_type, score, time_est, words, thesis_sents, keywords = meta
    
    # We parse Track 2 into:
    # 1. Global Framework Banner (Q1-Q4)
    # 2. Logic Block Cards with Gold Sentences & Teacher Explanations
    
    html_parts = []
    
    html_parts.append(f"""
    <div class="global-framework-box">
      <div class="framework-banner">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
        <span>【一】全局审题与立意建构 · 名师导学解题图谱</span>
      </div>
      <div class="framework-tip">考场高分秘诀：答题绝非机械默写，必须精准咬合命题意图、答题高度与展开逻辑！</div>
    </div>
    """)
    
    current_block = {
        'title': '【一、全题宏观破题与导论】',
        'items': []
    }
    blocks = []
    
    for s in sents2:
        txt = s['text'].strip()
        
        # Check section boundary
        if any(txt.startswith(x) for x in ['【一、', '【二、', '【三、', '【四、', '【五、', '【六、', '一、全题', '二、第一板块', '三、第二板块', '四、第三板块', '五、第四板块', '六、第五板块', '【第一阶段', '【第二阶段', '【第三阶段', '【第四阶段', '【第五阶段', '【第六阶段']):
            if current_block['items']:
                blocks.append(current_block)
            current_block = {
                'title': txt,
                'items': []
            }
            continue
            
        current_block['items'].append(s)
        
    if current_block['items']:
        blocks.append(current_block)
        
    for b in blocks:
        block_html = f"""
        <div class="logic-block-card">
          <div class="logic-block-title">
            <span class="logic-sec-pill">逻辑板块</span>
            <h3>{b['title']}</h3>
          </div>
          <div class="logic-block-body">
        """
        
        for s in b['items']:
            txt = s['text']
            is_gold = any(x in txt for x in ['具体表述到答题语句就是', '对应考场原句是', '本句是：', '答题原句']) or any(clean_norm(txt)[:8] in clean_norm(ts) for ts in thesis_sents if len(clean_norm(ts)) >= 8)
            is_qa = any(txt.startswith(x) for x in ['【1.', '【2.', '【3.', '【4.', '一、这道题', '二、应该从', '三、从哪些', '四、这三个'])
            
            formatted_text = highlight_html(txt, keywords)
            
            if is_qa:
                block_html += f"""
                <div class="framework-qa-card">
                  <div class="qa-badge">审题核心维度</div>
                  <span class="recite-sent" data-sent-id="{s['id']}" data-start="{s['start']}" data-end="{s['end']}">{formatted_text}</span>
                </div>
                """
            elif is_gold:
                block_html += f"""
                <div class="gold-sent-card">
                  <div class="gold-card-header">
                    <span class="gold-badge">【考场金句 · 黄金得分点】</span>
                    <span class="gold-tip">提炼核心句 · 一眼踩中给分点</span>
                  </div>
                  <div class="gold-content">
                    <span class="recite-sent gold-sent-active" data-sent-id="{s['id']}" data-start="{s['start']}" data-end="{s['end']}">{formatted_text}</span>
                  </div>
                </div>
                """
            else:
                block_html += f"""
                <div class="teacher-explain-card">
                  <div class="explain-card-header">
                    <span class="explain-badge">💡 名师逻辑咬合精解</span>
                  </div>
                  <div class="explain-content">
                    <span class="recite-sent" data-sent-id="{s['id']}" data-start="{s['start']}" data-end="{s['end']}">{formatted_text}</span>
                  </div>
                </div>
                """
                
        block_html += """
          </div>
        </div>
        """
        html_parts.append(block_html)
        
    return f"""<div class="paper-track2-wrap">{"".join(html_parts)}</div>"""

print("Building rich HTML for all 36 items...")

embedded_sentences = {}
count = 0

for subj in ["items_807", "items_706"]:
    src_dir = SRC_807 if subj == "items_807" else SRC_706
    for it in manifest[subj]:
        count += 1
        stem = it["stem"]
        md_file = src_dir / f"{stem}.md"
        if not md_file.exists():
            # fallback search
            for f in src_dir.glob("*.md"):
                if it["id"].split("_", 1)[1] in f.stem:
                    md_file = f
                    break
                    
        meta = extract_metadata_and_terms(md_file)
        
        # Track 1
        t1_json = BASE_DIR / it["track1"]["sentences_file"]
        sents1 = json.load(open(t1_json, encoding="utf-8"))
        it["track1"]["html"] = build_track1_html(it, sents1, meta)
        embedded_sentences[it["track1"]["sentences_file"].replace("\\", "/")] = sents1
        
        # Track 2
        t2_json = BASE_DIR / it["track2"]["sentences_file"]
        sents2 = json.load(open(t2_json, encoding="utf-8"))
        it["track2"]["html"] = build_track2_html(it, sents2, meta)
        embedded_sentences[it["track2"]["sentences_file"].replace("\\", "/")] = sents2

print(f"Successfully processed {count} items with rich typography and highlight cards.")

# Save manifest
with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

# Save kaoyan_data.js
js_content = f"// 2027 考研专业课双轨随身背诵手卷 · 离线全量数据包（内置高保真排版与毫秒时间戳）\nwindow.KAOYAN_MANIFEST = {json.dumps(manifest, ensure_ascii=False)};\nwindow.KAOYAN_SENTENCES = {json.dumps(embedded_sentences, ensure_ascii=False)};\n"

with open(BASE_DIR / "data" / "kaoyan_data.js", "w", encoding="utf-8") as f:
    f.write(js_content)

print(f"[OK] Created rich offline data package: {BASE_DIR / 'data' / 'kaoyan_data.js'} ({len(js_content)/1024/1024:.2f} MB)")

# Node --check 编译期静态语法防白屏门禁
import subprocess
import sys

print("\n[Gate] Running node --check static syntax verification...")
checks = [
    ("data/kaoyan_data.js", BASE_DIR / "data" / "kaoyan_data.js"),
    ("app.js", BASE_DIR / "app.js"),
    ("sw.js", BASE_DIR / "sw.js")
]

for label, file_path in checks:
    if file_path.exists():
        res = subprocess.run(["node", "--check", str(file_path)], capture_output=True, text=True)
        if res.returncode != 0:
            print(f"❌ [GATE FAIL] Syntax check failed on {label}:\n{res.stderr}", file=sys.stderr)
            sys.exit(1)
        print(f"  ✓ {label}: syntax check passed")
print("✅ [GATE PASS] All JavaScript bundles verified with zero syntax errors!\n")

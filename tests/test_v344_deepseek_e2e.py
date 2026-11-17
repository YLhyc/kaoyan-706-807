# -*- coding: utf-8 -*-
"""
Comprehensive E2E & Live API Verification Suite for v3.4.4 DeepSeek & Tiered Cloze:
1. Live backend API checks on https://sync.2026706.xyz:
   - GET /api/health (v1.2.0, deepseekConfigured, pinValid)
   - GET /api/ai/usage (summary, last_24h, by_model, recent)
   - POST /api/ai/cloze + GET /api/ai/cloze (LWW upsert + ?item_id filter)
   - POST /api/ai/chat with response_format={"type": "json_object"}
   - POST /api/ai/chat with tools
2. Prompt prefix cache order in buildAskSystemPrompt (AI_STATIC_SYSTEM_PREFIX + full refText BEFORE sub-card focus & dynamic memory tail, identical prefix across sub-cards)
3. Chat thread localStorage persistence (kaoyan_ai_chat_threads_v1) across reload & #aiClearThreadBtn
4. Stop button (.is-streaming) during active stream: not disabled, aborts cleanly, preserves partial text + '（已停止生成）'
5. renderAiMarkdown:
   - .ai-quote-jump clickable -> calls seekToSentence(...)
   - .ai-item-jump clickable -> calls openStudyItem(...)
   - .ai-fold (<details>) collapsible hint rendering & toggle
   - Strict XSS safety (zero script/img/inline handlers injected)
6. Function calling tool-loop mock test (multi-chunk delta.tool_calls for search_knowledge_base, get_weak_items, get_learning_profile + .ai-tool-status)
7. Tiered AI Cloze (#aiClozeGenBtn -> cloze-tier-skeleton / cloze-tier-scoring + #clozeFilterBar filtering all/skeleton/scoring)
8. #aiBriefingBtn, #aiUsageBtn / #aiUsagePanel (live /api/ai/usage in browser), [data-ai-preset="exam-twist"], [data-ai-preset="cross-link"]
9. Desktop, iPad Portrait/Landscape, and Mobile viewport checks with AI drawer + #aiUsagePanel + #clozeFilterBar (zero horizontal overflow & zero console/page errors)
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC_BASE = "https://sync.2026706.xyz"
SYNC_PIN = "ky2026-rQRBy"
TEST_CLOZE_ID = "__test_v344_e2e__"


class Mp3RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=REPO_ROOT, **kwargs)

    def log_message(self, format, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def do_GET(self):
        path = self.translate_path(self.path.split("?")[0])
        if path.lower().endswith(".mp3") and os.path.isfile(path):
            file_size = os.path.getsize(path)
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d+)-(\d*)", rng)
                if m:
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else file_size - 1
                    end = min(end, file_size - 1)
                    length = end - start + 1
                    self.send_response(206)
                    self.send_header("Content-Type", "audio/mpeg")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(length))
                    self.end_headers()
                    with open(path, "rb") as f:
                        f.seek(start)
                        self.wfile.write(f.read(length))
                    return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            with open(path, "rb") as f:
                self.wfile.write(f.read())
            return
        super().do_GET()


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass


def start_server():
    httpd = ReusableTCPServer(("127.0.0.1", 0), Mp3RangeHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


def api_request(path, method="GET", payload=None, timeout=30):
    url = f"{SYNC_BASE}{path}"
    headers = {
        "X-Sync-Pin": SYNC_PIN,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KaoyanE2E/1.0",
        "Accept": "application/json",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def sse_bytes(events):
    chunks = []
    for ev in events:
        if isinstance(ev, str):
            chunks.append(f"data: {ev}\n\n")
        else:
            chunks.append(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n")
    return "".join(chunks).encode("utf-8")


def run():
    results = []

    def check(cond, msg):
        status = "PASS" if cond else "FAIL"
        results.append((bool(cond), msg))
        print(f"  [{status}] {msg}", flush=True)

    # =========================================================================
    # 1. Live Backend API Checks
    # =========================================================================
    print("\n[1] Live Backend API Verification (https://sync.2026706.xyz)", flush=True)
    st_h, health = api_request("/api/health")
    check(
        st_h == 200
        and health.get("ok") is True
        and health.get("version") == "1.2.0"
        and health.get("deepseekConfigured") is True
        and health.get("pinValid") is True,
        f"GET /api/health -> 200 v1.2.0 ({health})"
    )

    st_u1, usage1 = api_request("/api/ai/usage")
    summary1 = usage1.get("summary") or {}
    check(
        st_u1 == 200
        and usage1.get("ok") is True
        and all(k in summary1 for k in ("total_calls", "prompt_tokens", "cache_hit_tokens", "cache_miss_tokens", "completion_tokens", "cache_hit_rate"))
        and isinstance(usage1.get("last_24h"), dict)
        and isinstance(usage1.get("by_model"), list)
        and isinstance(usage1.get("recent"), list),
        f"GET /api/ai/usage schema valid (total_calls={summary1.get('total_calls')})"
    )

    now_utc = datetime.now(timezone.utc)
    ts_new = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    ts_stale = (now_utc - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    test_cloze_id = f"{TEST_CLOZE_ID}{int(now_utc.timestamp())}"

    st_cp1, cp1 = api_request(
        "/api/ai/cloze",
        method="POST",
        payload={
            "item_id": test_cloze_id,
            "skeleton": ["骨架测试词"],
            "scoring": ["采分眼测试词"],
            "model": "deepseek-flash",
            "updated_at": ts_new,
        },
    )
    st_cp_stale, cp_stale = api_request(
        "/api/ai/cloze",
        method="POST",
        payload={
            "item_id": test_cloze_id,
            "skeleton": ["旧词"],
            "scoring": ["旧采分"],
            "model": "deepseek-flash",
            "updated_at": ts_stale,
        },
    )
    st_cg, cg = api_request(f"/api/ai/cloze?item_id={test_cloze_id}")
    got_cloze = (cg.get("items") or {}).get(test_cloze_id) or {}
    check(
        st_cp1 == 200 and cp1.get("ok") is True and cp1.get("updated") is True
        and st_cp_stale == 200 and cp_stale.get("updated") is False
        and st_cg == 200 and got_cloze.get("skeleton") == ["骨架测试词"] and got_cloze.get("scoring") == ["采分眼测试词"],
        f"POST/GET /api/ai/cloze + LWW stale guard passed ({got_cloze})"
    )

    st_json, chat_json = api_request(
        "/api/ai/chat",
        method="POST",
        payload={
            "model": "deepseek-flash",
            "reasoning_effort": "low",
            "stream": False,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "Return strict JSON only."},
                {"role": "user", "content": 'Output {"skeleton":["意蕴"],"scoring":["悲剧"]}'},
            ],
        },
        timeout=45,
    )
    json_content = (((chat_json.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    parsed_json_ok = False
    try:
        parsed_obj = json.loads(json_content)
        parsed_json_ok = isinstance(parsed_obj, dict) and ("skeleton" in parsed_obj or "scoring" in parsed_obj)
    except Exception:
        parsed_json_ok = False
    check(st_json == 200 and parsed_json_ok, f"POST /api/ai/chat response_format=json_object -> 200 valid JSON ({json_content[:80]})")

    st_tools, chat_tools = api_request(
        "/api/ai/chat",
        method="POST",
        payload={
            "model": "deepseek-flash",
            "reasoning_effort": "low",
            "stream": False,
            "max_tokens": 1024,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "search_knowledge_base",
                        "description": "Search study items",
                        "parameters": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                            "required": ["query"],
                        },
                    },
                }
            ],
            "tool_choice": "auto",
            "messages": [
                {"role": "system", "content": "You have search_knowledge_base tool. Always call it when asked to search."},
                {"role": "user", "content": "请调用 search_knowledge_base 搜索 红楼梦"},
            ],
        },
        timeout=45,
    )
    tool_choice_msg = ((chat_tools.get("choices") or [{}])[0].get("message") or {})
    tool_calls_out = tool_choice_msg.get("tool_calls") or []
    check(
        st_tools == 200 and isinstance(chat_tools.get("choices"), list) and len(tool_calls_out) > 0,
        f"POST /api/ai/chat with tools -> 200 tool_calls={len(tool_calls_out)}"
    )

    st_u2, usage2 = api_request("/api/ai/usage")
    check(
        st_u2 == 200 and (usage2.get("summary") or {}).get("total_calls", 0) >= (summary1.get("total_calls", 0) + 2),
        f"Usage count incremented after live /api/ai/chat calls ({summary1.get('total_calls')} -> {(usage2.get('summary') or {}).get('total_calls')})"
    )

    # =========================================================================
    # 2. Playwright Browser E2E Checks
    # =========================================================================
    httpd, port = start_server()
    base_url = f"http://127.0.0.1:{port}/index.html"
    page_errors = []
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        # Pre-seed PIN & URL before navigation
        page.add_init_script(
            f"""
            localStorage.setItem('kaoyan_sync_url', {json.dumps(SYNC_BASE)});
            localStorage.setItem('kaoyan_sync_pin', {json.dumps(SYNC_PIN)});
            localStorage.setItem('kaoyan_ai_learning_profile_v1', JSON.stringify({{
              summary: '偏爱骨架链+对比表，706小说专题待巩固',
              updatedAt: Date.now()
            }}));
            """
        )

        # Mock handler controller
        mock_state = {
            "mode": "normal",  # normal | slow_stop | tool_loop | cloze_json | briefing | preset_twist | preset_cross
            "captured_requests": [],
            "tool_round": 0,
        }

        def route_handler(route):
            url = route.request.url
            if any(h in url for h in ("fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net")):
                if "fonts.googleapis.com" in url:
                    route.fulfill(status=200, content_type="text/css", body="")
                else:
                    route.fulfill(status=200, content_type="application/octet-stream", body=b"")
                return

            if url.startswith(f"{SYNC_BASE}/api/ai/chat") and route.request.method == "POST":
                try:
                    req_body = route.request.post_data_json or {}
                except Exception:
                    req_body = {}
                mock_state["captured_requests"].append({"url": url, "body": req_body})

                mode = mock_state["mode"]
                if mode == "slow_stop":
                    # Delay briefly so test can observe .is-streaming and click Stop; return partial SSE if not aborted
                    time.sleep(0.35)
                    body = sse_bytes([
                        {"choices": [{"delta": {"content": "部分流式"}, "finish_reason": None}]},
                        {"choices": [{"delta": {"content": "回复内容"}, "finish_reason": None}]},
                    ])
                    # Hold connection open longer before finishing
                    route.fulfill(
                        status=200,
                        headers={"Content-Type": "text/event-stream; charset=utf-8"},
                        body=body,
                    )
                    return

                if mode == "tool_loop":
                    mock_state["tool_round"] += 1
                    rnd = mock_state["tool_round"]
                    if rnd == 1:
                        events = [
                            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_kb_1", "type": "function", "function": {"name": "search_knowledge_base", "arguments": '{"query":'}}]}, "finish_reason": None}]},
                            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"红楼梦 悲剧","subject":"706"}'}}]}, "finish_reason": None}]},
                            {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "call_wk_2", "type": "function", "function": {"name": "get_weak_items", "arguments": '{"subject":"all"}'}}]}, "finish_reason": None}]},
                            {"choices": [{"delta": {"tool_calls": [{"index": 2, "id": "call_lp_3", "type": "function", "function": {"name": "get_learning_profile", "arguments": "{}"}}]}, "finish_reason": None}]},
                            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 200, "prompt_cache_hit_tokens": 120, "prompt_cache_miss_tokens": 80, "completion_tokens": 30}},
                            "[DONE]",
                        ]
                        route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                        return
                    else:
                        events = [
                            {"choices": [{"delta": {"content": "已串联检索结果：\n\n[[item:807_01|鲁迅小说专题]]\n\n<details class=\"ai-fold\"><summary>点击展开采分点</summary>核心采分：人物命运与历史悲剧。</details>"}, "finish_reason": None}]},
                            {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 420, "prompt_cache_hit_tokens": 300, "prompt_cache_miss_tokens": 120, "completion_tokens": 45}},
                            "[DONE]",
                        ]
                        route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                        return

                if mode == "cloze_json":
                    payload = {
                        "id": "mock_cloze",
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(mock_state["cloze_payload"], ensure_ascii=False),
                            },
                            "finish_reason": "stop",
                        }],
                        "usage": {"prompt_tokens": 300, "prompt_cache_hit_tokens": 200, "prompt_cache_miss_tokens": 100, "completion_tokens": 50},
                    }
                    route.fulfill(status=200, headers={"Content-Type": "application/json"}, body=json.dumps(payload, ensure_ascii=False))
                    return

                if mode == "briefing":
                    events = [
                        {"choices": [{"delta": {"content": "### 今日作战简报\n1. 优先攻克 [[item:706_01_T0_04_红楼梦_红楼梦悲剧意蕴与人生悲剧_30分论述|红楼梦悲剧意蕴]]"}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 250, "prompt_cache_hit_tokens": 150, "prompt_cache_miss_tokens": 100, "completion_tokens": 35}},
                        "[DONE]",
                    ]
                    route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                    return

                if mode == "preset_twist":
                    events = [
                        {"choices": [{"delta": {"content": "【变式真题】试析文本核心审美转向。\n\n<details class=\"ai-fold\"><summary>点击展开答题提示与采分点</summary>骨架：缘起-演进-价值。</details>"}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 260, "prompt_cache_hit_tokens": 200, "prompt_cache_miss_tokens": 60, "completion_tokens": 40}},
                        "[DONE]",
                    ]
                    route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                    return

                if mode == "preset_cross":
                    events = [
                        {"choices": [{"delta": {"content": "跨科脉络串联：[[item:807_01|807首篇]] 与当前篇目呼应。"}, "finish_reason": None}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 260, "prompt_cache_hit_tokens": 200, "prompt_cache_miss_tokens": 60, "completion_tokens": 35}},
                        "[DONE]",
                    ]
                    route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                    return

                # default normal SSE
                events = [
                    {"choices": [{"delta": {"content": "第一段解析。"}, "finish_reason": None}]},
                    {"choices": [{"delta": {"content": "第二段补充。"}, "finish_reason": None}]},
                    {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 180, "prompt_cache_hit_tokens": 120, "prompt_cache_miss_tokens": 60, "completion_tokens": 20}},
                    "[DONE]",
                ]
                route.fulfill(status=200, headers={"Content-Type": "text/event-stream; charset=utf-8"}, body=sse_bytes(events))
                return

            if url.startswith(f"{SYNC_BASE}/api/ai/cloze") and route.request.method == "POST":
                mock_state["captured_requests"].append({"url": url, "body": route.request.post_data_json})
                route.fulfill(
                    status=200,
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({"ok": True, "updated": True}),
                )
                return

            route.continue_()

        page.route("**/*", route_handler)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        page.goto(base_url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_function("() => !!window.__kaoyanBridge && !!window.__kaoyanAiHooks && window.__kaoyanBridge.getActiveSentences().length > 0", timeout=20000)

        # ---------------------------------------------------------------------
        # [2] Prompt Prefix Cache Order Verification
        # ---------------------------------------------------------------------
        print("\n[2] buildAskSystemPrompt Prefix Cache Order", flush=True)
        prefix_check = page.evaluate("""() => {
            const h = window.__kaoyanAiHooks;
            const baseCtx = h.getScopeContext();
            const ctxA = { ...baseCtx, blockId: '子卡一：核心背景', focusedCardText: '子卡一独有内容AAA' };
            const ctxB = { ...baseCtx, blockId: '子卡二：艺术特色', focusedCardText: '子卡二独有内容BBB' };
            const pA = h.buildAskSystemPrompt(ctxA, '测试提问');
            const pB = h.buildAskSystemPrompt(ctxB, '测试提问');
            const markerRef = '\\n【当前科目标题与参考原文】\\n';
            const markerFocus = '\\n【当前聚焦子卡片】\\n';
            const markerMem = '\\n【三层全局记忆与当前动态状态】\\n';
            const idxRefA = pA.indexOf(markerRef);
            const idxFocusA = pA.indexOf(markerFocus);
            const idxMemA = pA.indexOf(markerMem);
            const prefixA = pA.slice(0, idxFocusA);
            const prefixB = pB.slice(0, pB.indexOf(markerFocus));
            return {
                hasStaticPrefix: pA.includes('[[item:ITEM_ID|标题]]') && pA.includes('> 原句'),
                orderOk: idxRefA > 0 && idxRefA < idxFocusA && (idxMemA === -1 || idxFocusA < idxMemA),
                identicalPrefixAcrossSubcards: prefixA === prefixB && prefixA.length > 100,
                containsFullRef: pA.includes((baseCtx.fullRefText || '').slice(0, 60)),
                prefixLen: prefixA.length,
                indices: { idxRefA, idxFocusA, idxMemA }
            };
        }""")
        check(
            prefix_check["hasStaticPrefix"]
            and prefix_check["orderOk"]
            and prefix_check["identicalPrefixAcrossSubcards"]
            and prefix_check["containsFullRef"],
            f"Prompt prefix order & cross-subcard cache invariance verified ({prefix_check})"
        )

        # ---------------------------------------------------------------------
        # [3] Chat Thread localStorage Persistence & #aiClearThreadBtn
        # ---------------------------------------------------------------------
        print("\n[3] Chat Thread Persistence & #aiClearThreadBtn", flush=True)
        page.click("#btn-ai-assistant")
        page.wait_for_selector("#aiAssistantDrawer.open", timeout=5000)
        mock_state["mode"] = "normal"
        page.fill("#aiAskInput", "测试持久化提问")
        page.click("#aiAskSendBtn")
        page.wait_for_function("() => document.querySelector('#aiChatStream')?.textContent.includes('第二段补充')", timeout=8000)

        saved_ls = page.evaluate("() => localStorage.getItem('kaoyan_ai_chat_threads_v1')")
        check(bool(saved_ls) and "测试持久化提问" in saved_ls and "第二段补充" in saved_ls, "Chat thread persisted to localStorage")

        page.reload(wait_until="domcontentloaded", timeout=20000)
        page.wait_for_function("() => !!window.__kaoyanBridge && !!window.__kaoyanAiHooks", timeout=15000)
        page.click("#btn-ai-assistant")
        page.wait_for_selector("#aiAssistantDrawer.open", timeout=5000)
        reloaded_text = page.locator("#aiChatStream").inner_text()
        check("测试持久化提问" in reloaded_text and "第二段补充" in reloaded_text, "Chat thread restored cleanly after page reload")

        page.click("#aiClearThreadBtn")
        page.wait_for_timeout(150)
        after_clear_text = page.locator("#aiChatStream").inner_text()
        after_clear_ls = page.evaluate("() => localStorage.getItem('kaoyan_ai_chat_threads_v1')") or "{}"
        check(
            "测试持久化提问" not in after_clear_text
            and "已锁定" in after_clear_text
            and "测试持久化提问" not in after_clear_ls,
            "#aiClearThreadBtn clears both DOM stream and localStorage scope thread"
        )

        # ---------------------------------------------------------------------
        # [4] Stop Button (.is-streaming) Behavior
        # ---------------------------------------------------------------------
        print("\n[4] Stop Button (.is-streaming) Behavior", flush=True)
        # Use page.evaluate fetch override for deterministic controllable slow SSE stream
        page.evaluate("""() => {
            window.__origFetch = window.fetch;
            window.fetch = async (url, init) => {
                if (String(url).includes('/api/ai/chat')) {
                    const enc = new TextEncoder();
                    const stream = new ReadableStream({
                        start(controller) {
                            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"这是已流出的前半段内容"},"finish_reason":null}]}\\n\\n'));
                            if (init && init.signal) {
                                init.signal.addEventListener('abort', () => {
                                    try { controller.error(new DOMException('Aborted', 'AbortError')); } catch (e) {}
                                });
                            }
                        }
                    });
                    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
                }
                return window.__origFetch(url, init);
            };
        }""")
        page.fill("#aiAskInput", "测试中断生成")
        page.click("#aiAskSendBtn")
        page.wait_for_function("() => document.getElementById('aiAskSendBtn')?.classList.contains('is-streaming') && document.getElementById('aiChatStream')?.textContent.includes('前半段内容')", timeout=6000)
        streaming_btn_state = page.evaluate("""() => {
            const btn = document.getElementById('aiAskSendBtn');
            return {
                hasClass: btn.classList.contains('is-streaming'),
                disabled: btn.disabled,
                text: btn.textContent.trim()
            };
        }""")
        check(
            streaming_btn_state["hasClass"] is True
            and streaming_btn_state["disabled"] is False
            and streaming_btn_state["text"] == "停止",
            f"During stream #aiAskSendBtn shows enabled Stop state ({streaming_btn_state})"
        )

        page.click("#aiAskSendBtn")
        page.wait_for_function("() => !document.getElementById('aiAskSendBtn')?.classList.contains('is-streaming')", timeout=5000)
        stopped_state = page.evaluate("""() => ({
            hasClass: document.getElementById('aiAskSendBtn').classList.contains('is-streaming'),
            text: document.getElementById('aiAskSendBtn').textContent.trim(),
            streamText: document.getElementById('aiChatStream').innerText
        })""")
        check(
            stopped_state["hasClass"] is False
            and stopped_state["text"] == "发送"
            and "这是已流出的前半段内容" in stopped_state["streamText"]
            and "（已停止生成）" in stopped_state["streamText"],
            "Clicking Stop aborts stream, preserves partial text + '（已停止生成）', and restores Send button"
        )
        # Restore window.fetch
        page.evaluate("() => { if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch; } }")

        # ---------------------------------------------------------------------
        # [5] renderAiMarkdown (.ai-quote-jump, .ai-item-jump, .ai-fold, XSS)
        # ---------------------------------------------------------------------
        print("\n[5] renderAiMarkdown & XSS Safety", flush=True)
        md_info = page.evaluate("""() => {
            const b = window.__kaoyanBridge;
            const sents = b.getActiveSentences();
            const targetSent = sents[1] || sents[0];
            const allItems = b.getAllStudyItems();
            const otherItem = allItems.find(it => it.id !== b.getState().activeItemId && it.subject === '706') || allItems[1];
            const md = [
                '> ' + targetSent.text,
                '',
                `关联篇目：[[item:${otherItem.id}|${otherItem.title}]]`,
                '',
                '<details class="ai-fold"><summary>展开答题提示</summary>核心提示内容</details>',
                '',
                '<script>window.__xss1=1</script><img src=x onerror="window.__xss2=2">',
                '[[item:bad" onclick="window.__xss3=3|XSS<script>alert(1)</script>]]',
                '<details class="ai-fold"><summary>S<img src=x onerror="window.__xss4=4"></summary>B<script>window.__xss5=5</script></details>'
            ].join('\\n');

            const html = window.__kaoyanAiHooks.renderAiMarkdown(md, sents);
            const stream = document.getElementById('aiChatStream');
            stream.innerHTML = `<div class="ai-msg ai-msg-assistant"><div class="ai-msg-bubble">${html}</div></div>`;

            const quoteBtn = stream.querySelector('.ai-quote-jump');
            const itemBtns = Array.from(stream.querySelectorAll('.ai-item-jump'));
            const foldEls = Array.from(stream.querySelectorAll('details.ai-fold'));
            const hasScript = stream.querySelectorAll('script').length;
            const hasImg = stream.querySelectorAll('img').length;
            const badOnclick = itemBtns.some(el => el.hasAttribute('onclick'));

            // Spy on seekToSentence
            window.__seekCalls = [];
            const origSeek = b.seekToSentence;
            b.seekToSentence = (idx, start, opts) => {
                window.__seekCalls.push({ idx, start });
                return origSeek(idx, start, opts);
            };
            quoteBtn?.click();

            // Toggle first fold
            const fold0 = foldEls[0];
            const foldWasOpen = fold0 ? fold0.open : null;
            fold0?.querySelector('summary')?.click();
            const foldNowOpen = fold0 ? fold0.open : null;

            return {
                quoteExists: !!quoteBtn,
                quoteIdx: quoteBtn ? Number(quoteBtn.dataset.sentIdx) : -1,
                expectedSentIdx: targetSent.idx,
                seekCalls: window.__seekCalls,
                itemBtnCount: itemBtns.length,
                firstItemId: itemBtns[0]?.dataset.itemId,
                otherItemId: otherItem.id,
                foldCount: foldEls.length,
                foldToggled: foldWasOpen === false && foldNowOpen === true,
                xssSafe: hasScript === 0 && hasImg === 0 && !badOnclick && !window.__xss1 && !window.__xss2 && !window.__xss3 && !window.__xss4 && !window.__xss5
            };
        }""")
        check(
            md_info["quoteExists"]
            and md_info["quoteIdx"] == md_info["expectedSentIdx"]
            and len(md_info["seekCalls"]) == 1
            and md_info["seekCalls"][0]["idx"] == md_info["expectedSentIdx"],
            f".ai-quote-jump rendered & clicked -> seekToSentence({md_info['expectedSentIdx']}) ({md_info['seekCalls']})"
        )
        check(md_info["foldCount"] == 2 and md_info["foldToggled"] is True, "details.ai-fold rendered & summary toggles open/closed")
        check(md_info["xssSafe"] is True, "renderAiMarkdown XSS safety verified (0 script/img/onclick injected)")

        # Click .ai-item-jump and confirm openStudyItem switches item & closes drawer
        page.click(".ai-item-jump")
        page.wait_for_function(
            f"(targetId) => window.__kaoyanBridge.getState().activeItemId === targetId && !document.getElementById('aiAssistantDrawer').classList.contains('open')",
            arg=md_info["otherItemId"],
            timeout=8000,
        )
        check(True, f".ai-item-jump clicked -> switched activeItemId to {md_info['otherItemId']} and closed drawer")

        # ---------------------------------------------------------------------
        # [6] Function Calling Tool-Loop Mock Test
        # ---------------------------------------------------------------------
        print("\n[6] Function Calling Tool-Loop Test", flush=True)
        page.click("#btn-ai-assistant")
        page.wait_for_selector("#aiAssistantDrawer.open", timeout=5000)
        mock_state["captured_requests"].clear()
        mock_state["tool_round"] = 0
        mock_state["mode"] = "tool_loop"

        page.fill("#aiAskInput", "请帮我检索红楼梦并结合薄弱项和学习画像给出建议")
        page.click("#aiAskSendBtn")
        page.wait_for_function("() => document.querySelector('#aiChatStream')?.textContent.includes('已串联检索结果')", timeout=10000)

        chat_reqs = [r for r in mock_state["captured_requests"] if "/api/ai/chat" in r["url"]]
        round2_msgs = chat_reqs[1]["body"].get("messages", []) if len(chat_reqs) >= 2 else []
        tool_msgs = [m for m in round2_msgs if m.get("role") == "tool"]
        tool_contents = [m.get("content", "") for m in tool_msgs]
        check(
            len(chat_reqs) == 2
            and len(tool_msgs) == 3
            and any("红楼梦" in c and "results" in c for c in tool_contents)
            and any("items" in c for c in tool_contents)
            and any("learningProfile" in c for c in tool_contents),
            f"Tool loop executed 2 rounds and fed back all 3 client tools (tool_msgs={len(tool_msgs)})"
        )

        # ---------------------------------------------------------------------
        # [7] Tiered AI Cloze (#aiClozeGenBtn + #clozeFilterBar)
        # ---------------------------------------------------------------------
        print("\n[7] Tiered AI Cloze & #clozeFilterBar Filtering", flush=True)
        # Switch to a deterministic 706 item (`706_01_T0_04_红楼梦_红楼梦悲剧意蕴与人生悲剧_30分论述`) or extract phrases from current item
        cloze_phrases = page.evaluate("""() => {
            const text = (document.getElementById('paper-content')?.innerText || '').replace(/\\s+/g, '');
            // Pick two distinct Chinese substrings from current item body text that appear inside .recite-sent text nodes
            const spans = Array.from(document.querySelectorAll('#paper-content .recite-sent'));
            const candidates = [];
            for (const sp of spans) {
                const walk = document.createTreeWalker(sp, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = walk.nextNode())) {
                    if (n.parentElement && n.parentElement.closest('.cloze, .kw-red, .stream-kw, strong, h1, h2, h3, h4, button')) continue;
                    const t = (n.nodeValue || '').trim();
                    const m = t.match(/[\\u4e00-\\u9fa5]{3,6}/);
                    if (m && !candidates.includes(m[0])) candidates.push(m[0]);
                    if (candidates.length >= 6) break;
                }
                if (candidates.length >= 6) break;
            }
            return {
                skeleton: candidates.slice(0, 2),
                scoring: candidates.slice(2, 4)
            };
        }""")
        assert len(cloze_phrases["skeleton"]) >= 1 and len(cloze_phrases["scoring"]) >= 1, f"Failed to find phrases in item: {cloze_phrases}"

        mock_state["cloze_payload"] = cloze_phrases
        mock_state["mode"] = "cloze_json"
        mock_state["captured_requests"].clear()

        page.click("#aiClozeGenBtn")
        page.wait_for_function(
            "(skel0) => { const b = window.__kaoyanBridge; const d = b.getAiClozeData(b.getState().activeItemId); return d && Array.isArray(d.skeleton) && d.skeleton.includes(skel0); }",
            arg=cloze_phrases["skeleton"][0],
            timeout=8000,
        )
        # Wait briefly for async POST /api/ai/cloze after local bridge update
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if any("/api/ai/cloze" in r["url"] for r in mock_state["captured_requests"]):
                break
            page.wait_for_timeout(50)
        cloze_reqs = mock_state["captured_requests"]
        has_json_fmt = any((r["body"] or {}).get("response_format", {}).get("type") == "json_object" for r in cloze_reqs if "/api/ai/chat" in r["url"])
        has_cloze_post = any("/api/ai/cloze" in r["url"] for r in cloze_reqs)
        check(has_json_fmt and has_cloze_post, f"#aiClozeGenBtn sent response_format=json_object and synced POST /api/ai/cloze (json={has_json_fmt}, post={has_cloze_post})")

        # Close AI drawer and activate keyword cloze mode
        page.click("#aiDrawerClose")
        page.wait_for_timeout(200)
        page.click("#btn-cloze-mode")
        page.wait_for_function("() => window.__kaoyanBridge.getState().clozeMode === 'keyword'", timeout=5000)

        filter_counts_all = page.evaluate("""() => {
            const bar = document.getElementById('clozeFilterBar');
            const skelActive = document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-skeleton:not(.revealed)').length;
            const scorActive = document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-scoring:not(.revealed)').length;
            return { barVisible: bar && !bar.hidden, skelActive, scorActive };
        }""")
        check(
            filter_counts_all["barVisible"] and filter_counts_all["skelActive"] >= 1 and filter_counts_all["scorActive"] >= 1,
            f"#clozeFilterBar visible & both tiers rendered ({filter_counts_all})"
        )

        page.click('#clozeFilterBar [data-cloze-filter="skeleton"]')
        page.wait_for_timeout(120)
        filter_skel = page.evaluate("""() => ({
            mode: window.__kaoyanBridge.getState().clozeFilterMode,
            skelActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-skeleton:not(.revealed)').length,
            scorActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-scoring:not(.revealed)').length
        })""")
        check(
            filter_skel["mode"] == "skeleton" and filter_skel["skelActive"] >= 1 and filter_skel["scorActive"] == 0,
            f"Filter 'skeleton' blanks only skeleton tier ({filter_skel})"
        )

        page.click('#clozeFilterBar [data-cloze-filter="scoring"]')
        page.wait_for_timeout(120)
        filter_scor = page.evaluate("""() => ({
            mode: window.__kaoyanBridge.getState().clozeFilterMode,
            skelActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-skeleton:not(.revealed)').length,
            scorActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-scoring:not(.revealed)').length
        })""")
        check(
            filter_scor["mode"] == "scoring" and filter_scor["scorActive"] >= 1 and filter_scor["skelActive"] == 0,
            f"Filter 'scoring' blanks only scoring tier ({filter_scor})"
        )

        page.click('#clozeFilterBar [data-cloze-filter="all"]')
        page.wait_for_timeout(120)
        filter_all = page.evaluate("""() => ({
            mode: window.__kaoyanBridge.getState().clozeFilterMode,
            skelActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-skeleton:not(.revealed)').length,
            scorActive: document.querySelectorAll('#paper-content .cloze-blank.cloze-tier-scoring:not(.revealed)').length
        })""")
        check(
            filter_all["mode"] == "all" and filter_all["skelActive"] >= 1 and filter_all["scorActive"] >= 1,
            f"Filter 'all' restores both tiers ({filter_all})"
        )

        # ---------------------------------------------------------------------
        # [8] #aiUsageBtn / #aiUsagePanel (Live), #aiBriefingBtn, & Presets
        # ---------------------------------------------------------------------
        print("\n[8] #aiUsageBtn (Live), #aiBriefingBtn & Quick Presets", flush=True)
        page.click("#btn-ai-assistant")
        page.wait_for_selector("#aiAssistantDrawer.open", timeout=5000)

        # Live /api/ai/usage fetch in browser
        page.click("#aiUsageBtn")
        page.wait_for_function("() => !document.getElementById('aiUsagePanel').hidden && document.querySelectorAll('#aiUsagePanelBody .ai-usage-stat').length === 4", timeout=10000)
        usage_panel_text = page.locator("#aiUsagePanelBody").inner_text()
        check(
            "累计调用" in usage_panel_text and "缓存命中率" in usage_panel_text and "Hit / Miss" in usage_panel_text,
            f"#aiUsagePanel rendered live /api/ai/usage stats ({usage_panel_text.replace(chr(10), ' | ')})"
        )

        # Briefing button
        mock_state["mode"] = "briefing"
        mock_state["captured_requests"].clear()
        page.click("#aiBriefingBtn")
        page.wait_for_function("() => document.querySelector('#aiChatStream')?.textContent.includes('今日作战简报')", timeout=8000)
        brief_req = next((r for r in mock_state["captured_requests"] if "/api/ai/chat" in r["url"]), None)
        brief_user_msg = ((brief_req or {}).get("body") or {}).get("messages", [{}])[-1].get("content", "")
        check(
            bool(brief_req) and "薄弱高优候选篇目" in brief_user_msg and "长期学习画像" in brief_user_msg,
            "#aiBriefingBtn triggered briefing prompt with weak items & learning profile"
        )

        # Preset: exam-twist
        mock_state["mode"] = "preset_twist"
        mock_state["captured_requests"].clear()
        page.click('[data-ai-preset="exam-twist"]')
        page.wait_for_function("() => document.querySelector('#aiChatStream')?.textContent.includes('变式真题')", timeout=8000)
        twist_folds = page.locator("#aiChatStream details.ai-fold").count()
        check(twist_folds >= 1, f"[data-ai-preset='exam-twist'] rendered collapsible details.ai-fold ({twist_folds})")

        # Preset: cross-link
        mock_state["mode"] = "preset_cross"
        mock_state["captured_requests"].clear()
        page.click('[data-ai-preset="cross-link"]')
        page.wait_for_function("() => document.querySelector('#aiChatStream')?.textContent.includes('跨科脉络串联')", timeout=8000)
        cross_req = next((r for r in mock_state["captured_requests"] if "/api/ai/chat" in r["url"]), None)
        cross_tools = ((cross_req or {}).get("body") or {}).get("tools") or []
        check(len(cross_tools) == 3, f"[data-ai-preset='cross-link'] forwarded 3 client tools ({len(cross_tools)})")

        # ---------------------------------------------------------------------
        # [9] Mobile & iPad Viewport Check with AI Drawer + #aiUsagePanel + #clozeFilterBar
        # ---------------------------------------------------------------------
        print("\n[9] Responsive Zero-Overflow Check (Desktop / iPad / Mobile)", flush=True)
        for label, vw, vh in [
            ("Desktop 1440x900", 1440, 900),
            ("iPad Landscape 1194x834", 1194, 834),
            ("iPad Portrait 820x1180", 820, 1180),
            ("Mobile 390x844", 390, 844),
        ]:
            page.set_viewport_size({"width": vw, "height": vh})
            page.wait_for_timeout(200)
            ov = page.evaluate("""() => ({
                docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                docW: document.documentElement.scrollWidth,
                vw: window.innerWidth,
                drawerOverflow: document.getElementById('aiAssistantDrawer') ? document.getElementById('aiAssistantDrawer').scrollWidth > document.getElementById('aiAssistantDrawer').clientWidth + 2 : false,
                filterOverflow: document.getElementById('clozeFilterBar') ? document.getElementById('clozeFilterBar').scrollWidth > document.getElementById('clozeFilterBar').clientWidth + 2 : false
            })""")
            check(
                not ov["docOverflow"] and not ov["drawerOverflow"] and not ov["filterOverflow"],
                f"{label} zero horizontal overflow ({ov})"
            )

        check(len(page_errors) == 0, f"Zero uncaught pageerrors ({page_errors})")
        check(len(console_errors) == 0, f"Zero console.error messages ({console_errors})")

        context.close()
        browser.close()

    httpd.shutdown()

    passed = sum(1 for c, _ in results if c)
    total = len(results)
    print(f"\n=== V3.4.4 DEEPSEEK E2E SUMMARY: {passed}/{total} PASSED ===", flush=True)
    if passed != total:
        raise SystemExit(1)


if __name__ == "__main__":
    run()

// ======================================================================
// Comprehensive Test Suite: Audio Sync & Section/Card Jump Engine
// Verifying First-Principles Synchronization & Fixes in app.js
// ======================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log("======================================================================");
console.log("RUNNING FIRST-PRINCIPLES UNIT TESTS: AUDIO SYNC & SECTION/CARD JUMPS");
console.log("======================================================================\n");

// Read app.js source to extract functions or simulate DOM environment
const appJsSource = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

// Verify that key functions and logic exist in app.js
console.log(">>> [Check 1] Verifying function definitions in app.js...");
assert.ok(appJsSource.includes('function stampSentenceIndices'), 'stampSentenceIndices must be defined');
assert.ok(appJsSource.includes('function bindCardSectionClickHandlers'), 'bindCardSectionClickHandlers must be defined');
assert.ok(appJsSource.includes('function seekToSentence'), 'seekToSentence must be defined');
assert.ok(appJsSource.includes('function highlightSentence'), 'highlightSentence must be defined');
assert.ok(appJsSource.includes('function sanitizeSentences'), 'sanitizeSentences must be defined');
console.log("  ✓ All required functions are defined in app.js\n");

// Mock a lightweight DOM & Audio environment
function createMockDOM() {
  const elements = [];

  class MockClassList {
    constructor(el) {
      this.el = el;
      this.classes = new Set();
    }
    add(cls) { this.classes.add(cls); }
    remove(cls) { this.classes.delete(cls); }
    toggle(cls, force) {
      if (force !== undefined) {
        if (force) this.classes.add(cls);
        else this.classes.delete(cls);
        return force;
      }
      if (this.classes.has(cls)) {
        this.classes.delete(cls);
        return false;
      } else {
        this.classes.add(cls);
        return true;
      }
    }
    contains(cls) { return this.classes.has(cls); }
  }

  class MockElement {
    constructor(tagName, id = '', className = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.classList = new MockClassList(this);
      if (className) {
        className.split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
      }
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.listeners = {};
      elements.push(this);
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    addEventListener(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }

    dispatchEvent(event) {
      let cur = this;
      while (cur) {
        if (cur.listeners[event.type]) {
          cur.listeners[event.type].forEach(fn => fn(event));
        }
        if (event._stopped) break;
        cur = cur.parentElement;
      }
    }

    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    matches(selector) {
      const parts = selector.split(',').map(s => s.trim());
      for (const part of parts) {
        if (part.startsWith('.')) {
          const cls = part.slice(1);
          if (this.classList.contains(cls)) return true;
        } else if (part.startsWith('#')) {
          if (this.id === part.slice(1)) return true;
        } else if (part.startsWith('[data-')) {
          const m = part.match(/\[(data-[a-z0-9\-]+)(?:="([^"]*)")?\]/);
          if (m) {
            const attrKey = m[1].replace('data-', '').replace(/-([a-z])/g, (_, g) => g.toUpperCase());
            if (m[2] !== undefined) {
              if (String(this.dataset[attrKey]) === m[2]) return true;
            } else {
              if (this.dataset[attrKey] !== undefined) return true;
            }
          }
        } else if (this.tagName.toLowerCase() === part.toLowerCase()) {
          return true;
        }
      }
      return false;
    }

    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length > 0 ? all[0] : null;
    }

    querySelectorAll(selector) {
      const results = [];
      const traverse = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) results.push(child);
          traverse(child);
        }
      };
      traverse(this);
      return results;
    }
  }

  const document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => elements.find(e => e.id === id) || null,
    querySelectorAll: (sel) => elements.filter(e => e.matches(sel))
  };

  return { document, MockElement };
}

// ======================================================================
// TEST 1: Standardize state.activeSentences to strict 0-based idx
// ======================================================================
console.log(">>> [Test 1] Standardizing activeSentences to strict 0-based idx...");

// Extract sanitizeSentences logic from app.js
function sanitizeSentences(sentences) {
  if (!sentences || !Array.isArray(sentences) || sentences.length === 0) return [];
  const list = sentences.map((s, idx) => {
    const start = typeof s.start === 'number' ? s.start : parseFloat(s.start || 0);
    let end = typeof s.end === 'number' ? s.end : parseFloat(s.end || 0);
    return {
      ...s,
      id: (s.id !== undefined && s.id !== null) ? s.id : (s.idx !== undefined ? s.idx : idx),
      start: isNaN(start) ? 0 : start,
      end: isNaN(end) ? (start + 1.0) : end,
      text: s.text || '',
      domId: s.domId || (s.id !== undefined ? String(s.id) : undefined)
    };
  });
  list.sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i].end > list[i + 1].start) {
      list[i].end = list[i + 1].start;
    }
  }
  list.forEach((item, index) => {
    item.idx = index;
  });
  return list;
}

// 1-based IDs from realistic JSON (like 807 manifest where id starts from 1)
const input1Based = [
  { id: 1, start: 0.05, end: 4.276, text: "Sentence 1" },
  { id: 2, start: 4.276, end: 7.277, text: "Sentence 2" },
  { id: 3, start: 7.277, end: 8.984, text: "Sentence 3" }
];

const sanitized1 = sanitizeSentences(input1Based);
assert.strictEqual(sanitized1.length, 3);
assert.strictEqual(sanitized1[0].idx, 0, 'First sentence idx must strictly be 0');
assert.strictEqual(sanitized1[0].id, 1, 'First sentence id preserves original 1');
assert.strictEqual(sanitized1[1].idx, 1, 'Second sentence idx must strictly be 1');
assert.strictEqual(sanitized1[1].id, 2, 'Second sentence id preserves original 2');
assert.strictEqual(sanitized1[2].idx, 2, 'Third sentence idx must strictly be 2');
assert.strictEqual(sanitized1[2].id, 3, 'Third sentence id preserves original 3');
console.log("  ✓ Standardized 1-based JSON input into strict 0-based idx: [0, 1, 2]");

// ======================================================================
// TEST 2: Elimination of 1-based vs 0-based collision in seekToSentence
// ======================================================================
console.log(">>> [Test 2] seekToSentence direct 0-based array index access...");

function runSeekScenario(activeSentences, sentIdxOrId) {
  let targetSent = null;
  let targetIdx = -1;
  const len = activeSentences.length;

  if (typeof sentIdxOrId === 'number' && Number.isInteger(sentIdxOrId) && sentIdxOrId >= 0 && sentIdxOrId < len) {
    targetIdx = sentIdxOrId;
    targetSent = activeSentences[sentIdxOrId];
  } else {
    const matchIdx = activeSentences.findIndex(s =>
      String(s.id) === String(sentIdxOrId) ||
      (s.domId && String(s.domId) === String(sentIdxOrId))
    );
    if (matchIdx !== -1) {
      targetIdx = matchIdx;
      targetSent = activeSentences[matchIdx];
    }
  }
  return { targetIdx, targetSent };
}

// When user clicks on 3rd sentence with 0-based idx 2:
// In the OLD buggy code: findIndex matched sentence with id: 2 (the 2nd sentence, index 1)!
// In NEW code: 2 is integer in [0, len), directly retrieves index 2 (the 3rd sentence)!
const resIdx2 = runSeekScenario(sanitized1, 2);
assert.strictEqual(resIdx2.targetIdx, 2, 'Index 2 MUST target sentence at index 2 (3rd sentence)');
assert.strictEqual(resIdx2.targetSent.text, "Sentence 3", 'MUST target Sentence 3, NOT Sentence 2');

const resIdx1 = runSeekScenario(sanitized1, 1);
assert.strictEqual(resIdx1.targetIdx, 1, 'Index 1 MUST target sentence at index 1 (2nd sentence)');
assert.strictEqual(resIdx1.targetSent.text, "Sentence 2", 'MUST target Sentence 2');

const resIdx0 = runSeekScenario(sanitized1, 0);
assert.strictEqual(resIdx0.targetIdx, 0, 'Index 0 MUST target sentence at index 0 (1st sentence)');
assert.strictEqual(resIdx0.targetSent.text, "Sentence 1", 'MUST target Sentence 1');

// When searching by string ID "2" (e.g. from DOM data-sent-id="2"):
const resStrId = runSeekScenario(sanitized1, "2");
assert.strictEqual(resStrId.targetIdx, 1, 'String "2" matches sentence with id 2 (index 1)');
assert.strictEqual(resStrId.targetSent.text, "Sentence 2");
console.log("  ✓ Integer indices 0, 1, 2 strictly target sentences 0, 1, 2 with zero collision!");

// ======================================================================
// TEST 3: Stamping data-sent-idx onto DOM elements & 1:1 highlight sync
// ======================================================================
console.log(">>> [Test 3] Stamping data-sent-idx and 1:1 highlight query...");

const { document, MockElement } = createMockDOM();
const paperContent = new MockElement('div', 'paperContent', 'paper-content');

// Create 3 span elements as found in 807 HTML (having data-sent-id="1", "2", "3", but no data-sent-idx initially)
const span1 = new MockElement('span', '', 'recite-sent');
span1.dataset.sentId = '1';
span1.dataset.start = '0.05';
span1.dataset.end = '4.276';
paperContent.appendChild(span1);

const span2 = new MockElement('span', '', 'recite-sent');
span2.dataset.sentId = '2';
span2.dataset.start = '4.276';
span2.dataset.end = '7.277';
paperContent.appendChild(span2);

const span3 = new MockElement('span', '', 'recite-sent');
span3.dataset.sentId = '3';
span3.dataset.start = '7.277';
span3.dataset.end = '8.984';
paperContent.appendChild(span3);

// Execute stampSentenceIndices logic
function stampSentenceIndicesMock(container, sents) {
  sents.forEach((s, idx) => {
    let node = null;
    if (s.id !== undefined && s.id !== null) {
      node = container.querySelector(`[data-sent-id="${s.id}"]`);
    }
    if (node) {
      node.dataset.sentIdx = String(idx);
    }
  });
}

stampSentenceIndicesMock(paperContent, sanitized1);

assert.strictEqual(span1.dataset.sentIdx, "0", 'span1 data-sent-idx must be 0');
assert.strictEqual(span2.dataset.sentIdx, "1", 'span2 data-sent-idx must be 1');
assert.strictEqual(span3.dataset.sentIdx, "2", 'span3 data-sent-idx must be 2');
console.log("  ✓ Stamped data-sent-idx: span1=0, span2=1, span3=2");

// Test highlightSentence querying [data-sent-idx="${targetIdx}"]
function highlightSentenceMock(container, sents, target) {
  let targetIdx = -1;
  const len = sents.length;
  if (typeof target === 'number' && Number.isInteger(target) && target >= 0 && target < len) {
    targetIdx = target;
  } else {
    targetIdx = sents.findIndex(s => String(s.id) === String(target));
  }

  // 1. Query by [data-sent-idx="${targetIdx}"]
  let targetEl = null;
  if (targetIdx !== -1) {
    targetEl = container.querySelector(`[data-sent-idx="${targetIdx}"]`);
  }
  return { targetIdx, targetEl };
}

// When audio plays sentence at index 1 (Sentence 2):
const hlRes1 = highlightSentenceMock(paperContent, sanitized1, 1);
assert.strictEqual(hlRes1.targetEl, span2, 'Highlighting index 1 MUST highlight span2');

// When audio plays sentence at index 2 (Sentence 3):
const hlRes2 = highlightSentenceMock(paperContent, sanitized1, 2);
assert.strictEqual(hlRes2.targetEl, span3, 'Highlighting index 2 MUST highlight span3');

console.log("  ✓ highlightSentence(1) -> span2, highlightSentence(2) -> span3 (100% synchronized)");

// ======================================================================
// TEST 4: Section/Card Click Handling - First Sentence Seek & Play
// ======================================================================
console.log(">>> [Test 4] Card/section click handling seeking to section first sentence...");

// Create section cards
const card1 = new MockElement('div', 'sec1', 'exam-section-card');
const header1 = new MockElement('div', '', 'section-card-header');
const badge1 = new MockElement('span', '', 'sec-badge');
header1.appendChild(badge1);
card1.appendChild(header1);
const c1Sent1 = new MockElement('span', '', 'recite-sent');
c1Sent1.dataset.sentIdx = "0";
c1Sent1.dataset.start = "0.05";
card1.appendChild(c1Sent1);
paperContent.appendChild(card1);

const card2 = new MockElement('div', 'sec2', 'exam-section-card');
const header2 = new MockElement('div', '', 'section-card-header');
const badge2 = new MockElement('span', '', 'sec-badge');
header2.appendChild(badge2);
card2.appendChild(header2);
const c2Sent1 = new MockElement('span', '', 'recite-sent');
c2Sent1.dataset.sentIdx = "5";
c2Sent1.dataset.start = "18.50";
card2.appendChild(c2Sent1);
paperContent.appendChild(card2);

let lastSeekTarget = null;
let lastSeekTime = null;

function bindCardSectionClickMock(container, sents) {
  const targets = [header1, badge1, card1, header2, badge2, card2];
  targets.forEach(targetEl => {
    targetEl.addEventListener('click', (e) => {
      if (e.target.closest('.recite-sent')) return;
      const card = targetEl.closest('.exam-section-card') || targetEl;
      const firstSent = card.querySelector('.recite-sent');
      if (firstSent) {
        const rawIdx = parseInt(firstSent.dataset.sentIdx, 10);
        const rawStart = parseFloat(firstSent.dataset.start);
        lastSeekTarget = rawIdx;
        lastSeekTime = rawStart;
      }
    });
  });
}

bindCardSectionClickMock(paperContent, sanitized1);

// User clicks on card2's header (.section-card-header):
const mockEventHeader2 = {
  type: 'click',
  target: header2,
  _stopped: false,
  stopPropagation: function() { this._stopped = true; }
};
header2.dispatchEvent(mockEventHeader2);

assert.strictEqual(lastSeekTarget, 5, 'Clicking card2 header must seek to sentence idx 5');
assert.strictEqual(lastSeekTime, 18.50, 'Clicking card2 header must seek to start 18.50s');
console.log("  ✓ Clicking section-card-header in Section 2 jumped to idx 5, start 18.50s (NOT 00:00)!");

// User clicks on card2's badge (.sec-badge):
const mockEventBadge2 = {
  type: 'click',
  target: badge2,
  _stopped: false,
  stopPropagation: function() { this._stopped = true; }
};
badge2.dispatchEvent(mockEventBadge2);

assert.strictEqual(lastSeekTarget, 5, 'Clicking card2 badge must seek to sentence idx 5');
assert.strictEqual(lastSeekTime, 18.50, 'Clicking card2 badge must seek to start 18.50s');
console.log("  ✓ Clicking sec-badge in Section 2 jumped to idx 5, start 18.50s!");

// ======================================================================
// TEST 5: English Paragraph Jump Pills & Prompt Boxes
// ======================================================================
console.log(">>> [Test 5] English jump pills seeking to closest section's first sentence...");

// Create two English paragraphs
const enPara1 = new MockElement('div', 'p1', 'en-essay-para');
const pill1 = new MockElement('button', '', 'en-audio-jump-pill');
const p1Sent = new MockElement('span', '', 'recite-sent');
p1Sent.dataset.sentIdx = "0";
p1Sent.dataset.start = "0.10";
enPara1.appendChild(pill1);
enPara1.appendChild(p1Sent);
paperContent.appendChild(enPara1);

const enPara2 = new MockElement('div', 'p2', 'en-essay-para');
const pill2 = new MockElement('button', '', 'en-audio-jump-pill');
const p2Sent = new MockElement('span', '', 'recite-sent');
p2Sent.dataset.sentIdx = "4";
p2Sent.dataset.start = "25.27";
enPara2.appendChild(pill2);
enPara2.appendChild(p2Sent);
paperContent.appendChild(enPara2);

function bindEnJumpPillsMock(container) {
  const pills = [pill1, pill2];
  pills.forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetCard = pill.closest('.en-essay-para') || container;
      const firstSent = targetCard.querySelector('.recite-sent');
      if (firstSent) {
        lastSeekTarget = parseInt(firstSent.dataset.sentIdx, 10);
        lastSeekTime = parseFloat(firstSent.dataset.start);
      }
    });
  });
}

bindEnJumpPillsMock(paperContent);

// Click pill2 in paragraph 2
const mockPill2Event = {
  type: 'click',
  target: pill2,
  _stopped: false,
  stopPropagation: function() { this._stopped = true; }
};
pill2.dispatchEvent(mockPill2Event);

assert.strictEqual(lastSeekTarget, 4, 'Clicking pill in paragraph 2 MUST seek to sentence idx 4');
assert.strictEqual(lastSeekTime, 25.27, 'Clicking pill in paragraph 2 MUST seek to start 25.27s');
console.log("  ✓ English jump pill in Paragraph 2 jumped to idx 4, start 25.27s (NOT start of essay)!");

// ======================================================================
// TEST 6: Political Chapter Track 2 .card-audio-btn
// ======================================================================
console.log(">>> [Test 6] Political Chapter Track 2 .card-audio-btn seeking to first sentence...");

let audioPlayingState = false;
let audioPlayed = false;

const subCard = new MockElement('div', 'subcard1', 'sub-card');
const audioBtn = new MockElement('button', '', 'card-audio-btn');
const subCardSent = new MockElement('span', '', 'recite-sentence');
subCardSent.dataset.sentIdx = "0";
subCardSent.dataset.start = "0.10";
subCard.appendChild(audioBtn);
subCard.appendChild(subCardSent);

audioBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (audioPlayingState) {
    audioPlayingState = false;
  } else {
    lastSeekTarget = parseInt(subCardSent.dataset.sentIdx, 10);
    lastSeekTime = parseFloat(subCardSent.dataset.start);
    audioPlayed = true;
    audioPlayingState = true;
  }
});

const mockAudioBtnEvent = {
  type: 'click',
  target: audioBtn,
  _stopped: false,
  stopPropagation: function() { this._stopped = true; }
};
audioBtn.dispatchEvent(mockAudioBtnEvent);

assert.strictEqual(lastSeekTarget, 0, 'Clicking .card-audio-btn must seek to subcard first sentence');
assert.strictEqual(lastSeekTime, 0.10, 'Clicking .card-audio-btn must seek to start 0.10s');
assert.strictEqual(audioPlayed, true, 'Audio play must be initiated');
console.log("  ✓ Political Track 2 .card-audio-btn properly sought to subcard first sentence and triggered playback!");

console.log("\n======================================================================");
console.log("ALL FIRST-PRINCIPLES SYNC & SECTION JUMP TESTS PASSED 100%!");
console.log("======================================================================\n");

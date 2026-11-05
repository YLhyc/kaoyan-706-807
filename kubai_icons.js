/**
 * Kubai Icons · 考研全科双轨背诵手卷专属动态微交互矢量引擎 (v1.9.4)
 * 基于 Kubai087 动态形变算法，专为金石朱墨与宣纸质感定制。
 * 支持平滑微交互、贝塞尔缓动形变、暗黑夜光自适应与主题联动。
 */
(function(window) {
  'use strict';

  // ---------- 1. Color Math & Tint System ----------
  const REF = [83, 147, 255];
  const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).toUpperCase();
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function tint(src, sel) {
    const s = rgb(src);
    return hex([0, 1, 2].map((i) => {
      const amt = i === 2 ? (s[0] - REF[0]) / (255 - REF[0]) : (s[i] - REF[i]) / (255 - REF[i]);
      return amt >= 0 ? sel[i] + (255 - sel[i]) * amt : sel[i] * (1 + amt);
    }));
  }

  // ---------- 2. Motion Easing (460ms, bezier(.22, 1, .36, 1)) ----------
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const e = sx(t) - x;
        if (Math.abs(e) < 1e-5) break;
        const d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      return sy(t);
    };
  }
  const EASE = bezier(0.22, 1, 0.36, 1);
  const DUR = 460;
  let REDUCED = false;
  try { REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function interp(a, b, t) {
    if (typeof b === 'number') return typeof a === 'number' ? a + (b - a) * t : b;
    if (Array.isArray(b)) return b.map((v, i) => interp(a ? a[i] : v, v, t));
    if (b && typeof b === 'object') {
      const o = {};
      for (const k in b) o[k] = interp(a ? a[k] : undefined, b[k], t);
      return o;
    }
    return b;
  }

  // ---------- 3. Geometry (Canvas 31×29) ----------
  const KR = 2.2, CR = 1.2;
  const f = (n) => +n.toFixed(3);
  const R = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  function rp(pts, r, full) {
    const n = pts.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const v = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
      const ri = Array.isArray(r) ? r[i] : r;
      const la = Math.hypot(a[0] - v[0], a[1] - v[1]) || 1e-6;
      const lb = Math.hypot(b[0] - v[0], b[1] - v[1]) || 1e-6;
      const lim = full ? 1 : 0.5;
      const k1 = Math.min(ri, la * lim) / la, k2 = Math.min(ri, lb * lim) / lb;
      d += (i ? 'L' : 'M') + f(v[0] + (a[0] - v[0]) * k1) + ' ' + f(v[1] + (a[1] - v[1]) * k1)
        + 'Q' + f(v[0]) + ' ' + f(v[1]) + ' ' + f(v[0] + (b[0] - v[0]) * k2) + ' ' + f(v[1] + (b[1] - v[1]) * k2);
    }
    return d + 'Z';
  }
  const rr = (x, y, w, h, r) => rp(R(x, y, w, h), r);
  const circ = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
  const lines = (x, y, widths) => widths.map((w, i) => `M${f(x)} ${f(y + i * 3)}H${f(x + w)}`).join('');
  function star(r1, r2) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? r2 : r1;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return rp(pts, 0.2);
  }
  function gear(teeth, rOut, rIn) {
    const pts = [], step = 360 / teeth, rad = (d) => d * Math.PI / 180;
    for (let i = 0; i < teeth; i++) {
      const a = i * step;
      [[rIn, a - step * 0.3], [rOut, a - step * 0.17], [rOut, a + step * 0.17], [rIn, a + step * 0.3]].forEach(([r, d]) => {
        pts.push([15.5 + r * Math.sin(rad(d)), 12.5 - r * Math.cos(rad(d))]);
      });
    }
    return rp(pts, 0.8);
  }
  function frontPiece(A, B, c, rc) {
    const xl = A[0] - Math.sqrt(A[2] ** 2 - (c - A[1]) ** 2), xr = B[0] + Math.sqrt(B[2] ** 2 - (c - B[1]) ** 2);
    const aL = Math.atan2(c - A[1], xl - A[0]) - rc / A[2];
    const aR = Math.atan2(c - B[1], xr - B[0]) + rc / B[2];
    const bL = [A[0] + A[2] * Math.cos(aL), A[1] + A[2] * Math.sin(aL)];
    const bR = [B[0] + B[2] * Math.cos(aR), B[1] + B[2] * Math.sin(aR)];
    return `M${f(xl + rc)} ${f(c)}Q${f(xl)} ${f(c)} ${f(bL[0])} ${f(bL[1])}`
      + `A${f(A[2])} ${f(A[2])} 0 0 0 ${f(A[0])} ${f(A[1] + A[2])}L${f(B[0])} ${f(B[1] + B[2])}`
      + `A${f(B[2])} ${f(B[2])} 0 0 0 ${f(bR[0])} ${f(bR[1])}Q${f(xr)} ${f(c)} ${f(xr - rc)} ${f(c)}Z`;
  }

  // ---------- 4. Gradients and Filter IDs ----------
  function makeU(k) {
    const grads = [];
    const gid = (type, h, s, d) => {
      const id = `${type}-${k}-${grads.length}`;
      grads.push({ id, type, h, s, d });
      return `url(#${id})`;
    };
    return {
      lo: (h) => gid('lo', h, false, false),
      loS: gid('lo', 21, true, false),
      up: (h) => gid('up', h, false, false),
      upS: gid('up', 21, true, false),
      sh: `url(#sh-${k})`,
      hi: `url(#hi-${k})`,
      id: (n) => `${n}-${k}`,
      grads
    };
  }

  function defs(k, grads) {
    const lines = [
      `<filter id="sh-${k}" x="-30%" y="-30%" width="160%" height="170%">`,
      '  <feDropShadow dx="0" dy="1.4" stdDeviation="1.1" flood-color="#000" flood-opacity="0"/>',
      '  <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.22 0"/>',
      '</filter>',
      `<filter id="hi-${k}" x="-20%" y="-20%" width="140%" height="140%">`,
      '  <feDropShadow dx="0" dy="0.6" stdDeviation="0.4" flood-color="#fff" flood-opacity="0.35"/>',
      '</filter>'
    ];
    for (const g of grads) {
      if (g.type === 'lo') {
        lines.push(`<linearGradient id="${g.id}" x1="0" y1="0" x2="0" y2="100%">`,
          '  <stop offset="0%" data-src="#A6C8FF"/>',
          '  <stop offset="100%" data-src="#4080F4"/>',
          '</linearGradient>');
      } else {
        lines.push(`<linearGradient id="${g.id}" x1="0" y1="0" x2="0" y2="100%">`,
          '  <stop offset="0%" data-src="#BFE0FF"/>',
          '  <stop offset="100%" data-src="#6BA6FF"/>',
          '</linearGradient>');
      }
    }
    return `<defs>${lines.join('')}</defs>`;
  }

  const soften = (h, k) => hex(rgb(h).map((v) => v + (255 - v) * k));
  const mute = (h, sat, dark) => {
    const c = rgb(h), g = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    return hex(c.map((v) => (v + (g - v) * sat) * (1 - dark)));
  };

  const clearTone = (name, base, n) => ({
    name,
    colors: Array(n).fill(soften(base, 0.1)),
    edges: Array(n).fill(mute(base, 0, 0.16)),
    deepMarks: true
  });

  const flatTone = (name, base, n) => ({
    name,
    colors: Array(n).fill(base),
    edges: Array(n).fill(base),
    deepMarks: false
  });

  // ---------- 5. Palettes for App Themes ----------
  // 经典金石朱墨 (默认)
  const PAL_ZHUSHA = clearTone('金石朱墨', '#B8332A', 30);
  // 暗黑夜光模式
  const PAL_DARK = clearTone('暗夜珊瑚', '#FF7860', 30);
  // 沉香宣纸模式
  const PAL_PAPER = clearTone('沉香赭墨', '#8A4B1A', 30);

  const runtime = { palette: PAL_ZHUSHA };

  // ---------- 6. Runtime Paint & Morph System ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_VIEWBOX = '0 -2 31 29';
  const at = (el, attrs) => { for (const k in attrs) el.setAttribute(k, attrs[k]); };

  function render(inst) {
    const cur = inst.cur;
    if (inst.icon.draw) inst.icon.draw(cur, inst.E);
    for (const [ol, shape] of inst.clips) {
      const d = ol.getAttribute('d');
      if (d && shape.getAttribute('d') !== d) shape.setAttribute('d', d);
    }
    const deep = Boolean(runtime.palette.deepMarks);
    const c = rgb(runtime.palette.colors[0] || '#B8332A');
    const e = rgb(runtime.palette.edges[0] || '#8B1E17');
    const key = hex(c) + hex(e) + deep;
    if (inst.painted === key) return;
    inst.painted = key;

    const pick = (src) => (rgb(src)[0] <= REF[0] ? e : c);
    for (const [el, attr, src] of inst.tints) {
      el.setAttribute(attr, tint(src, el.tagName !== 'stop' ? pick(src) : c));
    }
    for (const el of inst.whites) {
      el.setAttribute(el.dataset.w, deep ? tint('#2F6FE0', e) : '#fff');
    }
    for (const stop of inst.pures) {
      const base = tint(stop.dataset.src, pick(stop.dataset.src));
      stop.setAttribute('stop-color', deep && stop.dataset.pure === '0' ? soften(base, 0.72) : base);
    }
    if (inst.shadow) {
      const sh = rgb(tint('#8AB6FF', c));
      inst.shadow.setAttribute('values', `0 0 0 0 ${f(sh[0] / 255)} 0 0 0 0 ${f(sh[1] / 255)} 0 0 0 0 ${f(sh[2] / 255)} 0 0 0 0.22 0`);
    }
  }

  function go(inst) {
    const to = inst.icon.target(inst.hover);
    if (!inst.cur) { inst.cur = to; render(inst); return; }
    if (inst.raf) cancelAnimationFrame(inst.raf);
    if (REDUCED) { inst.cur = to; render(inst); return; }
    const from = inst.cur, t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / DUR);
      inst.cur = interp(from, to, EASE(t));
      render(inst);
      if (t < 1) inst.raf = requestAnimationFrame(tick);
    };
    inst.raf = requestAnimationFrame(tick);
  }

  // ---------- 7. 11 款核心 Kubai 动态图标定义 ----------
  const OL = 'class="ol" data-t="stroke:#5393FF"';
  const LINE = 'class="ln" data-t="stroke:#D3E2FC"';
  const ACC = 'class="ln" data-t="stroke:#5393FF"';
  const DEEP = 'data-t="fill:#2F6FE0"';
  const DEEPS = 'data-t="stroke:#2F6FE0"';
  const FOLDER_BACK_R = [KR, 1.4, 1.4, KR, KR, KR];
  const GEAR = gear(6, 11.4, 9);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);

  const ICONS = [
    {
    name: '书本',
    // A closed book whose cover swings open on hover.
    svg: (u) => {
      const back = rr(6.3, 1.5, 18.4, 22, KR), cover = rr(6.3, 1.5, 18.4, 19.4, KR);
      return `<g filter="${u.sh}"><path d="${back}" fill="${u.loS}"/></g><path d="${back}" ${OL}/>
        <path d="${rr(7.8, 3, 15.6, 19.4, CR)}" fill="#fff"/>
        <path d="${lines(11.4, 8.4, [9.2, 6.6])}" ${ACC}/>
        <g data-n="cv"><g filter="${u.hi}"><path d="${cover}" fill="${u.loS}"/></g><path data-n="sh" d="${cover}" ${DEEP} opacity="0"/><path d="${cover}" ${OL}/>
          <path d="${lines(10.4, 7.6, [10.2])}" class="ln" stroke="#fff" data-w="stroke"/></g>`;
    },
    target: (h) => ({ o: h ? 1 : 0 }),
    draw(p, E) {
      const o = Math.max(0, Math.min(1, p.o));
      at(E.cv, { transform: `translate(6.3 0) scale(${f(Math.max(0.001, 1 - 0.72 * o))} 1) translate(-6.3 0)` });
      at(E.sh, { opacity: f(0.35 * o) });
    }
  },
    {
    name: '文件夹',
    svg: (u) => `
      <g filter="${u.sh}"><path data-n="back" fill="${u.lo(21)}"/></g>
      <path data-n="backO" ${OL}/>
      <g data-n="file"><path d="${rr(0, 0, 17, 9, 1)}" fill="#fff"/><path d="M5.5 2.3H11.5" ${LINE} stroke-width="1"/></g>
      <g filter="${u.hi}"><path data-n="front" fill="${u.up(18)}"/></g>
      <path data-n="frontO" ${OL}/>`,
    target: (h) => ({
      back: h ? [[4, 3], [11.2, 3], [14.2, 6], [27, 6], [27.6, 23], [4.6, 23]] : [[4, 2], [11.2, 2], [14.2, 5], [27, 5], [27, 23], [4, 23]],
      fx: h ? 7.9 : 7,
      front: h ? [[6.8, 13], [29.3, 13], [27.6, 23], [5.4, 23]] : [[4, 5], [27, 5], [27, 23], [4, 23]],
      fr: h ? 1.8 : KR
    }),
    draw(p, E) {
      const b = rp(p.back, FOLDER_BACK_R), fr = rp(p.front, p.fr);
      at(E.back, { d: b }); at(E.backO, { d: b });
      at(E.file, { transform: `translate(${f(p.fx)} 9)` });
      at(E.front, { d: fr }); at(E.frontO, { d: fr });
    }
  },
    {
    name: '图表',
    // A bar chart whose bars rise and fall to new values on hover.
    svg: (u) => `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" fill="${u.loS}"/></g></g>
      <path d="${rr(5.2, 2.2, 20.6, 20.6, KR)}" ${OL}/>
      <path data-n="b1" fill="#fff"/><path data-n="b2" fill="#fff"/><path data-n="b3" fill="#fff"/>`,
    target: (h) => ({ hgt: h ? [10, 5.4, 13.4] : [5.4, 10.6, 7.6] }),
    draw(p, E) {
      [8.4, 13.7, 19].forEach((x, i) => {
        const hh = p.hgt[i];
        at(E['b' + (i + 1)], { d: rp(R(x, 20 - hh, 3.6, hh), [1, 1, 0.4, 0.4]) });
      });
    }
  },
    {
    name: '眼睛',
    // An eye that glances to the side on hover.
    svg: (u) => {
      const eye = 'M3.6 12.5C7 6.6 11 4.2 15.5 4.2C20 4.2 24 6.6 27.4 12.5C24 18.4 20 20.8 15.5 20.8C11 20.8 7 18.4 3.6 12.5Z';
      return `<clipPath id="${u.id('eye')}"><path d="${eye}"/></clipPath>
        <g filter="${u.sh}"><g filter="${u.hi}"><path d="${eye}" fill="${u.loS}"/></g></g>
        <g clip-path="url(#${u.id('eye')})"><g data-n="iris"><g filter="${u.hi}"><path d="${circ(0, 0, 5.4)}" fill="${u.upS}"/></g><path d="${circ(0, 0, 5.4)}" ${OL}/>
          <circle data-n="pup" ${DEEP}/></g></g>
        <path d="${eye}" ${OL}/>`;
    },
    target: (h) => ({ x: h ? 2.6 : 0, pup: h ? 2.9 : 2.3 }),
    draw(p, E) { at(E.iris, { transform: `translate(${f(15.5 + p.x)} 12.5)` }); at(E.pup, { r: f(p.pup) }); }
  },
    {
    name: '外观',
    // Light and dark halves of one disc; hover turns the light half across.
    svg: (u) => {
      const disc = [15.5, 12.5, 11.5], half = frontPiece(disc, disc, 12.5, 2);
      return `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${circ(15.5, 12.5, 11.5)}" fill="${u.loS}"/></g></g>
      <path d="${circ(15.5, 12.5, 11.5)}" ${OL}/>
      <g filter="${u.hi}"><g data-n="half"><path d="${half}" fill="${u.upS}"/></g></g>
      <g data-n="halfO"><path d="${half}" ${OL}/></g>`;
    },
    target: (h) => ({ rot: h ? 90 : -90 }),
    draw(p, E) {
      const t = `rotate(${f(p.rot)} 15.5 12.5)`;
      at(E.half, { transform: t }); at(E.halfO, { transform: t });
    }
  },
    {
    name: '设置',
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="gear"><path d="${GEAR}" fill="${u.loS}"/></g></g></g><g data-n="gearO"><path d="${GEAR}" ${OL}/></g>
      <path d="${circ(15.5, 12.5, 5.8)}" fill="#fff"/>
      <g filter="${u.hi}"><path data-n="hub" fill="${u.upS}"/></g>
      <path data-n="hubO" ${OL}/>`,
    target: (h) => ({ rot: h ? 60 : 0, hub: h ? 2.9 : 3.5 }),
    draw(p, E) {
      at(E.gear, { transform: `rotate(${f(p.rot)} 15.5 12.5)` }); at(E.gearO, { transform: `rotate(${f(p.rot)} 15.5 12.5)` });
      const d = circ(15.5, 12.5, p.hub);
      at(E.hub, { d }); at(E.hubO, { d });
    }
  },
    {
    name: '搜索',
    // The page is the subject; the lens is a supporting mark on its corner, a solid
    // ring with no inner outline so it never leaves a thin band.
    svg: (u) => `
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(4, 1, 16.8, 20.2, KR)}" fill="${u.lo(20.2)}"/></g></g>
      <path d="${rr(4, 1, 16.8, 20.2, KR)}" ${OL}/>
      <path d="${lines(7.4, 4.8, [10, 6.6])}" class="ln" stroke="#fff" data-w="stroke"/>
      <g filter="${u.hi}"><path d="${rp(R(4, 10.8, 16.8, 10.4), [1.6, 1.6, KR, KR])}" fill="${u.upS}"/></g>
      <path d="${rp(R(4, 10.8, 16.8, 10.4), [1.6, 1.6, KR, KR])}" ${OL}/>
      <g data-n="lens" filter="${u.sh}">
        <circle r="3.6" fill="#fff" fill-opacity=".8"/>
        <circle r="3.6" fill="${u.upS}" fill-opacity=".35"/>
        <circle r="4.5" fill="none" stroke-width="1.8" data-t="stroke:#2F6FE0"/>
        <path d="M3.8 3.8L6.6 6.6" stroke-width="2.2" stroke-linecap="round" data-t="stroke:#2F6FE0"/>
      </g>`,
    target: (h) => ({ lens: h ? [13.2, 10.4, 1.05] : [19.8, 16.8, 1] }),
    draw(p, E) {
      const [x, y, s] = p.lens;
      at(E.lens, { transform: `translate(${f(x)} ${f(y)}) scale(${f(s)})` });
    }
  },
    {
    name: '星标',
    // A star with a lighter star inset; it turns one point on hover.
    svg: (u) => {
      const big = star(11.6, 5.4), small = star(5.6, 2.6);
      return `<g filter="${u.sh}"><g filter="${u.hi}"><g data-n="r1"><path d="${big}" fill="${u.loS}"/></g></g></g>
        <g data-n="r1o"><path d="${big}" ${OL}/></g>
        <g filter="${u.hi}"><g data-n="r2"><path d="${small}" fill="${u.upS}"/></g></g>
        <g data-n="r2o"><path d="${small}" ${OL}/></g>`;
    },
    target: (h) => ({ rot: h ? 72 : 0, s: h ? 1.05 : 1 }),
    draw(p, E) {
      const t = `translate(15.5 13.4) rotate(${f(p.rot)}) scale(${f(p.s)})`;
      ['r1', 'r1o', 'r2', 'r2o'].forEach((n) => at(E[n], { transform: t }));
    }
  },
    {
    name: '播放',
    // A play button that turns into pause on hover.
    svg: (u) => `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${circ(15.5, 12.5, 11.5)}" fill="${u.loS}"/></g></g>
      <path d="${circ(15.5, 12.5, 11.5)}" ${OL}/>
      <path data-n="l" fill="#fff" data-w="fill"/><path data-n="r" fill="#fff" data-w="fill"/>`,
    target: (h) => ({
      l: h ? [[11, 7.2], [14.2, 7.2], [14.2, 17.8], [11, 17.8]] : [[12.2, 7.2], [16.4, 9.6], [16.4, 15.4], [12.2, 17.8]],
      r: h ? [[16.8, 7.2], [20, 7.2], [20, 17.8], [16.8, 17.8]] : [[16, 9.4], [21.4, 12.5], [21.4, 12.5], [16, 15.6]]
    }),
    draw(p, E) { at(E.l, { d: rp(p.l, 0.8) }); at(E.r, { d: rp(p.r, 0.8) }); }
  },
    {
    name: '耳机',
    // Headphones whose cups press in on hover.
    svg: (u) => {
      const band = 'M4.4 14.4A11.1 11.1 0 0 1 26.6 14.4H24A8.5 8.5 0 0 0 7 14.4Z';
      const cup = rr(0, 0, 6.8, 10.6, 3);
      return `<g filter="${u.sh}"><g filter="${u.hi}"><path d="${band}" fill="${u.loS}"/></g></g><path d="${band}" ${OL}/>
        <g data-n="l"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${cup}" fill="${u.upS}"/></g></g><path d="${cup}" ${OL}/></g>
        <g data-n="r"><g filter="${u.sh}"><g filter="${u.hi}"><path d="${cup}" fill="${u.upS}"/></g></g><path d="${cup}" ${OL}/></g>`;
    },
    target: (h) => ({ d: h ? 0.8 : 0 }),
    draw(p, E) {
      at(E.l, { transform: `translate(${f(3.6 + p.d)} 12.6)` });
      at(E.r, { transform: `translate(${f(20.6 - p.d)} 12.6)` });
    }
  },
    {
    name: '日历',
    svg: (u) => {
      const body = rr(5.2, 3.4, 20.6, 19.4, KR);
      const sheet = rp(R(8.2, 9, 14.6, 10.8), [0, 0, CR, CR]);
      const head = rp(R(5.2, 3.4, 20.6, 5.6), [KR, KR, 0, 0]);
      const ring = rr(10.4, 1.6, 1.8, 3.8, 0.9) + rr(18.8, 1.6, 1.8, 3.8, 0.9);
      return `
      <g filter="${u.sh}"><path d="${body}" fill="${u.loS}"/></g>
      <path d="${sheet}" fill="#fff"/>
      <text x="15.5" y="17.4" text-anchor="middle" font-size="8.4" font-weight="700" data-t="fill:#81B0FF">${tomorrow.getDate()}</text>
      <g data-n="sheet"><path d="${sheet}" fill="#fff"/>
        <text x="15.5" y="17.4" text-anchor="middle" font-size="8.4" font-weight="700" data-t="fill:#4389FF">${today.getDate()}</text>
        <path data-n="shade" d="${sheet}" data-t="fill:#4389FF" opacity="0"/></g>
      <path d="${body}" ${OL}/>
      <g filter="${u.hi}"><path d="${head}" fill="${u.upS}"/></g>
      <path d="${head}" ${OL}/>
      <g data-n="rings"><path d="${ring}" fill="#fff"/><path d="${ring}" ${OL}/></g>`;
    },
    target: (h) => ({ o: h ? 1 : 0, rings: h ? -0.6 : 0 }),
    draw(p, E) {
      // Today's page turns up under the header: it foreshortens toward its top edge and
      // darkens as it faces away, uncovering tomorrow.
      const o = Math.max(0, Math.min(1, p.o));
      const sy = Math.cos(o * Math.PI / 2);
      at(E.sheet, { transform: `translate(0 9) scale(1 ${f(Math.max(0.001, sy))}) translate(0 -9)`, opacity: o > 0.985 ? 0 : 1 });
      at(E.shade, { opacity: f(0.45 * Math.sin(o * Math.PI / 2)) });
      at(E.rings, { transform: `translate(0 ${f(p.rings)})` });
    }
  },
  ];

  let iconIdCounter = 0;
  const mountedInstances = [];

  function mount(name, container, options = {}) {
    if (!container) return null;
    const icon = ICONS.find((it) => it.name === name);
    if (!icon) {
      console.warn(`[Kubai] Icon not found: ${name}`);
      return null;
    }
    const idx = ++iconIdCounter;
    const k = 'kb' + idx;
    const u = makeU(k);
    const body = icon.svg(u);
    container.innerHTML = `<svg viewBox="${ICON_VIEWBOX}" fill="none" class="kubai-icon-svg" aria-hidden="true">${defs(k, u.grads)}${body}</svg>`;
    const svg = container.querySelector('svg');
    const E = {};
    svg.querySelectorAll('[data-n]').forEach((el) => { E[el.dataset.n] = el; });
    const tints = [...svg.querySelectorAll('[data-t]')].map((el) => {
      const [attr, src] = el.dataset.t.split(':');
      return [el, attr, src];
    });

    const defsEl = svg.querySelector('defs');
    const clips = [...svg.querySelectorAll('.ol')].map((el, j) => {
      const mask = document.createElementNS(SVG_NS, 'mask');
      mask.id = `ol-${k}-${j}`;
      at(mask, { maskUnits: 'userSpaceOnUse', x: -40, y: -40, width: 111, height: 109 });
      mask.innerHTML = '<rect x="-40" y="-40" width="111" height="109" fill="#fff"/>';
      const shape = document.createElementNS(SVG_NS, 'path');
      shape.setAttribute('fill', '#000');
      shape.setAttribute('fill-rule', el.getAttribute('fill-rule') || 'nonzero');
      mask.appendChild(shape);
      defsEl.appendChild(mask);
      el.setAttribute('mask', `url(#${mask.id})`);
      return [el, shape];
    });

    const inst = {
      icon, idx, E, tints, clips,
      whites: [...svg.querySelectorAll('[data-w]')],
      pures: [...svg.querySelectorAll('[data-pure]')],
      shadow: svg.querySelector(`feColorMatrix`),
      hover: Boolean(options.hover),
      cur: null,
      painted: '',
      raf: null
    };

    inst.cur = icon.target(inst.hover);
    render(inst);
    mountedInstances.push(inst);

    // Event binding
    if (options.interactive !== false) {
      container.addEventListener('mouseenter', () => {
        inst.hover = true;
        go(inst);
      });
      container.addEventListener('mouseleave', () => {
        if (!options.stayActive || !container.classList.contains('active')) {
          inst.hover = false;
          go(inst);
        }
      });
      container.addEventListener('touchstart', () => {
        inst.hover = true;
        go(inst);
      }, { passive: true });
      container.addEventListener('touchend', () => {
        setTimeout(() => {
          if (!options.stayActive || !container.classList.contains('active')) {
            inst.hover = false;
            go(inst);
          }
        }, 300);
      }, { passive: true });
    }

    return {
      inst,
      setHover(isHover) {
        inst.hover = Boolean(isHover);
        go(inst);
      },
      toggle() {
        inst.hover = !inst.hover;
        go(inst);
      }
    };
  }

  function setPalette(theme) {
    if (theme === 'dark') {
      runtime.palette = PAL_DARK;
    } else if (theme === 'paper') {
      runtime.palette = PAL_PAPER;
    } else {
      runtime.palette = PAL_ZHUSHA;
    }
    for (const inst of mountedInstances) {
      inst.painted = '';
      render(inst);
    }
  }

  // Theme auto observer
  try {
    const observer = new MutationObserver(() => {
      const docTheme = document.documentElement.getAttribute('data-theme') || 'light';
      setPalette(docTheme);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const initialTheme = document.documentElement.getAttribute('data-theme') || 'light';
    setPalette(initialTheme);
  } catch (e) {}

  // Export API
  window.KubaiIcons = {
    mount,
    setPalette,
    clearTone,
    flatTone,
    ICONS,
    runtime
  };

})(typeof window !== 'undefined' ? window : this);

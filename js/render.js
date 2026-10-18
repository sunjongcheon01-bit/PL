/* render.js — 캔버스 렌더링: 컬러맵 이미지, 컬러바, 스케일바, 선 그래프 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  const CMAPS = {
    gray: [[0, 0, 0], [255, 255, 255]],
    inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    diverge: [[33, 102, 172], [103, 169, 207], [247, 247, 247], [239, 138, 98], [178, 24, 43]],
    turbo: [[48, 18, 59], [70, 107, 227], [41, 187, 236], [49, 241, 152], [162, 252, 60], [237, 208, 58], [251, 128, 34], [210, 49, 5], [122, 4, 3]],
  };
  const LUT = {};
  function lut(name) {
    if (LUT[name]) return LUT[name];
    const stops = CMAPS[name] || CMAPS.gray, out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (stops.length - 1), a = Math.min(Math.floor(t), stops.length - 2), f = t - a;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[a][c] + f * (stops[a + 1][c] - stops[a][c]);
    }
    return (LUT[name] = out);
  }

  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  function fitCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, W: r.width, H: r.height };
  }

  function range(data, opt) {
    let lo = Infinity, hi = -Infinity;
    if (opt.robust) {
      const s = Array.from(data).filter(Number.isFinite).sort((a, b) => a - b);
      lo = s[Math.floor(s.length * 0.002)]; hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.998))];
    } else for (const v of data) { if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (opt.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
    if (opt.log) { lo = Math.max(lo, hi * 1e-6); }
    if (!(hi > lo)) hi = lo + (Math.abs(lo) || 1) * 1e-6;
    return [lo, hi];
  }

  /** 2D 데이터 → 이미지 (정사각 픽셀). 반환: 좌표 변환 정보 */
  function drawImage(cv, data, nx, ny, opt) {
    opt = opt || {};
    const { g, W, H } = fitCanvas(cv);
    g.fillStyle = css('--canvas-bg') || '#111'; g.fillRect(0, 0, W, H);
    const padR = 70, padB = 26;
    const s = Math.min((W - padR - 10) / nx, (H - padB - 10) / ny);
    const ox = 8, oy = 8, w = nx * s, h = ny * s;
    let [lo, hi] = opt.range || range(data, opt);
    const L = lut(opt.cmap || 'gray');
    const off = document.createElement('canvas'); off.width = nx; off.height = ny;
    const og = off.getContext('2d'), id = og.createImageData(nx, ny);
    const tf = opt.log ? (v) => (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v) => (v - lo) / (hi - lo);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = data[j * nx + i];
      const t = Math.max(0, Math.min(1, tf(v))) * 255 | 0;
      const p = (j * nx + i) * 4;
      id.data[p] = L[t * 3]; id.data[p + 1] = L[t * 3 + 1]; id.data[p + 2] = L[t * 3 + 2]; id.data[p + 3] = 255;
    }
    og.putImageData(id, 0, 0);
    g.imageSmoothingEnabled = false; g.drawImage(off, ox, oy, w, h);
    g.strokeStyle = css('--line'); g.lineWidth = 1; g.strokeRect(ox + 0.5, oy + 0.5, w, h);
    // 컬러바
    const bx = ox + w + 12, bw = 12;
    for (let y = 0; y < h; y++) {
      const t = 1 - y / h, ii = Math.round(t * 255);
      g.fillStyle = `rgb(${L[ii * 3]},${L[ii * 3 + 1]},${L[ii * 3 + 2]})`; g.fillRect(bx, oy + y, bw, 1.5);
    }
    g.fillStyle = css('--fg'); g.font = '11px ui-monospace, Consolas, monospace'; g.textBaseline = 'middle';
    const fmt = opt.fmt || fmtNum;
    const val = (t) => opt.log ? Math.pow(10, Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo))) : lo + t * (hi - lo);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) g.fillText(fmt(val(t)), bx + bw + 4, oy + (1 - t) * h);
    if (opt.unit) { g.textBaseline = 'top'; g.fillText(opt.unit, bx - 2, oy + h + 6); }
    // 스케일바
    if (opt.dxum) {
      const Lum = niceLen(nx * opt.dxum / 4), px = Lum / opt.dxum * s;
      g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(ox + 10, oy + h - 12); g.lineTo(ox + 10 + px, oy + h - 12); g.stroke();
      g.fillStyle = '#fff'; g.textBaseline = 'bottom'; g.fillText(Lum + ' µm', ox + 10, oy + h - 16);
    }
    const map = { ox, oy, s, nx, ny, lo, hi };
    if (opt.overlay) { g.save(); opt.overlay(g, map); g.restore(); }
    return map;
  }
  function niceLen(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p; }
  function fmtNum(v) {
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e4 || a < 1e-2) return v.toExponential(1);
    if (Number.isInteger(v)) return String(v);
    return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  /** 선 그래프. series: [{x,y,color,label,dash,width}], opt: {xlabel,ylabel,logy,xlim,ylim,bands,vlines,title} */
  function plot(cv, series, opt) {
    opt = opt || {};
    const { g, W, H } = fitCanvas(cv);
    g.fillStyle = css('--panel'); g.fillRect(0, 0, W, H);
    const pl = 64, pr = 14, pt = opt.title ? 24 : 12, pb = 38;
    const w = W - pl - pr, h = H - pt - pb;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of series) for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i]; if (!Number.isFinite(y) || (opt.logy && y <= 0)) continue;
      xmin = Math.min(xmin, s.x[i]); xmax = Math.max(xmax, s.x[i]); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    if (opt.xlim) [xmin, xmax] = opt.xlim;
    if (opt.ylim) [ymin, ymax] = opt.ylim;
    if (!Number.isFinite(xmin)) { xmin = 0; xmax = 1; ymin = 0; ymax = 1; }
    if (opt.logy) { ymax *= 2; ymin = Math.max(ymin, ymax * (opt.logSpan || 1e-5)); }
    else { if (!opt.ylim) { ymin = Math.min(0, ymin); ymax = ymax + 0.05 * (ymax - ymin || 1); } }
    if (!(ymax > ymin)) ymax = ymin + 1;
    const X = (x) => pl + (x - xmin) / (xmax - xmin) * w;
    const Y = opt.logy ? (y) => pt + h - (Math.log10(Math.max(y, ymin)) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) * h
                       : (y) => pt + h - (y - ymin) / (ymax - ymin) * h;
    // 대역 음영
    for (const b of (opt.bands || [])) {
      g.fillStyle = b.color; const x0 = X(Math.max(b.lo, xmin)), x1 = X(Math.min(b.hi, xmax));
      if (x1 > x0) { g.fillRect(x0, pt, x1 - x0, h); if (b.label) { g.fillStyle = css('--muted'); g.font = '10px sans-serif'; g.textBaseline = 'top'; g.fillText(b.label, x0 + 3, pt + 3 + (b.row || 0) * 12); } }
    }
    // 축
    g.strokeStyle = css('--grid'); g.lineWidth = 1; g.fillStyle = css('--muted'); g.font = '11px ui-monospace, Consolas, monospace';
    const xt = ticks(xmin, xmax, 7);
    g.textBaseline = 'top'; g.textAlign = 'center';
    for (const t of xt) { const x = X(t); g.beginPath(); g.moveTo(x, pt); g.lineTo(x, pt + h); g.stroke(); g.fillText(fmtNum(t), x, pt + h + 4); }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    const yt = opt.logy ? logTicks(ymin, ymax) : ticks(ymin, ymax, 5);
    for (const t of yt) { const y = Y(t); g.beginPath(); g.moveTo(pl, y); g.lineTo(pl + w, y); g.stroke(); g.fillText(fmtNum(t), pl - 4, y); }
    g.strokeStyle = css('--line'); g.strokeRect(pl + 0.5, pt + 0.5, w, h);
    g.fillStyle = css('--fg'); g.textAlign = 'center'; g.textBaseline = 'bottom';
    if (opt.xlabel) g.fillText(opt.xlabel, pl + w / 2, H - 2);
    if (opt.title) { g.textBaseline = 'top'; g.font = '12px sans-serif'; g.fillText(opt.title, pl + w / 2, 4); }
    if (opt.ylabel) { g.save(); g.translate(12, pt + h / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.font = '11px sans-serif'; g.fillText(opt.ylabel, 0, 0); g.restore(); }
    for (const v of (opt.vlines || [])) {
      if (v.x < xmin || v.x > xmax) continue;
      g.strokeStyle = v.color || css('--muted'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(v.x), pt); g.lineTo(X(v.x), pt + h); g.stroke(); g.setLineDash([]);
      if (v.label) { g.fillStyle = v.color || css('--muted'); g.textAlign = 'left'; g.textBaseline = 'top'; g.font = '10px sans-serif'; g.fillText(v.label, X(v.x) + 2, pt + 2 + (v.row || 0) * 11); }
    }
    // 데이터
    g.save(); g.beginPath(); g.rect(pl, pt, w, h); g.clip();
    for (const s of series) {
      g.strokeStyle = s.color; g.lineWidth = s.width || 1.6; g.setLineDash(s.dash || []);
      g.beginPath(); let started = false;
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i]; if (!Number.isFinite(y) || (opt.logy && y <= 0)) { started = false; continue; }
        const px = X(s.x[i]), py = Y(y);
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      }
      g.stroke();
      if (s.markers) { g.fillStyle = s.color; for (let i = 0; i < s.x.length; i++) { if (!Number.isFinite(s.y[i])) continue; g.beginPath(); g.arc(X(s.x[i]), Y(s.y[i]), 2.5, 0, 7); g.fill(); } }
    }
    g.restore(); g.setLineDash([]);
    // 범례
    const named = series.filter(s => s.label);
    if (named.length) {
      g.font = '11px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const lw = Math.max(...named.map(s => g.measureText(s.label).width)) + 30;
      let lx = pl + w - lw - 6, ly = pt + 8;
      g.fillStyle = css('--panel'); g.globalAlpha = 0.85; g.fillRect(lx - 4, ly - 7, lw + 4, named.length * 15 + 2); g.globalAlpha = 1;
      for (const s of named) {
        g.strokeStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash || []); g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 20, ly); g.stroke(); g.setLineDash([]);
        g.fillStyle = css('--fg'); g.fillText(s.label, lx + 25, ly); ly += 15;
      }
    }
    return { X, Y, pl, pt, w, h, xmin, xmax };
  }
  function ticks(a, b, n) {
    const step = niceLen((b - a) / n) || 1, out = [];
    for (let t = Math.ceil(a / step) * step; t <= b + 1e-9 * step; t += step) out.push(+t.toPrecision(12));
    return out;
  }
  function logTicks(a, b) {
    const out = []; for (let e = Math.ceil(Math.log10(a)); e <= Math.floor(Math.log10(b)); e++) out.push(Math.pow(10, e));
    if (out.length > 8) return out.filter((_, i) => i % 2 === 0);
    return out;
  }

  PL.Render = { drawImage, plot, fitCanvas, lut, css, fmtNum, range, niceLen };
})(PL);

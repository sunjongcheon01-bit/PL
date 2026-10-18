/* structure.js — 적층 구조(stack) 정의, 프리셋, 깊이 방향 비균일 격자 생성 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  let LAYER_ID = 1;
  function layer(o) {
    return Object.assign({
      id: LAYER_ID++, material: 'Si', thickness: 1, x: 0, strained: true,
      dopType: 'p', N: 1e15, tau_us: 10, fill: false,
    }, o);
  }
  PL.newLayer = layer;

  const PRESETS = {
    'Si bulk': () => [
      layer({ material: 'SiO2', thickness: 0.002 }),
      layer({ material: 'Si', fill: true, tau_us: 10 }),
    ],
    'Si epi / Si 기판': () => [
      layer({ material: 'SiO2', thickness: 0.002 }),
      layer({ material: 'Si', thickness: 5, N: 1e15, tau_us: 20 }),
      layer({ material: 'Si', fill: true, N: 1e18, dopType: 'p', tau_us: 1 }),
    ],
    'Si cap / SiGe / Si': () => [
      layer({ material: 'SiO2', thickness: 0.002 }),
      layer({ material: 'Si', thickness: 0.01, tau_us: 1 }),
      layer({ material: 'SiGe', thickness: 0.05, x: 0.25, strained: true, tau_us: 1 }),
      layer({ material: 'Si', fill: true, tau_us: 10 }),
    ],
    'SiGe/Si 다층 (3주기)': () => {
      const L = [layer({ material: 'SiO2', thickness: 0.002 })];
      for (let i = 0; i < 3; i++) {
        L.push(layer({ material: 'Si', thickness: 0.01, tau_us: 1 }));
        L.push(layer({ material: 'SiGe', thickness: 0.012, x: 0.3, strained: true, tau_us: 1 }));
      }
      L.push(layer({ material: 'Si', fill: true, tau_us: 10 }));
      return L;
    },
  };
  PL.PRESETS = PRESETS;

  /** 층 구간 계산 [µm] */
  function segments(state) {
    const segs = []; let z = 0;
    const depth = state.domain.depth;
    state.layers.forEach((L, idx) => {
      const t = L.fill ? Math.max(depth - z, 0.5) : Math.max(L.thickness, 1e-4);
      segs.push({ z0: z, z1: z + t, layer: L, idx });
      z += t;
    });
    return segs;
  }
  PL.segments = segments;

  /** 양끝에서 기하급수적으로 커지는 격자 (두께 t, 최소 dz0, 비율 g, 최대 dzmax) */
  function graded(t, dz0, g, dzmax) {
    if (t <= 2 * dz0) { const n = Math.max(1, Math.round(t / dz0)); return new Array(n).fill(t / n); }
    const half = []; let s = 0, d = dz0;
    while (s + d < t / 2) { half.push(d); s += d; d = Math.min(d * g, dzmax); }
    const rest = t - 2 * s;
    const mid = rest > 0 ? Math.max(1, Math.round(rest / Math.min(d, dzmax))) : 0;
    const arr = half.slice();
    for (let i = 0; i < mid; i++) arr.push(rest / mid);
    for (let i = half.length - 1; i >= 0; i--) arr.push(half[i]);
    const sum = arr.reduce((a, b) => a + b, 0);
    return arr.map(v => v * t / sum);
  }

  /** 깊이 격자 생성. 계면은 반드시 격자면이 되도록 함 */
  function buildZGrid(state, lamExc) {
    const segs = segments(state);
    const dzmax = Math.min(2.5, Math.max(state.domain.dx * 2, 1));
    const faces = [0], layerIdx = [];
    let firstSemi = true;
    segs.forEach(sg => {
      const L = sg.layer, t = sg.z1 - sg.z0;
      let cells;
      if (L.material === 'SiO2') cells = [t];
      else {
        const aDepth = 1e4 / Math.max(PL.mat.alpha(L, lamExc), 1e-6); // µm
        let dz0 = firstSemi ? Math.min(0.25 * aDepth, 0.05) : Math.min(0.05, t / 4);
        dz0 = Math.max(dz0, Math.min(0.002, t / 2));
        cells = graded(t, dz0, 1.35, dzmax);
        firstSemi = false;
      }
      let z = faces[faces.length - 1];
      cells.forEach(d => { z += d; faces.push(z); layerIdx.push(sg.idx); });
      faces[faces.length - 1] = sg.z1;
    });
    const nz = layerIdx.length;
    const zc = new Float64Array(nz), dz = new Float64Array(nz), active = new Uint8Array(nz);
    for (let k = 0; k < nz; k++) {
      dz[k] = faces[k + 1] - faces[k];
      zc[k] = 0.5 * (faces[k] + faces[k + 1]);
      active[k] = state.layers[layerIdx[k]].material === 'SiO2' ? 0 : 1;
    }
    return { nz, zf: Float64Array.from(faces), zc, dz, layerIdx: Int32Array.from(layerIdx), active, segs };
  }
  PL.buildZGrid = buildZGrid;

  /** 층 정보 요약 (UI 표시용) */
  function layerInfo(L) {
    if (L.material === 'SiO2') return { Eg: null, peak: null };
    const Eg = PL.mat.bandgap(L);
    const peak = PL.mat.peakLambda(PL.mat.bbShape(L));
    const info = { Eg, peak };
    if (L.material === 'SiGe' && L.x > 0) {
      info.hcMB = PL.mat.hcMB(L.x);
      info.hcPB = PL.mat.hcPB(L.x);
      const tnm = L.thickness * 1000;
      info.relaxRisk = !L.strained ? '완화(relaxed)층' :
        tnm > info.hcPB ? '위험: People–Bean 한계 초과 → misfit 전위 발생 가능성 높음' :
        tnm > info.hcMB ? '준안정: MB 초과, PB 이하 → 열처리 시 misfit 발생 가능' : '안정 (MB 이하)';
    }
    return info;
  }
  PL.layerInfo = layerInfo;
})(PL);

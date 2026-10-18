/* optics.js — 광학계: 여기(흡수/생성), 반사, 광 탈출·수집, 필터, 검출기 QE, PSF */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';
  const M = PL.mat, C = PL.C;

  const LASERS = [405, 532, 633, 808, 980];

  /** 첫 반도체 층 */
  function topSemi(state) { return state.layers.find(L => L.material !== 'SiO2') || state.layers[0]; }

  /** 공기 → (상부 SiO2 박막) → 반도체 수직 입사 반사율 (박막 간섭 포함) */
  function reflectance(state, lam) {
    const semi = topSemi(state);
    const ns = M.nIndex(semi, lam);
    const L0 = state.layers[0];
    if (L0.material !== 'SiO2') { const r = (1 - ns) / (1 + ns); return r * r; }
    const n1 = 1.46, d = L0.thickness * 1000; // nm
    const r01 = (1 - n1) / (1 + n1), r12 = (n1 - ns) / (n1 + ns);
    const delta = 2 * Math.PI * n1 * d / lam;
    // r = (r01 + r12 e^{2iδ}) / (1 + r01 r12 e^{2iδ})
    const c2 = Math.cos(2 * delta), s2 = Math.sin(2 * delta);
    const nr = r01 + r12 * c2, ni = r12 * s2;
    const dr = 1 + r01 * r12 * c2, di = r01 * r12 * s2;
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }

  /** 셀 k 에서 흡수되는 입사 광자 비율 (입사 플럭스 1 기준) */
  function generationFraction(state, Z, lam) {
    const R = reflectance(state, lam);
    const frac = new Float64Array(Z.nz);
    let phi = 1 - R;
    for (let k = 0; k < Z.nz; k++) {
      const L = state.layers[Z.layerIdx[k]];
      const a = M.alpha(L, lam);
      const out = phi * Math.exp(-a * Z.dz[k] * 1e-4);
      frac[k] = Z.active[k] ? phi - out : 0;
      phi = out;
    }
    return { frac, R, transmitted: phi };
  }

  /** 수집 기하: 반도체 내부 허용 반각, 입체각 비율, 평균 경로 증가 */
  function collectionGeom(state, NA, lam) {
    const n = M.nIndex(topSemi(state), lam);
    const s = Math.min(NA / n, 0.999);
    const ct = Math.sqrt(1 - s * s);
    return { f: (1 - ct) / 2, sec: -Math.log(ct) / (1 - ct), thetaDeg: Math.asin(s) * 180 / Math.PI };
  }

  /** 탈출·수집 효율 Tesc[k][λ] — 등방 발광 중 대물렌즈 NA 안으로 나와 공기로 빠져나오는 비율
   *  = f_NA · (1 − R(λ)) · exp(−∫α(λ)dz · ⟨sec θ⟩)   (자기흡수 포함) */
  function escape(state, Z, NA) {
    const L = PL.LAM, nl = L.length, out = [];
    const geo = new Float64Array(nl), sec = new Float64Array(nl);
    for (let q = 0; q < nl; q++) {
      const g = collectionGeom(state, NA, L[q]);
      geo[q] = g.f * (1 - reflectance(state, L[q])); sec[q] = g.sec;
    }
    const tau = new Float64Array(nl); // 위쪽 누적 광학 깊이
    for (let k = 0; k < Z.nz; k++) {
      const Lk = state.layers[Z.layerIdx[k]];
      const T = new Float64Array(nl);
      const half = 0.5 * Z.dz[k] * 1e-4;
      for (let q = 0; q < nl; q++) {
        const a = M.alpha(Lk, L[q]);
        T[q] = geo[q] * Math.exp(-(tau[q] + a * half) * sec[q]);
        tau[q] += a * 2 * half;
      }
      out.push(T);
    }
    return out;
  }

  // ---------- 필터 ----------
  const sig = (x) => 1 / (1 + Math.exp(-x));
  function filterT(ch, lam) {
    const w = Math.max(ch.edge || 10, 0.5) / 4.4; // 10–90% 폭 → logistic 스케일
    let t = 1;
    if (ch.kind !== 'sp') t *= sig((lam - ch.lo) / w);
    if (ch.kind === 'bp' || ch.kind === 'sp') t *= sig((ch.hi - lam) / w);
    return (ch.Tmax || 0.9) * t + Math.pow(10, -(ch.OD || 6));
  }

  const CHANNEL_PRESETS = [
    { id: 'bb', name: 'BB (Si 밴드간)', kind: 'bp', lo: 1050, hi: 1250, edge: 15, OD: 6, Tmax: 0.9, on: true },
    { id: 'sige', name: 'SiGe 대역', kind: 'bp', lo: 1200, hi: 1400, edge: 15, OD: 6, Tmax: 0.9, on: false },
    { id: 'lp1400', name: 'D-line (LP1400)', kind: 'lp', lo: 1400, hi: 1800, edge: 15, OD: 6, Tmax: 0.9, on: true },
    { id: 'custom', name: '사용자 BP', kind: 'bp', lo: 1500, hi: 1600, edge: 10, OD: 6, Tmax: 0.9, on: false },
    { id: 'all', name: '전체 (LP900)', kind: 'lp', lo: 900, hi: 1800, edge: 15, OD: 6, Tmax: 0.9, on: false },
  ];

  // ---------- 검출기 ----------
  const S = (x, x0, w) => 1 / (1 + Math.exp(-(x - x0) / w));
  const DETECTORS = {
    ingaas: { name: 'InGaAs 카메라 (900–1700 nm)', QE: l => 0.80 * S(l, 925, 18) * (1 - S(l, 1675, 15)) },
    ingaas_vis: { name: 'InGaAs VisNIR (400–1700 nm)', QE: l => (0.35 + 0.45 * S(l, 900, 60)) * S(l, 420, 15) * (1 - S(l, 1675, 15)) },
    ingaas_ext: { name: '확장 InGaAs (1000–2200 nm)', QE: l => 0.70 * S(l, 1000, 25) * (1 - S(l, 2150, 20)) },
    si_ccd: { name: 'Si CCD (참고용, ~1100 nm 컷오프)', QE: l => 0.9 * (1 - Math.exp(-M.alpha({ material: 'Si' }, l) * 15e-4)) * S(l, 380, 15) },
  };

  /** 채널의 실효 중심 파장 (필터×QE 가중) */
  function channelCenter(ch, det) {
    let s = 0, w = 0;
    for (const l of PL.LAM) { const t = filterT(ch, l) * det.QE(l); s += t * l; w += t; }
    return w > 0 ? s / w : (ch.lo + (ch.hi || ch.lo + 200)) / 2;
  }

  /** PSF Gaussian σ [µm] : 회절 + 디포커스(겉보기 깊이 z/n 기준 기하 블러) */
  function psfSigma(lamc_nm, NA, dzDefocus_um, n) {
    const sd = 0.21 * (lamc_nm / 1000) / NA;
    const tanA = NA / Math.sqrt(Math.max(1 - NA * NA, 1e-3));
    const rb = Math.abs(dzDefocus_um) / n * tanA;
    return Math.sqrt(sd * sd + 0.25 * rb * rb);
  }

  function photonEnergyJ(lam) { return C.HC / lam * C.q; }

  PL.Optics = {
    LASERS, topSemi, reflectance, generationFraction, collectionGeom, escape,
    filterT, CHANNEL_PRESETS, DETECTORS, channelCenter, psfSigma, photonEnergyJ,
  };
})(PL);

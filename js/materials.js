/* materials.js — 300 K 물성 데이터베이스 (Si, SiGe, SiO2)
 * 단위: 길이 cm (명시가 없으면), 에너지 eV, 파장 nm, 시간 s
 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  const C = PL.C = {
    T: 300,
    kT: 0.025852,          // eV @300 K
    HC: 1239.842,          // eV·nm
    q: 1.602176634e-19,    // J/eV
  };

  // ---------- 스펙트럼 격자 (검출 대역 전체) ----------
  const LAM = [];
  for (let l = 800; l <= 1800.0001; l += 2.5) LAM.push(l);
  PL.LAM = Float64Array.from(LAM);
  PL.DLAM = 2.5;

  // ---------- Si 흡수계수 α(λ) [cm^-1], 300 K (Green 2008 기반, 밴드끝은 외삽) ----------
  const SI_ALPHA = [
    [250, 1.84e6], [300, 1.73e6], [350, 1.04e6], [370, 6.95e5], [380, 2.93e5],
    [390, 1.50e5], [400, 9.52e4], [420, 5.00e4], [450, 2.55e4], [475, 1.80e4],
    [500, 1.11e4], [532, 7.85e3], [550, 6.39e3], [600, 4.14e3], [650, 2.81e3],
    [700, 1.90e3], [750, 1.30e3], [800, 8.50e2], [850, 5.35e2], [900, 3.06e2],
    [950, 1.57e2], [1000, 6.40e1], [1050, 1.64e1], [1080, 7.0], [1100, 3.5],
    // 밴드끝 꼬리(>1100 nm): 상온 Si 내부 PL 피크 ≈ 1.09–1.10 eV 가 재현되도록 보정한 값
    [1120, 1.9], [1140, 0.95], [1150, 0.62], [1160, 0.42], [1175, 0.23], [1200, 8.0e-2],
    [1250, 8.0e-3], [1300, 4.0e-4], [1350, 1.5e-5], [1400, 3.0e-7], [1600, 1.0e-12], [2000, 1.0e-20],
  ];
  // 굴절률 n(λ) Si
  const SI_N = [
    [400, 5.57], [450, 4.67], [500, 4.30], [532, 4.15], [600, 3.94], [633, 3.88],
    [700, 3.79], [800, 3.69], [900, 3.62], [1000, 3.57], [1100, 3.54], [1300, 3.50],
    [1550, 3.48], [1800, 3.46], [2200, 3.45],
  ];

  function interp(table, x, logY) {
    if (x <= table[0][0]) return table[0][1];
    const n = table.length;
    if (x >= table[n - 1][0]) return table[n - 1][1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (table[m][0] <= x) lo = m; else hi = m; }
    const [x0, y0] = table[lo], [x1, y1] = table[hi];
    const t = (x - x0) / (x1 - x0);
    if (logY) return Math.exp(Math.log(y0) + t * (Math.log(y1) - Math.log(y0)));
    return y0 + t * (y1 - y0);
  }
  PL.interp = interp;

  const EG_SI = 1.124; // eV @300 K

  /** SiGe 밴드갭 감소량 ΔEg(x) [eV] */
  function dEgSiGe(x, strained) {
    if (x <= 0) return 0;
    // strained(pseudomorphic on Si): Lang et al. 피팅, relaxed: Weber & Alonso
    return strained ? (0.896 * x - 0.396 * x * x) : (0.43 * x - 0.0206 * x * x);
  }

  /** 재료 객체(layer 또는 class)에 대한 광학/전기 함수 */
  function bandgap(mat) {
    if (mat.material === 'SiO2') return 9.0;
    return EG_SI - (mat.material === 'SiGe' ? dEgSiGe(mat.x, mat.strained) : 0) - (mat.dEgExtra || 0);
  }

  /** 흡수계수 α(λ) [cm^-1]: SiGe는 Si 곡선을 ΔEg 만큼 에너지 이동(강체 이동 근사) */
  function alpha(mat, lam) {
    if (mat.material === 'SiO2') return 0;
    const dEg = EG_SI - bandgap(mat);
    if (dEg === 0) return interp(SI_ALPHA, lam, true);
    const E = C.HC / lam + dEg;
    return interp(SI_ALPHA, C.HC / E, true);
  }

  function nIndex(mat, lam) {
    if (mat.material === 'SiO2') return 1.46;
    const n = interp(SI_N, lam, false);
    return mat.material === 'SiGe' ? n + 0.3 * mat.x : n;
  }

  /** 이동도 (Klaassen 단순식) [cm²/Vs]; SiGe는 합금 산란 감소 */
  function mobility(N, carrier, mat) {
    let mu;
    if (carrier === 'e') mu = 52.2 + (1417 - 52.2) / (1 + Math.pow(N / 9.68e16, 0.68));
    else mu = 44.9 + (470.5 - 44.9) / (1 + Math.pow(N / 2.23e17, 0.719));
    if (mat.material === 'SiGe') mu /= (1 + 8 * mat.x);
    return mu;
  }

  /** 층의 재결합/수송 파라미터 계산 (주입 수준 dn [cm^-3]) */
  const B_RAD = 9.5e-15;           // cm³/s (Trupke 2003, 300 K)
  const C_N = 2.8e-31, C_P = 0.99e-31; // Auger cm^6/s
  function recomb(mat, dn) {
    const N = mat.N;
    const M = N + dn; // 다수캐리어
    const Dn = C.kT * mobility(N, 'e', mat), Dp = C.kT * mobility(N, 'h', mat);
    let invRad = B_RAD * (mat.Bscale || 1) * M;
    let invAug, Dmin, Dmaj;
    if (mat.dopType === 'n') { invAug = (C_N * M + C_P * dn) * M; Dmin = Dp; Dmaj = Dn; }
    else { invAug = (C_N * dn + C_P * M) * M; Dmin = Dn; Dmaj = Dp; }
    // 양극성 확산계수 (저주입 → 소수캐리어 D, 고주입 → 2DnDp/(Dn+Dp))
    const nmin = dn, nmaj = M;
    const D = (nmin + nmaj) * Dmin * Dmaj / (nmin * Dmin + nmaj * Dmaj);
    const invSRH = 1 / (mat.tau_us * 1e-6);
    return { D, invTau: invSRH + invRad + invAug, invRad, B: B_RAD * (mat.Bscale || 1), M };
  }

  // ---------- 임계 두께 ----------
  const A_SI = 0.5431; // nm
  function mismatch(x) { return 0.0418 * x; }
  /** Matthews–Blakeslee (60° 전위) [nm] */
  function hcMB(x) {
    if (x <= 0) return Infinity;
    const b = 0.384, nu = 0.28, f = mismatch(x);
    const pre = b * (1 - nu * 0.25) / (8 * Math.PI * f * (1 + nu) * 0.5);
    let h = 10;
    for (let i = 0; i < 100; i++) h = pre * (Math.log(h / b) + 1);
    return h;
  }
  /** People–Bean (준안정 한계) [nm] */
  function hcPB(x) {
    if (x <= 0) return Infinity;
    const b = 0.4, nu = 0.28, f = mismatch(x);
    const pre = (1 - nu) / (1 + nu) / (16 * Math.PI * Math.SQRT2) * (b * b / A_SI) / (f * f);
    let h = 100;
    for (let i = 0; i < 200; i++) h = pre * Math.log(Math.max(h / b, 1.0001));
    return h;
  }

  // ---------- 발광 스펙트럼 형태 ----------
  /** 밴드간 발광: 일반화 Planck(van Roosbroeck–Shockley) r(E) ∝ α(E)·E²·exp(−E/kT)
   *  λ 격자 위 photon/nm 분포, 합 = 1 로 정규화 */
  function bbShape(mat) {
    const L = PL.LAM, out = new Float64Array(L.length);
    const isGe = mat.material === 'SiGe';
    // 합금 무질서 broadening (Gaussian σ, eV)
    const sig = isGe ? 0.1 * mat.x * (1 - mat.x) + 0.002 : 0;
    let s = 0;
    const raw = new Float64Array(L.length);
    for (let i = 0; i < L.length; i++) {
      const E = C.HC / L[i];
      raw[i] = alpha(mat, L[i]) * E * E * Math.exp(-(E - 1.0) / C.kT) * (E * E / C.HC);
    }
    if (sig > 0) {
      for (let i = 0; i < L.length; i++) {
        const Ei = C.HC / L[i]; let acc = 0, wsum = 0;
        for (let j = 0; j < L.length; j++) {
          const d = (C.HC / L[j] - Ei) / sig;
          if (d * d > 25) continue;
          const w = Math.exp(-0.5 * d * d); acc += w * raw[j]; wsum += w;
        }
        out[i] = wsum > 0 ? acc / wsum : 0;
      }
    } else out.set(raw);
    for (let i = 0; i < L.length; i++) s += out[i] * PL.DLAM;
    if (s > 0) for (let i = 0; i < L.length; i++) out[i] /= s;
    return out;
  }

  /** 전위 관련 D-line (상온 위치) */
  const DLINES = [
    { name: 'D1', E: 0.800 }, { name: 'D2', E: 0.862 },
    { name: 'D3', E: 0.930 }, { name: 'D4', E: 0.995 },
  ];
  const DLINE_FWHM = 0.065; // eV (상온 폭)
  function dShape(mix) {
    const L = PL.LAM, out = new Float64Array(L.length);
    const sig = DLINE_FWHM / 2.3548;
    for (let i = 0; i < L.length; i++) {
      const E = C.HC / L[i]; let v = 0;
      for (let d = 0; d < 4; d++) {
        if (!mix[d]) continue;
        const z = (E - DLINES[d].E) / sig;
        v += mix[d] * Math.exp(-0.5 * z * z);
      }
      out[i] = v * E * E / C.HC; // 에너지 밀도 → 파장 밀도
    }
    let s = 0;
    for (let i = 0; i < L.length; i++) s += out[i] * PL.DLAM;
    if (s > 0) for (let i = 0; i < L.length; i++) out[i] /= s;
    return out;
  }

  function peakLambda(shape) {
    let im = 0;
    for (let i = 1; i < shape.length; i++) if (shape[i] > shape[im]) im = i;
    return PL.LAM[im];
  }

  PL.mat = {
    EG_SI, B_RAD, dEgSiGe, bandgap, alpha, nIndex, mobility, recomb,
    hcMB, hcPB, mismatch, bbShape, dShape, DLINES, peakLambda,
  };
})(PL);

/* noise.js — 광학/검출 노이즈 및 이미지 처리 유틸
 *  여기 단계: 조명 불균일, 레이저 스페클  (확산 전에 G에 곱해짐 → 확산이 스페클을 평균화)
 *  검출 단계: 샷(Poisson), 다크 전류, 리드 노이즈, PRNU, DSNU(고정 패턴), ADC 양자화, 레이저 누설, RIN
 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  function gauss(R) { // Box–Muller
    let u = 0, v = 0; while (u === 0) u = R(); v = R();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function poisson(R, lam) {
    if (lam <= 0) return 0;
    if (lam < 30) { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= R(); } while (p > L); return k - 1; }
    return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(R)));
  }

  /** 분리형 Gaussian 블러 (반사 경계) — σ 단위: 픽셀 */
  function blur(img, nx, ny, sigma) {
    if (!(sigma > 0.15)) return Float64Array.from(img);
    const r = Math.ceil(3.5 * sigma), ker = new Float64Array(2 * r + 1);
    let s = 0; for (let i = -r; i <= r; i++) { ker[i + r] = Math.exp(-0.5 * i * i / (sigma * sigma)); s += ker[i + r]; }
    for (let i = 0; i < ker.length; i++) ker[i] /= s;
    const refl = (i, n) => { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };
    const tmp = new Float64Array(nx * ny), out = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0; for (let t = -r; t <= r; t++) a += ker[t + r] * img[j * nx + refl(i + t, nx)]; tmp[j * nx + i] = a;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0; for (let t = -r; t <= r; t++) a += ker[t + r] * tmp[refl(j + t, ny) * nx + i]; out[j * nx + i] = a;
    }
    return out;
  }

  /** 레이저 스페클 강도 패턴 (평균 1). grain: 스페클 알갱이 크기[px], C: 대비(0~1) */
  function speckle(nx, ny, grain, Cst, R) {
    const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) { re[i] = gauss(R); im[i] = gauss(R); }
    const s = Math.max(grain / 2.0, 0.3);
    const a = blur(re, nx, ny, s), b = blur(im, nx, ny, s);
    const I = new Float64Array(nx * ny); let m = 0;
    for (let i = 0; i < I.length; i++) { I[i] = a[i] * a[i] + b[i] * b[i]; m += I[i]; }
    m /= I.length;
    for (let i = 0; i < I.length; i++) I[i] = 1 + Cst * (I[i] / m - 1);
    return I;
  }

  /** 조명 프로파일 (평균이 아니라 '중심 = 1' 기준) */
  function illumination(nx, ny, dx, opt) {
    const P = new Float64Array(nx * ny);
    const cx = nx * dx / 2, cy = ny * dx / 2;
    const s = (opt.illumFWHM || 1e9) / 2.3548;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx - cx, y = (j + 0.5) * dx - cy;
      P[j * nx + i] = opt.illumProfile === 'gauss' ? Math.exp(-0.5 * (x * x + y * y) / (s * s)) : 1;
    }
    return P;
  }

  /** 카메라 노출: ideal[e-/s], 반환 {e (전자수), adu, sigma(e) 추정, t} */
  function camera(ideal, nx, ny, nz, cfg, R, fixedR) {
    const n = ideal.length, t = cfg.t;
    const on = cfg.on;
    const e = new Float64Array(n), adu = new Float64Array(n);
    const gain = cfg.fullWell / (Math.pow(2, cfg.bits) - 1); // e-/ADU
    for (let i = 0; i < n; i++) {
      const prnu = on.prnu ? 1 + cfg.prnu * gauss(fixedR) : 1;
      const dsnu = on.fpn ? Math.max(0, 1 + cfg.dsnu * gauss(fixedR)) : 1;
      let sig = ideal[i] * t * prnu + (on.leak ? cfg.leak * t : 0);
      let dark = on.dark ? cfg.dark * t * dsnu : 0;
      let v = on.shot ? poisson(R, sig + dark) : sig + dark;
      if (on.read) v += cfg.read * gauss(R);
      v = Math.min(Math.max(v, 0), cfg.fullWell);
      e[i] = v;
      adu[i] = on.quant ? Math.round(v / gain) : v / gain;
    }
    return { e, adu, gain };
  }

  /** 단일 픽셀 노이즈 σ [e-] — SNR 계산용 */
  function sigmaE(signal_e, cfg) {
    const on = cfg.on, t = cfg.t;
    let v = 0;
    if (on.shot) v += signal_e + (on.dark ? cfg.dark * t : 0) + (on.leak ? cfg.leak * t : 0);
    if (on.read) v += cfg.read * cfg.read;
    if (on.prnu) v += Math.pow(cfg.prnu * signal_e, 2);
    if (on.quant) v += Math.pow(cfg.fullWell / (Math.pow(2, cfg.bits) - 1), 2) / 12;
    if (on.rin && cfg.rin) v += Math.pow(cfg.rin * signal_e, 2);
    return Math.sqrt(Math.max(v, 1e-12));
  }

  /** 스캔 모드 RIN: 픽셀별 레이저 세기 요동 + 라인 드리프트 */
  function applyRIN(ideal, nx, ny, rin, R) {
    const out = new Float64Array(ideal.length);
    for (let j = 0; j < ny; j++) {
      const line = 1 + 0.5 * rin * gauss(R);
      for (let i = 0; i < nx; i++) out[j * nx + i] = ideal[j * nx + i] * line * (1 + rin * gauss(R));
    }
    return out;
  }

  PL.Noise = { gauss, poisson, blur, speckle, illumination, camera, sigmaE, applyRIN };
})(PL);

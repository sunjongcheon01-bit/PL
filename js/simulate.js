/* simulate.js — 시뮬레이션 파이프라인
 *
 *  Widefield : 면 조사 → 3D 확산(고주입 Picard 반복) → 셀별 발광 → 채널별(필터·QE) 수집
 *              → 깊이별 디포커스 PSF 블러 → 카메라 노이즈
 *  Scanning  : 점 조사 래스터 스캔. 저주입 선형 근사에서 상반성(reciprocity) 사용:
 *              S(r0) = Σ ψ·g(r0),  A ψ = c(채널 수집 가중)  → 채널당 1회 풀이로 전체 맵
 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';
  const M = PL.mat, O = PL.Optics, Nz = PL.Noise, C = PL.C;
  const CN = 2.8e-31, CP = 0.99e-31;

  function prepare(state, opt) {
    opt = opt || {};
    const o = state.optics;
    const Z = PL.buildZGrid(state, o.lamExc);
    const dxum = state.domain.dx;
    const nx = Math.max(4, Math.round(state.domain.Lx / dxum)), ny = nx;
    const G3 = { nx, ny, nz: Z.nz, dxum, dx: dxum * 1e-4, zc: Z.zc, zf: Z.zf, dzum: Z.dz, dz: Z.dz.map(v => v * 1e-4), active: Z.active, layerIdx: Z.layerIdx };
    const N = nx * ny * Z.nz;

    // 방출 클래스 (층별 + Ge 과잉 영역별)
    const classes = [], layerClass = new Int32Array(state.layers.length).fill(-1);
    const kT = C.kT, conf = state.physics.confFrac;
    const mkClass = (mat, kind, label) => {
      const Eg = M.bandgap(mat);
      const ne = M.mobility(mat.N, 'e', mat) * kT, nh = M.mobility(mat.N, 'h', mat) * kT;
      const cls = {
        mat, kind, label, Eg, shape: M.bbShape(mat),
        w: Math.exp(conf * (M.EG_SI - Eg) / kT),
        N: mat.N, nType: mat.dopType === 'n',
        Dmin: mat.dopType === 'n' ? nh : ne, Dmaj: mat.dopType === 'n' ? ne : nh,
        invSRH: 1 / (mat.tau_us * 1e-6), B: M.B_RAD * (mat.Bscale || 1),
      };
      classes.push(cls); return classes.length - 1;
    };
    state.layers.forEach((L, i) => {
      if (L.material !== 'SiO2') layerClass[i] = mkClass(L, L.material === 'SiGe' && L.x > 0 ? 'SiGe' : 'Si', `층${i + 1} ${L.material}${L.material === 'SiGe' ? ' x=' + L.x : ''}`);
    });

    const defState = opt.noDefects ? { defects: [] } : state;
    const Dat = (k) => classes[layerClass[Z.layerIdx[k]]] ? classes[layerClass[Z.layerIdx[k]]].Dmin : 30;
    const R = PL.rasterizeDefects(defState, G3, { Dat, dzAt: (k) => Z.dz[k] });
    const clusterClass = R.clusters.map(cl => {
      const d = cl.def;
      const k = (() => { let k = 0; while (k < Z.nz - 1 && Z.zf[k + 1] <= d.z) k++; return k; })();
      const base = state.layers[Z.layerIdx[k]];
      const mat = Object.assign({}, base, base.material === 'SiGe' ? { x: Math.min(base.x + d.dxGe, 0.9) } : { material: 'SiGe', x: d.dxGe, strained: true });
      return mkClass(mat, 'cluster', 'Ge 과잉 #' + d.id);
    });
    const cellClass = new Int32Array(N);
    for (let c = 0; c < N; c++) {
      const k = c % Z.nz;
      cellClass[c] = R.cluster[c] >= 0 ? clusterClass[R.cluster[c]] : layerClass[Z.layerIdx[k]];
    }

    // 광학
    const gen = O.generationFraction(state, Z, o.lamExc);
    const Tesc = O.escape(state, Z, o.NA);
    const det = O.DETECTORS[o.detector] || O.DETECTORS.ingaas;
    const QE = PL.LAM.map(l => det.QE(l));
    const channels = (opt.channels || o.channels.filter(c => c.on));
    const dShapes = R.emitters.map(e => M.dShape(e.def.mix));
    const chData = channels.map(ch => prepChannel(ch, classes, dShapes, Tesc, QE, Z.nz, det, state));

    return { state, Z, G3, N, R, classes, cellClass, gen, Tesc, det, QE, channels, chData, dShapes, layerClass };
  }

  function prepChannel(ch, classes, dShapes, Tesc, QE, nz, det, state) {
    const F = PL.LAM.map(l => O.filterT(ch, l));
    const wt = new Float64Array(PL.LAM.length);
    for (let q = 0; q < wt.length; q++) wt[q] = F[q] * QE[q] * PL.DLAM;
    const proj = (shape) => {
      const out = new Float64Array(nz);
      for (let k = 0; k < nz; k++) { let s = 0; const T = Tesc[k]; for (let q = 0; q < wt.length; q++) s += shape[q] * T[q] * wt[q]; out[k] = s; }
      return out;
    };
    const lamc = O.channelCenter(ch, det);
    return { ch, F, Qc: classes.map(c => proj(c.shape)), Qd: dShapes.map(proj), lamc };
  }

  /** 셀 물성 → 행렬 계수 (dn: 주입 수준 Float64Array 또는 null=저주입) */
  function buildProps(ctx, dn) {
    const { G3, N, classes, cellClass, R, state } = ctx;
    const { nz, active, layerIdx } = G3;
    const Dw = new Float64Array(N), w = new Float64Array(N), wInvTau = new Float64Array(N), sinkW = new Float64Array(N);
    const invRadM = new Float64Array(N); // B·M (복사 재결합률 / Δn)
    for (let c = 0; c < N; c++) {
      const k = c % nz;
      if (!active[k]) { w[c] = 1; Dw[c] = 1; continue; }
      const cl = classes[cellClass[c]];
      const d = dn ? Math.max(dn[c], 0) : 0;
      const Mj = cl.N + d;
      const invAug = cl.nType ? (CN * Mj + CP * d) * Mj : (CN * d + CP * Mj) * Mj;
      const D = (d + Mj) * cl.Dmin * cl.Dmaj / (d * cl.Dmin + Mj * cl.Dmaj);
      invRadM[c] = cl.B * Mj;
      w[c] = cl.w; Dw[c] = D * cl.w;
      wInvTau[c] = cl.w * (cl.invSRH + invRadM[c] + invAug + R.regionInvTau[c]);
      sinkW[c] = R.sink[c] * cl.w;
    }
    // 면 재결합 (상/하면, 이종 계면, 산화막 계면)
    const s = state.surface, faceS = new Float64Array(nz);
    let topK = -1; for (let k = 0; k < nz; k++) if (active[k]) { topK = k; break; }
    for (let k = 0; k < nz; k++) {
      if (!active[k]) continue;
      if (k === topK) faceS[k] += s.S_front;
      else if (k > 0 && !active[k - 1]) faceS[k] += s.S_ox;
      if (k === nz - 1) faceS[k] += s.S_back;
      else if (!active[k + 1]) faceS[k] += s.S_ox;
      else {
        const m1 = state.layers[layerIdx[k]].material, m2 = state.layers[layerIdx[k + 1]].material;
        if (m1 !== m2) { faceS[k] += 0.5 * s.S_int; faceS[k + 1] += 0.5 * s.S_int; }
      }
    }
    return { Dw, w, wInvTau, sinkW, faceS, topExtraS: R.topExtraS, invRadM };
  }

  // ---------- Widefield ----------
  async function widefieldSolve(ctx, hooks) {
    const { state, G3, N, gen } = ctx, o = state.optics;
    const { nx, ny, nz } = G3, A = G3.dx * G3.dx;
    let P = Nz.illumination(nx, ny, G3.dxum, o);
    if (state.noise.on.speckle) {
      const Sp = Nz.speckle(nx, ny, state.noise.speckleGrain / G3.dxum, state.noise.speckleC, PL.rng(state.noise.seed + 101));
      P = P.map((v, i) => v * Sp[i]);
    }
    const exc = ctx.R.excMask;
    const Phi0 = o.powerDensity / O.photonEnergyJ(o.lamExc); // photons/cm²/s
    const rhs = new Float64Array(N);
    for (let q = 0; q < nx * ny; q++) for (let k = 0; k < nz; k++) rhs[q * nz + k] = Phi0 * P[q] * exc[q] * gen.frac[k] * A;

    let dn = null, u = null, props = null, prevSum = 0, info = [];
    const maxIt = state.physics.highInjection ? state.physics.picardMax : 1;
    // Picard 반복은 느슨한 허용오차로, 수렴 후 마지막 1회만 정밀하게 풉니다.
    let it = 0, final = maxIt === 1;
    while (true) {
      props = buildProps(ctx, dn);
      const S = PL.Solver.assemble(G3, props);
      const lab = final ? '확산 풀이 (최종)' : `확산 풀이 Picard ${it + 1}/${maxIt}`;
      const res = await PL.Solver.solve(S, rhs, { x0: u, tol: final ? 1e-7 : 1e-4, onProgress: (i, r) => hooks && hooks.progress && hooks.progress(lab, i, r) });
      u = res.x;
      const dnNew = new Float64Array(N); let sum = 0, mx = 0;
      for (let c = 0; c < N; c++) { dnNew[c] = props.w[c] * u[c]; sum += dnNew[c]; if (dnNew[c] > mx) mx = dnNew[c]; }
      info.push({ iter: res.iter, relres: res.relres, ms: res.ms, dnMax: mx });
      hooks && hooks.log && hooks.log(`  ${lab}: PCG ${res.iter}회, 잔차 ${res.relres.toExponential(1)}, ${(res.ms / 1000).toFixed(1)} s, Δn_max=${mx.toExponential(2)} cm⁻³`);
      dn = dnNew;
      if (final) break;
      it++;
      if ((it > 1 && Math.abs(sum - prevSum) / sum < 0.005) || it >= maxIt) final = true;
      prevSum = sum;
    }
    if (state.physics.highInjection) props = buildProps(ctx, dn); // 최종 dn에 맞춘 B·M
    return { dn, props, rhs, P, Phi0, info };
  }

  /** 셀 단위 방출률(광자/s) 집계 → 채널 이미지(e-/s/px) */
  function formImages(ctx, sol, chList) {
    const { G3, R, cellClass, state } = ctx, o = state.optics;
    const { nx, ny, nz, active, zc } = G3, V0 = G3.dx * G3.dx;
    const ext = R.extMask, dn = sol.dn, invRadM = sol.props.invRadM;
    const semi = O.topSemi(state);
    const out = [];
    for (const cd of (chList || ctx.chData)) {
      const n = M.nIndex(semi, cd.lamc);
      const sig = new Float64Array(nz), bins = new Map(), binOf = new Int32Array(nz);
      for (let k = 0; k < nz; k++) {
        sig[k] = O.psfSigma(cd.lamc, o.NA, zc[k] - o.focus, n);
        const key = Math.round(Math.log(sig[k]) / 0.08);
        if (!bins.has(key)) bins.set(key, { sigma: sig[k], img: new Float64Array(nx * ny) });
        binOf[k] = key;
      }
      const bk = new Array(nz); for (let k = 0; k < nz; k++) bk[k] = bins.get(binOf[k]).img;
      for (let q = 0; q < nx * ny; q++) {
        const b = q * nz, e = ext[q];
        for (let k = 0; k < nz; k++) {
          if (!active[k]) continue;
          const c = b + k;
          const ph = invRadM[c] * dn[c] * V0 * G3.dz[k];
          bk[k][q] += ph * cd.Qc[cellClass[c]][k] * e;
        }
      }
      R.emitters.forEach((em, ei) => {
        const eta = em.def.etaD, Qd = cd.Qd[ei];
        for (let p = 0; p < em.cells.length; p++) {
          const c = em.cells[p], k = c % nz, q = (c - k) / nz;
          bk[k][q] += eta * em.K[p] * dn[c] * Qd[k] * ext[q];
        }
      });
      const img = new Float64Array(nx * ny);
      for (const { sigma, img: b } of bins.values()) {
        const bl = Nz.blur(b, nx, ny, sigma / G3.dxum);
        for (let q = 0; q < img.length; q++) img[q] += bl[q];
      }
      out.push({ ch: cd.ch, lamc: cd.lamc, ideal: img, sigmaSurf: sig[0] });
    }
    return out;
  }

  /** 레이저 누설 (e-/s/px): 반사된 여기광 × 수집 × 필터 차단 × QE(λexc) */
  function leakage(ctx, cd, photonsPerPx) {
    const o = ctx.state.optics;
    const R = O.reflectance(ctx.state, o.lamExc);
    const f = Math.min(1, o.NA * o.NA); // 거울 반사광은 대물렌즈로 대부분 되돌아옴
    return photonsPerPx * R * f * O.filterT(cd.ch, o.lamExc) * ctx.det.QE(o.lamExc);
  }

  // ---------- Scanning ----------
  function spotKernel(fwhm_um, dxum) {
    const s = fwhm_um / 2.3548;
    const r = Math.max(0, Math.ceil(4 * s / dxum) + 1);
    const k = new Float64Array(2 * r + 1);
    const erf = PL.erf;
    for (let t = -r; t <= r; t++) {
      if (s < 1e-6) { k[t + r] = t === 0 ? 1 : 0; continue; }
      const a = ((t - 0.5) * dxum) / (s * Math.SQRT2), b = ((t + 0.5) * dxum) / (s * Math.SQRT2);
      k[t + r] = 0.5 * (erf(b) - erf(a));
    }
    return { k, r };
  }
  /** 0-패딩 분리형 컨볼루션 (스팟이 영역 밖으로 나간 부분은 손실) */
  function conv0(img, nx, ny, K) {
    const { k, r } = K, tmp = new Float64Array(nx * ny), out = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0; for (let t = -r; t <= r; t++) { const ii = i + t; if (ii >= 0 && ii < nx) a += k[t + r] * img[j * nx + ii]; } tmp[j * nx + i] = a;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let a = 0; for (let t = -r; t <= r; t++) { const jj = j + t; if (jj >= 0 && jj < ny) a += k[t + r] * tmp[jj * nx + i]; } out[j * nx + i] = a;
    }
    return out;
  }

  /** 채널 수집 가중 벡터 c (Σ c·u = 검출 e-/s) — 저주입 */
  function collectVector(ctx, props, cd) {
    const { G3, R, cellClass, N } = ctx, { nz, active } = G3, V0 = G3.dx * G3.dx;
    const c = new Float64Array(N), ext = R.extMask;
    for (let x = 0; x < N; x++) {
      const k = x % nz; if (!active[k]) continue;
      const q = (x - k) / nz;
      c[x] = props.invRadM[x] * props.w[x] * V0 * G3.dz[k] * cd.Qc[cellClass[x]][k] * ext[q];
    }
    R.emitters.forEach((em, ei) => {
      for (let p = 0; p < em.cells.length; p++) {
        const x = em.cells[p], k = x % nz, q = (x - k) / nz;
        c[x] += em.def.etaD * em.K[p] * props.w[x] * cd.Qd[ei][k] * ext[q];
      }
    });
    return c;
  }

  async function scanMaps(ctx, hooks, chList) {
    const { state, G3, gen } = ctx, o = state.optics;
    const { nx, ny, nz } = G3;
    const props = buildProps(ctx, null);
    const S = PL.Solver.assemble(G3, props);
    const Np = o.scanPower_mW * 1e-3 / O.photonEnergyJ(o.lamExc);
    const K = spotKernel(o.spotFWHM, G3.dxum);
    const out = [];
    for (const cd of (chList || ctx.chData)) {
      const cvec = collectVector(ctx, props, cd);
      const res = await PL.Solver.solve(S, cvec, { tol: 1e-8, onProgress: (i, r) => hooks && hooks.progress && hooks.progress(`상반성 풀이 [${cd.ch.name}]`, i, r) });
      hooks && hooks.log && hooks.log(`  [${cd.ch.name}] PCG ${res.iter}회, ${(res.ms / 1000).toFixed(1)} s`);
      const psi = res.x, T = new Float64Array(nx * ny);
      for (let q = 0; q < nx * ny; q++) { let s = 0; for (let k = 0; k < nz; k++) s += gen.frac[k] * psi[q * nz + k]; T[q] = s * ctx.R.excMask[q]; }
      const map = conv0(T, nx, ny, K);
      for (let q = 0; q < map.length; q++) map[q] *= Np;
      out.push({ ch: cd.ch, lamc: cd.lamc, ideal: map, psi });
    }
    return { maps: out, props, S, Np, K };
  }

  /** 스캔: (i0,j0)에 스팟을 두고 직접 순방향 풀이 → Δn (검증·스펙트럼용) */
  async function scanForward(ctx, scanRes, i0, j0, hooks) {
    const { G3, gen, N, R } = ctx, { nx, ny, nz } = G3, { k, r } = scanRes.K;
    const rhs = new Float64Array(N);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const f = scanRes.Np * k[di + r] * k[dj + r] * R.excMask[j * nx + i];
      if (!f) continue;
      for (let kk = 0; kk < nz; kk++) rhs[(j * nx + i) * nz + kk] = f * gen.frac[kk];
    }
    const res = await PL.Solver.solve(scanRes.S, rhs, { tol: 1e-9, onProgress: (it, rr) => hooks && hooks.progress && hooks.progress('스팟 순방향 풀이', it, rr) });
    const dn = new Float64Array(N);
    for (let c = 0; c < N; c++) dn[c] = scanRes.props.w[c] * res.x[c];
    return { dn, u: res.x, rhs, props: scanRes.props };
  }

  // ---------- 스펙트럼 ----------
  /** cols: 열(column) 인덱스 배열 또는 null(전체). 반환: 성분별 검출 스펙트럼(e-/s/nm)과 내부 발광 스펙트럼 */
  function spectrum(ctx, dn, props, cols) {
    const { G3, R, cellClass, classes, Tesc, QE } = ctx, { nx, ny, nz, active } = G3, V0 = G3.dx * G3.dx;
    const nl = PL.LAM.length, ncl = classes.length;
    const W = new Float64Array(ncl * nz);
    const colList = cols || Array.from({ length: nx * ny }, (_, i) => i);
    const colSet = cols ? new Set(cols) : null;
    for (const q of colList) {
      const e = R.extMask[q];
      for (let k = 0; k < nz; k++) {
        if (!active[k]) continue; const c = q * nz + k;
        W[cellClass[c] * nz + k] += props.invRadM[c] * dn[c] * V0 * G3.dz[k] * e;
      }
    }
    const comps = { Si: new Float64Array(nl), SiGe: new Float64Array(nl), cluster: new Float64Array(nl), D: new Float64Array(nl) };
    const intr = { Si: new Float64Array(nl), SiGe: new Float64Array(nl), cluster: new Float64Array(nl), D: new Float64Array(nl) };
    for (let ci = 0; ci < ncl; ci++) {
      const cl = classes[ci], A = comps[cl.kind], B = intr[cl.kind];
      for (let k = 0; k < nz; k++) {
        const w = W[ci * nz + k]; if (!w) continue;
        const T = Tesc[k];
        for (let l = 0; l < nl; l++) { const v = w * cl.shape[l]; B[l] += v; A[l] += v * T[l] * QE[l]; }
      }
    }
    R.emitters.forEach((em, ei) => {
      const Wd = new Float64Array(nz);
      for (let p = 0; p < em.cells.length; p++) {
        const c = em.cells[p], k = c % nz, q = (c - k) / nz;
        if (colSet && !colSet.has(q)) continue;
        Wd[k] += em.def.etaD * em.K[p] * dn[c] * R.extMask[q];
      }
      const sh = ctx.dShapes[ei];
      for (let k = 0; k < nz; k++) {
        if (!Wd[k]) continue; const T = Tesc[k];
        for (let l = 0; l < nl; l++) { const v = Wd[k] * sh[l]; intr.D[l] += v; comps.D[l] += v * T[l] * QE[l]; }
      }
    });
    const total = new Float64Array(nl), totalIntr = new Float64Array(nl);
    for (const key in comps) for (let l = 0; l < nl; l++) { total[l] += comps[key][l]; totalIntr[l] += intr[key][l]; }
    return { comps, intr, total, totalIntr };
  }

  /** 스펙트럼 맵: 여러 협대역 채널로 피크/무게중심 파장 */
  function bandChannels(lo, hi, n) {
    const out = [], w = (hi - lo) / n;
    for (let b = 0; b < n; b++) out.push({ id: 'band' + b, name: `${Math.round(lo + b * w)}–${Math.round(lo + (b + 1) * w)}`, kind: 'bp', lo: lo + b * w, hi: lo + (b + 1) * w, edge: 1, OD: 9, Tmax: 1 });
    return out;
  }
  function centroidMap(imgs) {
    const n = imgs[0].ideal.length, cen = new Float64Array(n), pk = new Float64Array(n);
    for (let q = 0; q < n; q++) {
      let s = 0, ws = 0, best = -1, bl = 0;
      for (const im of imgs) { const v = im.ideal[q], l = 0.5 * (im.ch.lo + im.ch.hi); s += v * l; ws += v; if (v > best) { best = v; bl = l; } }
      cen[q] = ws > 0 ? s / ws : 0; pk[q] = bl;
    }
    return { centroid: cen, peak: pk };
  }

  // ---------- 노이즈 적용 ----------
  function noiseCfg(state, t) {
    const n = state.noise;
    return { t, on: n.on, fullWell: n.fullWell, read: n.read, dark: n.dark, prnu: n.prnu / 100, dsnu: n.dsnu / 100, bits: n.bits, rin: n.on.rin ? n.rin / 100 : 0, leak: 0 };
  }
  function applyNoise(ctx, img, leak) {
    const st = ctx.state, n = st.noise, { nx, ny } = ctx.G3;
    let ideal = img.ideal;
    const mode = st.optics.mode;
    if (mode === 'scan' && n.on.rin) ideal = Nz.applyRIN(ideal, nx, ny, n.rin / 100, PL.rng(n.seed + 7));
    let mx = 0; for (const v of ideal) if (v > mx) mx = v;
    let t = mode === 'scan' ? st.optics.dwell_ms * 1e-3 : (n.autoExp ? 0.7 * n.fullWell / Math.max(mx + leak + (n.on.dark ? n.dark : 0), 1e-30) : n.exposure_ms * 1e-3);
    if (mode !== 'scan' && n.autoExp) t = Math.min(Math.max(t, 1e-6), 30);
    const cfg = noiseCfg(st, t); cfg.leak = leak;
    if (mode === 'scan') cfg.fullWell = Math.max(cfg.fullWell, mx * t * 1.2 + 1e3); // 단일 검출기: 포화 없음 가정
    let h = 0; for (const ch of img.ch.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const cam = Nz.camera(ideal, nx, ny, 1, cfg, PL.rng(n.seed + 13 + h), PL.rng(n.seed + 999));
    return { t, cfg, e: cam.e, adu: cam.adu, gain: cam.gain };
  }

  // ---------- 검출 분석 ----------
  function defectSamples(d) {
    const pts = [];
    if (d.type === 'misfit') {
      const n = 30; for (let i = 0; i <= n; i++) { const t = -0.5 + i / n; pts.push(d.dir === 'y' ? [d.x, d.y + t * d.size] : [d.x + t * d.size, d.y]); }
    } else if (d.type === 'stacking_fault') {
      const th = 54.7356 * Math.PI / 180, off = d.size * Math.cos(th);
      for (let i = 0; i <= 10; i++) { const t = -0.5 + i / 10; pts.push(d.dir === 'y' ? [d.x + off * 0.3, d.y + t * d.size] : [d.x + t * d.size, d.y + off * 0.3]); }
    } else pts.push([d.x, d.y]);
    return pts;
  }
  /** 결함별 국부 대비와 SNR.
   *  확산 길이가 길면 모든 결함이 시야 전체의 Δn을 함께 낮추므로(전역 감소),
   *  차이 맵 Dm = I − I_ref 에서 '주변 고리 중앙값'을 빼서 국부 대비만 봅니다.
   *  기준(I_ref)이 없으면 I 자체에 같은 방법을 씁니다. */
  function analyze(ctx, imgs, refs, noises, thr) {
    const { G3, state } = ctx, { nx, ny, dxum } = G3;
    const rows = [];
    for (const d of state.defects) {
      const row = { def: d, ch: [] };
      const rin = Math.max(4, Math.ceil(((d.type === 'misfit' ? 0 : d.size / 2) + 3) / dxum)), rout = rin + Math.max(4, Math.ceil(5 / dxum));
      imgs.forEach((im, ci) => {
        const ref = refs ? refs[ci].ideal : null;
        const Dm = (q) => im.ideal[q] - (ref ? ref[q] : 0);
        let best = { dI: 0, I0: 0 };
        for (const [x, y] of defectSamples(d)) {
          const i0 = Math.floor(x / dxum), j0 = Math.floor(y / dxum);
          const ring = [];
          for (let dj = -rout; dj <= rout; dj++) for (let di = -rout; di <= rout; di++) {
            const rr = Math.hypot(di, dj); if (rr < rin || rr > rout) continue;
            const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            ring.push(Dm(j * nx + i));
          }
          ring.sort((a, b) => a - b);
          const bgD = ring.length ? ring[ring.length >> 1] : 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            const q = j * nx + i, I0 = (ref ? ref[q] : 0) + bgD, dI = Dm(q) - bgD;
            if (Math.abs(dI) > Math.abs(best.dI)) best = { dI, I0 };
          }
        }
        const nz_ = noises[ci];
        const sig = Nz.sigmaE(Math.max(best.I0, 0) * nz_.t, nz_.cfg);
        const snr = Math.abs(best.dI) * nz_.t / sig;
        row.ch.push({ contrast: best.I0 > 0 ? best.dI / best.I0 : (best.dI > 0 ? Infinity : 0), snr, detected: snr >= thr, bright: best.dI > 0 });
      });
      rows.push(row);
    }
    return rows;
  }

  // erf (Numerical Recipes erfc Chebyshev 근사, 오차 < 1.2e-7)
  PL.erf = function (x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.5 * x);
    const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return s * y;
  };

  PL.Sim = {
    prepare, prepChannel, buildProps, widefieldSolve, formImages, leakage, spotKernel, conv0,
    collectVector, scanMaps, scanForward, spectrum, bandChannels, centroidMap, applyNoise, analyze, noiseCfg,
  };
})(PL);

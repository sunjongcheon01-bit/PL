/* solver.js — 3D 정상상태 캐리어 확산 방정식 유한체적 해법
 *
 *  −∇·(D w ∇u) + (w/τ) u + Σ K_defect w u = G ,   Δn = w·u
 *
 *  w = exp(ΔE_conf/kT) 는 SiGe 밴드 오프셋에 의한 캐리어 가둠(Slotboom 변환).
 *  이 형태는 대칭 양정치 행렬이 되므로 전처리 공액경사법(PCG)으로 풉니다.
 *  전처리기: 깊이(z) 방향 선(line) 삼중대각 역행렬 — 얇은 층(비등방 격자)에 강함.
 *  인덱스: idx = (j*nx + i)*nz + k   (z 방향이 연속)
 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  /**
   * g: {nx, ny, nz, dx[cm], dz[cm Float64Array], active[Uint8Array nz]}
   * p: {Dw, wInvTau, sinkW : Float64Array(N); faceS: Float64Array(nz) 상/하면 SRV×w 합(cm/s);
   *     topExtraS: Float64Array(nx*ny) | null (top cell 추가 SRV×w)}
   */
  function assemble(g, p) {
    const { nx, ny, nz, dx, dz, active } = g;
    const N = nx * ny * nz, A = dx * dx;
    const diag = new Float64Array(N), Tx = new Float64Array(N), Ty = new Float64Array(N), Tz = new Float64Array(N);
    const sx = nz, sy = nx * nz;
    let topK = -1;
    for (let k = 0; k < nz; k++) if (active[k]) { topK = k; break; }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const col = (j * nx + i) * nz;
      for (let k = 0; k < nz; k++) {
        const c = col + k;
        if (!active[k]) { diag[c] = 1; continue; }
        const V = A * dz[k];
        diag[c] += V * p.wInvTau[c] + p.sinkW[c] + A * p.faceS[k] * p.w[c];
        if (k === topK && p.topExtraS) diag[c] += A * p.topExtraS[j * nx + i] * p.w[c];
        const Da = p.Dw[c];
        if (k < nz - 1 && active[k + 1]) {
          const t = A / (dz[k] / (2 * Da) + dz[k + 1] / (2 * p.Dw[c + 1]));
          Tz[c] = t; diag[c] += t; diag[c + 1] += t;
        }
        if (i < nx - 1) {
          const Db = p.Dw[c + sx];
          const t = dz[k] * 2 * Da * Db / (Da + Db);
          Tx[c] = t; diag[c] += t; diag[c + sx] += t;
        }
        if (j < ny - 1) {
          const Db = p.Dw[c + sy];
          const t = dz[k] * 2 * Da * Db / (Da + Db);
          Ty[c] = t; diag[c] += t; diag[c + sy] += t;
        }
      }
    }
    const S = factor({ g, N, diag, Tx, Ty, Tz, sx, sy });
    S.levels = buildLevels(S);
    return S;
  }

  /** z-line 삼중대각 전처리기 분해 */
  function factor(S) {
    const { N, diag, Tz } = S, { nx, ny, nz } = S.g;
    const cp = new Float64Array(N), m = new Float64Array(N);
    for (let col = 0; col < nx * ny; col++) {
      const b0 = col * nz;
      m[b0] = 1 / diag[b0]; cp[b0] = -Tz[b0] * m[b0];
      for (let k = 1; k < nz; k++) {
        const c = b0 + k;
        const den = diag[c] + Tz[c - 1] * cp[c - 1];
        m[c] = 1 / den; cp[c] = -Tz[c] * m[c];
      }
    }
    S.cp = cp; S.m = m;
    return S;
  }

  // ---------- 가로 방향 멀티그리드 (z 는 유지하는 semi-coarsening) ----------
  //  확산 길이가 영역보다 길면 가로 저주파 모드가 거의 감쇠되지 않아 단순 전처리 PCG가 수백 회 반복됩니다.
  //  2×2 열을 묶어 거친 격자를 만들고(재결합 항은 합, 가로 결합은 면적/거리 보정 0.5배),
  //  z-line Jacobi 평활화를 쓰는 대칭 V-cycle 을 PCG 전처리기로 사용합니다.
  function coarsen(S) {
    const { nx, ny, nz, active } = S.g, nxc = Math.ceil(nx / 2), nyc = Math.ceil(ny / 2);
    const Nc = nxc * nyc * nz, sx = S.sx, sy = S.sy;
    const react = new Float64Array(Nc), Tx = new Float64Array(Nc), Ty = new Float64Array(Nc), Tz = new Float64Array(Nc);
    const map = new Int32Array(S.N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const c = (j * nx + i) * nz + k, C = ((j >> 1) * nxc + (i >> 1)) * nz + k;
      map[c] = C;
      if (!active[k]) continue;
      const sumT = S.Tz[c] + (k > 0 ? S.Tz[c - 1] : 0) + S.Tx[c] + (i > 0 ? S.Tx[c - sx] : 0) + S.Ty[c] + (j > 0 ? S.Ty[c - sy] : 0);
      react[C] += S.diag[c] - sumT;
      Tz[C] += S.Tz[c];
      if ((i & 1) && i < nx - 1) Tx[C] += 0.5 * S.Tx[c];
      if ((j & 1) && j < ny - 1) Ty[C] += 0.5 * S.Ty[c];
    }
    const g = { nx: nxc, ny: nyc, nz, active };
    const csx = nz, csy = nxc * nz, diag = new Float64Array(Nc);
    for (let C = 0; C < Nc; C++) {
      const k = C % nz;
      if (!active[k]) { diag[C] = 1; continue; }
      diag[C] += react[C] + Tz[C] + Tx[C] + Ty[C];
      if (k < nz - 1) diag[C + 1] += Tz[C];
      if (Tx[C]) diag[C + csx] += Tx[C];
      if (Ty[C]) diag[C + csy] += Ty[C];
    }
    return factor({ g, N: Nc, diag, Tx, Ty, Tz, sx: csx, sy: csy, map });
  }
  function buildLevels(S) {
    const levels = [S];
    let L = S;
    while ((L.g.nx > 4 || L.g.ny > 4) && levels.length < 12) { L = coarsen(L); levels.push(L); }
    if (levels.length < 2) return null;
    for (const lv of levels) { lv.r = new Float64Array(lv.N); lv.z = new Float64Array(lv.N); lv.b = new Float64Array(lv.N); lv.x = new Float64Array(lv.N); }
    return levels;
  }
  const OMEGA = 0.8;
  function smooth(L, x, b) {
    matvec(L, x, L.r);
    for (let i = 0; i < L.N; i++) L.r[i] = b[i] - L.r[i];
    precond(L, L.r, L.z);
    for (let i = 0; i < L.N; i++) x[i] += OMEGA * L.z[i];
  }
  function vcycle(levels, l, b, x) {
    const L = levels[l];
    x.fill(0);
    if (l === levels.length - 1) { for (let s = 0; s < 30; s++) smooth(L, x, b); return; }
    precond(L, b, L.z);                                   // 사전 평활 (x0 = 0)
    for (let i = 0; i < L.N; i++) x[i] = OMEGA * L.z[i];
    matvec(L, x, L.r);
    for (let i = 0; i < L.N; i++) L.r[i] = b[i] - L.r[i];
    const Cn = levels[l + 1], map = Cn.map;
    Cn.b.fill(0);
    for (let i = 0; i < L.N; i++) Cn.b[map[i]] += L.r[i];  // 제한 R = Pᵀ
    vcycle(levels, l + 1, Cn.b, Cn.x);
    for (let i = 0; i < L.N; i++) x[i] += Cn.x[map[i]];     // 연장 P (상수)
    smooth(L, x, b);                                      // 사후 평활
  }
  function applyPrec(S, r, z) {
    if (S.levels && S.useMG !== false) vcycle(S.levels, 0, r, z);
    else precond(S, r, z);
  }

  function matvec(S, x, y) {
    const { g, N, diag, Tx, Ty, Tz, sx, sy } = S;
    const { nx, ny, nz } = g;
    for (let c = 0; c < N; c++) y[c] = diag[c] * x[c];
    for (let c = 0; c < N - 1; c++) { const t = Tz[c]; if (t) { y[c] -= t * x[c + 1]; y[c + 1] -= t * x[c]; } }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx - 1; i++) {
      const b = (j * nx + i) * nz;
      for (let k = 0; k < nz; k++) { const c = b + k, t = Tx[c]; if (t) { y[c] -= t * x[c + sx]; y[c + sx] -= t * x[c]; } }
    }
    for (let j = 0; j < ny - 1; j++) {
      const b = j * nx * nz, e = b + nx * nz;
      for (let c = b; c < e; c++) { const t = Ty[c]; if (t) { y[c] -= t * x[c + sy]; y[c + sy] -= t * x[c]; } }
    }
  }

  function precond(S, r, z) {
    const { g, cp, m, Tz } = S;
    const nz = g.nz, ncol = g.nx * g.ny;
    for (let col = 0; col < ncol; col++) {
      const b0 = col * nz;
      z[b0] = r[b0] * m[b0];
      for (let k = 1; k < nz; k++) { const c = b0 + k; z[c] = (r[c] + Tz[c - 1] * z[c - 1]) * m[c]; }
      for (let k = nz - 2; k >= 0; k--) { const c = b0 + k; z[c] -= cp[c] * z[c + 1]; }
    }
  }

  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  // setTimeout 은 백그라운드 탭에서 1초 단위로 지연되므로 MessageChannel 로 양보
  const chan = new MessageChannel(), waiters = [];
  chan.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
  const tick = () => new Promise(r => { waiters.push(r); chan.port2.postMessage(0); });

  /** PCG. opts: {tol, maxIter, x0, onProgress(iter, relres), label} */
  async function solve(S, b, opts) {
    opts = opts || {};
    const N = S.N, tol = opts.tol || 1e-7, maxIter = opts.maxIter || 4000;
    const x = opts.x0 ? Float64Array.from(opts.x0) : new Float64Array(N);
    const r = new Float64Array(N), z = new Float64Array(N), p = new Float64Array(N), q = new Float64Array(N);
    matvec(S, x, q);
    for (let i = 0; i < N; i++) r[i] = b[i] - q[i];
    const bn = Math.sqrt(dot(b, b)) || 1;
    applyPrec(S, r, z); p.set(z);
    let rz = dot(r, z), it = 0, rel = Math.sqrt(dot(r, r)) / bn;
    const t0 = performance.now();
    while (rel > tol && it < maxIter) {
      matvec(S, p, q);
      const alpha = rz / dot(p, q);
      for (let i = 0; i < N; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; }
      applyPrec(S, r, z);
      const rz2 = dot(r, z), beta = rz2 / rz; rz = rz2;
      for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
      it++;
      if (it % 2 === 0) {
        rel = Math.sqrt(dot(r, r)) / bn;
        if (opts.onProgress) opts.onProgress(it, rel);
        await tick();
      }
    }
    rel = Math.sqrt(dot(r, r)) / bn;
    return { x, iter: it, relres: rel, ms: performance.now() - t0 };
  }

  PL.Solver = { assemble, matvec, precond, applyPrec, solve };
})(PL);

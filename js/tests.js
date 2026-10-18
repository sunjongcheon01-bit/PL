/* tests.js — 검증 테스트: 해석해, 문헌값, 수치 보존성, 상반성 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';
  let last = null;

  function smallState(mode) {
    const st = {
      domain: { Lx: 24, depth: 20, dx: 1 },
      layers: PL.PRESETS['Si cap / SiGe / Si'](),
      surface: { S_front: 1e3, S_back: 1e3, S_int: 100, S_ox: 100 },
      physics: { confFrac: 0.5, highInjection: false, picardMax: 1 },
      optics: { mode, lamExc: 532, powerDensity: 1, illumProfile: 'flat', illumFWHM: 100, scanPower_mW: 0.01, spotFWHM: 1, dwell_ms: 1, NA: 0.5, focus: 0, detector: 'ingaas',
        channels: JSON.parse(JSON.stringify(PL.Optics.CHANNEL_PRESETS)).map(c => Object.assign(c, { on: c.id === 'bb' || c.id === 'lp1400' })) },
      noise: { on: {}, seed: 1 }, analysis: { reference: false },
      defects: [PL.newDefect('loop', 8.5, 12.5, { z: 0.3, size: 0.1 }), PL.newDefect('threading', 16.5, 12.5, { z: 0, size: 6 })],
    };
    return st;
  }

  async function run(out, cv) {
    const lines = [];
    const add = (ok, name, detail) => { lines.push(`${ok === null ? '•' : ok ? '✔ 통과' : '✘ 실패'}  ${name}\n     ${detail}`); out.textContent = lines.join('\n\n'); };
    out.textContent = '실행 중…';
    await new Promise(r => setTimeout(r, 10));

    // 1) 1D 확산 해석해
    {
      const D = 35, tau = 1e-6, S = 1e3, a = 7850, Phi = 1e17, Lc = Math.sqrt(D * tau);
      const faces = [0]; let d = 0.005;
      while (faces[faces.length - 1] < 1000) { faces.push(faces[faces.length - 1] + d); d = Math.min(d * 1.12, 4); }
      const nz = faces.length - 1, dz = new Float64Array(nz), zc = new Float64Array(nz);
      for (let k = 0; k < nz; k++) { dz[k] = (faces[k + 1] - faces[k]) * 1e-4; zc[k] = 0.5 * (faces[k] + faces[k + 1]); }
      const nx = 2, ny = 2, N = nx * ny * nz, dx = 1e-4, A = dx * dx;
      const G = { nx, ny, nz, dx, dz, active: new Uint8Array(nz).fill(1) };
      const fill = (v) => new Float64Array(N).fill(v);
      const faceS = new Float64Array(nz); faceS[0] = S;
      const p = { Dw: fill(D), w: fill(1), wInvTau: fill(1 / tau), sinkW: fill(0), faceS, topExtraS: null };
      const Sy = PL.Solver.assemble(G, p), rhs = new Float64Array(N);
      for (let c = 0; c < N; c++) { const k = c % nz; rhs[c] = Phi * (Math.exp(-a * faces[k] * 1e-4) - Math.exp(-a * faces[k + 1] * 1e-4)) * A; }
      const res = await PL.Solver.solve(Sy, rhs, { tol: 1e-11 });
      const ana = (z) => { z *= 1e-4; return a * Phi * tau / (a * a * Lc * Lc - 1) * ((S + a * D) / (S + D / Lc) * Math.exp(-z / Lc) - Math.exp(-a * z)); };
      let err = 0; const xs = [], yn = [], ya = [];
      for (let k = 0; k < nz; k++) {
        if (zc[k] > 250) break;
        const v = res.x[k] / 1, e = Math.abs(v - ana(zc[k])) / ana(zc[k]);
        err = Math.max(err, e); xs.push(zc[k]); yn.push(v); ya.push(ana(zc[k]));
      }
      last = { xs, yn, ya };
      add(err < 0.01, '1D 확산–재결합 해석해 비교 (532 nm, L = ' + (Lc * 1e4).toFixed(0) + ' µm, S = 1e3 cm/s)', `최대 상대오차 ${(err * 100).toFixed(3)} % (z < 250 µm), PCG ${res.iter}회`);
      redraw(cv);
    }

    // 2) Si 상온 PL 스펙트럼
    {
      const sh = PL.mat.bbShape({ material: 'Si', x: 0 }), pk = PL.mat.peakLambda(sh);
      const mx = Math.max(...sh); let lo = 0, hi = 0;
      for (let i = 0; i < sh.length; i++) if (sh[i] >= mx / 2) { if (!lo) lo = PL.LAM[i]; hi = PL.LAM[i]; }
      add(pk > 1115 && pk < 1145, 'Si 상온 밴드간 PL 피크 (일반화 Planck 법칙)', `피크 ${pk.toFixed(1)} nm (문헌 ≈ 1130 nm), 반치폭 ${lo}–${hi} nm (${(PL.C.HC / lo - PL.C.HC / hi).toFixed(3)} eV, 문헌 상온 ≈ 0.07–0.1 eV)`);
    }
    // 3) SiGe 조성별 피크
    {
      const rows = [0.1, 0.2, 0.3, 0.4].map(x => {
        const m = { material: 'SiGe', x, strained: true };
        return `x=${x}: Eg ${PL.mat.bandgap(m).toFixed(3)} eV, 피크 ${PL.mat.peakLambda(PL.mat.bbShape(m)).toFixed(0)} nm`;
      });
      add(null, 'SiGe(strained) 조성별 밴드갭·PL 피크 (Ge가 많을수록 장파장으로 이동)', rows.join(' | '));
    }
    // 4) 임계 두께
    {
      const rows = [0.1, 0.2, 0.3, 0.4].map(x => `x=${x}: MB ${PL.mat.hcMB(x).toFixed(1)} nm / PB ${PL.mat.hcPB(x).toFixed(0)} nm`);
      const mb = PL.mat.hcMB(0.2);
      add(mb > 7 && mb < 25, 'SiGe/Si 임계 두께 (Matthews–Blakeslee / People–Bean)', rows.join(' | ') + '  (문헌: x=0.2에서 MB ≈ 10–20 nm, PB ≈ 100–300 nm)');
    }
    await new Promise(r => setTimeout(r, 10));

    // 5) 보존성: 총 생성 = 총 재결합
    {
      const st = smallState('widefield'), ctx = PL.Sim.prepare(st);
      const sol = await PL.Sim.widefieldSolve(ctx, null);
      const { nz } = ctx.G3, A = ctx.G3.dx * ctx.G3.dx, pr = sol.props;
      let gen = 0, rec = 0;
      let topK = 0; while (!ctx.G3.active[topK]) topK++;
      for (let c = 0; c < ctx.N; c++) {
        const k = c % nz; if (!ctx.G3.active[k]) continue;
        gen += sol.rhs[c];
        const u = sol.dn[c] / pr.w[c];
        rec += pr.wInvTau[c] * A * ctx.G3.dz[k] * u + pr.sinkW[c] * u + A * pr.faceS[k] * pr.w[c] * u + (k === topK ? A * pr.topExtraS[(c - k) / nz] * pr.w[c] * u : 0);
      }
      const e = Math.abs(rec - gen) / gen;
      add(e < 1e-5, '입자 보존 (Σ 생성 = Σ 재결합: 벌크 + 결함 + 표면)', `상대 차이 ${e.toExponential(2)}`);

      // 7) 정성적: 루프는 LP1400 밝음, BB 어두움 / 관통 전위는 BB 어두움
      const ref = PL.Sim.prepare(st, { noDefects: true });
      const solR = await PL.Sim.widefieldSolve(ref, null);
      const im = PL.Sim.formImages(ctx, sol), imR = PL.Sim.formImages(ref, solR);
      const nx = ctx.G3.nx, q = (x, y) => Math.floor(y) * nx + Math.floor(x);
      const c = (ci, x, y) => (im[ci].ideal[q(x, y)] - imR[ci].ideal[q(x, y)]) / imR[ci].ideal[q(x, y)];
      const bbI = im.findIndex(i => i.ch.id === 'bb'), lpI = im.findIndex(i => i.ch.id === 'lp1400');
      const cl_bb = c(bbI, 8.5, 12.5), cl_lp = c(lpI, 8.5, 12.5), ct_bb = c(bbI, 16.5, 12.5);
      add(cl_lp > 0 && cl_bb < 0 && ct_bb < 0, '결함 대비 부호 (물리적 기대치)',
        `전위 루프: LP1400 ${(cl_lp * 100).toFixed(1)} % (밝음 기대), BB ${(cl_bb * 100).toFixed(2)} % (어두움 기대) · 관통 전위: BB ${(ct_bb * 100).toFixed(2)} % (어두움 기대)`);
    }
    await new Promise(r => setTimeout(r, 10));

    // 6) 상반성 (스캔 맵 = 직접 순방향)
    {
      const st = smallState('scan'), ctx = PL.Sim.prepare(st);
      const cd = ctx.chData[0];
      const sm = await PL.Sim.scanMaps(ctx, null, [cd]);
      const i0 = 7, j0 = 9, f = await PL.Sim.scanForward(ctx, sm, i0, j0, null);
      const cv_ = PL.Sim.collectVector(ctx, sm.props, cd);
      let direct = 0; for (let c = 0; c < ctx.N; c++) direct += cv_[c] * f.u[c];
      const mapv = sm.maps[0].ideal[j0 * ctx.G3.nx + i0], e = Math.abs(direct - mapv) / direct;
      add(e < 1e-4, '상반성 정리 검증 (스캔 맵 1회 풀이 = 픽셀별 순방향 풀이)', `맵 ${mapv.toExponential(4)} vs 직접 ${direct.toExponential(4)} e⁻/s, 상대 차이 ${e.toExponential(2)}`);
    }
    lines.push('\n완료.'); out.textContent = lines.join('\n\n');
  }

  function redraw(cv) {
    cv = cv || document.getElementById('cvTest');
    if (!last || !cv || !cv.offsetParent) return;
    PL.Render.plot(cv, [
      { x: last.xs, y: last.ya, color: PL.Render.css('--muted'), label: '해석해', width: 2 },
      { x: last.xs, y: last.yn, color: '#e0a030', label: '수치해 (FV + PCG)', markers: true, width: 0.5 },
    ], { xlabel: '깊이 (µm)', ylabel: 'Δn (cm⁻³)', logy: true, logSpan: 1e-3, title: '테스트 1: 1D 확산 해석해 vs 수치해' });
  }

  PL.Tests = { run, redraw };
})(PL);

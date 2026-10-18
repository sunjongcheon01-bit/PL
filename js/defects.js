/* defects.js — 가상 결함 라이브러리와 격자 위 래스터화
 *
 *  모든 결함은 '재결합 싱크(sink)' K [cm³/s] 로 모델링합니다 (국부 재결합률 = K·Δn).
 *   - 점/구형: K = 1 / ( 1/(4πr²S) + (1/r − 1/Rc)/(4πD) )   (표면 반응 + 격자 이하 확산 한계)
 *   - 선(전위): 단위길이 K_L = 1 / ( 1/(2π r_c S) + ln(Rc/r_c)/(2πD) )
 *   - 면(적층결함): 단위면적 K_A = 2·S (양면)
 *  전위 계열 결함은 재결합 중 η_D 비율을 D-line(D1~D4)으로 방출 → 결함 채널에서 '밝은 점'.
 */
var PL = window.PL || (window.PL = {});
(function (PL) {
  'use strict';

  const TYPES = {
    loop: {
      label: '전위 루프', color: '#ff5d5d', geom: 'loop',
      desc: '작은 원형 전위(수십 nm~µm). 상온 D1 발광 → LP1400 채널에서 밝은 점, BB 채널에서는 약한 어두운 점.',
      def: { size: 0.1, z: 0.3, S: 1e5, rc: 0.02, etaD: 5e-4, mix: [0.9, 0.1, 0, 0] },
    },
    threading: {
      label: '관통 전위', color: '#ffb547', geom: 'vline',
      desc: '표면 방향으로 뻗은 수직 전위선. BB 채널에서 어두운 점(확산 길이만큼 퍼짐), D-line 약하게 발광.',
      def: { size: 5, z: 0, S: 1e5, rc: 0.02, etaD: 5e-5, mix: [0.85, 0.15, 0, 0] },
    },
    misfit: {
      label: 'Misfit 전위', color: '#ffd84a', geom: 'hline',
      desc: 'SiGe/Si 계면의 수평 전위선(<110> 방향). 여러 개면 격자무늬(cross-hatch).',
      def: { size: 60, z: 0.06, S: 1e5, rc: 0.02, etaD: 5e-5, mix: [0.8, 0.2, 0, 0], dir: 'x' },
    },
    stacking_fault: {
      label: '적층 결함(SF)', color: '#c77dff', geom: 'sf',
      desc: '{111}면(54.7° 기울기) 위의 면결함 + 경계 부분전위. 선/사다리꼴 모양 어두운 패턴, 경계에서 D-line.',
      def: { size: 4, z: 0, S: 1e5, rc: 0.02, etaD: 5e-5, Splane: 2e3, mix: [0.85, 0.15, 0, 0], dir: 'x' },
    },
    precipitate: {
      label: '산소 석출물(BMD)', color: '#4dd2ff', geom: 'sphere',
      desc: '구형 석출물. 계면 재결합으로 어두운 점, 펀치아웃 전위가 있으면 약한 D-line.',
      def: { size: 0.2, z: 10, S: 1e4, etaD: 2e-5, mix: [0.85, 0.15, 0, 0] },
    },
    void: {
      label: '보이드(COP)', color: '#7ee787', geom: 'sphere',
      desc: '내부 빈 공간. 내벽 표면 재결합으로 어두운 점. 발광 없음.',
      def: { size: 0.15, z: 3, S: 1e4, etaD: 0, mix: [0, 0, 0, 0] },
    },
    point_region: {
      label: '점결함/금속 오염 영역', color: '#a0a0ff', geom: 'region',
      desc: '수명이 짧아진 영역(예: Fe, Cu). 넓고 흐린 어두운 영역. 발광 없음.',
      def: { size: 6, z: 2, tauIn_us: 0.05, etaD: 0, mix: [0, 0, 0, 0] },
    },
    ge_cluster: {
      label: 'Ge 과잉 영역', color: '#ff8fd0', geom: 'region',
      desc: 'SiGe 층 내 국부적으로 Ge 농도가 높은 영역. 밴드갭↓ → 캐리어가 몰려 장파장 쪽에서 밝은 점, 피크 적색 이동.',
      def: { size: 1, z: 0.035, dxGe: 0.1, etaD: 0, mix: [0, 0, 0, 0] },
    },
    particle: {
      label: '표면 파티클/요철', color: '#e6e6e6', geom: 'disc',
      desc: '표면 물체. 여기광 차단(t_exc<1)과 광추출 변화(m_ext). m_ext>1 이면 모든 채널에서 밝게 보임(가짜 밝은 점).',
      def: { size: 2, z: 0, tExc: 0.3, mExt: 1.0, S: 1e5, etaD: 0, mix: [0, 0, 0, 0] },
    },
  };
  PL.DEFECT_TYPES = TYPES;

  let DID = 1;
  function newDefect(type, x, y, over) {
    const T = TYPES[type];
    const d = Object.assign({ id: DID++, type, x, y, dir: 'x' }, JSON.parse(JSON.stringify(T.def)), over || {});
    return d;
  }
  PL.newDefect = newDefect;
  PL.resetDefectId = (n) => { DID = n; };

  // ---------- 래스터화 ----------
  function rasterize(state, G3, ctx) {
    const { nx, ny, nz, dxum, zc, zf, active } = G3;
    const N = nx * ny * nz, Lx = nx * dxum;
    const sink = new Float64Array(N), regionInvTau = new Float64Array(N);
    const cluster = new Int16Array(N).fill(-1);
    const topExtraS = new Float64Array(nx * ny), excMask = new Float64Array(nx * ny).fill(1), extMask = new Float64Array(nx * ny).fill(1);
    const emitters = [], clusters = [];
    const Dat = ctx.Dat; // k → D [cm²/s]
    const Rc = 0.5 * dxum * 1e-4;

    function kFromZ(z) {
      if (z <= zc[0]) return [0, 0, 1];
      if (z >= zc[nz - 1]) return [nz - 1, nz - 1, 1];
      let lo = 0, hi = nz - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (zc[m] <= z) lo = m; else hi = m; }
      const t = (z - zc[lo]) / (zc[hi] - zc[lo]);
      return [lo, hi, 1 - t];
    }
    function cellOf(x, y, z) {
      const i = Math.floor(x / dxum), j = Math.floor(y / dxum);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return -1;
      let k = 0; while (k < nz - 1 && zf[k + 1] <= z) k++;
      return (j * nx + i) * nz + k;
    }
    // 점 싱크를 삼선형 가중으로 분배. 반환: [{c, w}]
    function spread(x, y, z) {
      const out = [];
      const fx = x / dxum - 0.5, fy = y / dxum - 0.5;
      let i0 = Math.floor(fx), j0 = Math.floor(fy);
      const tx = fx - i0, ty = fy - j0;
      const [ka, kb, wa] = kFromZ(z);
      const zs = ka === kb ? [[ka, 1]] : [[ka, wa], [kb, 1 - wa]];
      const act = zs.filter(e => active[e[0]]);
      if (!act.length) return out;
      const ws = act.reduce((s, e) => s + e[1], 0);
      for (const [ii, wx] of [[i0, 1 - tx], [i0 + 1, tx]]) for (const [jj, wy] of [[j0, 1 - ty], [j0 + 1, ty]]) {
        const ic = Math.min(nx - 1, Math.max(0, ii)), jc = Math.min(ny - 1, Math.max(0, jj));
        for (const [k, wz] of act) {
          const w = wx * wy * wz / ws;
          if (w > 0) out.push({ c: (jc * nx + ic) * nz + k, w });
        }
      }
      return out;
    }
    function addPoint(x, y, z, K, em) {
      if (x < 0 || y < 0 || x > Lx || y > ny * dxum || !(K > 0)) return;
      for (const { c, w } of spread(x, y, z)) {
        sink[c] += K * w;
        if (em) { em.cells.push(c); em.K.push(K * w); }
      }
    }
    const Dz = (z) => Dat(kFromZ(z)[0]);
    const KL = (d, z) => {
      const rc = (d.rc || 0.02) * 1e-4, D = Dz(z);
      return 1 / (1 / (2 * Math.PI * rc * d.S) + Math.log(Math.max(Rc / rc, 1.0001)) / (2 * Math.PI * D));
    };
    function addLine(d, p0, p1, em) {
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      if (L <= 0) return;
      const zmid = 0.5 * (p0[2] + p1[2]);
      const kmid = kFromZ(zmid)[0];
      const h = Math.max(Math.min(dxum, ctx.dzAt(kmid)) / 3, 0.002);
      const n = Math.max(1, Math.ceil(L / h));
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const p = [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1]), p0[2] + t * (p1[2] - p0[2])];
        addPoint(p[0], p[1], p[2], KL(d, p[2]) * (L / n) * 1e-4, em);
      }
    }
    function sphereK(r_um, S, z) {
      const r = r_um * 1e-4, D = Dz(z);
      const Rcc = Math.max(Rc, r * 1.01);
      return 1 / (1 / (4 * Math.PI * r * r * S) + (1 / r - 1 / Rcc) / (4 * Math.PI * D));
    }

    for (const d of state.defects) {
      const T = TYPES[d.type]; if (!T) continue;
      const em = (d.etaD > 0) ? { def: d, cells: [], K: [] } : null;
      const s = d.size;
      switch (d.type) {
        case 'loop': {
          const r = s / 2;
          const rc = (d.rc || 0.02) * 1e-4, D = Dz(d.z);
          if (2 * r < dxum) {
            const Kl = KL(d, d.z) * 2 * Math.PI * r * 1e-4;
            const rr = Math.max(r * 1e-4, rc * 1.01), Rcc = Math.max(Rc, rr * 1.01);
            const K = 1 / (1 / Kl + (1 / rr - 1 / Rcc) / (4 * Math.PI * D));
            addPoint(d.x, d.y, d.z, K, em);
          } else {
            const n = Math.max(8, Math.ceil(2 * Math.PI * r / (dxum / 3)));
            for (let q = 0; q < n; q++) {
              const a0 = 2 * Math.PI * q / n, a1 = 2 * Math.PI * (q + 1) / n;
              addLine(d, [d.x + r * Math.cos(a0), d.y + r * Math.sin(a0), d.z], [d.x + r * Math.cos(a1), d.y + r * Math.sin(a1), d.z], em);
            }
          }
          break;
        }
        case 'threading':
          addLine(d, [d.x, d.y, Math.max(d.z, 1e-4)], [d.x, d.y, d.z + s], em); break;
        case 'misfit': {
          const hx = d.dir === 'y' ? 0 : s / 2, hy = d.dir === 'y' ? s / 2 : 0;
          addLine(d, [d.x - hx, d.y - hy, d.z], [d.x + hx, d.y + hy, d.z], em); break;
        }
        case 'stacking_fault': {
          // {111} 면: 표면 교선 방향(dir)으로 폭 a, 깊이로 a·sin(54.7°) 내려가며 수직 방향으로 a·cos 이동
          const th = 54.7356 * Math.PI / 180;
          const a = s, depth = a * Math.sin(th), off = a * Math.cos(th);
          const u = d.dir === 'y' ? [0, 1] : [1, 0], v = d.dir === 'y' ? [1, 0] : [0, 1];
          const P = (su, sv) => [d.x + u[0] * su + v[0] * sv, d.y + u[1] * su + v[1] * sv, d.z + depth * (sv / off)];
          // 면 (사다리꼴: 깊어질수록 폭이 좁아짐 → 삼각형 근사)
          const h = Math.max(dxum / 3, 0.05);
          const nv = Math.max(2, Math.ceil(a / h));
          const KA = 2 * (d.Splane || 0); // cm/s
          for (let iv = 0; iv < nv; iv++) {
            const tv = (iv + 0.5) / nv, w = a * (1 - tv);
            const nu = Math.max(1, Math.ceil(w / h));
            for (let iu = 0; iu < nu; iu++) {
              const su = -w / 2 + (iu + 0.5) * w / nu;
              const p = P(su, tv * off);
              const dA = (w / nu) * (a / nv) * 1e-8; // cm²
              if (KA > 0) addPoint(p[0], p[1], p[2], KA * dA, null);
            }
          }
          const A0 = P(-a / 2, 0), A1 = P(a / 2, 0), Tp = P(0, off);
          addLine(d, A0, Tp, em); addLine(d, A1, Tp, em);
          break;
        }
        case 'precipitate':
        case 'void': {
          const r = s / 2;
          if (r < dxum / 2) addPoint(d.x, d.y, d.z, sphereK(r, d.S, d.z), em);
          else {
            const n = Math.max(12, Math.ceil(4 * Math.PI * r * r / Math.pow(dxum / 2, 2)));
            const Ktot = 4 * Math.PI * Math.pow(r * 1e-4, 2) * d.S;
            for (let q = 0; q < n; q++) {
              const zz = 1 - 2 * (q + 0.5) / n, rr = Math.sqrt(1 - zz * zz), ph = q * 2.399963;
              addPoint(d.x + r * rr * Math.cos(ph), d.y + r * rr * Math.sin(ph), d.z + r * zz, Ktot / n, em);
            }
          }
          break;
        }
        case 'point_region':
        case 'ge_cluster': {
          const r = s / 2;
          const cells = [];
          const i0 = Math.max(0, Math.floor((d.x - r) / dxum)), i1 = Math.min(nx - 1, Math.floor((d.x + r) / dxum));
          const j0 = Math.max(0, Math.floor((d.y - r) / dxum)), j1 = Math.min(ny - 1, Math.floor((d.y + r) / dxum));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let k = 0; k < nz; k++) {
            if (!active[k]) continue;
            const xc = (i + 0.5) * dxum, yc = (j + 0.5) * dxum;
            if (Math.hypot(xc - d.x, yc - d.y, zc[k] - d.z) <= r) cells.push([(j * nx + i) * nz + k, 1]);
          }
          if (!cells.length) {
            const c = cellOf(d.x, d.y, d.z);
            if (c >= 0 && active[c % nz]) {
              const k = c % nz;
              const Vc = dxum * dxum * (zf[k + 1] - zf[k]);
              cells.push([c, Math.min(1, (4 / 3) * Math.PI * r * r * r / Vc)]);
            }
          }
          if (d.type === 'point_region') {
            for (const [c, f] of cells) regionInvTau[c] += f / (d.tauIn_us * 1e-6);
          } else {
            const ci = clusters.length;
            clusters.push({ def: d });
            for (const [c] of cells) cluster[c] = ci;
          }
          break;
        }
        case 'particle': {
          const r = s / 2, sub = 4;
          const i0 = Math.max(0, Math.floor((d.x - r) / dxum)), i1 = Math.min(nx - 1, Math.floor((d.x + r) / dxum));
          const j0 = Math.max(0, Math.floor((d.y - r) / dxum)), j1 = Math.min(ny - 1, Math.floor((d.y + r) / dxum));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            let cov = 0;
            for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
              const xx = (i + (a + 0.5) / sub) * dxum, yy = (j + (b + 0.5) / sub) * dxum;
              if (Math.hypot(xx - d.x, yy - d.y) <= r) cov++;
            }
            cov /= sub * sub;
            if (!cov) continue;
            const q = j * nx + i;
            excMask[q] *= 1 - cov * (1 - d.tExc);
            extMask[q] *= 1 + cov * (d.mExt - 1);
            topExtraS[q] += cov * (d.S || 0);
          }
          break;
        }
      }
      if (em && em.cells.length) emitters.push({ def: d, cells: Int32Array.from(em.cells), K: Float64Array.from(em.K) });
    }
    return { sink, regionInvTau, cluster, clusters, emitters, topExtraS, excMask, extMask };
  }
  PL.rasterizeDefects = rasterize;

  // ---------- 결함 생성 도우미 ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  PL.rng = rng;

  /** SiGe 계면(SiGe 층의 아래면) 깊이 목록 [µm] */
  function interfaces(state) {
    return PL.segments(state).filter(s => s.layer.material === 'SiGe').map(s => s.z1);
  }
  PL.sigeInterfaces = interfaces;

  function misfitGrid(state, opt) {
    const R = rng(opt.seed || 7), out = [];
    const L = state.domain.Lx, z = opt.z;
    const dirs = opt.both ? ['x', 'y'] : ['x'];
    for (const dir of dirs) {
      let p = R() * opt.spacing;
      while (p < L) {
        const len = L * (opt.fullLength ? 1 : 0.4 + 0.6 * R());
        const c = opt.fullLength ? L / 2 : len / 2 + R() * (L - len);
        const d = dir === 'x' ? newDefect('misfit', c, p, { size: len, z, dir: 'x' }) : newDefect('misfit', p, c, { size: len, z, dir: 'y' });
        out.push(d);
        p += opt.spacing * (0.5 + R());
      }
    }
    return out;
  }
  PL.misfitGrid = misfitGrid;

  function scatter(state, type, n, opt) {
    const R = rng(opt.seed || 11), out = [], L = state.domain.Lx, m = 5;
    for (let q = 0; q < n; q++) {
      const z = opt.zmin + R() * (opt.zmax - opt.zmin);
      const size = opt.smin * Math.pow(opt.smax / opt.smin, R());
      out.push(newDefect(type, m + R() * (L - 2 * m), m + R() * (L - 2 * m), { z, size }));
    }
    return out;
  }
  PL.scatterDefects = scatter;
})(PL);

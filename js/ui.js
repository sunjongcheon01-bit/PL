/* ui.js — 화면 구성, 구조/결함 편집기, 실행 및 결과 표시 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = PL.Render, T = PL.DEFECT_TYPES;

  // ---------------- 상태 ----------------
  function defaultState() {
    const st = {
      domain: { Lx: 100, depth: 50, dx: 1 },
      layers: PL.PRESETS['Si cap / SiGe / Si'](),
      surface: { S_front: 1e3, S_back: 1e3, S_int: 100, S_ox: 100 },
      physics: { confFrac: 0.5, highInjection: true, picardMax: 6 },
      optics: {
        mode: 'widefield', lamExc: 532, powerDensity: 100, illumProfile: 'flat', illumFWHM: 150,
        scanPower_mW: 0.5, spotFWHM: 1.0, dwell_ms: 2, NA: 0.5, focus: 0, detector: 'ingaas',
        channels: JSON.parse(JSON.stringify(PL.Optics.CHANNEL_PRESETS)),
      },
      noise: {
        on: { shot: true, dark: true, read: true, prnu: true, fpn: true, quant: true, leak: true, speckle: false, rin: true },
        fullWell: 1.0e6, read: 120, dark: 2e4, prnu: 1.0, dsnu: 5, bits: 14, exposure_ms: 20, autoExp: true,
        speckleC: 0.6, speckleGrain: 2, rin: 0.5, seed: 1, thr: 3,
      },
      analysis: { reference: true },
      defects: [],
    };
    const D = PL.newDefect;
    st.defects = [
      D('loop', 22, 25, { z: 0.3, size: 0.05 }), D('loop', 30, 70, { z: 1.5, size: 0.1 }), D('loop', 75, 20, { z: 4, size: 0.2 }),
      D('threading', 50, 50, { z: 0, size: 8 }),
      D('misfit', 50, 88, { z: 0.06, size: 70, dir: 'x' }),
      D('stacking_fault', 80, 60, { z: 0, size: 6, dir: 'x' }),
      D('precipitate', 15, 50, { z: 8, size: 0.3 }),
      D('point_region', 60, 25, { z: 3, size: 8 }),
      D('ge_cluster', 40, 35, { z: 0.035, size: 1.5 }),
      D('particle', 85, 85, { size: 3 }),
    ];
    return st;
  }
  let state = defaultState();
  let selId = null, tool = 'select', result = null, busy = false, dirty = false;

  // ---------------- DOM 도우미 ----------------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  }
  const fmt = (v) => {
    if (v === Infinity) return '∞';
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    const a = Math.abs(v); if (a === 0) return '0';
    return (a >= 1e5 || a < 1e-3) ? v.toExponential(2).replace('e+', 'e') : String(+v.toPrecision(4));
  };
  /** 숫자 입력 (지수 표기 허용) */
  function num(obj, key, opt) {
    opt = opt || {};
    const inp = h('input', { type: 'text', value: fmt(obj[key]), style: `width:${opt.w || 86}px` });
    inp.addEventListener('change', () => {
      let v = Number(inp.value.replace(/,/g, ''));
      if (!isFinite(v)) { inp.value = fmt(obj[key]); return; }
      if (opt.min !== undefined) v = Math.max(opt.min, v);
      if (opt.max !== undefined) v = Math.min(opt.max, v);
      obj[key] = v; inp.value = fmt(v); changed(opt.redraw);
      if (opt.on) opt.on(v);
    });
    return inp;
  }
  function row(label, ctrl, unit) { return h('div', { class: 'row' }, h('span', null, label), h('span', null, ctrl, unit ? h('span', { class: 'muted small' }, ' ' + unit) : null)); }
  function chk(obj, key, label, redraw) {
    const c = h('input', { type: 'checkbox' }); c.checked = !!obj[key];
    c.addEventListener('change', () => { obj[key] = c.checked; changed(redraw); });
    return h('label', null, c, ' ' + label);
  }
  function sel(obj, key, options, redraw, on) {
    const s = h('select', null, options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = String(obj[key]);
    s.addEventListener('change', () => { const v = s.value; obj[key] = isNaN(+v) || v === '' ? v : +v; if (on) on(); changed(redraw); });
    return s;
  }
  function changed(redraw) {
    dirty = true;
    if (redraw === 'all') renderAll();
    else { drawStruct(); renderStackInfo(); if (redraw === 'optics') renderOptics(); if (redraw === 'defect') renderDefects(); if (redraw === 'struct') renderStruct(); }
    if (result) $('progText').textContent = '설정이 바뀌었습니다 — 다시 실행하면 반영됩니다.';
  }

  // ---------------- 탭 ----------------
  function tabs(navId) {
    const nav = $(navId);
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      nav.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      const ids = [...nav.querySelectorAll('button')].map(x => x.dataset.tab);
      ids.forEach(id => $(id).classList.toggle('on', id === b.dataset.tab));
      setTimeout(redrawVisible, 0);
    });
  }
  function showView(id) { const b = document.querySelector(`#workTabs button[data-tab="${id}"]`); if (b) b.click(); }

  // ---------------- 구조 패널 ----------------
  function renderStruct() {
    const p = $('t-struct'); p.innerHTML = '';
    const pre = h('select', null, h('option', { value: '' }, '프리셋 선택…'), Object.keys(PL.PRESETS).map(k => h('option', { value: k }, k)));
    pre.addEventListener('change', () => { if (!pre.value) return; state.layers = PL.PRESETS[pre.value](); changed('all'); });
    p.append(h('fieldset', null, h('legend', null, '적층 구조 (위 → 아래)'), row('프리셋', pre),
      h('div', { class: 'hint' }, '맨 아래 층은 "기판(나머지 깊이 채움)"입니다. SiO₂는 패시베이션/광학 박막으로만 작동합니다.'),
      h('div', { id: 'layerList' }),
      h('button', { onclick: () => { state.layers.splice(Math.max(0, state.layers.length - 1), 0, PL.newLayer({ material: 'SiGe', thickness: 0.03, x: 0.2 })); changed('struct'); } }, '+ 층 추가 (기판 위)')));
    const list = p.querySelector('#layerList');
    state.layers.forEach((L, i) => {
      const isSub = i === state.layers.length - 1;
      const matSel = sel(L, 'material', [['Si', 'Si'], ['SiGe', 'SiGe'], ['SiO2', 'SiO₂']], 'struct');
      const info = PL.layerInfo(L);
      const card = h('div', { class: 'layer-card ' + L.material },
        h('div', { class: 'lh' }, h('b', null, `${i + 1}. `), matSel,
          isSub ? h('span', { class: 'muted small' }, '기판 (fill)') : h('span', null,
            h('button', { class: 'iconbtn', title: '위로', onclick: () => { if (i > 0) { [state.layers[i - 1], state.layers[i]] = [state.layers[i], state.layers[i - 1]]; changed('struct'); } } }, '↑'),
            h('button', { class: 'iconbtn', title: '아래로', onclick: () => { if (i < state.layers.length - 2) { [state.layers[i + 1], state.layers[i]] = [state.layers[i], state.layers[i + 1]]; changed('struct'); } } }, '↓'),
            h('button', { class: 'iconbtn danger', title: '삭제', onclick: () => { state.layers.splice(i, 1); changed('struct'); } }, '✕'))),
        h('div', { class: 'lg' },
          isSub ? null : h('label', null, '두께 µm', num(L, 'thickness', { min: 1e-4, redraw: 'struct' })),
          L.material === 'SiGe' ? h('label', null, 'Ge 농도 x', num(L, 'x', { min: 0, max: 0.8, redraw: 'struct' })) : null,
          L.material === 'SiGe' ? h('label', null, '변형', sel(L, 'strained', [['true', 'strained'], ['false', 'relaxed']], 'struct', () => { L.strained = String(L.strained) === 'true'; })) : null,
          L.material !== 'SiO2' ? h('label', null, '도핑', sel(L, 'dopType', [['p', 'p형'], ['n', 'n형']], 'struct')) : null,
          L.material !== 'SiO2' ? h('label', null, 'N cm⁻³', num(L, 'N', { min: 1e12, max: 1e20, redraw: 'struct' })) : null,
          L.material !== 'SiO2' ? h('label', null, 'τ_SRH µs', num(L, 'tau_us', { min: 1e-5, redraw: 'struct' })) : null),
        L.material !== 'SiO2' ? h('div', { class: 'hint' }, `Eg ${info.Eg.toFixed(3)} eV · BB 피크 ≈ ${info.peak.toFixed(0)} nm · L_diff ≈ ${diffLen(L).toFixed(0)} µm`,
          info.hcMB ? h('div', { class: info.relaxRisk.startsWith('위험') ? 'bad' : info.relaxRisk.startsWith('준') ? 'warn' : 'ok' }, `임계두께 MB ${info.hcMB.toFixed(1)} nm / PB ${info.hcPB.toFixed(0)} nm → ${info.relaxRisk}`) : null) : null);
      list.append(card);
    });
    p.append(h('fieldset', null, h('legend', null, '시뮬레이션 영역'),
      row('가로 크기 Lx', num(state.domain, 'Lx', { min: 10, max: 400, redraw: 'all' }), 'µm'),
      row('깊이', num(state.domain, 'depth', { min: 2, max: 500, redraw: 'all' }), 'µm'),
      row('가로 격자 dx', sel(state.domain, 'dx', [[2, '2 µm (빠름)'], [1, '1 µm (기본)'], [0.5, '0.5 µm (느림)'], [0.25, '0.25 µm (매우 느림)']], 'all')),
      h('div', { class: 'hint', id: 'gridHint' })));
    updateGridHint();
  }
  function diffLen(L) { const r = PL.mat.recomb(L, 0); return Math.sqrt(r.D / r.invTau) * 1e4; }
  function updateGridHint() {
    const e = $('gridHint'); if (!e) return;
    const Z = PL.buildZGrid(state, state.optics.lamExc), n = Math.round(state.domain.Lx / state.domain.dx);
    const cells = n * n * Z.nz;
    e.innerHTML = `격자 ${n}×${n}×${Z.nz} = ${(cells / 1e6).toFixed(2)} M 셀` + (cells > 2.5e6 ? ' <span class="warn">— 계산이 오래 걸릴 수 있음</span>' : '');
  }

  // ---------------- 결함 패널 ----------------
  function renderDefects() {
    const p = $('t-defect'); p.innerHTML = '';
    const list = h('div', { class: 'deflist' });
    state.defects.forEach(d => {
      list.append(h('div', { class: 'it' + (d.id === selId ? ' sel' : ''), onclick: () => { selId = d.id; renderDefects(); drawStruct(); } },
        h('span', null, h('span', { class: 'chip', style: `background:${T[d.type].color}` }), `#${d.id} ${T[d.type].label}`),
        h('span', { class: 'muted small' }, `z=${fmt(d.z)} µm, ${fmt(d.size)} µm`)));
    });
    p.append(h('fieldset', null, h('legend', null, `결함 목록 (${state.defects.length})`),
      h('div', { class: 'hint' }, '구조 편집 화면의 도구 막대에서 종류를 고르고 평면도/단면도를 클릭해 배치합니다.'),
      list, h('div', { class: 'toolbar', style: 'margin-top:6px' },
        h('button', { class: 'danger', onclick: () => { if (confirm('모든 결함을 지울까요?')) { state.defects = []; selId = null; changed('defect'); } } }, '모두 삭제'))));
    const d = state.defects.find(x => x.id === selId);
    if (d) {
      const t = T[d.type];
      const f = h('fieldset', null, h('legend', null, `#${d.id} ${t.label}`), h('div', { class: 'hint' }, t.desc),
        row('x', num(d, 'x', { redraw: 'defect' }), 'µm'), row('y', num(d, 'y', { redraw: 'defect' }), 'µm'),
        d.type !== 'particle' ? row(d.type === 'threading' || d.type === 'stacking_fault' ? '시작 깊이 z' : '깊이 z', num(d, 'z', { min: 0, redraw: 'defect' }), 'µm') : null,
        row(sizeLabel(d.type), num(d, 'size', { min: 0.001, redraw: 'defect' }), 'µm'),
        (d.type === 'misfit' || d.type === 'stacking_fault') ? row('방향', sel(d, 'dir', [['x', '[110] (x)'], ['y', '[1-10] (y)']], 'defect')) : null,
        d.S !== undefined ? row('재결합 속도 S', num(d, 'S', { min: 0 }), 'cm/s') : null,
        d.rc !== undefined ? row('유효 코어 반경 r_c', num(d, 'rc', { min: 1e-4 }), 'µm') : null,
        d.Splane !== undefined ? row('면 재결합 S_plane', num(d, 'Splane', { min: 0 }), 'cm/s') : null,
        d.tauIn_us !== undefined ? row('영역 내 수명 τ', num(d, 'tauIn_us', { min: 1e-6 }), 'µs') : null,
        d.dxGe !== undefined ? row('추가 Ge 농도 Δx', num(d, 'dxGe', { min: 0, max: 0.6 })) : null,
        d.tExc !== undefined ? row('여기광 투과 t_exc', num(d, 'tExc', { min: 0, max: 1 })) : null,
        d.mExt !== undefined ? row('광추출 배율 m_ext', num(d, 'mExt', { min: 0, max: 5 })) : null,
        ['loop', 'threading', 'misfit', 'stacking_fault', 'precipitate'].includes(d.type) ? h('div', null,
          row('D-line 발광 비율 η_D', num(d, 'etaD', { min: 0, max: 1 })),
          h('div', { class: 'row' }, h('span', null, 'D1:D2:D3:D4 비'), h('span', null, [0, 1, 2, 3].map(q => num(d.mix, q, { min: 0, w: 42 }))))) : null,
        h('div', { class: 'toolbar' },
          h('button', { onclick: () => { const c = PL.newDefect(d.type, d.x + 3, d.y + 3, JSON.parse(JSON.stringify(Object.assign({}, d, { id: undefined })))); c.id = Math.max(0, ...state.defects.map(e => e.id)) + 1; PL.resetDefectId(c.id + 1); state.defects.push(c); selId = c.id; changed('defect'); } }, '복제'),
          h('button', { class: 'danger', onclick: () => { state.defects = state.defects.filter(e => e.id !== d.id); selId = null; changed('defect'); } }, '삭제')));
      p.append(f);
    }
    // 생성기
    const gm = { spacing: 8, both: true, z: (PL.sigeInterfaces(state)[0] || 0.06), full: true };
    const ifs = PL.sigeInterfaces(state);
    p.append(h('fieldset', null, h('legend', null, 'Misfit 격자무늬 생성'),
      h('div', { class: 'hint' }, ifs.length ? `SiGe 계면 깊이: ${ifs.map(z => (z * 1000).toFixed(0) + ' nm').join(', ')}` : 'SiGe 층이 없습니다 (임의 깊이에 생성 가능).'),
      row('간격', num(gm, 'spacing', { min: 1 }), 'µm'), row('깊이', num(gm, 'z', { min: 0 }), 'µm'),
      h('div', { class: 'row' }, chk(gm, 'both', '양방향(cross-hatch)'), chk(gm, 'full', '시야 전체 길이')),
      h('button', { onclick: () => { state.defects.push(...PL.misfitGrid(state, { spacing: gm.spacing, z: gm.z, both: gm.both, fullLength: gm.full, seed: Date.now() % 1e6 })); changed('defect'); } }, '생성')));
    const gr = { type: 'loop', n: 10, zmin: 0.1, zmax: 5, smin: 0.02, smax: 0.3 };
    p.append(h('fieldset', null, h('legend', null, '무작위 결함 생성'),
      row('종류', sel(gr, 'type', Object.keys(T).map(k => [k, T[k].label]))), row('개수', num(gr, 'n', { min: 1, max: 500 })),
      row('깊이 범위', h('span', null, num(gr, 'zmin', { min: 0, w: 56 }), ' ~ ', num(gr, 'zmax', { min: 0, w: 56 })), 'µm'),
      row('크기 범위', h('span', null, num(gr, 'smin', { min: 0.001, w: 56 }), ' ~ ', num(gr, 'smax', { min: 0.001, w: 56 })), 'µm'),
      h('button', { onclick: () => { state.defects.push(...PL.scatterDefects(state, gr.type, gr.n, { zmin: gr.zmin, zmax: gr.zmax, smin: gr.smin, smax: gr.smax, seed: Date.now() % 1e6 })); changed('defect'); } }, '생성')));
  }
  function sizeLabel(t) {
    return { loop: '지름', threading: '길이(깊이 방향)', misfit: '길이', stacking_fault: '변 길이 a', precipitate: '지름', void: '지름', point_region: '지름', ge_cluster: '지름', particle: '지름' }[t];
  }

  // ---------------- 광학 패널 ----------------
  function renderOptics() {
    const o = state.optics, p = $('t-optics'); p.innerHTML = '';
    const lamSel = h('select', null, PL.Optics.LASERS.map(l => h('option', { value: l }, l + ' nm')), h('option', { value: 'c' }, '직접 입력'));
    lamSel.value = PL.Optics.LASERS.includes(o.lamExc) ? String(o.lamExc) : 'c';
    lamSel.addEventListener('change', () => { if (lamSel.value !== 'c') { o.lamExc = +lamSel.value; changed('optics'); updateGridHint(); } else renderOptics(); });
    p.append(h('fieldset', null, h('legend', null, '프리셋'),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => { Object.assign(o, { lamExc: 532, NA: 0.5, detector: 'ingaas' }); o.channels.forEach(c => c.on = ['bb', 'lp1400'].includes(c.id)); changed('optics'); } }, 'En-Vision 유사 (Micro 532 nm)'),
        h('button', { onclick: () => { Object.assign(o, { lamExc: 808, NA: 0.15, powerDensity: 10, detector: 'ingaas' }); o.channels.forEach(c => c.on = ['bb', 'lp1400'].includes(c.id)); changed('optics'); } }, 'Macro (808 nm)')),
      h('div', { class: 'hint' }, '공개 자료 기준 가정값입니다(실제 장비 사양 미공개). 모든 값은 아래에서 바꿀 수 있습니다.')));
    p.append(h('fieldset', null, h('legend', null, '조사 방식'),
      row('모드', sel(o, 'mode', [['widefield', 'Widefield (카메라)'], ['scan', '스캐닝 (점 조사 맵)']], 'optics')),
      row('여기 파장', h('span', null, lamSel, lamSel.value === 'c' ? num(o, 'lamExc', { min: 300, max: 1050, w: 60, redraw: 'optics' }) : null)),
      o.mode === 'widefield' ? h('div', null,
        row('전력 밀도', num(o, 'powerDensity', { min: 1e-3 }), 'W/cm²'),
        row('조명 분포', sel(o, 'illumProfile', [['flat', '균일 (flat-top)'], ['gauss', 'Gaussian']], 'optics')),
        o.illumProfile === 'gauss' ? row('조명 FWHM', num(o, 'illumFWHM', { min: 1 }), 'µm') : null)
      : h('div', null,
        row('레이저 출력', num(o, 'scanPower_mW', { min: 1e-6 }), 'mW'),
        row('스팟 FWHM', num(o, 'spotFWHM', { min: 0.1 }), 'µm'),
        row('픽셀당 체류시간', num(o, 'dwell_ms', { min: 1e-3 }), 'ms'),
        h('div', { class: 'hint' }, '스캔 맵은 저주입 선형 근사(상반성 정리)로 계산합니다. 스캔 간격 = 가로 격자 dx.')),
      row('대물렌즈 NA', num(o, 'NA', { min: 0.02, max: 0.95, redraw: 'optics' })),
      row('초점 깊이 (시료 내부)', num(o, 'focus', { min: 0 }), 'µm')));
    // 필터 채널
    const chBox = h('div');
    o.channels.forEach((c, i) => {
      chBox.append(h('div', { class: 'layer-card', style: 'border-left-color:var(--accent)' },
        h('div', { class: 'lh' }, chk(c, 'on', ''), h('input', { type: 'text', value: c.name, style: 'width:150px', onchange: (e) => { c.name = e.target.value; } }),
          sel(c, 'kind', [['bp', '밴드패스'], ['lp', '롱패스'], ['sp', '숏패스']], 'optics')),
        h('div', { class: 'lg' },
          c.kind !== 'sp' ? h('label', null, '하한 nm', num(c, 'lo', { min: 800, max: 1800, w: 60 })) : null,
          c.kind !== 'lp' ? h('label', null, '상한 nm', num(c, 'hi', { min: 800, max: 1800, w: 60 })) : null,
          h('label', null, '경사폭 nm', num(c, 'edge', { min: 1, w: 50 })), h('label', null, '차단 OD', num(c, 'OD', { min: 1, max: 12, w: 50 })))));
    });
    p.append(h('fieldset', null, h('legend', null, '검출 채널 (필터)'), chBox,
      h('div', { class: 'hint' }, '체크된 채널마다 이미지가 만들어집니다. LP1400은 Si 밴드간 발광을 거의 차단하고 D-line(1.4–1.6 µm)만 통과시킵니다.')));
    p.append(h('fieldset', null, h('legend', null, '검출기'),
      row('종류', sel(o, 'detector', Object.keys(PL.Optics.DETECTORS).map(k => [k, PL.Optics.DETECTORS[k].name]), 'optics'))));
    // 정보
    const info = h('div', { class: 'small' });
    const semis = state.layers.filter(L => L.material !== 'SiO2');
    const Rr = PL.Optics.reflectance(state, o.lamExc), cg = PL.Optics.collectionGeom(state, o.NA, 1150);
    info.append(h('div', null, `표면 반사율 R(${o.lamExc} nm) = ${(Rr * 100).toFixed(1)} %`),
      h('div', null, `수집: 내부 허용각 ${cg.thetaDeg.toFixed(1)}° → 입체각 비율 ${(cg.f * 100).toFixed(2)} % (높은 굴절률 때문에 작음)`),
      h('div', null, `PSF σ (초점면): ${PL.Optics.psfSigma(1150, o.NA, 0, 3.5).toFixed(2)} µm @1150 nm, ${PL.Optics.psfSigma(1550, o.NA, 0, 3.5).toFixed(2)} µm @1550 nm`),
      h('table', { class: 't' }, h('tr', null, h('th', null, '층'), h('th', null, `흡수 깊이 1/α @${o.lamExc}`), h('th', null, '확산 길이')),
        semis.map(L => h('tr', null, h('td', null, `${L.material}${L.material === 'SiGe' ? ' x=' + L.x : ''}`), h('td', null, fmt(1e4 / PL.mat.alpha(L, o.lamExc)) + ' µm'), h('td', null, diffLen(L).toFixed(0) + ' µm')))));
    p.append(h('fieldset', null, h('legend', null, '광학 계산값'), info));
  }

  // ---------------- 노이즈 패널 ----------------
  function renderNoise() {
    const n = state.noise, p = $('t-noise'); p.innerHTML = '';
    const on = n.on;
    p.append(h('fieldset', null, h('legend', null, '여기 단계 (확산 전)'),
      h('div', { class: 'row' }, chk(on, 'speckle', '레이저 스페클 (widefield)'), h('span')),
      row('스페클 대비', num(n, 'speckleC', { min: 0, max: 1 })), row('스페클 알갱이', num(n, 'speckleGrain', { min: 0.3 }), 'µm'),
      h('div', { class: 'hint' }, '스페클은 생성률 G에 곱해지므로 캐리어 확산이 평균화합니다 — 확산 길이가 길면 거의 사라집니다.'),
      h('div', { class: 'row' }, chk(on, 'rin', '레이저 세기 요동 RIN (스캔)'), h('span')), row('RIN', num(n, 'rin', { min: 0 }), '%')));
    p.append(h('fieldset', null, h('legend', null, '검출 단계'),
      h('div', { class: 'row' }, chk(on, 'shot', '샷 노이즈 (Poisson)'), chk(on, 'dark', '다크 전류')),
      h('div', { class: 'row' }, chk(on, 'read', '리드 노이즈'), chk(on, 'prnu', 'PRNU (감도 불균일)')),
      h('div', { class: 'row' }, chk(on, 'fpn', 'DSNU (다크 고정패턴)'), chk(on, 'quant', 'ADC 양자화')),
      h('div', { class: 'row' }, chk(on, 'leak', '레이저 누설 (필터 OD)'), h('span')),
      row('다크 전류', num(n, 'dark', { min: 0 }), 'e⁻/s/px'), row('리드 노이즈', num(n, 'read', { min: 0 }), 'e⁻ rms'),
      row('Full well', num(n, 'fullWell', { min: 1e3 }), 'e⁻'), row('ADC', num(n, 'bits', { min: 8, max: 16 }), 'bit'),
      row('PRNU', num(n, 'prnu', { min: 0 }), '%'), row('DSNU', num(n, 'dsnu', { min: 0 }), '%'),
      h('div', { class: 'row' }, chk(n, 'autoExp', '자동 노출 (최대 70% full well)'), h('span')),
      row('노출 시간', num(n, 'exposure_ms', { min: 1e-3 }), 'ms'),
      row('난수 시드', num(n, 'seed', { min: 0 }))));
    p.append(h('fieldset', null, h('legend', null, '검출 판정'),
      row('검출 기준 SNR ≥', num(n, 'thr', { min: 0.5 })),
      h('div', { class: 'row' }, chk(state.analysis, 'reference', '결함 없는 기준 시뮬레이션도 계산 (정확한 대비)'), h('span')),
      h('div', { class: 'hint' }, '기준 계산을 끄면 결함 주변 고리 영역의 중앙값을 배경으로 씁니다(계산 시간 절반).')));
  }

  // ---------------- 물리 패널 ----------------
  function renderPhys() {
    const s = state.surface, ph = state.physics, p = $('t-phys'); p.innerHTML = '';
    p.append(h('fieldset', null, h('legend', null, '표면·계면 재결합 속도'),
      row('앞면 S_front', num(s, 'S_front', { min: 0 }), 'cm/s'), row('뒷면 S_back', num(s, 'S_back', { min: 0 }), 'cm/s'),
      row('SiGe/Si 계면 S_int', num(s, 'S_int', { min: 0 }), 'cm/s'), row('내부 산화막 계면 S_ox', num(s, 'S_ox', { min: 0 }), 'cm/s'),
      h('div', { class: 'hint' }, '맨 처음 반도체 층의 윗면에 S_front 가 적용됩니다(자연산화막≈1e3, 양호한 열산화막≈10~100, 노출 표면≈1e4~1e5).')));
    p.append(h('fieldset', null, h('legend', null, '캐리어 모델'),
      row('SiGe 캐리어 가둠 비율', num(ph, 'confFrac', { min: 0, max: 1 })),
      h('div', { class: 'hint' }, 'ΔE_conf = 비율 × ΔEg. SiGe/Si의 밴드 오프셋(주로 가전자대)이 캐리어를 SiGe에 모으는 효과를 Slotboom 변환으로 반영(0 = 가둠 없음).'),
      h('div', { class: 'row' }, chk(ph, 'highInjection', '고주입 효과 (Picard 반복: 복사·Auger·양극성 확산)'), h('span')),
      row('최대 반복', num(ph, 'picardMax', { min: 1, max: 20 }))));
    p.append(h('fieldset', null, h('legend', null, '고정 조건'),
      h('div', { class: 'hint' }, '온도 300 K 고정. B_rad = 9.5e-15 cm³/s (Trupke 2003), Auger Cn=2.8e-31, Cp=0.99e-31 cm⁶/s, 이동도 Klaassen 단순식.')));
  }

  // ---------------- 구조 그림 ----------------
  const tools = [['select', '선택/이동']].concat(Object.keys(T).map(k => [k, T[k].label]));
  function renderToolbar() {
    const tb = $('toolBar'); tb.innerHTML = '';
    tb.append(h('span', { class: 'muted small' }, '도구'));
    tools.forEach(([k, lab]) => tb.append(h('button', { class: tool === k ? 'on' : '', onclick: () => { tool = k; renderToolbar(); } },
      k !== 'select' ? h('span', { class: 'chip', style: `background:${T[k].color}` }) : null, lab)));
    tb.append(h('span', { class: 'muted small' }, tool === 'select' ? '결함 클릭=선택, 드래그=이동, Delete=삭제' : `${T[tool].label}: 클릭하여 배치`));
  }

  let crossMap = null, topMap = null;
  function crossLayout(W, H) {
    const segs = PL.segments(state), padL = 70, padR = 10, padT = 26, padB = 16;
    const hp = H - padT - padB, minPx = 16;
    const wts = segs.map(s => Math.sqrt(s.z1 - s.z0));
    const sw = wts.reduce((a, b) => a + b, 0);
    const px = wts.map(w => minPx + (hp - minPx * segs.length) * w / sw);
    const y0 = [padT]; px.forEach((v, i) => y0.push(y0[i] + v));
    const z2y = (z) => { for (let i = 0; i < segs.length; i++) { const s = segs[i]; if (z <= s.z1 || i === segs.length - 1) return y0[i] + Math.min(1, Math.max(0, (z - s.z0) / (s.z1 - s.z0))) * px[i]; } return y0[segs.length]; };
    const y2z = (y) => { for (let i = 0; i < segs.length; i++) if (y <= y0[i + 1] || i === segs.length - 1) { const s = segs[i]; return s.z0 + Math.min(1, Math.max(0, (y - y0[i]) / px[i])) * (s.z1 - s.z0); } };
    const Lx = state.domain.Lx, w = W - padL - padR;
    return { segs, y0, px, z2y, y2z, x2X: (x) => padL + x / Lx * w, X2x: (X) => (X - padL) / w * Lx, padL, padT, w, H };
  }
  function layerColor(L) {
    if (L.material === 'SiO2') return R.css('--layer-ox');
    if (L.material === 'SiGe') return R.css('--layer-sige');
    return R.css('--layer-si');
  }
  function drawCross() {
    const cv = $('cvCross'); if (!cv.offsetParent) return;
    const { g, W, H } = R.fitCanvas(cv);
    g.fillStyle = R.css('--panel'); g.fillRect(0, 0, W, H);
    const m = crossMap = crossLayout(W, H);
    g.font = '11px sans-serif'; g.textBaseline = 'middle';
    m.segs.forEach((s, i) => {
      const L = s.layer;
      g.fillStyle = layerColor(L); g.globalAlpha = L.material === 'SiGe' ? 0.5 + 0.5 * Math.min(1, L.x / 0.4) : 1;
      g.fillRect(m.padL, m.y0[i], m.w, m.px[i]); g.globalAlpha = 1;
      g.strokeStyle = R.css('--line'); g.strokeRect(m.padL + 0.5, m.y0[i] + 0.5, m.w, m.px[i]);
      g.fillStyle = R.css('--fg'); g.textAlign = 'left';
      const t = s.z1 - s.z0;
      const lab = `${L.material}${L.material === 'SiGe' ? ' x=' + L.x : ''} · ${t < 1 ? (t * 1000).toFixed(t < 0.01 ? 1 : 0) + ' nm' : t.toFixed(1) + ' µm'}${L.fill ? ' (기판)' : ''}`;
      if (m.px[i] > 12) g.fillText(lab, m.padL + 6, m.y0[i] + Math.min(m.px[i] / 2, 12));
      g.fillStyle = R.css('--muted'); g.textAlign = 'right';
      g.fillText(fmtZ(s.z0), m.padL - 4, m.y0[i]);
    });
    g.textAlign = 'right'; g.fillText(fmtZ(m.segs[m.segs.length - 1].z1), m.padL - 4, m.y0[m.segs.length] - 4);
    // 기판 내부 깊이 눈금
    const sub = m.segs[m.segs.length - 1];
    [1, 2, 5, 10, 20, 50, 100, 200].forEach(z => { if (z > sub.z0 * 1.3 && z < sub.z1 * 0.97) { const y = m.z2y(z); g.strokeStyle = R.css('--grid'); g.beginPath(); g.moveTo(m.padL, y); g.lineTo(m.padL + m.w, y); g.stroke(); g.fillStyle = R.css('--muted'); g.fillText(z + ' µm', m.padL - 4, y); } });
    g.textAlign = 'left'; g.fillStyle = R.css('--muted'); g.fillText('표면 (여기광 ↓, PL ↑)', m.padL, 12);
    g.textAlign = 'right'; g.fillText('x →  ' + state.domain.Lx + ' µm', m.padL + m.w, 12);
    // 결함
    const ys = +$('ySlice').value;
    for (const d of state.defects) {
      const near = d.type === 'misfit' && d.dir === 'y' ? Math.abs(d.y - ys) <= d.size / 2 : Math.abs(d.y - ys) < 6;
      g.globalAlpha = near ? 1 : 0.3;
      drawDefectCross(g, m, d, d.id === selId);
    }
    g.globalAlpha = 1;
  }
  function fmtZ(z) { return z < 1 ? (z * 1000).toFixed(0) + ' nm' : z.toFixed(z < 10 ? 1 : 0) + ' µm'; }
  function drawDefectCross(g, m, d, isSel) {
    const col = T[d.type].color, X = m.x2X(d.x), Y = m.z2y(d.z);
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = isSel ? 3 : 2;
    const pxPerUm = m.w / state.domain.Lx;
    switch (d.type) {
      case 'threading': g.beginPath(); g.moveTo(X, m.z2y(d.z)); g.lineTo(X, m.z2y(d.z + d.size)); g.stroke(); break;
      case 'misfit':
        if (d.dir === 'x') { g.beginPath(); g.moveTo(m.x2X(d.x - d.size / 2), Y); g.lineTo(m.x2X(d.x + d.size / 2), Y); g.stroke(); }
        else { g.beginPath(); g.arc(X, Y, 3, 0, 7); g.fill(); }
        break;
      case 'stacking_fault': {
        const th = 54.7356 * Math.PI / 180, dep = d.size * Math.sin(th);
        if (d.dir === 'x') { g.beginPath(); g.moveTo(m.x2X(d.x - d.size / 2), Y); g.lineTo(m.x2X(d.x + d.size / 2), Y); g.lineTo(X, m.z2y(d.z + dep)); g.closePath(); g.globalAlpha *= 0.6; g.fill(); g.globalAlpha /= 0.6; g.stroke(); }
        else { g.beginPath(); g.moveTo(X, Y); g.lineTo(m.x2X(d.x + d.size * Math.cos(th)), m.z2y(d.z + dep)); g.stroke(); }
        break;
      }
      case 'particle': { const r = Math.max(3, d.size / 2 * pxPerUm); g.beginPath(); g.ellipse(X, m.padT - 1, r, Math.min(r, 8), 0, Math.PI, 0); g.fill(); break; }
      case 'point_region': case 'ge_cluster': { const r = Math.max(4, d.size / 2 * pxPerUm); g.setLineDash([3, 2]); g.beginPath(); g.ellipse(X, Y, r, Math.max(4, Math.abs(m.z2y(d.z + d.size / 2) - Y)), 0, 0, 7); g.stroke(); g.setLineDash([]); break; }
      case 'loop': { const r = Math.max(4, d.size / 2 * pxPerUm); g.beginPath(); g.ellipse(X, Y, r, 2.5, 0, 0, 7); g.stroke(); break; }
      default: { const r = Math.max(3.5, d.size / 2 * pxPerUm); g.beginPath(); g.arc(X, Y, r, 0, 7); g.fill(); }
    }
    if (isSel) { g.strokeStyle = R.css('--fg'); g.lineWidth = 1; g.setLineDash([2, 2]); g.strokeRect(X - 9, Y - 9, 18, 18); g.setLineDash([]); }
  }
  function drawTop() {
    const cv = $('cvTop'); if (!cv.offsetParent) return;
    const { g, W, H } = R.fitCanvas(cv);
    g.fillStyle = R.css('--panel'); g.fillRect(0, 0, W, H);
    const L = state.domain.Lx, pad = 28, s = Math.min(W - pad - 10, H - pad - 10) / L;
    const m = topMap = { ox: pad, oy: 10, s, L };
    g.fillStyle = R.css('--canvas-bg'); g.fillRect(m.ox, m.oy, L * s, L * s);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    const step = R.niceLen(L / 8);
    g.fillStyle = R.css('--muted'); g.font = '10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let v = 0; v <= L + 1e-9; v += step) {
      g.beginPath(); g.moveTo(m.ox + v * s, m.oy); g.lineTo(m.ox + v * s, m.oy + L * s); g.moveTo(m.ox, m.oy + v * s); g.lineTo(m.ox + L * s, m.oy + v * s); g.stroke();
      g.fillText(String(+v.toFixed(2)), m.ox + v * s, m.oy + L * s + 3);
    }
    const ys = +$('ySlice').value;
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(m.ox, m.oy + ys * s); g.lineTo(m.ox + L * s, m.oy + ys * s); g.stroke(); g.setLineDash([]);
    for (const d of state.defects) drawDefectTop(g, m, d, d.id === selId);
  }
  function drawDefectTop(g, m, d, isSel, alpha) {
    const col = T[d.type].color, X = m.ox + d.x * m.s, Y = m.oy + d.y * m.s;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = isSel ? 3 : 1.6;
    if (alpha !== undefined) g.globalAlpha = alpha;
    switch (d.type) {
      case 'misfit':
        g.beginPath();
        if (d.dir === 'x') { g.moveTo(X - d.size / 2 * m.s, Y); g.lineTo(X + d.size / 2 * m.s, Y); } else { g.moveTo(X, Y - d.size / 2 * m.s); g.lineTo(X, Y + d.size / 2 * m.s); }
        g.stroke(); break;
      case 'stacking_fault': {
        const off = d.size * Math.cos(54.7356 * Math.PI / 180) * m.s, a = d.size * m.s;
        g.beginPath();
        if (d.dir === 'x') { g.moveTo(X - a / 2, Y); g.lineTo(X + a / 2, Y); g.lineTo(X, Y + off); } else { g.moveTo(X, Y - a / 2); g.lineTo(X, Y + a / 2); g.lineTo(X + off, Y); }
        g.closePath(); g.stroke(); break;
      }
      case 'threading': g.beginPath(); g.arc(X, Y, 3, 0, 7); g.fill(); g.beginPath(); g.arc(X, Y, 6, 0, 7); g.stroke(); break;
      case 'point_region': case 'ge_cluster': g.setLineDash([3, 2]); g.beginPath(); g.arc(X, Y, Math.max(4, d.size / 2 * m.s), 0, 7); g.stroke(); g.setLineDash([]); break;
      case 'particle': g.globalAlpha = (alpha || 1) * 0.7; g.beginPath(); g.arc(X, Y, Math.max(3, d.size / 2 * m.s), 0, 7); g.fill(); g.globalAlpha = alpha || 1; break;
      default: g.beginPath(); g.arc(X, Y, Math.max(3, d.size / 2 * m.s), 0, 7); d.type === 'loop' ? g.stroke() : g.fill();
    }
    if (isSel) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([2, 2]); g.strokeRect(X - 9, Y - 9, 18, 18); g.setLineDash([]); }
    g.globalAlpha = 1;
  }
  function drawStruct() { drawCross(); drawTop(); }

  // 편집 상호작용
  function hitTop(px, py) {
    let best = null, bd = 10;
    for (const d of state.defects) for (const [x, y] of PL.Sim._samples(d)) {
      const dd = Math.hypot(topMap.ox + x * topMap.s - px, topMap.oy + y * topMap.s - py);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  function hitCross(px, py) {
    let best = null, bd = 10;
    for (const d of state.defects) {
      const X = crossMap.x2X(d.x), Y = crossMap.z2y(d.type === 'particle' ? 0 : d.z);
      let dd = Math.hypot(X - px, Y - py);
      if (d.type === 'misfit' && d.dir === 'x' && Math.abs(py - Y) < 6 && px >= crossMap.x2X(d.x - d.size / 2) && px <= crossMap.x2X(d.x + d.size / 2)) dd = Math.abs(py - Y);
      if (d.type === 'threading' && Math.abs(px - X) < 6 && py >= Y && py <= crossMap.z2y(d.z + d.size)) dd = Math.abs(px - X);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  function addDefect(type, x, y, z) {
    const Lx = state.domain.Lx;
    x = Math.min(Lx, Math.max(0, x)); y = Math.min(Lx, Math.max(0, y));
    const over = {};
    if (z !== undefined) over.z = Math.max(0, z);
    else if (type === 'misfit' && PL.sigeInterfaces(state).length) over.z = PL.sigeInterfaces(state)[0];
    else if (type === 'ge_cluster') { const s = PL.segments(state).find(s => s.layer.material === 'SiGe'); if (s) over.z = 0.5 * (s.z0 + s.z1); }
    const d = PL.newDefect(type, x, y, over);
    state.defects.push(d); selId = d.id; changed('defect');
  }
  function setupEditor() {
    let drag = null;
    const pos = (cv, e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const top = $('cvTop'), cross = $('cvCross');
    top.addEventListener('pointerdown', (e) => {
      const [px, py] = pos(top, e), m = topMap; if (!m) return;
      const x = (px - m.ox) / m.s, y = (py - m.oy) / m.s;
      if (tool !== 'select') { if (x >= 0 && y >= 0 && x <= m.L && y <= m.L) addDefect(tool, x, y); return; }
      const d = hitTop(px, py); selId = d ? d.id : null; renderDefects(); drawStruct();
      if (d) { drag = { view: 'top', d, x0: x, y0: y, dx0: d.x, dy0: d.y }; top.setPointerCapture(e.pointerId); }
    });
    top.addEventListener('pointermove', (e) => {
      if (!drag || drag.view !== 'top') return;
      const [px, py] = pos(top, e), m = topMap;
      const x = (px - m.ox) / m.s, y = (py - m.oy) / m.s;
      drag.d.x = clamp(drag.dx0 + x - drag.x0, 0, m.L); drag.d.y = clamp(drag.dy0 + y - drag.y0, 0, m.L); dirty = true; drawStruct();
    });
    top.addEventListener('pointerup', () => { if (drag) { drag = null; renderDefects(); } });
    cross.addEventListener('pointerdown', (e) => {
      const [px, py] = pos(cross, e), m = crossMap; if (!m) return;
      const x = m.X2x(px), z = m.y2z(py);
      if (tool !== 'select') { if (x >= 0 && x <= state.domain.Lx && py >= m.padT) addDefect(tool, x, +$('ySlice').value, z); return; }
      const d = hitCross(px, py); selId = d ? d.id : null; renderDefects(); drawStruct();
      if (d) { drag = { view: 'cross', d, px0: px, py0: py, dx0: d.x, z0: d.z, zy0: m.z2y(d.z) }; cross.setPointerCapture(e.pointerId); }
    });
    cross.addEventListener('pointermove', (e) => {
      if (!drag || drag.view !== 'cross') return;
      const [px, py] = pos(cross, e), m = crossMap;
      drag.d.x = clamp(drag.dx0 + m.X2x(px) - m.X2x(drag.px0), 0, state.domain.Lx);
      if (drag.d.type !== 'particle') drag.d.z = Math.max(0, m.y2z(drag.zy0 + py - drag.py0));
      dirty = true; drawStruct();
    });
    cross.addEventListener('pointerup', () => { if (drag) { drag = null; renderDefects(); } });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId !== null) { state.defects = state.defects.filter(d => d.id !== selId); selId = null; changed('defect'); }
      if (e.key === 'Escape') { tool = 'select'; renderToolbar(); }
    });
    $('ySlice').addEventListener('input', () => { $('ySliceV').textContent = $('ySlice').value; drawStruct(); });
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function renderStackInfo() {
    const e = $('stackInfo');
    const o = state.optics;
    const segs = PL.segments(state);
    const tbl = h('table', { class: 't' }, h('tr', null, ['층', '깊이', 'Eg (eV)', 'BB 피크', `흡수깊이 @${o.lamExc}nm`, '확산길이', '비고'].map(t => h('th', null, t))),
      segs.map((s, i) => {
        const L = s.layer, inf = PL.layerInfo(L);
        return h('tr', null, h('td', null, `${i + 1}. ${L.material}${L.material === 'SiGe' ? ` x=${L.x} (${L.strained ? 'strained' : 'relaxed'})` : ''}`),
          h('td', null, `${fmtZ(s.z0)} – ${fmtZ(s.z1)}`),
          h('td', null, inf.Eg ? inf.Eg.toFixed(3) : '—'), h('td', null, inf.peak ? inf.peak.toFixed(0) + ' nm' : '—'),
          h('td', null, L.material === 'SiO2' ? '투명' : fmt(1e4 / PL.mat.alpha(L, o.lamExc)) + ' µm'),
          h('td', null, L.material === 'SiO2' ? '—' : diffLen(L).toFixed(0) + ' µm'),
          h('td', { class: inf.relaxRisk && inf.relaxRisk.startsWith('위험') ? 'bad' : '' }, inf.relaxRisk || ''));
      }));
    e.innerHTML = ''; e.append(h('div', { class: 'card-h' }, '층 요약'), tbl);
  }

  // ---------------- 실행 ----------------
  function progress(txt, frac) { $('progText').textContent = txt; if (frac !== undefined) $('progBar').style.width = (frac * 100).toFixed(0) + '%'; }
  function log(txt) { console.log(txt); logLines.push(txt); $('progText').textContent = txt; }
  let logLines = [];
  const hooks = { log, progress: (lab, it, rr) => progress(`${lab} — 반복 ${it}, 잔차 ${rr.toExponential(1)}`, Math.min(0.98, Math.max(0.02, Math.log10(1 / Math.max(rr, 1e-9)) / 7))) };

  async function run() {
    if (busy) return; busy = true; $('btnRun').disabled = true; logLines = [];
    const t0 = performance.now();
    try {
      const st = JSON.parse(JSON.stringify(state)); // 실행 시점 스냅샷
      progress('준비 중…', 0.02); await new Promise(r => setTimeout(r, 20));
      const ctx = PL.Sim.prepare(st);
      log(`격자 ${ctx.G3.nx}×${ctx.G3.ny}×${ctx.G3.nz} (${(ctx.N / 1e6).toFixed(2)} M 셀), 결함 ${st.defects.length}개`);
      if (!ctx.channels.length) throw new Error('켜진 검출 채널이 없습니다 (광학 탭).');
      const res = { st, ctx, mode: st.optics.mode };
      const A = ctx.G3.dx * ctx.G3.dx;
      if (res.mode === 'widefield') {
        res.sol = await PL.Sim.widefieldSolve(ctx, hooks);
        res.imgs = PL.Sim.formImages(ctx, res.sol);
        if (st.analysis.reference) {
          log('기준(결함 없음) 계산 중…');
          if (st.optics.illumProfile !== 'gauss' && !st.noise.on.speckle) {
            // 균일 조명 + 결함 없음 → 가로 방향으로 균일하므로 작은 기둥 하나로 충분
            const st1 = JSON.parse(JSON.stringify(st)); st1.domain.Lx = 4 * st.domain.dx;
            const c1 = PL.Sim.prepare(st1, { noDefects: true });
            const s1 = await PL.Sim.widefieldSolve(c1, hooks);
            const n = ctx.G3.nx * ctx.G3.ny;
            res.refs = PL.Sim.formImages(c1, s1).map(im => ({ ch: im.ch, lamc: im.lamc, ideal: new Float64Array(n).fill(im.ideal[0]) }));
            res.refCol = Array.from({ length: c1.G3.nz }, (_, k) => s1.dn[k]);
          } else {
            res.ctxRef = PL.Sim.prepare(st, { noDefects: true });
            res.solRef = await PL.Sim.widefieldSolve(res.ctxRef, hooks);
            res.refs = PL.Sim.formImages(res.ctxRef, res.solRef);
          }
        }
        res.noises = res.imgs.map((im, i) => PL.Sim.applyNoise(ctx, im, st.noise.on.leak ? PL.Sim.leakage(ctx, ctx.chData[i], res.sol.Phi0 * A) : 0));
      } else {
        res.scan = await PL.Sim.scanMaps(ctx, hooks);
        res.imgs = res.scan.maps;
        if (st.analysis.reference) {
          log('기준(결함 없음) 계산 중…');
          res.ctxRef = PL.Sim.prepare(st, { noDefects: true });
          res.scanRef = await PL.Sim.scanMaps(res.ctxRef, hooks);
          res.refs = res.scanRef.maps;
        }
        res.noises = res.imgs.map((im, i) => PL.Sim.applyNoise(ctx, im, st.noise.on.leak ? PL.Sim.leakage(ctx, ctx.chData[i], res.scan.Np) : 0));
      }
      res.analysis = PL.Sim.analyze(ctx, res.imgs, res.refs, res.noises, st.noise.thr);
      result = res; dirty = false;
      // 기본 선택 픽셀: 첫 번째 결함 위치
      const d0 = st.defects[0];
      result.pix = d0 ? { i: clamp(Math.floor(d0.x / ctx.G3.dxum), 0, ctx.G3.nx - 1), j: clamp(Math.floor(d0.y / ctx.G3.dxum), 0, ctx.G3.ny - 1) } : { i: ctx.G3.nx >> 1, j: ctx.G3.ny >> 1 };
      result.chIdx = Math.max(0, ctx.channels.findIndex(c => c.id === 'lp1400'));
      if (res.mode === 'scan') await scanSpot();
      progress(`완료 — ${((performance.now() - t0) / 1000).toFixed(1)} s`, 1);
      renderResults(); showView('v-image');
    } catch (err) {
      console.error(err); progress('오류: ' + err.message, 0);
    } finally { busy = false; $('btnRun').disabled = false; }
  }

  async function scanSpot() {
    const r = result; if (!r || r.mode !== 'scan') return;
    const key = r.pix.i + ',' + r.pix.j;
    if (r.fwdKey === key) return;
    progress('선택 스팟 순방향 풀이…', 0.5);
    r.fwd = await PL.Sim.scanForward(r.ctx, r.scan, r.pix.i, r.pix.j, hooks);
    if (r.ctxRef) r.fwdRef = await PL.Sim.scanForward(r.ctxRef, r.scanRef, r.pix.i, r.pix.j, hooks);
    r.fwdKey = key; progress('완료', 1);
  }

  // ---------------- 결과 표시 ----------------
  function renderResults() {
    if (!result) return;
    const cb = $('chButtons'); cb.innerHTML = '';
    result.imgs.forEach((im, i) => cb.append(h('button', { class: i === result.chIdx ? 'on' : '', onclick: () => { result.chIdx = i; renderResults(); } }, im.ch.name)));
    drawImageView(); drawSpectrum(); drawCarrier(); renderDetect();
  }
  function currentData() {
    const r = result, i = r.chIdx, kind = $('imgKind').value, nz = r.noises[i];
    const { nx } = r.ctx.G3;
    if (kind === 'noisy') return { data: nz.e, unit: 'e⁻', title: `측정 (노출 ${fmtT(nz.t)})` };
    if (kind === 'ideal') return { data: r.imgs[i].ideal, unit: 'e⁻/s', title: '이상 (노이즈 없음)' };
    if (kind === 'contrast') {
      if (!r.refs) return { data: new Float64Array(nx * nx), unit: '%', title: '기준 계산이 꺼져 있음' };
      const a = r.imgs[i].ideal, b = r.refs[i].ideal;
      return { data: a.map((v, q) => b[q] > 0 ? 100 * (v - b[q]) / b[q] : 0), unit: '%', title: '대비 (I−I₀)/I₀', diverge: true };
    }
    if (kind === 'peak') {
      if (!r.specMap) return { data: new Float64Array(nx * nx), unit: 'nm', title: '"분광 맵 계산" 버튼을 누르세요' };
      return { data: r.specMap.centroid, unit: 'nm', title: '무게중심 파장', cmap: 'turbo' };
    }
  }
  function fmtT(t) { return t >= 1 ? t.toFixed(2) + ' s' : t >= 1e-3 ? (t * 1e3).toFixed(2) + ' ms' : (t * 1e6).toFixed(1) + ' µs'; }
  let imgMap = null;
  function drawImageView() {
    const cv = $('cvImg'); if (!result || !cv.offsetParent) return;
    const r = result, G = r.ctx.G3, cd = currentData();
    const log = $('logScale').checked && !cd.diverge;
    imgMap = R.drawImage(cv, cd.data, G.nx, G.ny, {
      cmap: cd.diverge ? 'diverge' : (cd.cmap || $('cmap').value), log, robust: !cd.diverge && !log, symmetric: cd.diverge, unit: cd.unit, dxum: G.dxum,
      overlay: (g, m) => {
        if ($('overlay').checked) for (const d of r.st.defects) drawDefectTop(g, { ox: m.ox, oy: m.oy, s: m.s / G.dxum }, d, false, 0.55);
        const p = r.pix; g.strokeStyle = '#00e5ff'; g.lineWidth = 1.5; g.strokeRect(m.ox + p.i * m.s - 3, m.oy + p.j * m.s - 3, m.s + 6, m.s + 6);
      },
    });
    const nz = r.noises[r.chIdx], im = r.imgs[r.chIdx];
    let mx = 0, mean = 0, sat = 0; for (const v of nz.e) { mx = Math.max(mx, v); mean += v; if (v >= nz.cfg.fullWell) sat++; } mean /= nz.e.length;
    $('imgInfo').innerHTML = `${cd.title} · 채널 <b>${im.ch.name}</b> (중심 ≈ ${im.lamc.toFixed(0)} nm) · ${r.mode === 'scan' ? '체류' : '노출'} ${fmtT(nz.t)} · 평균 ${fmt(mean)} e⁻, 최대 ${fmt(mx)} e⁻` + (sat ? ` · <span class="warn">포화 ${sat} px</span>` : '') + (r.mode === 'widefield' ? ` · PSF σ(표면) ${im.sigmaSurf.toFixed(2)} µm` : ` · 스팟 FWHM ${r.st.optics.spotFWHM} µm`);
    // 라인 프로파일
    const j = r.pix.j, nx = G.nx, xs = Array.from({ length: nx }, (_, i) => (i + 0.5) * G.dxum);
    const series = [{ x: xs, y: Array.from({ length: nx }, (_, i) => cd.data[j * nx + i]), color: R.css('--accent'), label: cd.title }];
    if (r.refs && $('imgKind').value === 'ideal') series.push({ x: xs, y: Array.from({ length: nx }, (_, i) => r.refs[r.chIdx].ideal[j * nx + i]), color: R.css('--muted'), dash: [4, 3], label: '기준(결함 없음)' });
    R.plot($('cvProf'), series, { xlabel: 'x (µm)', ylabel: cd.unit, vlines: [{ x: (r.pix.i + 0.5) * G.dxum, color: '#00a5c0' }] });
    const q = j * nx + r.pix.i;
    const rows = r.imgs.map((im2, c) => {
      const ref = r.refs ? r.refs[c].ideal[q] : null, v = im2.ideal[q];
      return h('tr', null, h('td', null, im2.ch.name), h('td', null, fmt(v) + ' e⁻/s'), h('td', null, ref !== null ? (100 * (v - ref) / ref).toFixed(2) + ' %' : '—'), h('td', null, fmt(r.noises[c].e[q]) + ' e⁻'));
    });
    $('pixInfo').innerHTML = '';
    $('pixInfo').append(h('div', null, `픽셀 (${r.pix.i}, ${r.pix.j}) = x ${((r.pix.i + 0.5) * G.dxum).toFixed(1)} µm, y ${((r.pix.j + 0.5) * G.dxum).toFixed(1)} µm`),
      h('table', { class: 't' }, h('tr', null, ['채널', '신호(이상)', '대비', '측정값'].map(t => h('th', null, t))), rows));
  }

  function drawSpectrum() {
    const cv = $('cvSpec'); if (!result || !cv.offsetParent) return;
    const r = result, G = r.ctx.G3, where = document.querySelector('input[name=specWhere]:checked').value;
    let sp, label;
    if (r.mode === 'widefield') {
      sp = PL.Sim.spectrum(r.ctx, r.sol.dn, r.sol.props, where === 'all' ? null : [r.pix.j * G.nx + r.pix.i]);
      label = where === 'all' ? '시야 전체' : `픽셀 (${r.pix.i},${r.pix.j}) 바로 아래 기둥`;
    } else {
      if (!r.fwd) return;
      sp = PL.Sim.spectrum(r.ctx, r.fwd.dn, r.fwd.props, null);
      label = `스팟 (${r.pix.i},${r.pix.j}) 조사 시 전체 수집`;
    }
    const L = Array.from(PL.LAM), logy = $('specLog').checked;
    const S = [
      { x: L, y: Array.from(sp.total), color: R.css('--fg'), label: '합계(검출)', width: 2.2 },
      { x: L, y: Array.from(sp.comps.Si), color: '#4f8fe8', label: 'Si 밴드간' },
      { x: L, y: Array.from(sp.comps.SiGe), color: '#e39a2d', label: 'SiGe 밴드간' },
      { x: L, y: Array.from(sp.comps.cluster), color: '#e05fb0', label: 'Ge 과잉 영역' },
      { x: L, y: Array.from(sp.comps.D), color: '#e04848', label: 'D-line (전위)' },
    ].filter(s => s.y.some(v => v > 0));
    if ($('specIntr').checked) {
      const qe = r.ctx.QE, mx = Math.max(...sp.total), mi = Math.max(...sp.totalIntr);
      S.push({ x: L, y: Array.from(sp.totalIntr, v => v / mi * mx), color: R.css('--muted'), dash: [5, 3], label: '내부 발광(정규화, 탈출 전)' });
    }
    const bands = r.ctx.channels.map((c, i) => ({ lo: c.kind === 'sp' ? 800 : c.lo, hi: c.kind === 'lp' ? 1800 : c.hi, color: ['rgba(79,143,232,0.10)', 'rgba(224,72,72,0.10)', 'rgba(227,154,45,0.10)', 'rgba(120,200,120,0.12)', 'rgba(160,160,160,0.10)'][i % 5], label: c.name, row: i }));
    const vl = PL.mat.DLINES.map((d, i) => ({ x: PL.C.HC / d.E, label: d.name, color: 'rgba(224,72,72,0.6)', row: i % 2 }));
    R.plot(cv, S, { xlabel: '파장 (nm)', ylabel: '검출 광전자 (e⁻/s/nm)', logy, logSpan: 1e-6, xlim: [850, 1800], bands, vlines: vl, title: label });
    const pk = PL.LAM[sp.total.indexOf(Math.max(...sp.total))];
    let tot = 0, totD = 0; for (let l = 0; l < L.length; l++) { tot += sp.total[l]; totD += sp.comps.D[l]; }
    $('specInfo').textContent = `피크 ${pk.toFixed(0)} nm · D-line 비중 ${(100 * totD / tot).toFixed(2)} % · 검출기 QE 포함, 필터는 음영으로만 표시(미적용)`;
  }

  function drawCarrier() {
    const cv = $('cvDn'); if (!result || !cv.offsetParent) return;
    const r = result, G = r.ctx.G3, { nx, nz, zc, zf } = G;
    const dn = r.mode === 'widefield' ? r.sol.dn : (r.fwd && r.fwd.dn);
    if (!dn) return;
    const rows = 160, depth = zf[nz - 1], img = new Float64Array(nx * rows);
    const kOf = (z) => { let k = 0; while (k < nz - 1 && zf[k + 1] < z) k++; return k; };
    const rowK = []; for (let rr = 0; rr < rows; rr++) rowK.push(kOf(Math.pow((rr + 0.5) / rows, 2) * depth));
    const j = r.pix.j;
    for (let rr = 0; rr < rows; rr++) for (let i = 0; i < nx; i++) img[rr * nx + i] = dn[(j * nx + i) * nz + rowK[rr]];
    // 비정사각: drawImage는 정사각 픽셀이므로 임시로 늘린 배열 사용
    const sx = Math.max(1, Math.round(rows / nx * 2.2)), wide = new Float64Array(nx * sx * rows);
    for (let rr = 0; rr < rows; rr++) for (let i = 0; i < nx * sx; i++) wide[rr * nx * sx + i] = img[rr * nx + Math.floor(i / sx)];
    R.drawImage(cv, wide, nx * sx, rows, {
      cmap: 'inferno', log: true, unit: 'cm⁻³',
      overlay: (g, m) => {
        g.fillStyle = '#fff'; g.font = '10px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        for (const z of [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200].filter(z => z < depth)) {
          const y = m.oy + Math.sqrt(z / depth) * rows * m.s;
          g.strokeStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.moveTo(m.ox, y); g.lineTo(m.ox + 14, y); g.stroke(); g.fillText(z + ' µm', m.ox + 16, y);
        }
        g.textAlign = 'right'; g.fillText(`y = ${((j + 0.5) * G.dxum).toFixed(1)} µm 단면 · 깊이축 √ 스케일`, m.ox + nx * sx * m.s - 6, m.oy + rows * m.s - 10); g.textAlign = 'left';
        for (const d of r.st.defects) {
          if (Math.abs(d.y - (j + 0.5) * G.dxum) > 3 && d.type !== 'misfit') continue;
          const X = m.ox + d.x / G.dxum * sx * m.s, Y = m.oy + Math.sqrt(Math.max(d.z, 0) / depth) * rows * m.s;
          g.strokeStyle = T[d.type].color; g.lineWidth = 1.5; g.beginPath(); g.arc(X, Y, 4, 0, 7); g.stroke();
        }
      },
    });
    // 깊이 프로파일
    const q = j * nx + r.pix.i, zs = Array.from(zc), act = G.active;
    const prof = (arr) => zs.map((_, k) => act[k] ? arr[q * nz + k] : NaN);
    const S = [{ x: zs, y: prof(dn), color: '#e0a030', label: 'Δn (결함 포함)', markers: false, width: 2 }];
    const dnRef = r.mode === 'widefield' ? (r.solRef && r.solRef.dn) : (r.fwdRef && r.fwdRef.dn);
    if (r.refCol) S.push({ x: zs, y: zs.map((_, k) => act[k] ? r.refCol[k] : NaN), color: R.css('--muted'), dash: [4, 3], label: 'Δn 기준(결함 없음)' });
    else if (dnRef) S.push({ x: zs, y: prof(dnRef), color: R.css('--muted'), dash: [4, 3], label: 'Δn 기준(결함 없음)' });
    const gen = r.ctx.gen.frac; let mxg = 0; zs.forEach((_, k) => { mxg = Math.max(mxg, gen[k] / G.dz[k]); });
    let mxd = 0; S[0].y.forEach(v => { if (v > mxd) mxd = v; });
    S.push({ x: zs, y: zs.map((_, k) => act[k] ? gen[k] / G.dz[k] / mxg * mxd : NaN), color: '#4f8fe8', dash: [2, 2], label: '생성률 G(z) (정규화)' });
    R.plot($('cvDepth'), S, { xlabel: '깊이 (µm)', ylabel: 'Δn (cm⁻³)', logy: true, logSpan: 1e-4, xlim: [0, Math.min(depth, 60)] });
  }

  function renderDetect() {
    const r = result; if (!r) return;
    const chs = r.imgs.map(im => im.ch.name);
    const tbl = h('table', { class: 't' },
      h('tr', null, h('th', null, '#'), h('th', null, '종류'), h('th', null, '깊이'), h('th', null, '크기'), chs.map(c => h('th', null, c + ' 대비 / SNR'))),
      r.analysis.map(rw => h('tr', { style: 'cursor:pointer', onclick: () => { const G = r.ctx.G3; r.pix = { i: clamp(Math.floor(rw.def.x / G.dxum), 0, G.nx - 1), j: clamp(Math.floor(rw.def.y / G.dxum), 0, G.ny - 1) }; afterPick(); showView('v-image'); } },
        h('td', null, rw.def.id), h('td', null, h('span', { class: 'chip', style: `background:${T[rw.def.type].color}` }), T[rw.def.type].label),
        h('td', null, fmtZ(rw.def.z)), h('td', null, fmtZ(rw.def.size)),
        rw.ch.map(c => h('td', { class: c.detected ? 'ok' : 'muted' }, `${c.detected ? '✔' : '✘'} ${c.bright ? '밝음' : '어두움'} ${Number.isFinite(c.contrast) ? (100 * c.contrast).toFixed(2) + '%' : '∞'} / ${c.snr.toFixed(1)}`)))));
    const sum = chs.map((c, i) => `${c}: ${r.analysis.filter(rw => rw.ch[i].detected).length}/${r.analysis.length}개 검출`).join(' · ');
    $('detectSummary').innerHTML = `<b>검출 요약</b> (SNR ≥ ${r.st.noise.thr}, 단일 픽셀 기준) — ${sum}<br><span class="muted">국부 대비 = (I − I_bg)/I_bg. I_bg는 결함 주변 고리(수 µm 바깥)의 배경입니다${r.refs ? ' — 결함 없는 기준과의 차이 맵에서 구해, 여러 결함이 함께 만드는 전역 신호 감소는 제외합니다' : ''}. SNR = |ΔI|·t / σ_noise(I_bg). 행을 클릭하면 해당 위치를 이미지에서 선택합니다.</span>`;
    $('detectTable').innerHTML = ''; $('detectTable').append(tbl);
  }

  async function afterPick() {
    if (result.mode === 'scan') { await scanSpot(); }
    drawImageView(); drawSpectrum(); drawCarrier();
  }

  function setupResultUI() {
    $('cvImg').addEventListener('click', (e) => {
      if (!result || !imgMap || busy) return;
      const r = $('cvImg').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const i = Math.floor((x - imgMap.ox) / imgMap.s), j = Math.floor((y - imgMap.oy) / imgMap.s);
      if (i < 0 || j < 0 || i >= result.ctx.G3.nx || j >= result.ctx.G3.ny) return;
      result.pix = { i, j }; afterPick();
    });
    ['imgKind', 'cmap', 'logScale', 'overlay'].forEach(id => $(id).addEventListener('change', drawImageView));
    document.querySelectorAll('input[name=specWhere]').forEach(e => e.addEventListener('change', drawSpectrum));
    ['specIntr', 'specLog'].forEach(id => $(id).addEventListener('change', drawSpectrum));
    $('btnSpecMap').addEventListener('click', async () => {
      if (!result || busy) return; busy = true;
      try {
        const r = result, ctx = r.ctx;
        if (r.mode === 'widefield') {
          const bands = PL.Sim.bandChannels(1000, 1700, 28).map(ch => PL.Sim.prepChannel(ch, ctx.classes, ctx.dShapes, ctx.Tesc, ctx.QE, ctx.G3.nz, ctx.det, ctx.state));
          progress('분광 맵 계산…', 0.5);
          r.specMap = PL.Sim.centroidMap(PL.Sim.formImages(ctx, r.sol, bands));
        } else {
          const bands = PL.Sim.bandChannels(1000, 1700, 10).map(ch => PL.Sim.prepChannel(ch, ctx.classes, ctx.dShapes, ctx.Tesc, ctx.QE, ctx.G3.nz, ctx.det, ctx.state));
          const sm = await PL.Sim.scanMaps(ctx, hooks, bands);
          r.specMap = PL.Sim.centroidMap(sm.maps);
        }
        progress('분광 맵 완료', 1);
        $('imgKind').value = 'peak'; drawImageView();
      } finally { busy = false; }
    });
  }

  // ---------------- 저장/불러오기 ----------------
  function setupIO() {
    $('btnSave').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'pl_scenario.json' }); document.body.append(a); a.click(); a.remove();
    });
    $('fileLoad').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const s = JSON.parse(await f.text()), base = defaultState();
        for (const k of ['domain', 'surface', 'physics', 'optics', 'noise', 'analysis']) s[k] = Object.assign(base[k], s[k] || {});
        s.noise.on = Object.assign(defaultState().noise.on, s.noise.on || {});
        state = s; PL.resetDefectId(Math.max(0, ...state.defects.map(d => d.id)) + 1);
        selId = null; result = null; renderAll();
      } catch (err) { alert('불러오기 실패: ' + err.message); }
      e.target.value = '';
    });
  }

  function renderAll() { renderStruct(); renderDefects(); renderOptics(); renderNoise(); renderPhys(); renderToolbar(); renderStackInfo(); $('ySlice').max = state.domain.Lx; drawStruct(); }
  function redrawVisible() { drawStruct(); if (result) { drawImageView(); drawSpectrum(); drawCarrier(); } PL.Tests && PL.Tests.redraw && PL.Tests.redraw(); }

  // 시작
  PL.Sim._samples = function (d) {
    if (d.type === 'misfit') { const p = []; for (let i = 0; i <= 20; i++) { const t = -0.5 + i / 20; p.push(d.dir === 'y' ? [d.x, d.y + t * d.size] : [d.x + t * d.size, d.y]); } return p; }
    if (d.type === 'stacking_fault') { const p = []; for (let i = 0; i <= 10; i++) { const t = -0.5 + i / 10; p.push(d.dir === 'y' ? [d.x, d.y + t * d.size] : [d.x + t * d.size, d.y]); } return p; }
    return [[d.x, d.y]];
  };
  tabs('sideTabs'); tabs('workTabs');
  setupEditor(); setupResultUI(); setupIO();
  $('btnRun').addEventListener('click', run);
  $('btnTests').addEventListener('click', () => PL.Tests.run($('testOut'), $('cvTest')));
  $('guide').innerHTML = PL.GUIDE_HTML || '';
  renderAll();
  window.addEventListener('resize', redrawVisible);
  window.PLapp = { get state() { return state; }, get result() { return result; }, run };
})();

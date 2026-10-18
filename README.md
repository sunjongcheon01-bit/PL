# PL 결함 검출 시뮬레이터

Photoluminescence(PL) 현미경으로 Si / SiGe 적층의 격자 결함이 어떻게 보이는지 물리 기반으로 계산하는 브라우저 앱입니다. 측정 온도는 상온 300 K로 고정입니다.
설치할 것이 없습니다. `index.html`을 더블클릭해 브라우저(Chrome/Edge)로 열면 됩니다.

## 기능
- **구조**: Si, SiGe(Ge 농도·strained/relaxed), SiO₂ 층을 쌓고 도핑·수명을 지정합니다. SiGe 층은 임계 두께(Matthews–Blakeslee / People–Bean) 대비 위험도를 표시합니다.
- **결함 그리기**: 평면도(x–y)와 단면도(x–z)에서 클릭해 가상 결함을 심습니다.
  - 종류: 전위 루프, 관통 전위, misfit 전위, 적층 결함, 산소 석출물, 보이드, 점결함/금속 오염 영역, Ge 과잉 영역, 표면 파티클
  - 크기·깊이·재결합 세기·D-line 발광 비율을 조절할 수 있고, misfit 격자무늬와 무작위 결함을 자동 생성할 수 있습니다.
- **광학**: widefield(카메라) / 스캐닝(점 조사 맵), 여기 파장(405–980 nm 또는 직접 입력), 출력, NA, 초점 깊이, 필터 채널(BB, SiGe, LP1400 D-line, 사용자 정의), 검출기(InGaAs, VisNIR, 확장 InGaAs, Si CCD)를 고릅니다. "En-Vision 유사" 프리셋이 있으며 값은 공개 자료 기반 가정입니다.
- **노이즈**: 스페클, RIN, 조명 불균일, 샷, 다크, 리드, PRNU, DSNU, ADC 양자화, 레이저 누설
- **결과**:
  - 채널별 2D 이미지 (측정 / 이상 / 대비 맵 / 피크 파장 맵)
  - 픽셀별 스펙트럼 (Si, SiGe, Ge 과잉 영역, D-line 성분 분리)
  - Δn 단면과 깊이 프로파일
  - 결함별 국부 대비·SNR·검출 여부 표
- **검증 탭**: 1D 확산 해석해, Si 상온 PL 피크, 임계 두께, 입자 보존, 결함 대비 부호, 상반성(스캔 맵 = 직접 계산)을 확인합니다.

## 물리 모델 (요약)
- **확산 방정식** (Slotboom 변환으로 SiGe 캐리어 가둠 반영):
  `−∇·(D w ∇u) + (w/τ)u + Σ K_결함 w u = G`, `Δn = w·u`
  - 유한체적 3D 격자에서 PCG로 풉니다. 전처리기는 가로 multigrid + z-line 평활입니다.
  - 고주입은 Picard 반복으로 처리합니다(복사, Auger, 양극성 확산).
- **결함**: 재결합 싱크 K로 표현합니다.
  - 구형 결함: 4πr²S (격자 이하 크기는 확산 한계 보정)
  - 전위선: 2πr_cS / 길이
  - 면결함: 2S / 면적
  - 전위 계열은 η_D 비율만큼 D-line을 방출합니다(상온은 D1 위주).
- **발광**: 일반화 Planck 법칙 `r(E) ∝ α(E)E²exp(−E/kT)`
  - SiGe는 ΔEg(x)만큼 이동하고 합금 broadening을 더합니다.
- **광학**:
  - 반사: SiO₂ 박막 간섭 포함
  - 흡수: Beer–Lambert
  - 탈출: NA/n 허용각, Fresnel, 자기흡수
  - 이미지: 깊이별 디포커스 PSF
- **스캔 맵**: 저주입 선형 근사에서 상반성 정리를 써서, 채널당 1회 풀이로 전체 맵을 계산합니다.

자세한 설명과 한계는 앱의 **원리 설명** 탭에 있습니다.

## 결함 아틀라스 (`defect_atlas.html`)
주요 결함의 발생 원인, 원자 배열(정상 → 결함 단계별 변화, 끊어진 결합 표시), 3D 형상, 시뮬레이션 기반 PL 이미지와 정상 대비 스펙트럼을 한 장씩 보여주는 발표용 페이지입니다. 더블클릭해 열면 됩니다(3D 보기는 three.js를 CDN에서 불러오므로 인터넷 연결이 필요합니다).

- `atlas/atlas_src.html`: 페이지 원본 (데이터 자리 `/*__DATA__*/`)
- `atlas/atlas_data.json`: 시뮬레이터로 계산한 결함별 이미지·스펙트럼 (48 × 48 µm, 532 nm, NA 0.5, InGaAs)
- `atlas/build.ps1`: 둘을 합쳐 `defect_atlas.html`을 다시 만듭니다.

```
powershell -ExecutionPolicy Bypass -File atlas\build.ps1
```

## 파일 구성
| 파일 | 내용 |
|---|---|
| `js/materials.js` | 300 K 물성 (α, n, Eg(x), 이동도, 재결합 계수, 임계 두께, 발광 스펙트럼) |
| `js/structure.js` | 적층 프리셋, 깊이 방향 비균일 격자 |
| `js/defects.js` | 결함 라이브러리, 래스터화, 생성기 |
| `js/optics.js` | 반사, 흡수, 탈출/수집, 필터, 검출기 QE, PSF |
| `js/noise.js` | 노이즈 모델, 블러 |
| `js/solver.js` | FV 조립, multigrid 전처리 PCG |
| `js/simulate.js` | widefield/스캔 파이프라인, 스펙트럼, 검출 분석 |
| `js/render.js`, `js/ui.js` | 화면 |
| `js/tests.js`, `js/guide.js` | 검증, 원리 설명 |
| `defect_atlas.html`, `atlas/` | 결함 아틀라스 (발표용) |

## 성능 참고
기본 설정(100×100 µm, dx 1 µm, 깊이 50 µm, 약 0.5 M 셀)에서 걸리는 시간은 대략 다음과 같습니다.
- widefield (기준 계산 포함): 약 3–5초
- 스캐닝: 약 15초

dx 0.5 µm는 셀 수가 4배라 그만큼 느려집니다.

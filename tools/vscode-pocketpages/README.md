# VSCode PocketPages

PocketPages 프로젝트를 위한 VS Code 전용 언어 확장입니다.

이 확장은 `.ejs`와 `pb_hooks/pages/**/*.js|cjs|mjs`를 일반 HTML/JavaScript 파일이 아니라, PocketPages의 라우팅 규칙, `_private` 탐색 모델, `<script server>` 문맥, PocketBase 스키마, 저장소 AGENTS 규칙까지 포함한 도메인 문서로 해석합니다.

즉, `resolve()`, `include()`, `redirect()`, `href`, `action`, `hx-*`, `record.get('field')` 같은 문자열 기반 연결점을 편집기 수준의 탐색, 자동완성, 진단 대상으로 바꿔주는 확장입니다.

## 핵심 기능

| 구분 | 지원 기능 | 설명 |
| --- | --- | --- |
| EJS 서버 코드 | `<script server>` 분석 | PocketPages 서버 실행 문맥으로 인식하여 completion, hover, signature help, diagnostics 제공 |
| EJS 템플릿 | `<% %>`, `<%= %>`, `<%- %>` 분석 | 템플릿 표현식도 JS로 분석하고 같은 파일의 서버 선언과 연결 |
| 경로 해석 | `resolve()`, `include()`, `href`, `action`, `hx-*`, `redirect()` | 경로 completion, definition 이동, document link 이동 지원 |
| 역참조 탐색 | 호출부 찾기 | `_private` partial/module, static route의 사용처 탐색 지원 |
| `_private` 모듈 추적 | `resolve()` 기반 CommonJS 분석 | export 멤버 completion, definition, references, rename 지원 |
| 스키마 검증 | PocketBase 컬렉션/필드 문자열 검사 | `pb_schema.json` 기반 completion과 unknown collection/field diagnostics 제공 |
| partial locals | `include(..., { ... })` locals 추론 | partial 내부 locals completion, hover, 일부 diagnostics 지원 |
| 규칙 진단 | AGENTS-aware diagnostics | 저장소 규칙 위반 패턴을 편집 중 바로 진단 |
| Quick Fix | 일부 규칙 위반 자동 수정 | 대표적인 PocketPages 규칙 위반 패턴을 빠르게 교정 |
| 편집 UX | hover, CodeLens, context menu | target 경로 hover, reference count CodeLens, 참조 탐색 명령 제공 |

## 분석 기준

확장은 현재 파일만 보지 않고 서비스 단위 문맥을 구성해 해석합니다.

- `apps/<service>/pb_hooks/pages`
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`
- 레포의 AGENTS 규칙 패턴

## 지원 범위

| 범위 | 내용 |
| --- | --- |
| 대상 프로젝트 | `apps/<service>` 아래 PocketPages 앱 |
| 대상 파일 | `.ejs`, `pb_hooks/pages/**/*.js|cjs|mjs` |
| 참조 메타데이터 | `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json` |

## 현재 범위 밖

| 미지원 항목 | 설명 |
| --- | --- |
| 코드 포맷팅 | formatter 역할은 하지 않음 |
| HTML 구조 품질 검사 | 일반적인 HTML lint 전체를 대체하지 않음 |
| UnoCSS/Tailwind 클래스 검사 | 클래스 유효성 검사는 제공하지 않음 |
| 완전한 동적 문자열 해석 | 모든 런타임 경로를 100% 해석하지 않음 |
| 완전한 데이터 흐름 분석 | 임의 런타임 값 흐름 전체 추적은 범위 밖 |

## 제공 명령

| 명령 | 설명 |
| --- | --- |
| `PocketPages: Probe Current EJS File` | 현재 파일이 PocketPages 앱으로 인식되는지와 진단 수를 빠르게 확인 |
| `PocketPages: Refresh Server Script Diagnostics` | 현재 문서의 PocketPages 진단을 강제로 다시 계산 |
| `PocketPages: Reload Caches` | 경로, 스키마, 참조 캐시를 다시 적재 |
| `PocketPages: All File References` | 현재 파일 기준의 include/resolve/route 사용처를 한 번에 확인 |

## 설치 및 실행

### 로컬 개발 실행

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. 열린 Extension Development Host에서 모노레포 루트를 엽니다.
5. `.ejs` 또는 `pb_hooks/pages/**/*.js` 파일을 열어 동작을 확인합니다.

### VSIX 패키징

```bash
npm run package:vsix
```

### 설치

```bash
npm run install:vscode-pocketpages
```

설치 후에는 `Developer: Reload Window`를 실행해야 최신 코드가 반영됩니다.

## 검증

핵심 language feature를 빠르게 점검하려면 다음 명령을 사용합니다.

```bash
npm run sanity-check
```

이 명령은 completion, definition, rename, references, diagnostics, quick fix, document link가 기대대로 동작하는지 확인합니다.

## 문제 확인 체크포인트

- 확장이 실제로 활성화되었는지
- VSIX 재설치 후 `Developer: Reload Window`를 실행했는지
- 현재 파일이 `apps/<service>` 아래 PocketPages 앱으로 인식되는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 존재하는지
- 현재 파일이 `.ejs` 또는 `pb_hooks/pages/**/*.js|cjs|mjs` 범위에 속하는지

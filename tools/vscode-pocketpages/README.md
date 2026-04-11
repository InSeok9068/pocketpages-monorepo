# VSCode PocketPages

PocketPages 프로젝트를 위한 VS Code 전용 언어 확장입니다.

이 확장은 PocketPages 코드를 일반 HTML/JavaScript로 보지 않고, 서비스 루트와 `pb_hooks/pages` 구조, `_private` 해석 규칙, `pocketpages-globals.d.ts`, `pb_schema.json`, 저장소 AGENTS 규칙까지 포함한 도메인 문서로 해석합니다.

핵심 목표는 문자열 기반 연결점을 편집기 기능으로 바꾸는 것입니다. 예를 들면 `resolve()`, `include()`, `asset()`, `redirect()`, `href`, `action`, `hx-*`, `require(\`${__hooks}/...\`)`, `record.get('field')` 같은 패턴을 completion, navigation, diagnostics 대상으로 다룹니다.

## 대상 범위

이 확장이 직접 지원하는 편집 대상은 다음과 같습니다.

- `apps/<service>` 아래의 PocketPages 앱
- 모든 `.ejs` 파일
- `pb_hooks/pages/**/*.js`
- `pb_hooks/pages/**/*.cjs`
- `pb_hooks/pages/**/*.mjs`
- `pb_hooks/**/*.js|cjs|mjs` 중 `pb_hooks/pages` 밖 파일의 schema-only 지원

다음 파일은 의도적으로 PocketPages code index에서 제외됩니다.

- `pb_hooks/pages/assets/**/*.min.js|cjs|mjs`
- `pb_hooks/pages/**/vendor/**` 아래의 클라이언트 자산 스크립트

즉 `.js`라고 해서 모두 같은 수준의 PocketPages 언어 기능이 붙는 것은 아닙니다.

- `pb_hooks/pages/**/*.js|cjs|mjs`는 PocketPages 페이지 코드로 전체 지원됩니다.
- `pb_hooks/jobs/*.js` 같은 `pb_hooks/pages` 밖 스크립트는 schema-only 지원만 받습니다.
  여기서는 컬렉션/필드 completion과 schema diagnostics만 제공되고, route/partial/resolve 계열 기능은 붙지 않습니다.

## 무엇을 이해하나

확장은 현재 파일만 보지 않고 서비스 단위 문맥을 구성합니다.

- `apps/<service>/pb_hooks/pages`
- `apps/<service>/pb_data/types.d.ts`
- `apps/<service>/pocketpages-globals.d.ts`
- `apps/<service>/types.d.ts`
- `apps/<service>/pb_schema.json`
- 저장소 AGENTS 패턴

또한 `.ejs`는 그대로 분석하지 않고 `<script server>` 블록, 템플릿 표현식, include locals 정보를 가상 TypeScript 문서로 구성해 분석합니다.

## 실제 제공 기능

### 1. EJS 분석

- `<script server>` 내부 completion
- `<% %>`, `<%= %>`, `<%- %>` 내부 completion
- EJS 내부 심볼 quick info hover
- `include()` 호출 signature help
- EJS semantic tokens
- EJS/server-template boundary CodeLens 및 장식선
- EJS 템플릿과 같은 파일의 서버 선언 연결
- include locals를 partial 내부 타입으로 연결

### 2. JS/CJS/MJS 페이지 코드 분석

- `pb_hooks/pages/**/*.js|cjs|mjs`에서 completion
- definition, references, rename
- diagnostics, quick fix, inlay hints
- 경로 hover 및 document link

주의:

- 일반 심볼 hover는 `.ejs`에서만 이 확장이 직접 제공합니다.
- JS/CJS/MJS에서는 중복 hover를 줄이기 위해 일반 quick info hover를 별도로 덧붙이지 않고, 기본 JS/TS hover에 맡깁니다.
- 대신 경로 hover는 JS/CJS/MJS에서도 동작합니다.

### 3. `pb_hooks/pages` 밖 script의 schema-only 지원

`pb_hooks/jobs/*.js` 같은 `pb_hooks/pages` 밖 스크립트에도 다음 기능은 지원합니다.

- `pb_schema.json` 기반 컬렉션 이름 completion
- `record.get('field')`, `record.set('field', value)` 계열 필드 completion
- unknown collection diagnostics
- unknown field diagnostics

하지만 이 범위는 의도적으로 얇게 제한됩니다.

- `resolve()` / `include()` / route path / `href` / `action` / `hx-*`는 지원하지 않음
- `_private` references / rename / document link / path hover는 지원하지 않음
- PocketPages page/middleware 규칙 diagnostics는 적용하지 않음

### 4. 경로 인텔리전스

다음 패턴을 경로/타깃으로 해석합니다.

- `resolve('...')`
- `include('...')`
- `asset('...')`
- `redirect('/path')`
- `href="/path"`
- `action="/path"`
- `hx-get`, `hx-post`, `hx-put`, `hx-patch`, `hx-delete`
- 정적 `require('...')`
- `require(\`${__hooks}/...\`)`
- `require(__hooks + '/...')`

지원되는 동작은 다음과 같습니다.

- 경로 completion
- definition 이동
- hover로 타깃 파일 표시
- document link
- `_private` partial/module, static route 기준 All File References
- `_private` 파일 rename 시 호출부 경로 자동 보정

### 5. `_private` partial / module 추적

- nearest `_private` 우선 resolve
- `../`를 이용한 상위 `_private` 해석
- `resolve('roles/board')` 같은 grouped path 해석
- `_private` CommonJS export 멤버 completion
- resolve 결과 멤버 definition / references / rename
- static `require('./module')` 호출부 추적
- `_private/*.ejs` partial caller 추적
- `include(..., { ... })` locals shape 추론

### 6. PocketBase 스키마 인텔리전스

`pb_schema.json`을 기준으로 컬렉션/필드 정보를 제공합니다.

- 컬렉션 이름 completion
- `record.get('field')` 필드 completion
- `record.set('field', value)` 계열 필드 diagnostics
- unknown collection diagnostics
- unknown field diagnostics
- 앱별 schema isolation
- invalid schema 이후 last-known-good fallback
- schema 복구 후 캐시 회복

지원 검증 대상에는 `$app.findRecordsByFilter()`, `findCollectionByNameOrId()`, `recordQuery()`, `isCollectionNameUnique()` 같은 컬렉션 식별자 메서드가 포함됩니다.

### 7. diagnostics / quick fix

현재 구현된 진단 축은 다음과 같습니다.

- unknown PocketBase collection / field
- `resolve('/_private/...')` 또는 `resolve('_private/...')` 경고
- unresolved `resolve()` / `include()` / route path
- include locals 누락 / 오타 / 불필요한 full context 전달
- `params`를 query처럼 사용하는 패턴 경고
- 수동 `__flash` query 문자열 경고
- `redirect()` 후 `return` 누락 경고
- `+middleware.js`의 `next()` 흐름 경고
- 클라이언트 `<script>` 구문 오류 감지

일부 diagnostics에는 quick fix가 붙습니다.

- `_private` prefix 제거
- include local 키 오타 수정
- unresolved path suggestion

### 8. 추가 편집 UX

- include target CodeLens
- route CodeLens
- partial/module/route caller 수 CodeLens
- All File References 명령
- inlay hints

## 제공 명령

| 명령 | 설명 |
| --- | --- |
| `PocketPages: Probe Current EJS File` | 현재 활성 파일의 `languageId`, 경로, app root 인식 여부, diagnostics 개수를 빠르게 확인 |
| `PocketPages: Refresh Server Script Diagnostics` | 현재 활성 문서의 PocketPages diagnostics를 즉시 다시 계산 |
| `PocketPages: Reload Caches` | 현재 앱 또는 전체 확장의 경로 / schema / reference 캐시를 다시 적재 |
| `PocketPages: All File References` | `_private` partial, `_private` module, static route 파일의 호출부를 한 번에 표시 |

## 지원하지 않는 것

이 확장은 다음 역할을 목표로 하지 않습니다.

- formatter
- 일반적인 HTML lint 전체 대체
- UnoCSS / Tailwind 클래스 검사
- 임의 동적 문자열의 완전 해석
- 완전한 런타임 데이터 흐름 추적
- `pb_hooks/jobs/*.js` 같은 비-`pb_hooks/pages` 스크립트의 full PocketPages 분석
  이 범위는 schema completion + schema diagnostics만 지원

## 검증

빠른 회귀 검증은 다음 명령으로 수행합니다.

```bash
npm run sanity-check
```

`sanity-check.js` 한 파일 안에서 source/manifest 계약 검증과 fixture 앱 기반 언어 기능 회귀 검증을 함께 수행합니다.

현재 `sanity-check`는 다음 축을 자동 검증합니다.

- monorepo app-root isolation
- `.ejs`, `.js`, `.cjs`, `.mjs` 분석
- `pb_hooks/jobs/*.js` schema-only completion / diagnostics
- EJS server block / template completion / hover
- typed include locals
- resolve/include/asset/route/require navigation
- `_private` module member definition / references / rename
- `_private` file rename path rewrite
- PocketBase schema completion / diagnostics / cache recovery
- AGENTS-aware diagnostics
- quick fix
- CodeLens
- document links
- inlay hints
- EJS semantic tokens

## 설치 및 실행

### 로컬 개발 실행

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. 열린 Extension Development Host에서 모노레포 루트를 엽니다.
5. `.ejs` 또는 `pb_hooks/pages/**/*.js|cjs|mjs` 파일을 열어 동작을 확인합니다.

### VSIX 패키징

```bash
npm run package:vsix
```

### 설치

```bash
npm run install:vscode-pocketpages
```

설치 후에는 `Developer: Reload Window`를 실행해야 최신 코드가 반영됩니다.

## 문제 확인 체크포인트

- 확장이 실제로 활성화되었는지
- VSIX 재설치 후 `Developer: Reload Window`를 실행했는지
- 현재 파일이 `apps/<service>` 아래 PocketPages 앱으로 인식되는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 존재하는지
- 현재 파일이 `.ejs`, `pb_hooks/pages/**/*.js|cjs|mjs`, 또는 schema-only 대상 `pb_hooks/**/*.js|cjs|mjs` 범위에 속하는지
- `pb_hooks/pages` 밖 스크립트라면 path/route/partial 기능이 아니라 schema completion/diagnostics만 기대해야 하는지

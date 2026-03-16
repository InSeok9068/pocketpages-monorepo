# VSCode PocketPages

PocketPages 프로젝트를 위한 VS Code 전용 언어 확장입니다.  
이 확장은 `.ejs`와 `pb_hooks/pages/**/*.js|cjs|mjs`를 단순 텍스트나 범용 JavaScript 파일로 취급하지 않고, PocketPages의 라우팅 규칙, `_private` 탐색 모델, EJS와 `<script server>`의 혼합 문서 구조, PocketBase 스키마, 그리고 저장소의 AGENTS 규칙까지 함께 해석합니다.

결과적으로 `resolve()`, `include()`, `redirect()`, `href`, `action`, `hx-*`, `record.get('field')`처럼 기존에는 문자열과 관습에 의존하던 지점을 편집기 수준의 탐색, 자동완성, 진단, 리팩터링 대상으로 끌어올립니다.

## 제품 목표

PocketPages 개발은 일반적인 HTML/JS 편집 지원만으로는 충분하지 않습니다.

- `.ejs` 안에 서버 코드와 템플릿 코드가 공존합니다.
- 주요 연결점이 함수 호출이 아니라 문자열 리터럴로 표현됩니다.
- `_private` partial과 module은 호출 문맥을 알아야 안전하게 수정할 수 있습니다.
- PocketBase 컬렉션과 필드 문자열은 스키마를 모르면 오타를 놓치기 쉽습니다.
- 이 저장소는 PocketPages 공식 규칙 외에도 별도의 로컬 작업 규칙을 사용합니다.

VSCode PocketPages는 이런 제약을 전제로 설계된 도메인 특화 언어 도구입니다. 목표는 "문자열 기반 추측 편집"을 "정적 해석 기반 편집"으로 바꾸는 것입니다.

## 분석 대상

확장은 현재 파일만 보는 방식이 아니라, 서비스 단위 문맥을 구성해 해석합니다.

- `apps/<service>/pb_hooks/pages`
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`
- 레포의 AGENTS 규칙 패턴

이 인덱싱 결과를 바탕으로 PocketPages 앱 구조를 서비스 단위로 이해하고, 파일 간 연결 관계를 편집기에 반영합니다.

## 핵심 언어 기능

### 1. `<script server>` 전용 언어 지원

`.ejs` 내부의 `<script server>` 블록을 실제 PocketPages 서버 실행 문맥으로 처리합니다.

- PocketPages 전역 심볼 completion
- hover
- signature help
- diagnostics

예를 들어 `meta`, `redirect`, `resolve`, `request`, `response`, `dbg` 같은 심볼을 일반 문자열 블록이 아닌 서버 코드로 해석합니다.

### 2. EJS 템플릿 식 분석

템플릿 영역의 `<% %>`, `<%= %>`, `<%- %>` 내부 JavaScript 표현식도 분석합니다.

- completion
- hover
- definition
- semantic highlighting

같은 `.ejs` 파일 안에서는 템플릿에서 참조한 심볼을 `<script server>` 선언부와 연결해 탐색할 수 있습니다.

### 3. PocketPages 경로 문자열 해석

확장은 PocketPages에서 중요한 의미를 갖는 문자열을 실제 파일과 라우트로 연결합니다.

- `resolve()` 경로 completion
- `include()` partial 경로 completion
- `href`, `action`, `hx-get`, `hx-post`, `hx-put`, `hx-delete`, `hx-patch` 경로 completion
- `redirect()` 대상 경로 completion
- definition 이동
- Ctrl/Cmd+Click document link 이동

추가로 다음 역참조 탐색을 지원합니다.

- `_private/*.ejs` partial에서 `include()` 호출부 찾기
- `_private/*.js|cjs|mjs` module에서 `resolve()` 호출부 찾기
- static route 파일에서 `href`, `action`, `hx-*`, `redirect()` 사용처 찾기

### 4. `resolve()` 기반 CommonJS 모듈 추적

`resolve()`로 조립한 `_private/*.js` 모듈의 export 멤버까지 추적합니다.

- export 멤버 completion
- export 멤버 definition
- export 멤버 references
- export 멤버 rename

이 기능은 EJS 엔트리와 `_private` service/module 사이를 오가며 리팩터링할 때 특히 유용합니다.

### 5. PocketBase 스키마 기반 문자열 검증

서비스 루트의 `pb_schema.json`을 읽어 컬렉션과 필드 문자열을 실제 스키마와 대조합니다.

- 컬렉션명 completion
- unknown collection diagnostics
- `record.get('field')` 필드명 completion
- unknown field diagnostics
- 일부 PocketBase API의 컬렉션 인자 completion
  - 예: `findCollectionByNameOrId()`, `recordQuery()`

즉, `"boards"`나 `"title"` 같은 문자열도 스키마 인식 대상이 됩니다.

### 6. `_private` partial locals 추적

`include('...', { ... })` 호출부를 읽어 partial 내부 locals를 추론합니다.

```ejs
<%- include('flash-alert.ejs', {
  flashMessage: 'Saved',
  isErrorFlash: false,
  flashMeta: { count: 1 }
}) %>
```

이 경우 partial 내부에서 다음과 같은 지원을 받을 수 있습니다.

- `flashMessage` completion / hover
- `isErrorFlash` diagnostics
- `flashMeta.count` completion

현재는 object literal 전달을 가장 정확하게 지원하며, 복잡한 값 흐름은 보수적으로 처리합니다.

### 7. AGENTS-aware diagnostics

이 확장은 문법 오류만 보는 일반 JS 진단 도구가 아닙니다. 저장소에서 실제로 강제하는 PocketPages 작업 규칙도 함께 검사합니다.

주요 진단 대상:

- `params.foo`를 query string처럼 읽는 패턴
- `resolve('/_private/...')` 또는 `resolve('_private/...')` 사용
- `?__flash=...`를 수동으로 조립하는 redirect
- partial에 `api`, `request`, `response`, `resolve`, `params`, `data` 같은 전체 컨텍스트를 통째로 넘기는 패턴
- `_private` 파일 내부에서 `resolve()`를 직접 호출하는 패턴

일부 항목은 quick fix도 제공합니다.

- `params.foo` -> `request.url.query.foo`
- `resolve('/_private/board-service')` -> `resolve('board-service')`

## 편집 경험

VSCode PocketPages는 다음 작업을 더 안전하게 만듭니다.

- EJS 페이지와 `_private` service를 함께 수정하는 작업
- `resolve()` 경로를 따라 모듈 구조를 읽는 작업
- partial에 전달되는 locals shape를 점검하는 작업
- `_private` partial 또는 module의 호출부를 역으로 찾는 작업
- route string이 실제 어느 page/xapi/api 엔트리를 가리키는지 검증하는 작업
- PocketBase 컬렉션명, 필드명을 변경하거나 정리하는 작업
- AGENTS 규칙 위반을 저장 전에 바로 잡는 작업

## 지원 범위

- `apps/<service>` 아래 PocketPages 앱
- `.ejs`
- `pb_hooks/pages/**/*.js|cjs|mjs`
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`

## 현재 범위 밖인 기능

이 확장은 PocketPages 문맥 해석에 집중합니다. 아래 기능은 현재 제공하지 않습니다.

- 코드 포맷팅
- HTML 구조 자체의 정적 품질 검사
- UnoCSS/Tailwind 클래스 유효성 검사
- 모든 동적 문자열 경로에 대한 완전한 해석
- 임의의 런타임 데이터 흐름에 대한 완전한 분석

즉, 범용 프론트엔드 IDE 전체를 대체하는 도구가 아니라, PocketPages 개발 생산성을 높이는 도메인 특화 언어 확장입니다.

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

### VS Code 또는 Antigravity 설치

```bash
npm run install:vscode-pocketpages
```

설치 후에는 `Developer: Reload Window`를 실행해야 최신 코드가 반영됩니다.

## 검증

확장 호스트를 띄우지 않고 핵심 language feature를 확인하려면 다음 명령을 사용합니다.

```bash
npm run sanity-check
```

이 명령은 completion, definition, rename, references, diagnostics, quick fix, document link가 예상대로 동작하는지 점검합니다.

## 제공 명령

- `PocketPages: Probe Current EJS File`
  - 현재 파일이 PocketPages 앱 루트 안에 있는지와 현재 진단 수를 빠르게 확인합니다.
- `PocketPages: Refresh Server Script Diagnostics`
  - 현재 문서의 PocketPages 진단을 강제로 다시 계산합니다.
- `PocketPages: Reload Caches`
  - 내부 캐시를 다시 적재해 경로, 스키마, 참조 정보 갱신이 필요한 상황을 정리합니다.
- `PocketPages: All File References`
  - 현재 열린 파일이 `_private/*.ejs`면 `include()` 호출부를 보여줍니다.
  - 현재 열린 파일이 `_private/*.js|cjs|mjs`면 `resolve()` 호출부와 정적 string literal `require()` 호출부를 함께 보여줍니다.
  - 현재 열린 파일이 static route 파일이면 `href`, `action`, `hx-*`, `redirect()` 사용처를 보여줍니다.

## 추가 UX

- `_private/*.ejs`, `_private/*.js|cjs|mjs`, static route 파일 상단에 reference count CodeLens를 표시합니다.
- 에디터 우클릭 메뉴에서 `PocketPages: All File References`를 바로 실행할 수 있습니다.
- `resolve()`, `include()`, `href`, `action`, `hx-*`, `redirect()` 문자열 hover에 실제 target 파일 경로를 표시합니다.

## 문제 확인 체크포인트

- 확장이 실제로 활성화되었는지
- VSIX 재설치 후 `Developer: Reload Window`를 실행했는지
- 현재 파일이 `apps/<service>` 아래 PocketPages 앱으로 인식되는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 존재하는지
- 현재 파일이 `.ejs` 또는 `pb_hooks/pages/**/*.js|cjs|mjs` 범위에 속하는지

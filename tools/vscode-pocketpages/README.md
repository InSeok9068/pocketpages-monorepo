# VSCode PocketPages

PocketPages 기반 `.ejs` / `pb_hooks/pages/**/*.js|cjs|mjs` 작업을 위한 VS Code 확장입니다.

이 확장은 일반 JavaScript 보조보다, 이 레포의 PocketPages 구조와 규칙을 빠르게 추적하고 안전하게 수정하는 데 초점을 둡니다.

## 지원 범위

- `apps/<service>` 아래 PocketPages 앱
- `.ejs` 문서
- `pb_hooks/pages/**/*.js|cjs|mjs` 문서
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`

## 주요 기능

- PocketPages 전역(`meta`, `redirect`, `resolve`, `request`, `response`, `dbg` 등) 자동완성
- `<script server>` 내부 completion / hover / signature help / diagnostics
- EJS 템플릿 태그(`<% %>`, `<%= %>`, `<%- %>`) 내부 completion / hover / definition
- 템플릿 영역에서 `<script server>` 변수 정의로 이동
- `resolve()`, `include()`, 정적 `href/action/hx-*`, `redirect()` 경로 자동완성
- `resolve()`, `include()`, 정적 라우트 문자열 정의로 이동
- `resolve()`로 불러온 CommonJS 모듈 export 멤버에 대한 정의 이동 / rename / references
- `pb_schema.json` 기반 컬렉션명 completion 및 unknown collection 경고
- `record.get('field')` 필드명 completion 및 unknown field 경고
- EJS 템플릿 JS 구문 semantic highlighting
- `_private` partial의 `include(..., { ... })` locals 추적
- partial locals 기반 completion / hover / diagnostics
- 레포 규칙 기반 AGENTS-aware diagnostics
- 일부 AGENTS 진단에 대한 quick fix

## AGENTS-aware diagnostics

현재 확장은 이 레포 규칙을 기준으로 다음 패턴을 추가로 점검합니다.

- `params.foo` 형태를 query string처럼 사용하는 경우 경고
  - quick fix: `request.url.query.foo` 기준으로 바꾸기
- `resolve('/_private/...')` 또는 `resolve('_private/...')` 사용 경고
  - quick fix: `_private` prefix 제거
- `?__flash=...`를 수동으로 붙이는 경고
- partial에 `api`, `request`, `response`, `resolve`, `params`, `data` 같은 전체 컨텍스트를 넘기는 경고

## include() locals 추적

`_private/*.ejs` partial을 `include('...', { ... })`로 호출하면, 호출부 object literal을 스캔해서 partial 안 locals 이름과 기본 타입을 추적합니다.

예시:

```ejs
<%- include('flash-alert.ejs', {
  flashMessage: 'Saved',
  isErrorFlash: false,
  flashMeta: { count: 1 }
}) %>
```

위처럼 호출하면 partial 안에서 다음이 동작합니다.

- `flashMessage` hover
- `isErrorFlash` completion / diagnostics
- `flashMeta.count` completion

현재 locals 타입 추적은 object literal 기반 호출을 가장 잘 처리합니다. 식별자/복잡한 표현식은 안전하게 `any`로 처리합니다.

## 아직 하지 않는 것

- 포맷팅
- HTML 자체 구조 검사
- CSS/UnoCSS 클래스 유효성 검사
- 모든 동적 문자열 경로에 대한 완전한 해석

## 로컬 실행

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. 열린 Extension Development Host에서 모노레포 루트를 엽니다.
5. `.ejs` 또는 `pb_hooks/pages/**/*.js` 파일을 열어 확인합니다.

## sanity check

확장 호스트를 띄우지 않고 language-service 브리지만 검증하려면:

```bash
npm run sanity-check
```

## VSIX 패키징 / 설치

VSIX 생성:

```bash
npm run package:vsix
```

VS Code/Antigravity에 재설치까지 한 번에:

```bash
npm run install:vscode-pocketpages
```

설치 후에는 에디터에서 `Developer: Reload Window`를 실행해야 새 코드가 반영됩니다.

## 확인용 명령

- `PocketPages: Probe Current EJS File`
  - 현재 파일이 PocketPages 앱 루트 안에 있는지, 진단이 몇 개인지 확인합니다.
- `PocketPages: Refresh Server Script Diagnostics`
  - 현재 파일 진단을 강제로 다시 계산합니다.

## 문제를 볼 때 먼저 확인할 것

- 확장이 실제로 활성화됐는지
- VSIX 재설치 후 `Developer: Reload Window`를 했는지
- 현재 파일이 `apps/<service>` 아래 PocketPages 앱으로 인식되는지
- `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 서비스 루트에 있는지

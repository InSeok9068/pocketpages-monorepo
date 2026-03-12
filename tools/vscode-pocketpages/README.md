# VSCode PocketPages

PocketPages 기반 `.ejs`와 `pb_hooks/pages/**/*.js|cjs|mjs`를 VS Code에서 더 정확하게 읽고 수정하기 위한 전용 확장입니다.

이 확장은 일반 JavaScript 보조 도구를 PocketPages에 억지로 적용하는 방식이 아니라, PocketPages의 파일 구조, `_private` 탐색 규칙, EJS + `<script server>` 혼합 문서 구조, PocketBase 스키마, 그리고 이 레포의 AGENTS 규칙까지 함께 이해하는 것을 목표로 합니다.

## 이 확장이 해결하려는 문제

PocketPages 작업은 겉보기보다 편집기 지원이 까다롭습니다.

- `.ejs` 안에 서버 코드와 템플릿 코드가 함께 있습니다.
- `resolve()`, `include()`, `href`, `action`, `hx-*`, `redirect()` 같은 문자열이 실제 라우트/모듈 경로 역할을 합니다.
- `record.get('field')`, 컬렉션명 문자열은 스키마를 모르면 오타를 잡기 어렵습니다.
- `_private` partial은 호출부에서 어떤 locals를 넘기는지 알아야 안전하게 수정할 수 있습니다.
- 이 레포는 PocketPages 공식 기능 외에도 `params` 사용 방식, flash 처리, partial context 전달 방식 같은 로컬 규칙이 있습니다.

이 확장은 바로 이런 지점들을 편집기 수준에서 해석해서, "문자열과 관습에 의존하던 작업"을 "이동 가능하고 진단 가능한 작업"으로 바꾸는 데 초점을 둡니다.

## 확장이 이해하는 프로젝트 모델

이 확장은 아래 정보를 함께 읽어서 PocketPages 앱 문맥을 구성합니다.

- `apps/<service>/pb_hooks/pages`
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`
- 레포 규칙에 해당하는 AGENTS 패턴

즉, 단순히 현재 파일 한 개만 파싱하지 않고, 서비스 루트와 타입/스키마/경로 구조를 함께 인덱싱해서 의미를 해석합니다.

## 핵심 기능

### 1. `<script server>`를 PocketPages 서버 코드로 다룹니다

`.ejs` 안의 `<script server>` 블록은 일반 문자열 블록이 아니라 실제 PocketPages 서버 실행 문맥으로 취급됩니다.

- PocketPages 전역 심볼 자동완성
  - 예: `meta`, `redirect`, `resolve`, `request`, `response`, `dbg`
- completion
- hover
- signature help
- diagnostics

이 기능 덕분에 `.ejs` 안에서도 서버 코드가 "에디터가 이해하는 코드"가 됩니다.

### 2. EJS 템플릿 영역도 단순 HTML로 보지 않습니다

템플릿 태그(`<% %>`, `<%= %>`, `<%- %>`) 안의 JavaScript 표현식도 분석 대상입니다.

- EJS 표현식 내부 completion
- hover
- definition
- semantic highlighting

또한 같은 파일 안에서는 템플릿에서 참조한 심볼을 `<script server>` 선언부로 바로 따라갈 수 있습니다.

즉, 템플릿과 서버 코드가 분리된 두 세계가 아니라, 하나의 PocketPages 문서로 연결됩니다.

### 3. 문자열 경로를 실제 PocketPages 경로로 연결합니다

PocketPages에서는 중요한 연결점이 문자열로 표현됩니다. 이 확장은 그 문자열을 실제 라우트/파일로 해석합니다.

- `resolve()` 경로 자동완성
- `include()` partial 경로 자동완성
- `href`, `action`, `hx-get`, `hx-post`, `hx-put`, `hx-delete`, `hx-patch` 경로 자동완성
- `redirect()` 대상 경로 자동완성
- 위 문자열들에 대한 definition 이동
- Ctrl/Cmd+Click 기반 document link 이동

예를 들어 `href="/boards"`는 단순 문자열이 아니라 실제 페이지 파일로 연결되고, `resolve('board-service')`는 실제 `_private` 모듈 파일로 연결됩니다.

### 4. `resolve()`로 조립한 CommonJS 모듈을 추적합니다

PocketPages에서는 `_private/*.js`를 `resolve()`로 조립해 쓰는 패턴이 많습니다.  
이 확장은 여기서 끝나지 않고, `resolve()`로 받은 모듈의 export 멤버까지 따라갑니다.

- export 멤버 completion
- export 멤버 definition 이동
- export 멤버 references 찾기
- export 멤버 rename

즉, 아래 같은 코드에서 `readAuthState`는 단순 property access가 아니라, 실제 선언/사용 지점을 추적 가능한 심볼이 됩니다.

```ejs
<script server>
const boardService = resolve('board-service')
const authState = boardService.readAuthState({ request })
</script>
```

이 기능은 EJS 내부 사용처와 JS 파일 사용처를 함께 엮어서 리팩터링하는 데 특히 중요합니다.

### 5. PocketBase 스키마를 기준으로 문자열 오타를 잡습니다

서비스 루트의 `pb_schema.json`을 읽어서 컬렉션과 필드를 실제 스키마 기준으로 검사합니다.

- 컬렉션명 completion
- unknown collection 진단
- `record.get('field')` 필드명 completion
- unknown field 진단
- 일부 PocketBase API 호출의 컬렉션 인자 completion
  - 예: `findCollectionByNameOrId()`, `recordQuery()`

즉, `"boards"`나 `"title"` 같은 문자열이 실제 스키마와 연결된 정보가 됩니다.

### 6. `_private` partial locals를 호출부 기준으로 추적합니다

이 확장의 중요한 기능 중 하나는 partial이 "무슨 값을 받는지"를 편집기가 이해한다는 점입니다.

`include('...', { ... })` 호출부를 읽어서 `_private/*.ejs` partial 내부 locals를 추적합니다.

예시:

```ejs
<%- include('flash-alert.ejs', {
  flashMessage: 'Saved',
  isErrorFlash: false,
  flashMeta: { count: 1 }
}) %>
```

위처럼 호출하면 partial 내부에서 다음이 동작합니다.

- `flashMessage` completion / hover
- `isErrorFlash` completion / diagnostics
- `flashMeta.count` completion

현재 locals 추적은 object literal 기반 전달을 가장 정확하게 다룹니다.  
식별자 재할당이나 복잡한 계산식은 보수적으로 처리하며, 필요한 경우 `any`로 완화합니다.

### 7. 이 레포 규칙을 이해하는 AGENTS-aware diagnostics를 제공합니다

이 확장은 TypeScript/JavaScript 진단만 보여주지 않습니다.  
이 저장소가 실제로 강제하는 PocketPages 작업 규칙도 함께 점검합니다.

현재 주요 진단 대상은 다음과 같습니다.

- `params.foo`를 query string처럼 읽는 패턴
- `resolve('/_private/...')` 또는 `resolve('_private/...')` 사용
- `?__flash=...`를 수동으로 붙이는 redirect
- partial에 `api`, `request`, `response`, `resolve`, `params`, `data` 같은 전체 컨텍스트를 통째로 넘기는 패턴
- `_private` 파일 내부에서 `resolve()`를 직접 호출하는 패턴

일부 진단은 quick fix를 함께 제공합니다.

- `params.foo` -> `request.url.query.foo`
- `resolve('/_private/board-service')` -> `resolve('board-service')`

즉, 이 확장은 "코드가 문법적으로 맞는가"만 보는 것이 아니라, "이 레포 방식대로 쓰였는가"까지 확인합니다.

## 이 확장이 특히 유용한 작업

- EJS 페이지에서 `_private` service를 호출하고 템플릿까지 같이 수정할 때
- `resolve()` 경로를 따라가며 모듈 구조를 읽을 때
- `include()` partial에 전달되는 locals 구조를 점검할 때
- `record.get()` 필드명과 컬렉션명을 안전하게 바꿀 때
- `href`, `action`, `hx-*`, `redirect()`가 실제 어느 엔트리로 연결되는지 확인할 때
- AGENTS 규칙 위반을 저장 전에 바로 잡고 싶을 때

## 지원 범위

- `apps/<service>` 아래 PocketPages 앱
- `.ejs` 문서
- `pb_hooks/pages/**/*.js|cjs|mjs` 문서
- 서비스별 `pb_data/types.d.ts`
- 서비스별 `pocketpages-globals.d.ts`
- 서비스별 `pb_schema.json`

## 아직 하지 않는 것

이 확장은 PocketPages 문맥 해석에 집중하며, 아래 영역은 현재 범위 밖입니다.

- 포맷팅
- HTML 구조 자체의 정적 품질 검사
- UnoCSS/Tailwind 클래스 유효성 검사
- 모든 동적 문자열 경로에 대한 완전한 해석
- 임의의 런타임 값 흐름을 완벽하게 추론하는 데이터플로 분석

즉, "PocketPages 문맥을 이해하는 편집 지원"이 목표이지, 범용 프론트엔드 IDE를 대체하는 것은 아닙니다.

## 로컬 실행

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. 열린 Extension Development Host에서 모노레포 루트를 엽니다.
5. `.ejs` 또는 `pb_hooks/pages/**/*.js` 파일을 열어 동작을 확인합니다.

## sanity check

확장 호스트를 띄우지 않고 language service 브리지만 검증하려면 아래 명령을 사용합니다.

```bash
npm run sanity-check
```

이 명령은 completion, definition, rename, references, diagnostics, quick fix, document link 같은 핵심 기능이 예상대로 동작하는지 점검합니다.

## VSIX 패키징 / 설치

VSIX 생성:

```bash
npm run package:vsix
```

VS Code 또는 Antigravity에 재설치까지 한 번에:

```bash
npm run install:vscode-pocketpages
```

설치 후에는 에디터에서 `Developer: Reload Window`를 실행해야 새 코드가 반영됩니다.

## 제공 명령

- `PocketPages: Probe Current EJS File`
  - 현재 파일이 PocketPages 앱 루트 안에 있는지, 현재 진단이 몇 개인지 빠르게 확인합니다.
- `PocketPages: Refresh Server Script Diagnostics`
  - 현재 문서의 PocketPages 진단을 강제로 다시 계산합니다.

## 문제를 볼 때 먼저 확인할 것

- 확장이 실제로 활성화됐는지
- VSIX 재설치 후 `Developer: Reload Window`를 했는지
- 현재 파일이 `apps/<service>` 아래 PocketPages 앱으로 인식되는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 있는지
- 현재 열어 둔 파일이 `.ejs` 또는 `pb_hooks/pages/**/*.js|cjs|mjs` 범위에 속하는지

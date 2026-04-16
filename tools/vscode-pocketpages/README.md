# VSCode PocketPages

PocketPages 모노레포를 위한 VS Code 전용 언어 확장입니다.

이 문서는 현재 `tools/vscode-pocketpages` 코드베이스를 기준으로, 확장이 실제로 어떤 파일을 관리하고 어떤 기능을 제공하는지 정의서처럼 정리한 문서입니다. 설명은 구현과 `sanity-check.js`에서 검증되는 동작을 기준으로 작성합니다.

## 문서 목적

- 확장의 지원 범위를 코드 기준으로 명확히 설명합니다.
- EJS, `pb_hooks/pages` 스크립트, schema-only hook script의 기능 차이를 구분합니다.
- 경로 해석, `_private` 추적, PocketBase schema 인텔리전스, diagnostics, CodeLens, 명령을 한 문서에서 확인할 수 있게 합니다.
- 구현 의도보다 현재 동작을 우선합니다.

## 개요

VSCode PocketPages는 PocketPages 파일을 일반 HTML 또는 일반 JavaScript로만 보지 않습니다. 다음 요소를 하나의 서비스 문맥으로 묶어서 해석합니다.

- `apps/<service>/pb_hooks/pages`
- `apps/<service>/pb_data/types.d.ts`
- `apps/<service>/pocketpages-globals.d.ts`
- `apps/<service>/types.d.ts`
- `apps/<service>/pb_schema.json`

핵심 목표는 문자열 기반 연결점을 편집기 기능으로 바꾸는 것입니다. 대표 대상은 다음과 같습니다.

- `resolve('...')`
- `include('...')`
- `asset('...')`
- `redirect('/path')`
- `href="/path"`
- `action="/path"`
- `hx-get`, `hx-post`, `hx-put`, `hx-patch`, `hx-delete`
- `require('...')`
- ``require(`${__hooks}/...`)``
- `require(__hooks + '/...')`
- `$app.findRecordsByFilter('collection')`
- `record.get('field')`, `record.set('field', value)`

## 런타임 구성

현재 확장은 Vue/Volar 계열과 비슷하게 런타임을 분리하지만, 구현 대상은 PocketPages에 맞춰져 있습니다.

| 패키지                        | 역할                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/vscode-pocketpages` | VS Code extension client, status bar, output channel, command wiring, file rename edit 적용                               |
| `packages/language-server`    | LSP 서버, completion/hover/definition/references/rename/code action/document link/inlay hint/semantic token/CodeLens 제공 |
| `packages/language-service`   | PocketPages 도메인 분석, project index, TypeScript bridge, diagnostics, schema/path/include/\_private 로직                |
| `packages/language-core`      | virtual code, mapper, snapshot, EJS `<script server>` 및 template block 파싱                                              |
| `packages/typescript-plugin`  | `.ejs` 문서를 TypeScript server에 연결하는 TS plugin                                                                      |

실행 흐름은 다음 순서입니다.

1. VS Code extension client가 LSP 서버를 시작합니다.
2. `.ejs`는 language core가 virtual code로 변환하고, TS plugin과 LSP가 각자 필요한 기능을 담당합니다.
3. `pb_hooks/pages/**/*.js|cjs|mjs`와 schema-only hook script는 language service가 app root 기준으로 project index를 만들고 TypeScript bridge와 PocketPages 규칙을 적용합니다.
4. `_private`, route, asset, schema, include locals 같은 PocketPages 전용 해석은 custom feature 경로를 통해 처리합니다.

## 지원 워크스페이스와 파일 범위

확장은 임의의 `.ejs` 파일을 전부 관리하지 않습니다. 먼저 `findAppRoot()`가 가장 가까운 상위 디렉터리에서 `pb_hooks/pages`를 찾을 수 있어야 합니다.

즉, 실제 관리 대상은 "PocketPages app root 안에 있는 문서"입니다.

### 파일 범위

| 파일 클래스             | 범위                     | PocketPages 전용 지원 |
| ----------------------- | ------------------------ | --------------------- | ------------------------------ | -------------------------------------------------------- |
| EJS 문서                | app root 안의 `.ejs`     | 전체 EJS 기능         |
| 페이지/내부 스크립트    | `pb_hooks/pages/\*_/_.js | cjs                   | mjs`                           | 전체 PocketPages 스크립트 기능                           |
| schema-only hook script | `pb_hooks/\*_/_.js       | cjs                   | mjs`중`pb_hooks/pages` 밖 파일 | PocketBase schema completion + schema diagnostics만 제공 |

### 제외되는 스크립트

`pb_hooks/pages` 안에 있어도 아래 스크립트는 PocketPages code index에서 제외됩니다.

- route-exposed `vendor/**` script
- `*.min.js`
- `*.min.cjs`
- `*.min.mjs`

이 제외 규칙은 completion, 진단, 탐색 같은 PocketPages 전용 스크립트 기능에 적용됩니다.

`_private/vendor/**` 내부 module은 내부 dependency로 계속 인덱싱합니다.

## 기능 분류

확장은 파일 종류에 따라 같은 기능을 다르게 제공합니다.

### 1. EJS 문서

EJS는 그대로 분석하지 않고 두 종류의 embedded code로 분리합니다.

- `<script server> ... </script>` 블록
- `<% %>`, `<%= %>`, `<%- %>` 같은 template code block

이때 language core는 source offset과 generated offset 매핑을 유지합니다. 그래서 TypeScript 기반 기능은 "실제로 타입 해석이 가능한 EJS 영역"에서만 동작하고, 경로 문자열은 PocketPages custom feature가 우선 처리합니다.

#### EJS에서 제공하는 기능

| 기능                     | 설명                                                           |
| ------------------------ | -------------------------------------------------------------- |
| completion               | `<script server>` 내부와 EJS code block 내부 completion        |
| hover                    | EJS 내부 TypeScript quick info hover + PocketPages 경로 hover  |
| definition               | EJS 심볼 definition + 경로 target definition                   |
| references               | EJS 심볼 references + `_private`/route 경로 references         |
| rename                   | EJS 심볼 rename + `_private` module member rename              |
| signature help           | TypeScript signature help + `include()` custom signature help  |
| diagnostics              | 편집 중 및 저장 시 diagnostics 재계산                          |
| code actions             | diagnostics에서 제공하는 quick fix                             |
| semantic tokens          | EJS code block 기준 semantic token 제공                        |
| CodeLens                 | Template boundary, route summary, include target, caller count |
| include locals inference | partial 내부에서 caller locals shape 추론                      |

#### EJS 특화 UX

- server/template boundary line을 editor decoration으로 표시합니다.
- EJS 문서에는 `Template` CodeLens가 boundary 위치에 표시됩니다.
- `_private/*.ejs` partial은 top-level partial setup block을 별도로 boundary 계산에 포함합니다.

### 2. `pb_hooks/pages/**/*.js|cjs|mjs`

이 범주는 PocketPages 페이지 코드로 취급합니다. route handler, `_private` module, `+middleware.js`, `+config.js`, 일반 page-adjacent script가 모두 여기에 포함됩니다. 다만 vendor/minified 스크립트는 제외됩니다.

#### 제공 기능

| 기능           | 설명                                                                               |
| -------------- | ---------------------------------------------------------------------------------- |
| completion     | TypeScript 기반 completion + PocketPages custom path/schema completion             |
| definition     | TypeScript 심볼 definition + PocketPages 경로 target definition                    |
| references     | TypeScript references + `_private`/route caller 추적                               |
| rename         | TypeScript rename + `_private` module member rename                                |
| signature help | TypeScript signature help + `include()` signature help                             |
| inlay hints    | TypeScript 기반 inlay hints                                                        |
| diagnostics    | PocketPages project-rule diagnostics + schema diagnostics + TypeScript diagnostics |
| code actions   | 일부 diagnostics에 대한 quick fix                                                  |
| document links | resolve/include/asset/route/require target link                                    |
| path hover     | resolve/include/asset/route target hover                                           |
| CodeLens       | route label, include target, caller count                                          |

#### hover 동작 주의

- 일반 JavaScript/TypeScript quick info hover는 이 확장이 `.js|cjs|mjs`에서 별도로 덮어쓰지 않습니다.
- 대신 PocketPages 전용 경로 hover는 제공합니다.
- 즉, JS/CJS/MJS에서는 일반 hover는 VS Code 기본 JS/TS 경험에 맡기고, PocketPages 경로 hover만 추가합니다.

### 3. schema-only hook script

schema-only 범위는 다음 조건을 만족하는 hook script입니다.

- `pb_hooks/` 아래에 있음
- `pb_hooks/pages/` 밖에 있음
- 확장자가 `.js`, `.cjs`, `.mjs`
- 같은 app root를 찾을 수 있음

대표 예시는 `pb_hooks/jobs/*.js`입니다.

#### schema-only에서 제공하는 PocketPages 전용 기능

| 기능                  | 설명                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| collection completion | `pb_schema.json` 기반 컬렉션 이름 completion                             |
| field completion      | `record.get('field')`, `record.set('field', value)` 계열 필드 completion |
| schema diagnostics    | unknown collection / unknown field diagnostics                           |

#### schema-only에서 의도적으로 비활성화한 PocketPages 기능

- `resolve()` / `include()` / `asset()` / route path custom hover
- 경로 target definition
- document links
- `_private` references / rename
- `include()` custom signature help
- PocketPages page/middleware 규칙 diagnostics

즉 schema-only 범위는 "PocketPages page model"이 아니라 "PocketBase schema 보조"로만 다룹니다.

## 경로 인텔리전스 정의

PocketPages 전용 path target으로 해석하는 패턴은 다음과 같습니다.

| 패턴                                                   | 의미                      |
| ------------------------------------------------------ | ------------------------- |
| `resolve('...')`                                       | `_private` module target  |
| `include('...')`                                       | `_private` partial target |
| `asset('...')`                                         | local/global asset target |
| `redirect('/path')`                                    | route target              |
| `href="/path"`                                         | route target              |
| `action="/path"`                                       | route target              |
| `hx-get`, `hx-post`, `hx-put`, `hx-patch`, `hx-delete` | route target              |
| `require('...')`                                       | static require target     |
| ``require(`${__hooks}/...`)``                          | hooks-root require target |
| `require(__hooks + '/...')`                            | hooks-root require target |

### 경로 인텔리전스로 제공하는 동작

- 경로 completion
- target definition
- target hover
- document links
- unresolved path diagnostics
- suggested replacement quick fix

### route 인텔리전스 범위

route index는 `pb_hooks/pages` 아래의 route 파일을 기준으로 만듭니다.

- 페이지 route: `.ejs`
- method route: `+get`, `+post`, `+put`, `+patch`, `+delete`
- route target 확장자: `.ejs`, `.js`, `.cjs`, `.mjs`
- route completion 후보는 static `.ejs` route 위주로 생성합니다.
- concrete path가 있으면 dynamic route file에도 navigation/link를 연결할 수 있습니다.

## `_private` partial / module 정의

`_private`는 route-exposed target이 아니라 내부 target으로 해석합니다.

### `_private` 해석 규칙

- 현재 파일 기준 nearest `_private`를 우선 탐색합니다.
- 필요하면 `../`를 이용해 상위 `_private`까지 올라갑니다.
- grouped path 예시인 `resolve('roles/board')`를 해석합니다.
- `resolve('/_private/...')` 또는 `resolve('_private/...')`는 허용 패턴이 아니라 진단 대상으로 봅니다.

### `_private`에서 제공하는 기능

| 기능                              | 설명                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- | --- | ----------------------- |
| include target resolution         | `_private/*.ejs` partial target 연결                                    |
| resolve target resolution         | `\_private/\*.js                                                        | cjs | mjs` module target 연결 |
| resolved module member completion | `const svc = resolve('board-service'); svc.` 같은 패턴 completion       |
| resolved module member definition | resolve 결과 멤버 definition                                            |
| resolved module member references | resolve 결과 멤버 references                                            |
| resolved module member rename     | resolve 결과 멤버 rename                                                |
| static require tracking           | `_private` module의 `require('./module')` 추적                          |
| partial caller tracking           | `_private` partial을 include하는 caller 추적                            |
| file rename rewrite               | `_private` 파일 rename 시 include/resolve/require 호출부 경로 자동 수정 |

### include locals 계약

partial 호출부의 `include(path, locals)`는 target partial의 사용 흔적을 바탕으로 locals 계약을 추론합니다.

이 계약을 기준으로 다음을 검사합니다.

- unknown local
- missing local
- full context 전달 금지 패턴

## PocketBase schema 인텔리전스 정의

PocketBase schema 기능은 `pb_schema.json`을 기준으로 동작합니다.

### 제공 기능

- collection name completion
- record field completion
- unknown collection diagnostics
- unknown field diagnostics
- field type text 기반 hover/completion 지원용 타입 정보
- 앱별 schema isolation
- invalid schema 이후 last-known-good fallback
- schema 복구 후 cache recovery

### collection method 탐지

collection-name completion과 diagnostics는 `pb_data/types.d.ts`에서 collection method 이름을 추출하려고 시도합니다. 추출에 실패하면 내장 기본 목록을 사용합니다.

기본 목록은 다음 메서드입니다.

- `countRecords`
- `findAuthRecordByEmail`
- `findCachedCollectionByNameOrId`
- `findCollectionByNameOrId`
- `findFirstRecordByData`
- `findFirstRecordByFilter`
- `findRecordById`
- `findRecordByViewFile`
- `findRecordsByFilter`
- `findRecordsByIds`
- `findAllRecords`
- `isCollectionNameUnique`
- `recordQuery`

### field access 탐지

field 컨텍스트는 현재 코드에서 `record.get()` / `record.set()` 계열 호출을 기준으로 수집합니다.

## diagnostics 정의

현재 구현된 PocketPages 전용 diagnostics 코드는 다음과 같습니다.

| 코드                              | 의미                                               |
| --------------------------------- | -------------------------------------------------- |
| `pp-unresolved-resolve-path`      | `resolve()` target을 찾지 못함                     |
| `pp-unresolved-include-path`      | `include()` target을 찾지 못함                     |
| `pp-unresolved-asset-path`        | `asset()` target을 찾지 못함                       |
| `pp-unresolved-route-path`        | route target을 찾지 못함                           |
| `pp-resolve-private-prefix`       | `resolve()`에 `_private` prefix를 직접 적음        |
| `pp-manual-flash-query`           | URL에 `__flash`를 직접 붙임                        |
| `pp-schema-collection`            | unknown PocketBase collection                      |
| `pp-schema-field`                 | unknown PocketBase field                           |
| `pp-redirect-missing-return`      | `redirect()` 이후 `return` 누락                    |
| `pp-middleware-next-bare-return`  | `+middleware.js`에서 bare `return` 사용            |
| `pp-middleware-next-empty-return` | `+middleware.js`에서 `return {}` 사용              |
| `pp-middleware-next-missing-call` | `+middleware.js`에서 `next()` 호출 누락            |
| `pp-partial-full-context`         | partial include에 full context를 넘기는 패턴       |
| `pp-private-resolve`              | `_private` 내부에서 허용되지 않는 `resolve()` 사용 |
| `pp-include-unknown-local`        | include locals에 알 수 없는 키 사용                |
| `pp-include-missing-local`        | include locals에서 필요한 키 누락                  |

또한 custom `pp-*` 코드 외에 다음 diagnostics도 함께 나올 수 있습니다.

- inline client `<script>`의 TypeScript parse diagnostics
- EJS/server/template 구간에서의 TypeScript diagnostics

## code actions 정의

모든 diagnostics가 quick fix를 가지는 것은 아닙니다. 현재 코드에서 quick fix가 붙는 대표 경우는 다음과 같습니다.

- unresolved path에 대한 suggested replacement
- `resolve()`의 `_private` prefix 제거
- include local key rename suggestion
- include missing local 보정

## Editor UX

### CodeLens

현재 CodeLens는 다음 종류를 표시합니다.

- route file 시작 위치의 route label
- EJS의 `Template` boundary label
- `include()` 호출 위치의 target 파일 label
- `_private` partial/module/static route의 caller 수 요약
- `All File References (N)` 진입점

### Semantic Tokens

EJS semantic token은 EJS code block 내부에 대해서만 제공합니다. 현재 token type은 다음 여섯 종류입니다.

- `keyword`
- `string`
- `number`
- `regexp`
- `comment`
- `operator`

### Status Bar / Output

- managed 문서를 열면 `PocketPages LSP` status bar item이 표시됩니다.
- 공용 output channel 이름은 `VSCode PocketPages`입니다.
- LSP lifecycle, document, completion, diagnostics, cache, references, rename, command 로그를 남깁니다.

### All File References

`All File References`는 다음 target에 대해 호출부를 모아 보여줍니다.

- `_private` partial
- `_private` module
- static route file

지원하지 않는 target에 대해 실행하면 경고 메시지를 표시합니다.

## 제공 명령

`package.json`에 현재 등록된 사용자 명령은 다음 네 개입니다.

| 명령                                             | 설명                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `PocketPages: Probe Current EJS File`            | 현재 활성 파일의 path, app root 인식 여부, diagnostics 개수 확인 |
| `PocketPages: Refresh Server Script Diagnostics` | 현재 활성 문서의 PocketPages diagnostics 재계산                  |
| `PocketPages: Reload Caches`                     | 현재 앱 또는 전체 확장의 path/schema/reference cache 재적재      |
| `PocketPages: All File References`               | `_private` partial/module/static route의 호출부 목록 표시        |

또한 editor context menu에서 `.ejs`, `.js`, `.cjs`, `.mjs` 파일에 대해 `All File References`를 실행할 수 있습니다.

## 현재 검증 범위

빠른 회귀 검증은 다음 명령으로 수행합니다.

```bash
npm run sanity-check
```

`sanity-check.js`는 source/manifest 계약 검증과 fixture app 기반 회귀 검증을 함께 수행합니다. 현재 자동 검증 축은 다음과 같습니다.

- app root isolation
- `.ejs`, `.js`, `.cjs`, `.mjs` 분석
- schema-only hook script completion / diagnostics
- EJS server block / template completion / hover
- include locals inference
- resolve/include/asset/route/require navigation
- `_private` module member definition / references / rename
- `_private` file rename path rewrite
- PocketBase schema completion / diagnostics / cache recovery
- project-rule diagnostics
- quick fix
- CodeLens
- document links
- inlay hints
- EJS semantic tokens
- package/manifest 계약

## 설치와 개발

### 로컬 개발 실행

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. Extension Development Host에서 모노레포 루트를 엽니다.
5. managed `.ejs` 또는 hook script 파일을 열어 동작을 확인합니다.

### VSIX 패키징

```bash
npm run package:vsix
```

현재 패키징은 local `file:` dependency와 `--follow-symlinks`를 기준으로 bundled TypeScript plugin을 포함합니다.

### 설치

```bash
npm run install:vscode-pocketpages
```

설치 후에는 `Developer: Reload Window`를 실행해야 최신 코드가 반영됩니다.

## 비대상과 제약

이 확장은 현재 다음 역할을 목표로 하지 않습니다.

- formatter
- 일반 HTML lint 전체 대체
- UnoCSS / Tailwind 클래스 검사
- 임의 동적 문자열의 완전 해석
- 완전한 런타임 데이터 흐름 추적
- `pb_hooks/pages` 밖 hook script의 full PocketPages page analysis

추가로 현재 동작상 중요한 제약은 다음과 같습니다.

- app root를 찾지 못하는 파일은 관리 대상이 아닙니다.
- schema-only 범위는 PocketPages 전용 기능을 schema 축으로 제한합니다.
- JS/CJS/MJS 문서의 일반 hover는 기본 JS/TS 경험에 의존하고, 이 확장은 PocketPages 경로 hover를 추가합니다.
- route completion은 static `.ejs` route 중심으로 구성되며, route navigation은 더 넓은 target 타입을 해석합니다.

## 문제 확인 체크포인트

- 현재 파일이 실제로 app root 아래에 있는지
- 상위 디렉터리에서 `pb_hooks/pages`를 찾을 수 있는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `pb_schema.json`가 있는지
- 현재 파일이 EJS, `pb_hooks/pages` 스크립트, schema-only hook script 중 어느 범주인지
- vendor/minified script가 아닌지
- 기대하는 기능이 PocketPages 전용 기능인지, 아니면 기본 JS/TS 기능인지

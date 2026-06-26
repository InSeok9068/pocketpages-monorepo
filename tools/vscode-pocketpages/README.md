# VSCode PocketPages

PocketPages 모노레포 개발을 위한 VS Code 언어 확장입니다.

`.ejs` 파일과 `pb_hooks/pages` 스크립트를 일반 HTML/JavaScript 파일로만 보지 않고, PocketPages의 SSR 라우팅, `_private` partial/module, PocketBase schema, route/include/resolve/asset 문자열 연결을 하나의 app root 문맥으로 분석합니다.

이 문서는 현재 `tools/vscode-pocketpages` 코드와 `scripts/sanity-check.js`에서 검증되는 동작을 기준으로 합니다.

## 주요 기능

- EJS `<script server>`와 template code block의 completion, hover, diagnostics, navigation
- `resolve()`, `include()`, `asset()`, route path, static `require()` target 추적
- PocketBase `pb_schema.json` 기반 collection/field completion과 diagnostics
- `_private` partial/module caller 추적, references, rename, file rename rewrite
- app root 단위 cache와 VS Code watcher 기반 invalidation
- TypeScript language service 기반 JavaScript symbol 분석
- pull diagnostics, Code Actions, Document Links, Inlay Hints, Semantic Tokens, CodeLens

## 빠른 시작

```bash
npm install
npm test
```

개발 중에는 `tools/vscode-pocketpages`를 VS Code workspace로 열고 `F5`를 실행합니다. Extension Development Host에서 PocketPages 모노레포 루트를 열고 managed `.ejs` 또는 hook script 파일을 열면 LSP가 시작됩니다.

주요 명령은 Command Palette와 editor context menu에서 사용할 수 있습니다.

| 명령 | 설명 |
| --- | --- |
| `PocketPages: Inspect Current File` | 현재 파일의 app root 인식 여부와 diagnostics 개수 확인 |
| `PocketPages: Refresh Diagnostics` | 현재 문서 diagnostics 재계산 |
| `PocketPages: Reload PocketPages Cache` | 현재 앱 또는 전체 path/schema/reference cache 재적재 |
| `PocketPages: Find File References` | `_private` partial/module/static route/asset 호출부 표시 |
| `PocketPages: Explain Current File` | 현재 파일의 route, 실행 체인, 참조 요약 표시 |
| `PocketPages: Extract Selection to Partial` | 선택한 EJS template markup을 `_private` partial로 추출 |
| `PocketPages: Copy Debug Bundle` | 현재 파일 진단 정보와 최근 로그를 debug bundle로 복사 |

## 지원 파일 범위

확장은 다음 조건에서 활성화됩니다.

- `onLanguage:ejs`
- workspace 안에 `pocketpages-globals.d.ts`가 있음

PocketPages 전용 분석은 app root를 찾을 수 있는 파일에만 적용됩니다. app root는 상위 디렉터리에서 `pb_hooks/pages`를 찾는 방식으로 결정합니다.

| 파일 범주 | 대상 | 제공 범위 |
| --- | --- | --- |
| EJS 문서 | app root 안의 `.ejs` | EJS virtual code, TypeScript 기능, PocketPages path/schema 기능, diagnostics, CodeLens |
| pages script | `pb_hooks/pages/**/*.js`, `**/*.cjs`, `**/*.mjs` | TypeScript 기능, PocketPages path/schema 기능, diagnostics, document link, CodeLens |
| schema-only hook script | `pb_hooks/**/*.js`, `**/*.cjs`, `**/*.mjs` 중 `pb_hooks/pages` 밖 파일 | PocketBase schema completion/diagnostics 중심 |

`pb_hooks/pages` 안에 있어도 route-exposed `vendor/**`, `*.min.js`, `*.min.cjs`, `*.min.mjs`는 PocketPages code index에서 제외합니다. `_private/vendor/**`는 내부 dependency로 보고 계속 인덱싱합니다.

`pb_hooks/pages/**/assets/**`는 route/include/resolve/schema 분석 대상은 아니지만 `asset('/assets/...')` target으로 사용할 수 있습니다. asset 파일 생성/삭제는 구조 변화로 처리하고, 단순 내용 변경은 app cache resync를 만들지 않습니다.

## 동작 모델

### App Root

확장은 다음 파일들을 하나의 PocketPages app root로 묶어 해석합니다.

- `apps/<service>/pb_hooks/pages`
- `apps/<service>/pb_data/types.d.ts`
- `apps/<service>/pocketpages-globals.d.ts`
- `apps/<service>/types.d.ts`
- `apps/<service>/pb_schema.json`

여러 앱이 있는 모노레포에서도 cache invalidation은 app root 단위로 제한합니다. 한 앱의 변경이 전체 workspace 분석을 불필요하게 흔들지 않게 하는 것이 기본 방향입니다.

### Source Snapshot

열린 editor 문서의 snapshot이 우선입니다.

- cache reload가 열린 문서 내용을 disk나 stale virtual code로 되돌리지 않습니다.
- 문서 변경 시 무거운 virtual code 생성을 바로 강제하지 않습니다.
- completion, hover, diagnostics 같은 실제 요청 시점에 최신 snapshot 기준으로 virtual code를 준비합니다.
- TypeScript 기능은 prepared virtual state가 현재 문서와 일치할 때만 사용합니다.

### EJS Virtual Code

EJS 문서는 그대로 TypeScript에 넣지 않고, 다음 영역으로 나눠 virtual code를 만듭니다.

- `<script server> ... </script>`
- `<% %>`, `<%= %>`, `<%- %>` template code block
- `_private/*.ejs` partial의 top-level setup 영역

각 영역은 source offset과 generated offset mapping을 갖습니다. TypeScript completion, hover, definition, references, rename은 TypeScript 의미가 있는 위치에서만 동작하고, `include('...')` 같은 PocketPages path literal은 custom feature가 우선 처리합니다.

### TypeScript와 PocketPages 보강

이 확장은 TypeScript를 대체하는 별도 타입 엔진을 목표로 하지 않습니다. 일반 JavaScript symbol, 함수 반환, 객체 property, hover, definition, rename, signature help는 가능한 한 TypeScript language service가 판단합니다.

PocketPages 확장은 TypeScript가 모르는 문맥을 TypeScript가 이해할 수 있는 형태로 보강합니다.

- EJS server/template 영역을 TypeScript가 읽을 수 있는 virtual code로 만듭니다.
- `pb_schema.json` 기반 `$app`, `Record`, `record.get()`, `record.set()` type prelude를 만듭니다.
- `resolve('...')` target module type을 TypeScript에 알려줍니다.
- TypeScript 결과를 source/generated mapping으로 원본 위치에 되돌립니다.

TypeScript가 알 수 없는 PocketPages 도메인 문자열은 custom feature가 처리합니다.

- `resolve('...')`, `include('...')`, `asset('...')`
- route string: `href`, `action`, `hx-*`, `redirect`
- collection name literal
- `record.get('field')`, `record.set('field', value)` field literal
- `record.set('field+', value)`, `record.set('field-', value)`, `record.set('field:autogenerate', value)` modifier field literal
- `$app.findRecordsByFilter('collection', 'field = ...')` filter field literal
- `$app.findRecordsByFilter('collection', '...', '-field,+other')` sort field literal

## 제공 기능

### EJS

| 기능 | 설명 |
| --- | --- |
| Completion | server block, template block, schema context, include locals, route/include/resolve/asset path |
| Hover | TypeScript quick info, PocketPages path/schema hover |
| Definition | TypeScript symbol, route/include/resolve/asset/require target |
| References | TypeScript references, route/include/resolve/static require caller 추적 |
| Rename | TypeScript rename, `_private` module member rename, asset/path rename |
| Signature Help | TypeScript signature help, `include()` custom signature help |
| Diagnostics | TypeScript diagnostics, schema diagnostics, project-rule diagnostics |
| Code Actions | unresolved path fix, `_private` prefix 제거, include locals 보정 |
| Semantic Tokens | EJS code block 내부 token |
| CodeLens | template boundary, route label, include target, lazy caller references |

EJS block 끝 위치는 사용자가 커서를 자주 멈추는 위치이므로 terminal end 위치를 TypeScript ownership으로 인정합니다. 같은 offset에서 다음 segment가 시작하는 내부 경계는 허용하지 않아 path literal이나 custom 영역을 오염시키지 않습니다.

빈 `<script server></script>`도 zero-length mapping을 갖기 때문에, block 안이 비어 있어도 completion ownership을 가질 수 있습니다.

### JavaScript/CJS/MJS

`pb_hooks/pages` 아래의 `.js`, `.cjs`, `.mjs` 파일은 PocketPages pages script로 분석합니다.

| 기능 | 설명 |
| --- | --- |
| Completion | TypeScript completion, schema completion, path completion |
| Definition | TypeScript symbol, route/include/resolve/asset/require target |
| References | TypeScript references, `_private`/route/static require caller 추적 |
| Rename | TypeScript rename, `_private` module member rename, path rename |
| Signature Help | TypeScript signature help, `include()` signature help |
| Diagnostics | TypeScript diagnostics, schema diagnostics, PocketPages project-rule diagnostics |
| Document Links | route/include/resolve/asset/require target link |
| Inlay Hints | TypeScript 기반 inlay hints |
| CodeLens | route label, include target, lazy caller references |

일반 JavaScript hover는 VS Code의 기본 JS/TS 경험에 맡기고, 이 확장은 PocketPages path hover를 추가합니다.

### Schema-Only Hook Script

`pb_hooks/pages` 밖의 hook script는 PocketPages page model로 보지 않습니다. 대신 PocketBase schema 보조 기능만 제공합니다.

지원하는 기능:

- collection name completion
- `record.get('field')`, `record.set('field', value)` field completion
- unknown collection diagnostics
- unknown field diagnostics
- static `require()` path definition/document link/references
- hook script file rename edit for supported static require forms

제공하지 않는 기능:

- `resolve()` / `include()` / `asset()` path 기능
- route target navigation
- non-`require()` document links
- `resolve()` / `include()` 기반 `_private` references / rename
- `include()` custom signature help
- page/middleware 전용 project-rule diagnostics

## Path 인텔리전스

확장은 다음 문자열 패턴을 PocketPages target으로 해석합니다.

| 패턴 | target |
| --- | --- |
| `resolve('...')`, `api.resolve('...')` | `_private` module |
| `include('...')`, `api.include('...')` | `_private` partial |
| `asset('...')` | local/global asset |
| `redirect('/path')`, `api.redirect('/path')` | route |
| `datastar.redirect('/path')`, `datastar.replaceURL('/path')` | route |
| `href="/path"` | route, static asset fallback |
| `action="/path"` | route, `method` 기준 GET/POST 우선순위 적용 |
| `hx-get`, `hx-post`, `hx-put`, `hx-patch`, `hx-delete`, `data-hx-*` | route |
| `@get('/path')`, `@post('/path')`, `@put('/path')`, `@patch('/path')`, `@delete('/path')` in `data-*` attributes | route |
| `require('...')` | static require target |
| ``require(`${__hooks}/...`)`` | hooks-root require target |
| `require(__hooks + '/...')` | hooks-root require target |

제공하는 동작:

- path completion
- target definition
- target hover
- document link
- references
- rename
- unresolved path diagnostics
- suggested replacement quick fix

동적 문자열 조합은 안정적으로 정적 해석할 수 있는 범위에서만 지원합니다. 완전히 런타임 의존적인 문자열은 false positive를 줄이기 위해 강하게 추론하지 않습니다.

## `_private` 해석

`_private`는 route-exposed target이 아니라 내부 target입니다.

규칙:

- 현재 파일 기준 nearest `_private`를 우선 탐색합니다.
- 필요하면 상위 디렉터리의 `_private`까지 탐색합니다.
- `resolve('roles/board')`처럼 grouped path를 지원합니다.
- `resolve('/_private/...')`, `resolve('_private/...')`는 허용 패턴이 아니며 diagnostics 대상입니다.
- `_private` 내부에서 request-context `resolve()` chaining을 기본 패턴으로 보지 않습니다.

제공 기능:

- `_private/*.ejs` partial target resolution
- `_private/*.js|cjs|mjs|json` module target resolution
- resolved module member completion, definition, references, rename
- static require tracking
- partial caller tracking
- `_private` 파일 rename 시 include/resolve/require 호출부 rewrite

`include(path, locals)` 호출부의 locals 객체와 target partial 내부 사용 흔적을 비교합니다.

- target partial이 사용하는 local 누락
- 호출부 locals에 target partial이 쓰지 않는 key 존재
- full context 전달 금지 패턴

## PocketBase Schema

schema 기능은 `pb_schema.json`을 기준으로 동작합니다.

제공 기능:

- collection name completion
- record field completion
- static filter/sort string field completion
- collection/field schema hover
- unknown collection diagnostics
- unknown field diagnostics
- unknown collection/field suggested replacement quick fix
- `$app.findRecordsByFilter()` / `$app.findFirstRecordByFilter()` 정적 filter 문자열 field diagnostics
- `$app.findRecordsByFilter()` 정적 sort 문자열 field diagnostics
- field type 기반 documentation
- app root별 schema isolation
- invalid schema 이후 last-known-good fallback
- schema 복구 후 cache recovery

collection method 이름은 가능한 경우 `pb_data/types.d.ts`에서 추출합니다. 추출에 실패하면 내장 기본 method 목록을 사용합니다.

schema 타입은 custom 기능만을 위한 별도 세계가 아니라 TypeScript prelude에도 반영됩니다.

- `$app.findRecordById('books', ...)`, `$app.findFirstRecordByFilter('books', ...)` 같은 단일 record 조회는 `PocketPagesRecord<"books">`로 연결합니다.
- `$app.findRecordsByFilter('books', ...)` 같은 목록 조회는 `PocketPagesRecordArray<"books">`로 연결합니다.
- `record.get('field')`, `record.set('field', value)`는 collection별 field type을 TypeScript가 볼 수 있도록 overload를 만듭니다.
- `record.set('field+', value)`, `record.set('field-', value)`, `record.set('field:autogenerate', value)`는 modifier를 제외한 base field 기준으로 schema diagnostics/hover/completion을 적용합니다.
- `$app.findRecordsByFilter('books', 'sta')`, `$app.findRecordsByFilter('books', '', '-cre')`처럼 정적 filter/sort 문자열의 field 위치에서는 해당 collection field completion을 제공합니다.
- collection/field 문자열 completion과 hover는 schema field type, TypeScript type, select values, relation target 같은 핵심 schema 정보를 보여줍니다.
- collection 문자열 hover는 collection field 목록을 간단한 markdown table로 보여줍니다.
- `$app.findRecordsByFilter('books', 'title ~ {:q}')`처럼 collection과 filter 문자열이 정적으로 확인되는 경우 filter의 왼쪽 field operand를 schema field로 검사합니다.
- filter 문자열 안의 string literal과 `//` comment는 field 후보에서 제외합니다. 동적 filter 문자열, 복잡한 helper 조합, confidence가 낮은 collection 추론은 false positive를 줄이기 위해 진단하지 않습니다.
- `$app.findRecordsByFilter('books', 'status = "published"', '-created,+title')`처럼 collection과 sort 문자열이 정적으로 확인되는 경우 sort field를 schema field로 검사합니다. `@random`, nested path, 동적 sort 문자열은 오탐을 줄이기 위해 진단하지 않습니다.
- index report의 `schemaUsage.fields`와 `impactByFile.schemaFields`도 record/filter/sort field usage를 구분해 보여줍니다.
- unknown collection/field diagnostics는 schema의 비슷한 이름이 있으면 `Replace with ...` quick fix를 제공합니다.
- schema method receiver가 `$app`이 아니어도 TypeScript가 `pocketbase.PocketBase` 또는 `core.App`로 확인할 수 있으면 같은 collection/filter/sort diagnostics와 collection completion을 적용합니다.
- `resolve('service')` target module의 export 함수가 직접 `$app.find...()` 결과를 반환하면, 명시 JSDoc이 없는 경우 호출부에서도 schema return type을 사용할 수 있게 보강합니다.
- 함수에 명시적인 JSDoc return type이 있으면 schema inference보다 그 타입을 우선합니다.

이 추론은 false positive를 줄이기 위해 정적으로 확인 가능한 패턴에만 적용합니다. 완전히 동적인 collection name, 런타임 문자열 조합, 복잡한 helper alias는 강하게 추론하지 않습니다.

## Diagnostics

PocketPages 전용 diagnostics는 `pp-*` 코드로 표시됩니다.

| 코드 | 의미 |
| --- | --- |
| `pp-unresolved-resolve-path` | `resolve()` target을 찾지 못함 |
| `pp-unresolved-include-path` | `include()` target을 찾지 못함 |
| `pp-unresolved-asset-path` | `asset()` target을 찾지 못함 |
| `pp-unresolved-route-path` | route target을 찾지 못함 |
| `pp-resolve-private-prefix` | `resolve()`에 `_private` prefix를 직접 적음 |
| `pp-manual-flash-query` | URL에 `__flash`를 직접 붙임 |
| `pp-query-via-params` | query 값을 `params`로 읽으려는 패턴 |
| `pp-schema-collection` | unknown PocketBase collection |
| `pp-schema-field` | unknown PocketBase field, 지원되는 정적 filter/sort field operand 포함 |
| `pp-redirect-missing-return` | `redirect()` 이후 `return` 누락 |
| `pp-middleware-next-bare-return` | `+middleware.js`에서 bare `return` 사용 |
| `pp-middleware-next-empty-return` | `+middleware.js`에서 `return {}` 사용 |
| `pp-middleware-next-missing-call` | `+middleware.js`에서 `next()` 호출 누락 |
| `pp-partial-full-context` | partial include에 full context를 넘기는 패턴 |
| `pp-private-resolve` | `_private` 내부에서 허용되지 않는 `resolve()` 사용 |
| `pp-include-unknown-local` | include locals에 알 수 없는 key 사용 |
| `pp-include-missing-local` | include locals에서 필요한 key 누락 |

이외에도 다음 진단이 함께 표시될 수 있습니다.

- EJS server/template 영역의 TypeScript diagnostics
- inline client `<script>` parse diagnostics
- JavaScript/CJS/MJS 문서의 TypeScript diagnostics

대표 Code Actions:

- unresolved path에 대한 suggested replacement
- `resolve()`의 `_private` prefix 제거
- include local key rename suggestion
- missing include local 보정
- `let record = null`, `let records = []` 이후 명확한 `$app.find...()` 대입이 있는 경우의 optional JSDoc type 보강

JSDoc type 보강은 Problems 패널에 진단을 만들지 않는 contextual quick fix입니다. JavaScript/JSDoc 한계 때문에 TypeScript 타입 연결이 끊긴 경우 사용자가 선택할 수 있는 탈출구이며, 코드를 자동으로 타입 주석 중심으로 바꾸지는 않습니다.

## Cache와 Invalidation

### 열린 문서

열린 문서의 최신 editor snapshot이 우선입니다. 문서 변경은 LSP document sync로 반영하고, completion cache와 prepared virtual state는 최신 문서 버전에 맞춰 다시 준비합니다.

### 디스크 파일 변경

LSP 경로는 VS Code watcher 이벤트를 받아 app root 단위 cache를 무효화합니다.

- create/delete 이벤트는 route/include/resolve/asset 구조 cache를 비웁니다.
- change 이벤트는 주로 내용 cache와 TypeScript/static file state를 비웁니다.
- 열린 문서의 내용 변경은 watcher가 아니라 editor snapshot으로 처리합니다.
- watcher 이벤트가 누락된 것으로 의심되면 `PocketPages: Reload PocketPages Cache` 명령으로 현재 앱 또는 전체 cache를 다시 적재할 수 있습니다.

TypeScript plugin 경로는 별도로 watcher를 dirty hint로 사용하고, tracked file scan/stat fallback으로 `.ejs` 문서 목록과 관련 app 파일 변경을 다시 확인합니다. LSP project index 자체가 모든 watcher 누락을 주기적으로 재스캔하는 구조는 아닙니다.

### Completion Cache

completion cache는 document version, offset, trigger context를 기준으로 제한적으로 재사용합니다. incomplete completion의 가까운 재요청만 재사용하고, reload/lifecycle 변화에서는 지웁니다.

## 큰 EJS 파일 정책

큰 EJS 파일에서는 사용자가 체감하는 입력 지연을 줄이기 위한 예외 정책이 있습니다.

현재 기준:

- 큰 문서 기준: 50,000자 이상
- 수정 직후 diagnostics quiet delay: 3초
- large document semantic region budget: 2개 region

큰 EJS에서 quote trigger completion은 TypeScript fallback을 생략할 수 있습니다. 이 예외는 `"` 또는 `'` trigger에만 적용됩니다. route/include/resolve/asset/schema 같은 custom completion은 먼저 시도하고, dot/member completion은 유지합니다.

큰 EJS 문서를 수정한 직후에는 무거운 semantic diagnostics를 바로 실행하지 않고 refresh를 예약합니다.

- 이전 결과가 있으면 이전 결과를 유지합니다.
- 이전 결과가 없으면 임시 빈 결과를 줄 수 있습니다.
- 임시 빈 결과는 final cache로 고정하지 않습니다.
- quiet delay 이후 다시 diagnostics를 계산합니다.

cached region diagnostics가 있으면 현재 커서 주변과 일부 region을 우선 계산하고, 나머지는 refresh로 미룹니다. 이 정책은 틀린 결과를 빠르게 내는 방식이 아니라 이미 검증된 region은 재사용하고 무거운 region을 지연하는 방식입니다.

## Editor UX

### CodeLens

현재 CodeLens는 다음 정보를 표시합니다.

- route file 시작 위치의 route label
- EJS `Template` boundary label
- `include()` 호출 위치의 target 파일 label
- `_private` partial/module/static route/asset caller references 진입점

caller references CodeLens는 editor refresh 중 전체 workspace 참조 수를 미리 계산하지 않습니다. 사용자가 CodeLens를 클릭하면 `PocketPages: Find File References`와 같은 경로로 참조를 계산하고 표시합니다.

### Document Link

다음 target은 editor에서 바로 열 수 있는 document link를 제공합니다.

- route path
- include partial
- resolve module
- asset file
- static require target

### Semantic Tokens

EJS code block 내부에 semantic token을 제공합니다.

현재 token type:

- `keyword`
- `string`
- `number`
- `regexp`
- `comment`
- `operator`

### Status Bar / Output

- managed 문서를 열면 `PocketPages LSP` status bar item이 표시됩니다.
- output channel 이름은 `VSCode PocketPages`입니다.
- lifecycle, document, completion, diagnostics, cache, references, rename, command 로그를 남깁니다.

## Rename

파일 rename 시 다음 호출부를 함께 고칠 수 있습니다.

- `include('...')`
- `resolve('...')`
- static `require('...')`
- hooks-root `require(...)`
- asset path
- route path

지원 범위는 정적으로 해석 가능한 문자열입니다. 런타임 문자열 조합은 안전하게 rewrite할 수 있는 경우에만 처리합니다.

## 패키지 구성

| 위치 | 역할 |
| --- | --- |
| `packages/vscode-pocketpages` | VS Code client, status bar, output channel, command wiring, file watcher, file rename edit 적용 |
| `packages/language-server` | LSP 서버, completion/hover/definition/references/rename/diagnostics/code action/document link/inlay hint/semantic token/CodeLens 제공 |
| `packages/language-service` | PocketPages project index, schema 분석, path 해석, TypeScript bridge, diagnostics, cache/invalidation 정책 |
| `packages/language-core` | EJS parser, virtual code, source/generated mapper, snapshot 관리 |
| `packages/typescript-plugin` | `.ejs` 문서를 TypeScript server project에 연결하는 TS plugin |

## 검증

회귀 검증은 다음 명령으로 실행합니다.

```bash
npm test
```

이는 내부적으로 다음을 실행합니다.

```bash
npm run sanity-check
```

현재 sanity check가 검증하는 주요 축:

- app root isolation
- EJS server/template virtual code
- source snapshot 우선 sync
- stale virtual code reload 방지
- block end / empty block mapping
- `.js`, `.cjs`, `.mjs` script 분석
- schema-only hook script completion/diagnostics
- route/include/resolve/asset/require navigation
- include locals inference
- `_private` module member completion/definition/references/rename
- `_private` file rename rewrite
- PocketBase schema completion/diagnostics/cache recovery
- LSP watcher 기반 app cache invalidation
- TypeScript plugin tracked file create/delete 반영
- TypeScript plugin watcher dirty state와 scan fallback
- public asset content change noop
- diagnostics lane cache
- large EJS diagnostics deferral
- CodeLens
- document links
- inlay hints
- semantic tokens
- package/manifest 계약

## 패키징과 설치

### VSIX 패키징

```bash
npm run package:vsix
```

패키징은 local `file:` dependency와 `--follow-symlinks`를 기준으로 bundled TypeScript plugin을 포함합니다.

### 설치

```bash
npm run install:vscode-pocketpages
```

설치 후에는 `Developer: Reload Window`를 실행해야 최신 코드가 반영됩니다.

## 비대상과 제약

이 확장은 다음 역할을 목표로 하지 않습니다.

- formatter
- 일반 HTML lint 전체 대체
- UnoCSS / Tailwind class 검사
- TypeScript를 대체하는 별도 타입 엔진
- 임의 동적 문자열의 완전 해석
- 완전한 런타임 데이터 흐름 추적
- custom completion만으로 일반 JavaScript 타입 덮어쓰기
- `pb_hooks/pages` 밖 hook script의 full PocketPages page analysis

중요한 제약:

- app root를 찾지 못하는 파일은 PocketPages 관리 대상이 아닙니다.
- schema-only hook script는 schema 기능으로 제한됩니다.
- JS/CJS/MJS 문서의 일반 hover는 기본 JS/TS 경험에 맡기고, 확장은 PocketPages path hover를 추가합니다.
- route completion은 static `.ejs` route 중심입니다.
- route navigation은 `.ejs`, `.js`, `.cjs`, `.mjs` target을 더 넓게 해석합니다.
- public asset JS는 app graph/cache 대상은 아니지만, asset path target과 일반 editor 문서로는 열릴 수 있습니다.
- JSDoc type quick fix는 선택 사항입니다. 확장이 코드를 자동으로 타입 주석 중심으로 바꾸지는 않습니다.

## 문제 확인 체크포인트

기능이 기대대로 동작하지 않을 때는 다음을 먼저 확인합니다.

- 현재 파일이 app root 아래에 있는지
- 상위 디렉터리에서 `pb_hooks/pages`를 찾을 수 있는지
- 서비스 루트에 `pb_data/types.d.ts`, `pocketpages-globals.d.ts`, `types.d.ts`, `pb_schema.json`이 있는지
- 현재 파일이 EJS, pages script, schema-only hook script 중 어느 범주인지
- 파일이 route-exposed vendor/minified script로 제외된 것은 아닌지
- 기대하는 기능이 PocketPages 전용 기능인지, 기본 JS/TS 기능인지
- 타입 연결이 TypeScript prelude/virtual code로 가능한 패턴인지, 동적 런타임 흐름인지
- 동적 문자열이 정적 분석 가능한 형태인지
- 외부 파일 변경 뒤 path/schema 결과가 오래 stale해 보이면 `PocketPages: Reload PocketPages Cache`를 실행했는지

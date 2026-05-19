# VSCode PocketPages

PocketPages 모노레포 개발을 위한 VS Code 언어 확장입니다.

이 확장은 `.ejs` 파일과 `pb_hooks/pages` 스크립트를 일반 HTML/JavaScript 파일로만 보지 않고, PocketPages의 SSR 라우팅, `_private` partial/module, PocketBase schema, route/include/resolve/asset 문자열 연결을 하나의 앱 문맥으로 분석합니다.

문서의 기준은 현재 `tools/vscode-pocketpages` 코드베이스와 `scripts/sanity-check.js`에서 검증되는 동작입니다.

## 목표

- PocketPages 앱 개발자가 VS Code 안에서 route, partial, module, schema 연결을 바로 확인할 수 있게 합니다.
- EJS `<script server>`와 template code block에 TypeScript 기반 completion, hover, diagnostics, navigation을 제공합니다.
- `resolve()`, `include()`, `asset()`, route path, static `require()` 같은 문자열 기반 연결을 editor 기능으로 바꿉니다.
- app root 단위 cache와 watcher invalidation으로 여러 앱이 있는 모노레포에서도 한 앱의 변경이 전체를 불필요하게 흔들지 않게 합니다.
- Vue/Volar, Svelte language tools의 핵심 원칙인 source snapshot, virtual code, mapping, root-scoped invalidation 구조를 PocketPages에 맞게 적용합니다.

## 핵심 모델

확장은 다음 파일들을 하나의 PocketPages app root로 묶어 해석합니다.

- `apps/<service>/pb_hooks/pages`
- `apps/<service>/pb_data/types.d.ts`
- `apps/<service>/pocketpages-globals.d.ts`
- `apps/<service>/types.d.ts`
- `apps/<service>/pb_schema.json`

가장 중요한 불변식은 다음과 같습니다.

1. 열린 editor 문서의 snapshot이 항상 source of truth입니다.
2. EJS virtual code는 source snapshot에서 파생되는 cache입니다.
3. watcher 이벤트는 dirty hint일 뿐이고, 실제 상태 판단은 rescan, stat, script version, snapshot으로 확인합니다.
4. cache invalidation은 app root 단위로 제한합니다.
5. TypeScript 기능은 source/generated mapping으로 허용된 위치에서만 제공합니다.
6. PocketPages 전용 path/schema 기능은 TypeScript 기능보다 먼저 판단합니다.

이 구조는 Vue/Svelte language tools와 같은 방향입니다. 원본 파일을 직접 신뢰하고, generated code는 언제든 다시 만들 수 있는 파생물로 취급합니다.

### TypeScript와 PocketPages 보강 경계

이 확장은 TypeScript를 대체하는 별도 타입 엔진을 목표로 하지 않습니다. 일반 JavaScript symbol, 함수 반환, 객체 property, hover, definition, rename, signature help 같은 영역은 가능한 한 TypeScript language service가 판단합니다.

PocketPages 확장이 하는 일은 TypeScript가 원래 모르는 문맥을 TypeScript가 이해할 수 있는 형태로 번역하는 것입니다.

- EJS server/template 영역을 TypeScript가 읽을 수 있는 virtual code로 만듭니다.
- `pb_schema.json`을 기반으로 `$app`, `Record`, `record.get()`, `record.set()` 타입 prelude를 만듭니다.
- `resolve('...')` target을 찾아 해당 `_private` module type을 TypeScript에 알려줍니다.
- source/generated mapping으로 TypeScript 결과를 원본 EJS 위치로 되돌립니다.

TypeScript가 알 수 없는 PocketPages 도메인 문자열은 custom feature가 처리합니다.

- `resolve('...')`, `include('...')`, `asset('...')`
- route string (`href`, `action`, `hx-*`, `redirect`)
- collection name literal
- `record.get('field')`, `record.set('field', value)`의 field literal

일반 변수나 module member 타입을 custom completion만으로 덮어쓰는 방식은 피합니다. 타입을 더 잘 연결해야 할 때는 가능한 한 virtual code/prelude를 보강해서 TypeScript가 같은 타입 정보를 보게 하는 방향을 우선합니다.

## 패키지 구성

| 위치 | 역할 |
| --- | --- |
| `packages/vscode-pocketpages` | VS Code client, status bar, output channel, command wiring, file watcher, file rename edit 적용 |
| `packages/language-server` | LSP 서버, completion/hover/definition/references/rename/diagnostics/code action/document link/inlay hint/semantic token/CodeLens 제공 |
| `packages/language-service` | PocketPages project index, schema 분석, path 해석, TypeScript bridge, diagnostics, cache/invalidation 정책 |
| `packages/language-core` | EJS parser, virtual code, source/generated mapper, snapshot 관리 |
| `packages/typescript-plugin` | `.ejs` 문서를 TypeScript server project에 연결하는 TS plugin |

## 활성화와 파일 범위

확장은 다음 조건에서 활성화됩니다.

- `onLanguage:ejs`
- workspace 안에 `pocketpages-globals.d.ts`가 있음

실제 PocketPages 전용 분석은 app root를 찾을 수 있는 파일에만 적용됩니다. app root는 상위 디렉터리에서 `pb_hooks/pages`를 찾는 방식으로 결정합니다.

| 파일 범주 | 대상 | 제공 범위 |
| --- | --- | --- |
| EJS 문서 | app root 안의 `.ejs` | EJS virtual code, TypeScript 기능, PocketPages path/schema 기능, diagnostics, CodeLens |
| pages script | `pb_hooks/pages/**/*.js`, `**/*.cjs`, `**/*.mjs` | TypeScript 기능, PocketPages path/schema 기능, diagnostics, document link, CodeLens |
| schema-only hook script | `pb_hooks/**/*.js`, `**/*.cjs`, `**/*.mjs` 중 `pb_hooks/pages` 밖 파일 | PocketBase schema completion/diagnostics 중심 |

### 제외되는 script

`pb_hooks/pages` 안에 있어도 다음 파일은 PocketPages code index에서 제외합니다.

- route-exposed `vendor/**`
- `*.min.js`
- `*.min.cjs`
- `*.min.mjs`

`_private/vendor/**`는 route-exposed client script가 아니라 내부 dependency로 볼 수 있으므로 계속 인덱싱합니다.

### public asset

`pb_hooks/pages/**/assets/**`는 route/include/resolve/schema 분석 대상이 아닙니다.

- asset 파일 생성/삭제는 구조 변화로 보고 cache를 갱신할 수 있습니다.
- asset 파일의 단순 내용 변경은 app cache resync를 만들지 않습니다.
- `asset('/assets/...')` 호출부의 completion, definition, hover, reference, rename 대상이 될 수 있습니다.

## EJS 지원

EJS 문서는 그대로 TypeScript에 넣지 않고, 다음 영역으로 나눠 virtual code를 만듭니다.

- `<script server> ... </script>`
- `<% %>`, `<%= %>`, `<%- %>` 같은 template code block
- `_private/*.ejs` partial의 top-level setup 영역

각 영역은 source offset과 generated offset mapping을 갖습니다. 그래서 completion, hover, definition, references, rename은 실제로 TypeScript 의미가 있는 위치에서만 동작하고, `include('...')` 같은 path literal은 PocketPages custom feature가 우선 처리합니다.

### EJS 기능

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
| CodeLens | template boundary, route label, include target, caller count, all references |

### EJS mapping 예외

EJS block 끝 위치는 실제 사용자가 커서를 자주 멈추는 위치입니다. 이 확장은 terminal end 위치를 TypeScript ownership으로 인정합니다. 단, 같은 offset에서 다음 segment가 시작하는 내부 경계는 허용하지 않아 path literal이나 다른 custom 영역을 오염시키지 않습니다.

빈 `<script server></script>`도 zero-length mapping을 갖기 때문에, block 안이 비어 있어도 completion ownership을 가질 수 있습니다.

## JavaScript/CJS/MJS 지원

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
| CodeLens | route label, include target, caller count, all references |

일반 JavaScript hover는 VS Code의 기본 JS/TS 경험에 맡기고, 이 확장은 PocketPages path hover를 추가합니다.

## Schema-only hook script

`pb_hooks/pages` 밖의 hook script는 PocketPages page model로 보지 않습니다. 대신 PocketBase schema 보조 기능만 제공합니다.

지원하는 기능은 다음과 같습니다.

- collection name completion
- `record.get('field')`, `record.set('field', value)` field completion
- unknown collection diagnostics
- unknown field diagnostics

의도적으로 제공하지 않는 기능은 다음과 같습니다.

- `resolve()` / `include()` / `asset()` path 기능
- route target navigation
- document links
- `_private` references / rename
- `include()` custom signature help
- page/middleware 전용 project-rule diagnostics

## Path 인텔리전스

확장은 다음 문자열 패턴을 PocketPages target으로 해석합니다.

| 패턴 | target |
| --- | --- |
| `resolve('...')` | `_private` module |
| `include('...')` | `_private` partial |
| `asset('...')` | local/global asset |
| `redirect('/path')` | route |
| `href="/path"` | route |
| `action="/path"` | route |
| `hx-get`, `hx-post`, `hx-put`, `hx-patch`, `hx-delete` | route |
| `require('...')` | static require target |
| ``require(`${__hooks}/...`)`` | hooks-root require target |
| `require(__hooks + '/...')` | hooks-root require target |

제공하는 동작은 다음과 같습니다.

- path completion
- target definition
- target hover
- document link
- references
- rename
- unresolved path diagnostics
- suggested replacement quick fix

동적 문자열 조합은 안정적으로 정적 해석할 수 있는 범위에서만 지원합니다. 완전히 런타임 의존적인 문자열은 false positive를 피하기 위해 강하게 추론하지 않습니다.

## `_private` 해석

`_private`는 route-exposed target이 아니라 내부 target입니다.

### 규칙

- 현재 파일 기준 nearest `_private`를 우선 탐색합니다.
- 필요하면 상위 디렉터리의 `_private`까지 탐색합니다.
- `resolve('roles/board')`처럼 grouped path를 지원합니다.
- `resolve('/_private/...')`, `resolve('_private/...')`는 허용 패턴이 아니며 diagnostics 대상입니다.
- `_private` 내부에서 request-context `resolve()` chaining을 기본 패턴으로 보지 않습니다.

### 제공 기능

- `_private/*.ejs` partial target resolution
- `_private/*.js|cjs|mjs|json` module target resolution
- resolved module member completion
- resolved module member definition
- resolved module member references
- resolved module member rename
- static require tracking
- partial caller tracking
- `_private` 파일 rename 시 include/resolve/require 호출부 rewrite

### Include locals

`include(path, locals)` 호출부의 locals 객체와 target partial 내부 사용 흔적을 비교합니다.

검사 대상은 다음과 같습니다.

- target partial이 사용하는 local 누락
- 호출부 locals에 target partial이 쓰지 않는 key 존재
- full context 전달 금지 패턴

## PocketBase Schema 인텔리전스

schema 기능은 `pb_schema.json`을 기준으로 동작합니다.

제공 기능은 다음과 같습니다.

- collection name completion
- record field completion
- unknown collection diagnostics
- unknown field diagnostics
- field type 기반 documentation
- app root별 schema isolation
- invalid schema 이후 last-known-good fallback
- schema 복구 후 cache recovery

collection method 이름은 가능한 경우 `pb_data/types.d.ts`에서 추출합니다. 추출에 실패하면 내장 기본 method 목록을 사용합니다.

### Schema 타입 연결

schema 타입은 custom 기능만을 위한 별도 세계가 아니라 TypeScript prelude에도 반영됩니다.

- `$app.findRecordById('books', ...)`, `$app.findFirstRecordByFilter('books', ...)` 같은 단일 record 조회는 `PocketPagesRecord<"books">`로 연결합니다.
- `$app.findRecordsByFilter('books', ...)` 같은 목록 조회는 `PocketPagesRecordArray<"books">`로 연결합니다.
- `record.get('field')`, `record.set('field', value)`는 collection별 field type을 TypeScript가 볼 수 있도록 overload를 만듭니다.
- `resolve('service')` target module의 export 함수가 직접 `$app.find...()` 결과를 반환하면, 명시 JSDoc이 없는 경우 호출부에서도 schema return type을 사용할 수 있게 보강합니다.
- 함수에 명시적인 JSDoc return type이 있으면 schema inference보다 그 타입을 우선합니다.

이 추론은 false positive를 줄이기 위해 정적으로 확인 가능한 패턴에만 적용합니다. 완전히 동적인 collection name, 런타임 문자열 조합, 복잡한 helper alias는 강하게 추론하지 않습니다.

기본 method 목록은 다음과 같습니다.

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
| `pp-schema-field` | unknown PocketBase field |
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

## Code Actions

모든 diagnostics가 quick fix를 갖는 것은 아닙니다.

현재 대표 quick fix는 다음과 같습니다.

- unresolved path에 대한 suggested replacement
- `resolve()`의 `_private` prefix 제거
- include local key rename suggestion
- missing include local 보정
- `let record = null`, `let records = []` 이후 명확한 `$app.find...()` 대입이 있는 경우의 optional JSDoc type 보강

JSDoc type 보강은 Problems 패널에 진단을 만들지 않는 contextual quick fix입니다. JavaScript/JSDoc 한계 때문에 TypeScript 타입 연결이 끊긴 경우에 사용자가 선택할 수 있는 탈출구이며, 코드에 자동으로 삽입하지 않습니다.

## Cache와 Invalidation 정책

이 확장은 빠른 응답보다 source truth를 지키는 것을 우선합니다. cache는 성능을 위해 쓰지만, source snapshot을 대체하지 않습니다.

### Source snapshot

열린 문서의 최신 editor snapshot이 항상 우선입니다.

- cache reload가 열린 문서 내용을 disk나 stale virtual code로 되돌리지 않습니다.
- virtual code가 stale이면 최신 source snapshot 기준으로 다시 생성합니다.
- service document override도 source snapshot 텍스트를 기준으로 sync합니다.

### Virtual code

EJS virtual code는 필요할 때 준비합니다.

- 문서 변경 시 무조건 무거운 virtual code를 만들지 않습니다.
- completion, hover, diagnostics 등 실제 요청 시점에 최신 snapshot 기준으로 prepare합니다.
- TypeScript feature는 prepared virtual state가 현재 문서와 일치할 때만 사용합니다.

### Watcher

watcher는 직접 truth를 결정하지 않습니다.

1. 파일 이벤트가 오면 app root dirty generation을 올립니다.
2. 다음 요청에서 project version이 같더라도 dirty generation이 바뀌었으면 tracked file list를 다시 봅니다.
3. 실제 변경 여부는 rescan, stat, script version으로 확인합니다.
4. watcher가 누락돼도 scan interval fallback으로 다시 확인합니다.

이 구조는 Svelte language tools의 watcher 철학과 비슷합니다. watcher는 "바뀌었을 수 있음" 신호이고, 실제 판단은 파일 시스템과 snapshot이 합니다.

### Public asset

`pb_hooks/pages/**/assets/**` 내용 변경은 route/include/resolve/schema 의미를 바꾸지 않으므로 app cache resync를 만들지 않습니다. 생성/삭제는 asset target 목록을 바꾸므로 구조 변경으로 처리합니다.

### Completion cache

completion cache는 document version, offset, trigger context를 기준으로 제한적으로 재사용합니다. incomplete completion의 가까운 재요청만 재사용하고, reload/lifecycle 변화에서는 지웁니다.

## 큰 EJS 파일 정책

큰 EJS 파일에서는 사용자가 체감하는 입력 지연을 줄이기 위한 예외 정책이 있습니다.

현재 기준은 다음과 같습니다.

- 큰 문서 기준: 50,000자 이상
- 수정 직후 diagnostics quiet delay: 3초
- large document semantic region budget: 2개 region

### Completion

큰 EJS에서 quote trigger completion은 TypeScript fallback을 생략할 수 있습니다. 이 예외는 `"` 또는 `'` trigger에만 적용됩니다.

- route/include/resolve/asset/schema 같은 custom completion은 먼저 시도합니다.
- dot/member completion은 유지합니다.
- quote trigger에서 TypeScript가 과도하게 많은 후보를 만드는 비용만 줄입니다.

### Diagnostics

큰 EJS 문서를 수정한 직후에는 무거운 semantic diagnostics를 바로 실행하지 않고 refresh를 예약합니다.

- 이전 결과가 있으면 이전 결과를 유지합니다.
- 이전 결과가 없으면 임시 빈 결과를 줄 수 있습니다.
- 임시 빈 결과는 final cache로 고정하지 않습니다.
- quiet delay 이후 다시 diagnostics를 계산합니다.

### Semantic budget

큰 EJS에서 cached region diagnostics가 있으면, 현재 커서 주변과 일부 region을 우선 계산하고 나머지는 refresh로 미룹니다.

이 정책은 "틀린 결과를 빠르게 내기"가 아니라 "이미 검증된 region은 재사용하고, 무거운 region은 지연"하는 방식입니다.

## Editor UX

### CodeLens

현재 CodeLens는 다음 정보를 표시합니다.

- route file 시작 위치의 route label
- EJS `Template` boundary label
- `include()` 호출 위치의 target 파일 label
- `_private` partial/module/static route의 caller 수
- `All File References (N)` 진입점

### Document Link

다음 target은 editor에서 바로 열 수 있는 document link를 제공합니다.

- route path
- include partial
- resolve module
- asset file
- static require target

### Semantic Tokens

EJS code block 내부에 semantic token을 제공합니다.

현재 token type은 다음과 같습니다.

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

## 명령

| 명령 | 설명 |
| --- | --- |
| `PocketPages: Inspect Current File` | 현재 파일의 path, app root 인식 여부, diagnostics 개수 확인 |
| `PocketPages: Refresh Diagnostics` | 현재 문서의 diagnostics 재계산 |
| `PocketPages: Reload PocketPages Cache` | 현재 앱 또는 전체 확장의 path/schema/reference cache 재적재 |
| `PocketPages: Find File References` | `_private` partial/module/static route/asset의 호출부 목록 표시 |
| `PocketPages: Explain Current File` | 현재 파일의 route, 실행 체인, 참조 요약 표시 |
| `PocketPages: Extract Selection to Partial` | 선택한 EJS template markup을 `_private` partial로 추출 |
| `PocketPages: Copy Debug Bundle` | 현재 파일 진단 정보와 최근 로그를 debug bundle로 복사 |

editor context menu에서도 `.ejs`, `.js`, `.cjs`, `.mjs` 파일에 대해 `Find File References`를 실행할 수 있습니다.

## All File References

`All File References`는 다음 target에 대해 호출부를 모아 보여줍니다.

- `_private` partial
- `_private` module
- static route file
- asset file

지원하지 않는 target에서 실행하면 경고 메시지를 표시합니다.

## Rename 지원

파일 rename 시 다음 호출부를 함께 고칠 수 있습니다.

- `include('...')`
- `resolve('...')`
- static `require('...')`
- hooks-root `require(...)`
- asset path
- route path

지원 범위는 정적으로 해석 가능한 문자열입니다. 런타임 문자열 조합은 안전하게 rewrite할 수 있는 경우에만 처리합니다.

## 검증

회귀 검증은 다음 명령으로 실행합니다.

```bash
npm test
```

이는 내부적으로 다음을 실행합니다.

```bash
npm run sanity-check
```

현재 sanity check가 검증하는 주요 축은 다음과 같습니다.

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
- watcher dirty generation
- tracked file create/delete 반영
- watcher 누락 fallback scan
- public asset content change noop
- diagnostics lane cache
- large EJS diagnostics deferral
- CodeLens
- document links
- inlay hints
- semantic tokens
- package/manifest 계약

## 설치와 개발

### 로컬 개발

1. `tools/vscode-pocketpages`를 VS Code 워크스페이스로 엽니다.
2. `npm install`
3. `F5`
4. Extension Development Host에서 모노레포 루트를 엽니다.
5. managed `.ejs` 또는 hook script 파일을 열어 동작을 확인합니다.

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
- custom completion만으로 일반 JavaScript 타입을 덮어쓰기
- `pb_hooks/pages` 밖 hook script의 full PocketPages page analysis

중요한 제약은 다음과 같습니다.

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

## 설계 요약

이 확장은 PocketPages의 파일 기반 SSR 구조에 맞춰 얇은 virtual layer를 둡니다.

Vue/Volar처럼 source snapshot과 embedded code mapping을 사용하고, Svelte처럼 watcher를 dirty hint로 쓰며 실제 파일 목록은 다시 읽어 확인합니다. 하지만 Vue/Svelte의 일반화된 component model을 그대로 복제하지는 않습니다. PocketPages에 필요한 app root, EJS server/template block, `_private`, route graph, schema graph 중심으로 범위를 좁혀 유지보수성과 예측 가능성을 우선합니다.

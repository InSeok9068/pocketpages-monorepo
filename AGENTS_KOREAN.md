# AGENTS_KOREAN.md

## 0. 원칙

- 추상화보다 명시적인 구조를 우선한다
- 파일 경로만 봐도 흐름이 읽혀야 한다
- 로직은 사용하는 곳 가까이에 둔다
- SPA 복잡성보다 SSR 중심의 예측 가능한 구조를 우선한다
- MUST = 항상 따라야 함
- DEFAULT = 특별한 이유가 없으면 먼저 선택
- EXCEPTION = 명확한 근거가 있을 때만 허용

---

## 1. 스택과 구조

- 스택: PocketBase (JSVM), PocketPages (SSR, file routing), EJS, HTMX, Alpine.js, UnoCSS (Tailwind v3 compatible)
- 서비스 루트: `apps/<service>/*`
- `pb_hooks/pages` = 라우팅 루트
- `(site)` = layout이 적용되는 전체 페이지
- `xapi/*` = layout 없는 interaction
- `api/*` = data/API
- `_private/*` = internal partial, service, util, module

---

## 2. 라우팅과 Params

- filename이 URL 의미를 드러내야 한다
- `index.ejs` = 디렉터리 기본 route
- `new.ejs`, `edit.ejs`, `[slug].ejs` 같은 명시적인 이름을 우선한다
- `[param]`은 정적 경로로 의미를 충분히 드러낼 수 없을 때만 사용한다
- `params` = route params 전용
- query = `request.url.query`
- EXCEPTION: `params.__flash`만 허용

---

## 3. Page / Middleware / Load

- `+load.js`는 page level에서 한 번 실행된다
- `+middleware.js`는 계층적으로 실행된다
- DEFAULT: page 전용 data나 meta는 page `<script server>`에 둔다
- DEFAULT: 여러 하위 route에서 공유하는 로직은 `+middleware.js`에 둔다
- DEFAULT: 구조적으로 필요하지 않으면 `+load.js`는 피한다
- MUST: page 전용 로직은 page에 둔다
- MUST: 여러 route가 공유하는 로직은 middleware로 올린다
- MUST: middleware가 early return 하면 응답을 명시적으로 보낸다

---

## 4. 렌더링

- 공통 UI는 `+layout.ejs`
- page 전용 UI는 page 파일
- layout은 leaf page data만 본다
- template는 render에만 집중한다
- template 안에 무거운 로직이나 formatting 로직을 두지 않는다
- 허용: 단순 `if`, 단순 loop, 짧은 expression
- HTMX는 partial HTML 또는 redirect만 반환하고 layout HTML은 반환하지 않는다
- DEFAULT: 공통 마크업은 `_private` partial로 재사용한다

---

## 5. \_private 와 Resolve

- `_private`는 internal 전용이며 route로 노출하지 않는다
- partial, service, util, internal module 용도로 사용한다
- partial에는 필요한 최소 props만 넘긴다
- `request`, `response`, `api`, `resolve`, full `params`, full `data` 같은 전체 context는 넘기지 않는다
- `_private` module은 CommonJS만 사용한다
- `_private` 내부에서 `resolve()`를 기본 패턴처럼 쓰지 않는다
- 의존성은 entry에서 먼저 고르고 주입한다
- `resolve()`는 entry level에서 의존성을 고르는 용도로 먼저 사용한다
- `resolve('/_private/...')`는 사용하지 않는다
- `resolve('moduleName')`처럼 `_private` 기준 이름을 사용한다

---

## 6. Redirect, Roles, Logging

- `redirect('/path', { status, message })` 패턴을 사용한다
- flash query를 수동으로 만들지 않는다
- flash는 `params.__flash`로 읽는다
- MUST: redirect 전에 `dbg(status, redirectTo, flash or error)`로 로그를 남긴다
- role은 `_private/roles/*`에 둔다
- role은 domain logic만 담당한다
- MUST: role 안에서 DB write, redirect, response 생성, 숨은 DB query를 하지 않는다
- MUST: role 입력값은 준비된 data만 사용한다
- `dbg` = debug, `info` = normal flow, `warn` = 예상 가능한 문제, `error` = 실패
- DEFAULT: request entry, branch point, DB access, mutation, error 지점에서 로그를 남긴다
- DEFAULT: 전체 `Record` dump보다 핵심 필드만 로그로 남긴다

---

## 7. PocketBase / JSVM

- ES6만 사용한다
- sync code만 사용한다
- CommonJS만 사용한다
- `async/await`는 사용하지 않는다
- Promise 기반 흐름은 사용하지 않는다
- `pb_data/types.d.ts` = JSVM runtime API 기준
- `pb_schema.json` = schema 기준
- `apps/<service>/types.d.ts` = shared JSDoc shape 기준
- `record.field` 대신 `record.get('field')`를 사용한다
- relation은 실제 `collection.id`를 사용한다
- relation id를 하드코딩하지 않는다
- self relation은 생성 후 업데이트로 처리한다

---

## 8. Frontend

- Alpine은 UI helper로만 사용한다
- business logic이나 complex state를 넣지 않는다
- toggle, modal, tab, 짧은 local UI state에 사용한다

---

## 9. Code Style

- explicit > abstraction
- trace path는 짧게 유지한다
- 불필요한 helper를 만들지 않는다
- shared named shape는 `apps/<service>/types.d.ts`에 정의한다
- JSDoc에서는 `types.*`를 직접 사용한다
- local typedef bridge는 사용하지 않는다
- shared function에는 JSDoc이 필요하다
- 한글 설명은 짧게 쓴다
- 구현 설명보다 함수와 params의 역할 설명을 적는다

---

## 10. AI Workflow

- 먼저 이 작업이 PocketPages인지 PocketBase인지 구분한다
- single-file, low-impact change면 바로 파일을 연다
- multi-file change이거나 영향이 불명확하면 `./task.sh index <service>`를 실행한다
- 서비스 수정은 반드시 `./task.sh lint <service>`로 마무리한다

---

## 11. Structure Analysis

- 영향 범위가 불명확하면 `impactByFile`을 먼저 본다
- `_private/*.ejs` partial 변경 전에는 `partials`
- `_private/*.js` module 변경 전에는 `resolveGraph`
- route, redirect, `href`, `action`, `hx-*` 변경 전에는 `routeLinks`
- collection 또는 field 변경 전에는 `schemaUsage`
- route 목록이나 path 자체가 중요하면 `routes`

---

## 12. Checklist

- Before: layer가 맞는지, 책임 분리가 맞는지, routing 선택이 맞는지, schema/runtime source를 확인했는지
- After: params와 query를 구분했는지, partial에 최소 props만 넘겼는지, HTMX가 partial-or-redirect만 반환하는지, flash pattern을 썼는지, `record.get()`을 썼는지, shared function JSDoc을 추가했는지, lint를 통과했는지

---

## 13. Priority

1. `.docs/pocketpages/*`
2. `.docs/pocketbase/*`
3. `pb_schema.json`
4. `pb_data/types.d.ts`
5. `apps/<service>/types.d.ts`

규칙이 충돌하면 이 파일의 기준을 이 저장소 기본값보다 우선한다.

# AGENTS.md

이 문서는 이 저장소에서 작업하는 에이전트/개발자가 PocketPages 기반 구조를 빠르게 이해하고, 같은 기준으로 일관되게 수정하기 위한 작업 가이드입니다.

---

## 1) 프로젝트 요약

- 이 레포는 **PocketBase + PocketPages** 기반 SSR 서비스 모음입니다.
- 핵심 실행 컨텍스트는 PocketBase의 `pb_hooks` JSVM이며, PocketPages가 파일 기반 라우팅/레이아웃/렌더링을 담당합니다.
- 이 레포에서는 특히 **단순함, 명시성, 추적 가능성**을 중요하게 봅니다.

---

## 2) 기술 기준

- 플랫폼: PocketBase
- 앱 레이어: PocketPages (`require('pocketpages')`)
- 인증 헬퍼: `pocketpages-plugin-auth`
- 템플릿 엔진: EJS (`pocketpages-plugin-ejs`)
- 페이지 루트: `pb_hooks/pages`
- 클라이언트 상호작용: Alpine.js
- 서버 통신/부분 갱신: HTMX
- 리얼타임: `pocketpages-plugin-realtime`
- 스타일링: UnoCSS Runtime
- 스타일 문법 기준: TailwindCSS v3 호환 문법(Wind3 기준)
- JSVM 코드 문법 기준: ES6(ES2015) 호환 문법만 사용

---

## 3) 서비스 구조 기준 핵심 경로

- 이 레포는 `apps/*` 아래에 서비스별 디렉터리를 두는 모노레포 구조입니다.
- 각 서비스는 대체로 비슷한 PocketPages/PocketBase 구조를 따르며, 아래 경로는 `apps/sample`을 예시로 든 공통 가이드라인입니다.
- `apps/<service>/pb_hooks/pocketpages.pb.js`: PocketPages 부트스트랩 엔트리
- `apps/<service>/pb_hooks/pages/+config.js`: PocketPages 설정
- `apps/<service>/pb_hooks/pages/(site)/+layout.ejs`: 사이트 레이아웃
- `apps/<service>/pb_hooks/pages/(site)/*`: 레이아웃이 적용되는 전체 페이지
- `apps/<service>/pb_hooks/pages/api/*`: JSON/프로그래매틱 API 성격의 엔드포인트를 둘 수 있는 위치
- `apps/<service>/pb_hooks/pages/xapi/*`: layout 없는 interaction endpoint 위치
- `apps/<service>/pb_hooks/pages/_private/*`: partial, 서버 유틸, 내부 모듈
- `apps/<service>/pb_schema.json`: PocketBase 스키마 스냅샷
- `apps/<service>/pb_data/types.d.ts`: PocketBase JSVM 타입 정의
- `apps/<service>/types.d.ts`: 해당 서비스의 JSDoc 타입 네임스페이스
- `.docs/pocketpages/*`: PocketPages 문서 스냅샷
- `.docs/pocketbase/pocketbase_docs_js.md`: PocketBase JS 문서

---

## 4) 가장 중요한 작업 원칙

- PocketPages에서는 과도한 추상화보다 **파일 구조가 직접 의도를 설명하는 형태**를 우선합니다.
- 한 번만 쓰이는 로직은 억지로 공용화하지 말고, 해당 페이지 문맥 안에 명시적으로 둡니다.
- 여러 파일에서 반복되는 책임만 공용화합니다.
- 사람이든 AI든 **파일 경로만 보고 흐름을 추적할 수 있어야** 합니다.
- 이 프로젝트는 SPA식 복잡한 클라이언트 상태를 의도적으로 줄이고, 서버 주도 렌더링과 정형화된 PocketBase 패턴 안에서 문제를 다루기 쉽게 유지하는 것을 핵심 가치로 둡니다.
- 목표는 기능을 복잡하게 확장하는 것보다, AI가 빠르게 읽고 수정하고 검증할 수 있는 **예측 가능한 구조**를 유지하는 것입니다.
- 수정 전에는 항상 "이 책임이 페이지 전용인지, 여러 하위 경로에 공통인지, API 응답 전용인지"부터 구분합니다.

---

## 4-1) 규칙 해석 레벨

- `강제 규칙`: 특별한 사유가 없는 한 반드시 따릅니다. 공식 문서 예시와 달라도, 이 레포의 일관성을 위해 우선 적용합니다.
- `기본값`: 가장 먼저 선택할 기본 접근입니다. 다른 방식을 쓰려면 구조적 이유가 분명해야 합니다.
- `예외 허용`: 특정 조건에서만 허용되는 대안입니다. 사용 시 왜 예외가 필요한지 스스로 설명할 수 있어야 합니다.

---

## 5) PocketPages 레이어 작업 기준

### A. 라우팅과 파일명

#### 강제 규칙

- 파일명은 화면 역할과 URL 의미가 바로 읽히게 유지합니다.

#### 기본값

- 파일 기반 라우팅 구조를 먼저 존중합니다.
- `index.ejs`는 **디렉터리 대표 경로**일 때 우선 사용합니다.
- 하위 화면의 의미가 분명하면 `new.ejs`, `edit.ejs`, `[postSlug].ejs`처럼 파일명으로 의도를 드러냅니다.

#### 예외 허용

- 동적 라우트(`[param]`)는 정적 경로로 의도를 충분히 드러낼 수 없을 때만 도입합니다.

### A-1. `params`와 query string

- PocketPages의 파일 기반 라우팅에서는 파일/디렉터리 이름이 URL을 만들고, 대괄호로 감싼 이름이 route parameter가 됩니다.
- 예시:
  ```text
  pb_hooks/pages/
    posts/
      [postId]/
        comments/
          [commentId].ejs
  ```
- 위 구조는 `/posts/123/comments/456` 같은 URL에 매핑되고, 이때 `params.postId === '123'`, `params.commentId === '456'`처럼 **route parameter**를 읽습니다.
- query string은 파일 경로에서 만들어지는 값이 아니므로 route parameter와 구분해서 읽습니다.
- 예시:
  ```text
  /posts/123/comments/456?sort=latest&highlight=true
  ```
- 위 URL에서 `postId`, `commentId`는 route parameter이고, `sort`, `highlight`는 query string입니다.

#### 강제 규칙

- 이 레포에서는 혼동을 줄이기 위해 `params`를 **route parameter용**으로 봅니다.
- route parameter는 파일/디렉터리의 `[name]`에서 생긴 값만 `params.name`으로 읽습니다.
- query string은 `request.url.query` 체인으로 읽는 것을 기본 사용법으로 고정합니다.
- 예시: `request.url.query.sort`, `request.url.query.highlight`, `request.url.query.filters.category`

#### 예외 허용

- PocketPages `redirect(..., { message })`가 만드는 flash message는 공식 패턴에 맞춰 `params.__flash`로 읽습니다.
- `request.url.query`로 처리하기 어려운 특수한 경우에만 `new URL(request.url)` 기반의 명시적 파싱을 보조적으로 사용합니다.

### B. 페이지, 로더, 미들웨어 구분

#### 강제 규칙

- `+load.js`는 페이지 엔트리와 같은 레벨에서 **하나만 실행**된다는 점을 전제로 설계합니다.
- `+middleware.js`는 루트에서 리프까지 계층적으로 실행된다는 점을 전제로 설계합니다.
- middleware에서 PocketPages 컨텍스트 API가 필요하면 **전역 심볼로 가정하지 말고**, 함수 인자로 받은 `api`에서 꺼내 사용합니다.
- 예시: `module.exports = function ({ params, resolve, dbg }) { ... }`
- `next`를 쓰는 middleware에서 조기 종료하면 직접 응답을 보내야 한다는 점을 항상 염두에 둡니다.

#### 기본값

- 페이지 하나에서만 쓰는 데이터 준비/메타 설정은 해당 페이지 상단의 `<script server>`에 둡니다.
- 여러 하위 경로에 공통으로 필요한 데이터, 인증, 가드, 요청 검증은 `+middleware.js`로 올립니다.
- `+load.js`는 여러 템플릿에서 같은 로딩 책임을 공유하거나, `+get.js`/`+post.js` 등과 함께 구조적으로 유지할 이유가 분명할 때만 사용합니다.

#### 예외 허용

- `next`를 사용하는 middleware는 흐름 제어가 분명히 필요할 때만 사용합니다.

### C. 레이아웃

#### 강제 규칙

- 공통 `<head>`, 메타 기본값, 공통 스크립트, 공통 외형은 `+layout.ejs`에 둡니다.
- 페이지 고유 내용은 각 `*.ejs`에 둡니다.
- 레이아웃이 실제로 필요로 하는 값은 leaf 페이지 기준으로 설계합니다.
- PocketPages 레이아웃에서는 leaf 쪽 데이터만 보인다는 점을 기준으로 구조를 잡습니다.

#### 기본값

- layout 자체에서 여러 하위 페이지에 공통으로 필요한 데이터가 있다면, leaf 페이지마다 중복해서 넣지 말고 middleware로 올려서 전달하는 쪽을 우선합니다.

### D. EJS 템플릿 작성 원칙

#### 강제 규칙

- EJS 템플릿은 렌더링에 집중시키고, 화면에 필요한 값 준비는 가능한 한 상단 `<script server>`, `+load.js`, `+middleware.js`, 또는 `_private` 서버 유틸에서 끝냅니다.
- 템플릿 안에서 여러 필드를 조합한 파생값 계산, 문자열 정리, 기본값 보정, 날짜/숫자 표시값 생성 같은 전처리를 길게 작성하지 않습니다.

#### 기본값

- 템플릿 본문에서는 출력, 단순 `if`, 단순 반복, 짧은 조건부 표현 정도만 유지합니다.
- 반복문 내부에서 같은 record에 대해 여러 `const`를 연속 선언해야 하기 시작하면, 그 계산은 템플릿 밖으로 올립니다.
- HTML 구조만 봐도 화면 의도가 읽히고, 서버 로직은 위쪽 준비 단계에서 추적 가능하게 유지하는 방향을 우선합니다.

#### 예외 허용

- 한 줄로 바로 이해되는 단순 표현은 템플릿 안에 둘 수 있습니다.

### E. `_private` 사용법

#### 강제 규칙

- `_private`는 단순 partial 폴더가 아니라, **부분 템플릿 + 서버 유틸 + 내부 모듈**을 두는 위치로 사용합니다.
- 외부 라우트로 노출되면 안 되는 파일은 `_private`에 둡니다.
- partial은 `_private`에 두고 `include()`로 재사용합니다.
- partial은 렌더링에 필요한 값만 `include()` 인자로 받게 설계합니다.
- partial에 PocketPages 전체 컨텍스트(`api`, `request`, `response`, `resolve`, 통짜리 `params`, 통짜리 `data`)를 그대로 넘기지 않습니다.
- 필요한 데이터 계산, DB 조회, 분기 처리는 엔트리나 loader/middleware에서 끝내고, partial은 가능한 한 **순수하고 예측 가능한 렌더 조각**으로 유지합니다.
- PocketPages의 `include()`와 `resolve()`는 현재 요청 엔트리의 디렉터리에서 시작해 가까운 `_private`를 먼저 찾고, 없으면 상위 디렉터리로 올라가며 탐색합니다.
- `resolve()`는 `_private`를 포함한 전체 경로를 넘기는 것이 아니라 `_private` 기준 이름으로 사용합니다.
- 예시: `resolve('board-service')`, `resolve('roles/post')`
- `resolve('/_private/board-service')` 같은 형태는 `_private/_private/...`로 잘못 해석될 수 있으므로 사용하지 않습니다.
- `resolve()`는 PocketPages **요청 컨텍스트 API**이므로, `_private/*.js` 내부에서 이를 전역처럼 가정하거나 연쇄 호출하는 구조를 기본 패턴으로 두지 않습니다.

#### 기본값

- 공통 서버 로직, 쿼리 유틸, 포맷터, slug 처리 같은 로직도 `_private`에 둡니다.
- `_private` 파일은 **가까운 곳에 두고**, 더 넓게 재사용되기 시작하면 상위 디렉터리로 올립니다.
- 하위 섹션에서 상위 `_private` 파일을 override할 수 있다는 점을 감안해 파일 위치를 정합니다.
- 이 레포에서 `resolve()`의 기본 역할은 **엔트리에서 필요한 `_private` 모듈을 조립하는 것**입니다.
- 여러 page/xapi/api 엔트리에서 연결될 수 있는 service, role, formatter, query 모듈은 엔트리에서 먼저 `resolve()`로 결정합니다.
- `_private/*.js` 내부에서의 `require()`는 **이미 선택된 파일 내부의 고정 구현을 연결하는 일반 CommonJS import**로 봅니다.
- `_private` 모듈이 다른 `_private` 모듈이나 role에 의존하면, 우선 엔트리에서 먼저 `resolve()`로 불러온 뒤 함수 인자로 넘겨 **의존성 주입** 형태로 조합합니다.
- 한 번만 쓰이는 로직이면 `_private`로 빼기보다 해당 페이지 엔트리에 두는 편을 우선합니다.

#### 예외 허용

- `_private/*.js` 내부에서 `require('pocketpages')`나 일반 CommonJS import를 쓰는 것은 가능하지만, 이것으로 PocketPages의 `_private` 탐색 규칙이나 요청별 `resolve()` 문맥을 대체하려고 하지는 않습니다.

### F. HTMX와 API 응답

#### 강제 규칙

- 전체 페이지와 부분 응답은 디렉터리 차원에서 분리합니다.
- HTMX 응답은 layout 없는 raw HTML 또는 리다이렉트처럼 필요한 응답만 반환합니다.

#### 기본값

- HTMX는 전체 페이지를 다시 받지 않고 **필요한 조각만 받는 구조**를 기본값으로 삼습니다.
- layout이 적용되는 페이지는 `(site)` 아래에 둡니다.
- HTMX partial, form action, redirect, SSE, raw HTML 응답처럼 **레이아웃 없는 상호작용 엔드포인트**는 `pages/xapi/*` 아래에 둡니다.
- JSON을 반환하거나 외부/프로그래매틱 호출을 위한 **명시적인 API 엔드포인트**는 `pages/api/*` 아래에 둡니다.
- 초기 페이지 렌더와 HTMX 응답이 같은 마크업을 써야 하면 `_private` partial로 묶어 한 곳에서 관리합니다.

### G. redirect와 flash message

#### 강제 규칙

- 성공/실패 알림을 위해 `?__flash=...` 쿼리스트링을 수동으로 조립하지 않습니다.
- redirect 직전에는 `dbg()`로 `status`, `redirectTo`, `flash` 또는 `error`를 남겨 런타임 추적이 가능하게 합니다.
- flash message는 도착 페이지에서 `params.__flash`로 읽는 것을 기본값으로 삼습니다.
- `params.__flash`는 PocketPages flash 전달 규칙에 한정된 예외적 사용으로 보고, 일반 query string 접근 패턴으로 확대하지 않습니다.

#### 기본값

- 작업 완료, 생성/수정/삭제 성공, 검증 실패처럼 **사용자가 다음 화면에서 바로 알아야 하는 결과**는 PocketPages `redirect()`의 flash message 패턴을 우선 사용합니다.
- 기본 패턴은 `redirect('/target', { status: 303, message: 'Post created.' })` 형태로 작성합니다.
- 여러 페이지에서 같은 flash UI를 쓴다면 각 페이지에 같은 마크업을 반복하지 말고 `_private` partial로 분리해 `include()`로 재사용합니다.
- flash UI는 메시지 문자열만 출력하는 데서 끝내지 말고, 성공/실패 여부가 시각적으로 드러나도록 스타일 규칙도 함께 둡니다.

---

## 6) PocketBase / JSVM 작업 기준

- 이 레포에서는 대부분의 요청-응답 기반 기능을 PocketPages 안에서 처리하는 것을 기본값으로 봅니다.
- 다만 **스케줄 작업(cron/job)** 은 PocketPages가 아니라 `pb_hooks/*.pb.js` 에서 **PocketBase JS 확장 기능을 그대로 사용**하는 것을 기본 원칙으로 삼습니다.

### A. 타입과 문서 기준

#### 강제 규칙

- PocketBase JSVM을 사용하는 JS 코드는 **ES6(ES2015)와 호환되는 문법**으로만 작성합니다.
- 모든 로직은 동기식으로 작성하며, `async/await`와 Promise 기반 비동기 문법은 사용하지 않습니다.
- 모듈은 `import` / `export` 대신 CommonJS `require()` / `module.exports`만 사용합니다.
- PocketBase JSVM 코드는 반드시 해당 서비스의 `pb_data/types.d.ts`를 기준으로 가능한 API/타입만 사용합니다.
- 문서 예시와 `pb_data/types.d.ts`가 다르면 `pb_data/types.d.ts`를 우선합니다.
- 타입 정의에 없는 심볼/시그니처는 사용하지 않습니다.
- 서비스 코드에서 이름을 붙여 관리할 JSDoc 타입은 사용 범위와 무관하게 서비스 루트 `types.d.ts`에 둡니다.
- `types.d.ts`는 기본적으로 **pure ambient** 파일로 유지하고, `declare namespace types { ... }` 형태를 사용합니다.
- 해당 서비스의 JSDoc 타입은 모노레포 루트가 아니라 **반드시 `apps/<service>/types.d.ts`** 에 둡니다.
- `pb_data/types.d.ts`는 **PocketBase JSVM 런타임이 실제로 제공하는 API/전역/시그니처의 기준**이고, `types.d.ts`는 **해당 서비스가 JSDoc에서 이름 붙여 재사용하는 입력/출력/렌더링 shape의 기준**입니다.
- JS/EJS JSDoc에서 서비스 타입 네임스페이스를 쓸 때는 `types.KjcaDashboardState`처럼 **반드시 `types.*`를 직접 참조합니다.**
- 서비스 코드 안에서는 로컬 `@typedef`로 named shape를 정의하지 않습니다.
- 필요한 named type은 항상 `apps/<service>/types.d.ts`에 추가합니다.

#### 예외 허용

- JSDoc 타입 참조를 위한 `import('...')` 표현은 런타임 모듈 문법이 아니므로 사용할 수 있습니다.

### B. 스키마 확인 기준

#### 강제 규칙

- 컬렉션명, 필드명, 필드 타입, relation, 옵션, 제약 조건 확인이 필요하면 해당 서비스 루트의 `pb_schema.json`을 먼저 봅니다.

#### 기본값

- `pb_schema.json`은 전체를 무작정 펼쳐서 읽지 말고, **필요한 컬렉션명으로 필터링해서 필요한 부분만 확인**합니다.

### C. Record 접근 기준

#### 기본값

- JS/EJS에서 PocketBase `Record`를 다룰 때는 `record.fieldName` 직접 접근을 기본값으로 가정하지 않습니다.
- 우선 `record.get('fieldName')` 방식으로 읽습니다.

### D. Roles 기준

#### 강제 규칙

- 이 레포에서는 DB record 기반의 도메인 판단 로직을 `roles/*.js`에 둡니다.
- role 파일은 기본적으로 `apps/<service>/pb_hooks/pages/_private/roles/*.js` 위치에 둡니다.
- 예시: `roles/post.js`, `roles/board.js`
- role은 저장/삭제/리다이렉트/응답을 처리하지 않고, **DB 데이터와 상태를 기준으로 한 판단만** 담당합니다.
- `xapi`/`page` 호출부는 role의 `can...()`, `is...()`, `has...()`, `assert...()` 같은 결과를 보고 **명시적으로 에러를 던지거나 흐름을 제어**하며, 저장/삭제/리다이렉트/응답도 호출부가 담당합니다.
- 요청 body, params, query의 형식 검증처럼 **이번 요청의 입력 shape만 확인하는 로직**은 role로 올리지 말고 엔트리에 둡니다.
- role 안에서 숨은 DB 조회나 과도한 내부 의존성 조립은 기본 패턴으로 두지 않습니다.
- role은 해당 서비스의 `pb_schema.json`과 **항상 싱크가 맞아야 하며**, 누락되거나 달라진 필드는 `pb_schema.json` 기준으로 업데이트합니다.

#### 기본값

- 여러 엔트리에서 반복되는 **DB 기반 상태 판단, 관계 검증, 도메인 가드**만 role로 분리합니다.
- 조회와 record 준비는 엔트리나 service에서 끝내고, role은 **전달받은 record/값만으로 판단**하는 것을 기본값으로 삼습니다.
- role이 다른 role이나 공통 모듈에 의존하면, `_private` 내부에서 연쇄 `resolve()`하지 말고 엔트리에서 먼저 조립한 뒤 함수 인자로 넘겨 사용합니다.

### E. 로그와 런타임 추적

#### 강제 규칙

- 페이지 렌더 직전 데이터나 redirect 직전 응답 payload를 남길 때는 `Record` 전체 dump보다 실제 추적에 필요한 핵심 필드 요약을 우선합니다.

#### 기본값

- 서버 로직을 작성할 때는 PocketPages 전역 로그 함수 `dbg`, `info`, `warn`, `error`를 적극적으로 사용합니다.
- 런타임에서 어디서 문제가 났는지 바로 알 수 있도록 주요 단계별 로그를 명시적으로 남깁니다.
- 특히 요청 진입, 입력값 확인, 분기, DB 조회, 저장/삭제, 예외 처리 지점은 로그를 남깁니다.
- `dbg()`는 개발 추적용, `info()`는 정상 흐름 기록, `warn()`은 예상 가능한 이상 상태, `error()`는 실제 실패 기록으로 구분합니다.

### F. 마이그레이션

#### 강제 규칙

- relation 필드는 대상 컬렉션이 저장된 뒤의 실제 `collection.id`를 사용합니다.
- relation 대상 컬렉션 ID를 임의 문자열로 하드코딩하지 않습니다.
- self relation은 컬렉션 생성과 동시에 넣지 말고, 저장 후 2차 업데이트로 추가합니다.

---

## 7) 프론트엔드 기준

- 간단한 클라이언트 상호작용은 Alpine.js로 처리합니다.
- 스타일은 UnoCSS Runtime utility class 기준으로 작성합니다.
- UnoCSS Runtime은 Wind3(TailwindCSS v3 호환) 기준으로 보고 작업합니다.
- 스타일 클래스를 작성하거나 수정할 때는 **TailwindCSS v3 문법을 기본값**으로 사용합니다.
- TailwindCSS v4 전용 문법이나 UnoCSS 전용 확장 문법은 기존 코드/설정에서 명시적으로 필요하다고 확인된 경우에만 사용합니다.

---

## 8) 이 레포에서 선호하는 코드 스타일

### 기본값

- 명시적인 코드를 선호합니다.
- 짧은 추적 경로를 선호합니다.
- 불필요한 공용 헬퍼/래퍼를 지양합니다.
- 공통 책임은 middleware 또는 `_private`로 이동합니다.
- 페이지 전용 책임은 페이지 안에 유지합니다.
- 파일명만 봐도 역할이 드러나게 구성합니다.

### 강제 규칙

- 여러 곳에서 쓰이도록 함수나 로직을 따로 뺐다면 해당 함수에는 **반드시 JSDoc**을 작성합니다.
- 함수 입력/반환 타입에 이름을 붙여 관리할 필요가 있으면 `apps/<service>/types.d.ts`에 타입을 먼저 정의한 뒤 함수 JSDoc에서 재사용합니다.
- 단일 파일에서만 쓰는 타입이라도 서비스 코드에서 named shape가 필요하면 반드시 `apps/<service>/types.d.ts`에 둡니다.
- 파일 안에서 브리지용 `@typedef {types.SomeType} SomeType`는 두지 않습니다.
- 함수 JSDoc 본문에서는 `types.SomeType`를 직접 씁니다.
- JSDoc에는 함수가 하는 일과 각 파라미터의 역할을 **짧은 한글 설명**으로 적고, 구현 과정을 장황하게 풀어쓰지 않습니다.

---

## 9) 체크리스트

### 작업 전

- 이 작업이 PocketPages 레이어인지 PocketBase 레이어인지 먼저 구분했는가
- 파일 구조만 봐도 흐름을 추적할 수 있는가
- 공통 책임과 페이지 전용 책임이 섞이지 않도록 책임 경계를 먼저 정했는가
- 동적 라우트가 정말 필요한가
- `index.ejs`가 정말 디렉터리 대표 페이지인가
- 페이지 전용 데이터 로딩인데 `+load.js`를 쓰고 있지는 않은가
- 여러 하위 경로에서 반복되는 책임인데 middleware로 올리는 편이 더 맞지는 않은가
- 반복되는 partial/서버 유틸인데 `_private`로 정리하는 편이 더 맞지는 않은가
- `_private` 파일이 실제 사용 범위와 맞는 위치에 있는가
- 문맥 선택 책임은 엔트리의 `resolve()`에 두고, `_private` 내부의 `require()`는 고정 구현 연결에만 쓰는 구조인가
- 컬렉션/필드 확인이 필요할 때 `pb_schema.json`을 컬렉션명 기준으로 확인했는가
- JSVM API 사용이 `pb_data/types.d.ts` 기준과 맞는가

### 작업 후

- flash를 제외한 query string 접근을 `params`에 기대지 않고, partial에는 필요한 값만 넘기고 있는가
- 따로 분리한 함수라면 JSDoc이 있고, 필요한 named type은 `apps/<service>/types.d.ts`에 정리되어 있으며, 함수/파라미터 역할 설명이 짧은 한글로 적혀 있는가
- 서버 작업이라면 단계별 로그가 충분한가
- JS/EJS에서 PocketBase `Record`를 읽을 때 `record.get()` 접근이 맞는가
- HTMX 응답이 전체 레이아웃 HTML을 다시 반환하지 않는가
- redirect가 필요한 작업 완료/실패 흐름이라면 `redirect(..., { message })` flash 패턴을 사용했는가
- 라우트/리다이렉트/API 응답 영향이 있으면 사용자가 확인해야 할 포인트를 남겼는가
- migration 변경이 있으면 startup/초기 부팅 리스크와 확인 포인트를 남겼는가
- redirect 후 사용자 피드백이 필요한 흐름이라면 도착 페이지에서 `params.__flash`가 실제로 렌더링되는지 확인했는가
- AI가 서비스를 수정한 뒤에는 반드시 **Windows Git Bash**에서 `./task.sh lint <service>`를 실행해 해당 서비스 lint를 통과시켰는가
- lint에서 이슈가 나오면 관련 파일을 수정한 뒤 같은 명령을 다시 실행해 통과 여부를 확인했는가

---

## 10) 문서 참조 우선순위

- 1순위: `.docs/pocketpages/*`
- 2순위: `.docs/pocketbase/pocketbase_docs_js.md`
- 3순위: 해당 서비스의 `pb_schema.json`, `pb_data/types.d.ts`
- `.docs/pocketpages/*`는 PocketPages가 **기술적으로 지원하는 기능과 동작 의미**를 확인하는 기준입니다.
- 다만 이 `AGENTS.md`가 같은 주제에 대해 더 좁은 기본값이나 금지 패턴을 정의하면, 그것은 이 레포의 **작업 규칙**으로 간주하고 구현 시 우선 적용합니다.
- 예시: `(site)/xapi/api` 디렉터리 역할 분리, `_private`에서 `resolve()`와 `require()`의 역할 분담, partial에 PocketPages 전체 컨텍스트를 넘기지 않는 규칙.
- 공식 문서끼리 설명이 엇갈리면, 이 문서에 명시된 레포 기준과 이미 존재하는 서비스의 로컬 패턴을 우선해 일관되게 유지합니다.

---

## 11) 도구 사용 메모

- PowerShell에서 경로에 괄호나 대괄호가 포함된 파일을 읽을 때는 전체 경로를 따옴표로 감쌉니다.
- 대괄호가 포함된 경로는 필요하면 `-LiteralPath`를 우선 사용합니다.

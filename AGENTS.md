# AGENTS.md

이 문서는 이 저장소에서 작업하는 에이전트/개발자가 PocketPages 기반 구조를 빠르게 이해하고, 같은 기준으로 일관되게 수정하기 위한 작업 가이드입니다.

## 1) 프로젝트 요약

- 이 레포는 **PocketBase + PocketPages** 기반 SSR 서비스 모음입니다.
- 핵심 실행 컨텍스트는 PocketBase의 `pb_hooks` JSVM이며, PocketPages가 파일 기반 라우팅/레이아웃/렌더링을 담당합니다.
- 이 레포에서는 특히 **단순함, 명시성, 추적 가능성**을 중요하게 봅니다.

## 2) 기술 기준

- 플랫폼: PocketBase
- 앱 레이어: PocketPages (`require('pocketpages')`)
- 템플릿 엔진: EJS (`pocketpages-plugin-ejs`)
- 페이지 루트: `pb_hooks/pages`
- 클라이언트 상호작용: Alpine.js
- 서버 통신/부분 갱신: HTMX
- 리얼타임: `pocketpages-plugin-realtime`
- 스타일링: UnoCSS Runtime (Attributify Mode)

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
- `apps/<service>/pb_data/types.d.ts`: 서비스 기준 PocketBase JSVM 타입 정의
- `.docs/pocketpages/*`: PocketPages 문서 스냅샷
- `.docs/pocketbase/pocketbase_docs_js.md`: PocketBase JS 문서

## 4) 가장 중요한 작업 원칙

- PocketPages에서는 과도한 추상화보다 **파일 구조가 직접 의도를 설명하는 형태**를 우선합니다.
- 한 번만 쓰이는 로직은 억지로 공용화하지 말고, 해당 페이지 문맥 안에 명시적으로 둡니다.
- 여러 파일에서 반복되는 책임만 공용화합니다.
- 사람이든 AI든 **파일 경로만 보고 흐름을 추적할 수 있어야** 합니다.
- 이 프로젝트는 SPA식 복잡한 클라이언트 상태를 의도적으로 줄이고, 서버 주도 렌더링과 정형화된 PocketBase 패턴 안에서 문제를 다루기 쉽게 유지하는 것을 핵심 가치로 둡니다.
- 목표는 기능을 복잡하게 확장하는 것보다, AI가 빠르게 읽고 수정하고 검증할 수 있는 **예측 가능한 구조**를 유지하는 것입니다.
- 수정 전에는 항상 "이 책임이 페이지 전용인지, 여러 하위 경로에 공통인지, API 응답 전용인지"부터 구분합니다.

## 5) PocketPages 레이어 작업 기준

### A. 라우팅과 파일명

- 파일 기반 라우팅 구조를 먼저 존중합니다.
- `index.ejs`는 **디렉터리 대표 경로**일 때 우선 사용합니다.
- 하위 화면의 의미가 분명하면 `new.ejs`, `edit.ejs`, `[postSlug].ejs`처럼 파일명으로 의도를 드러냅니다.
- 파일명은 화면 역할과 URL 의미가 최대한 바로 읽히게 유지합니다.
- 동적 라우트(`[param]`)는 필요한 경우에만 도입합니다.

### B. 페이지, 로더, 미들웨어 구분

- 페이지 하나에서만 쓰는 데이터 준비/메타 설정은 해당 페이지 상단의 `<script server>`에 두는 것을 기본값으로 삼습니다.
- `+load.js`는 페이지 엔트리와 같은 레벨에서 **하나만 실행**된다는 점을 전제로 사용합니다.
- `+load.js`는 여러 템플릿에서 같은 로딩 책임을 공유하거나, `+get.js`/`+post.js` 등과 함께 구조적으로 유지할 이유가 분명할 때만 사용합니다.
- 여러 하위 경로에 공통으로 필요한 데이터, 인증, 가드, 요청 검증은 `+middleware.js`로 올립니다.
- `+middleware.js`는 루트에서 리프까지 계층적으로 실행되므로, 공통 책임을 모으는 용도로 사용합니다.
- middleware에서 PocketPages 컨텍스트 API가 필요하면 **전역 심볼로 가정하지 말고**, 함수 인자로 받은 `api`에서 꺼내 사용합니다.
- 예시: `module.exports = function ({ params, resolve, dbg }) { ... }`
- `next`를 사용하는 middleware는 흐름 제어가 복잡해지므로, 꼭 필요한 경우에만 사용합니다.
- middleware에서 조기 종료하면 직접 응답을 보내야 한다는 점을 항상 염두에 둡니다.

### C. 레이아웃

- 공통 `<head>`, 메타 기본값, 공통 스크립트, 공통 외형은 `+layout.ejs`에 둡니다.
- 페이지 고유 내용은 각 `*.ejs`에 둡니다.
- 레이아웃이 실제로 필요로 하는 값은 leaf 페이지 기준으로 설계합니다.
- PocketPages 레이아웃에서는 leaf 쪽 데이터만 보인다는 점을 기준으로 구조를 잡습니다.
- layout 자체에서 여러 하위 페이지에 공통으로 필요한 데이터가 있다면, leaf 페이지마다 중복해서 넣지 말고 middleware로 올려서 전달하는 쪽을 우선합니다.

### D. `_private` 사용법

- `_private`는 단순 partial 폴더가 아니라, **부분 템플릿 + 서버 유틸 + 내부 모듈**을 두는 기본 위치입니다.
- 외부 라우트로 노출되면 안 되는 파일은 `_private`에 둡니다.
- partial은 `_private`에 두고 `include()`로 재사용합니다.
- 공통 서버 로직, 쿼리 유틸, 포맷터, slug 처리 같은 로직도 `_private`에 둡니다.
- EJS, `<script server>`, loader, middleware처럼 PocketPages 요청 컨텍스트 안에서는 `_private` 모듈을 `resolve()`로 불러올 수 있습니다.
- `resolve()`는 `_private`를 포함한 전체 경로를 넘기는 것이 아니라, `_private` 기준 이름으로 사용합니다.
- 예시: `resolve('board-service')`
- middleware에서는 `resolve()`를 전역 함수처럼 직접 호출하지 말고, `module.exports = function ({ resolve }) { ... }`처럼 **인자로 받은 `resolve`**를 사용합니다.
- `resolve('/_private/board-service')` 같은 형태는 `_private/_private/...`로 잘못 해석될 수 있으므로 사용하지 않습니다.
- `_private` 파일은 **가까운 곳에 두고**, 더 넓게 재사용되기 시작하면 상위 디렉터리로 올립니다.
- 하위 섹션에서 상위 `_private` 파일을 override할 수 있다는 점을 감안해 파일 위치를 정합니다.

### E. HTMX와 API 응답

- HTMX는 전체 페이지를 다시 받지 않고 **필요한 조각만 받는 구조**를 기본값으로 삼습니다.
- 전체 페이지와 부분 응답은 디렉터리 차원에서 분리합니다.
- 이 레포에서는 layout이 적용되는 페이지는 `(site)` 아래에 둡니다.
- HTMX partial, form action, redirect, SSE, raw HTML 응답처럼 **레이아웃 없는 상호작용 엔드포인트**는 `pages/xapi/*` 아래에 둡니다.
- JSON을 반환하거나 외부/프로그래매틱 호출을 위한 **명시적인 API 엔드포인트**는 `pages/api/*` 아래에 둘 수 있습니다.
- 즉 `xapi`는 layout 없는 interaction endpoint, `api`는 JSON/프로그래매틱 API라는 구분을 기본값으로 삼습니다.
- HTMX 응답은 layout 없는 raw HTML 또는 리다이렉트처럼 필요한 응답만 반환합니다.
- 초기 페이지 렌더와 HTMX 응답이 같은 마크업을 써야 하면 `_private` partial로 묶어 한 곳에서 관리합니다.

### F. redirect와 flash message

- 작업 완료, 생성/수정/삭제 성공, 검증 실패처럼 **사용자가 다음 화면에서 바로 알아야 하는 결과**는 PocketPages `redirect()`의 flash message 패턴을 우선 사용합니다.
- 기본 패턴은 `redirect('/target', { status: 303, message: 'Post created.' })` 형태로 작성합니다.
- 성공/실패 알림을 위해 `?__flash=...` 쿼리스트링을 수동으로 조립하지 않습니다.
- redirect 직전에는 `dbg()`로 `status`, `redirectTo`, `flash` 또는 `error`를 남겨 런타임 추적이 가능하게 합니다.
- flash message는 도착 페이지에서 `params.__flash`로 읽는 것을 기본값으로 삼습니다.
- 여러 페이지에서 같은 flash UI를 쓴다면 각 페이지에 같은 마크업을 반복하지 말고 `_private` partial로 분리해 `include()`로 재사용합니다.
- flash UI는 메시지 문자열만 출력하는 데서 끝내지 말고, 성공/실패 여부가 시각적으로 드러나도록 스타일 규칙도 함께 둡니다.

## 6) PocketBase / JSVM 작업 기준

- 이 레포에서는 대부분의 요청-응답 기반 기능을 PocketPages 안에서 처리하는 것을 기본값으로 봅니다.
- 다만 **스케줄 작업(cron/job)** 은 PocketPages가 아니라 `pb_hooks/*.pb.js` 에서 **PocketBase JS 확장 기능을 그대로 사용**하는 것을 기본 원칙으로 삼습니다.

### A. 타입과 문서 기준

- PocketBase JSVM 코드는 반드시 해당 서비스의 `pb_data/types.d.ts`를 기준으로 가능한 API/타입만 사용합니다.
- 문서 예시와 `pb_data/types.d.ts`가 다르면 `pb_data/types.d.ts`를 우선합니다.
- 타입 정의에 없는 심볼/시그니처는 사용하지 않습니다.

### B. 스키마 확인 기준

- 컬렉션명, 필드명, 필드 타입, relation, 옵션, 제약 조건 확인이 필요하면 해당 서비스 루트의 `pb_schema.json`을 먼저 봅니다.
- `pb_schema.json`은 전체를 무작정 펼쳐서 읽지 말고, **필요한 컬렉션명으로 필터링해서 필요한 부분만 확인**합니다.

### C. Record 접근 기준

- EJS에서 PocketBase `Record`를 렌더링할 때는 `record.fieldName` 직접 접근을 기본값으로 가정하지 않습니다.
- 우선 `record.get('fieldName')` 방식으로 읽습니다.

### D. DT(Data/Domain Type) 기준

- 이 레포에서는 **직접 만든 컬렉션마다 DT를 둡니다.**
- DT 파일은 기본적으로 `apps/<service>/pb_hooks/pages/_private/table/*.js` 위치에 둡니다.
- DT는 저장/삭제/응답을 처리하지 않고, **상태/필드 판단만** 담당합니다.
- `xapi`/`page` 호출부는 DT의 `can...()`, `is...()`, `has...()` 결과를 보고 **명시적으로 에러를 던집니다.**
- 저장/삭제/리다이렉트/응답 처리는 항상 호출부가 담당합니다.
- DT는 해당 서비스의 `pb_schema.json`과 **항상 싱크가 맞아야 합니다.**
- DT와 실제 스키마가 어긋나면 **`pb_schema.json`이 정답**이며, 누락되거나 달라진 필드는 `pb_schema.json` 기준으로 DT를 업데이트합니다.

### E. 로그와 런타임 추적

- 서버 로직을 작성할 때는 PocketPages 전역 로그 함수 `dbg`, `info`, `warn`, `error`를 적극적으로 사용합니다.
- 런타임에서 어디서 문제가 났는지 바로 알 수 있도록 주요 단계별 로그를 명시적으로 남깁니다.
- 특히 요청 진입, 입력값 확인, 분기, DB 조회, 저장/삭제, 예외 처리 지점은 로그를 남기는 편을 기본값으로 둡니다.
- 페이지 렌더 직전 데이터나 redirect 직전 응답 payload도 `dbg()`로 남겨도 되며, 이때는 `Record` 전체 dump보다 실제 추적에 필요한 핵심 필드 요약을 우선합니다.
- `dbg()`는 개발 추적용, `info()`는 정상 흐름 기록, `warn()`은 예상 가능한 이상 상태, `error()`는 실제 실패 기록으로 구분합니다.

### F. 마이그레이션

- relation 필드는 대상 컬렉션이 저장된 뒤의 실제 `collection.id`를 사용합니다.
- relation 대상 컬렉션 ID를 임의 문자열로 하드코딩하지 않습니다.
- self relation은 컬렉션 생성과 동시에 넣지 말고, 저장 후 2차 업데이트로 추가하는 것을 기본 원칙으로 합니다.

## 7) 프론트엔드 기준

- 간단한 클라이언트 상호작용은 Alpine.js로 처리합니다.
- 스타일은 UnoCSS Runtime + Attributify Mode 기준으로 작성합니다.
- 스타일을 긴 `class=""` 하나에 몰아넣지 말고, 가능한 한 Attributify 속성으로 나눠 씁니다.
- 성격이 비슷한 스타일은 속성 그룹으로 묶습니다.
- 예시: `text="center lg white"`, `border="~ stone-200 rounded-xl"`

## 8) 이 레포에서 선호하는 코드 스타일

- 명시적인 코드 선호
- 짧은 추적 경로 선호
- 불필요한 공용 헬퍼/래퍼 지양
- 공통 책임은 middleware 또는 `_private`로 이동
- 페이지 전용 책임은 페이지 안에 유지
- 파일명만 봐도 역할이 드러나게 구성

## 9) 변경 전 체크리스트

- 이 작업이 PocketPages 레이어인지 PocketBase 레이어인지 먼저 구분했는가
- 동적 라우트가 정말 필요한가
- `index.ejs`가 정말 디렉터리 대표 페이지인가
- 페이지 전용 데이터 로딩인데 `+load.js`를 쓰고 있지는 않은가
- 여러 하위 경로에서 반복되는 책임인데 middleware로 올리는 편이 더 맞지는 않은가
- 반복되는 partial/서버 유틸인데 `_private`로 정리하는 편이 더 맞지는 않은가
- HTMX 응답이 전체 레이아웃 HTML을 다시 반환하지 않는가
- 컬렉션/필드 확인이 필요할 때 `pb_schema.json`을 컬렉션명 기준으로 확인했는가
- JSVM API 사용이 `pb_data/types.d.ts` 기준과 맞는가

## 10) 변경 중 체크리스트

- 파일 구조만 봐도 흐름을 추적할 수 있는가
- 공통 책임과 페이지 전용 책임이 섞이지 않았는가
- `_private` 파일이 실제 사용 범위와 맞는 위치에 있는가
- 서버 작업이라면 단계별 로그가 충분한가
- EJS에서 `record.get()` 접근이 맞는가
- redirect가 필요한 작업 완료/실패 흐름이라면 `redirect(..., { message })` flash 패턴을 사용했는가

## 11) 변경 후 체크리스트

- 라우트/리다이렉트/API 응답 영향이 있으면 사용자가 확인해야 할 포인트를 남겼는가
- migration 변경이 있으면 startup/초기 부팅 리스크와 확인 포인트를 남겼는가
- redirect 후 사용자 피드백이 필요한 흐름이라면 도착 페이지에서 `params.__flash`가 실제로 렌더링되는지 확인했는가
- AI가 서비스를 수정한 뒤에는 반드시 **Windows Git Bash**에서 `./task.sh lint <service>`를 실행해 해당 서비스 lint를 통과시켰는가
- lint에서 이슈가 나오면 관련 파일을 수정한 뒤 같은 명령을 다시 실행해 통과 여부를 확인했는가

## 12) 문서 참조 우선순위

- 1순위: `.docs/pocketpages/*`
- 2순위: `.docs/pocketbase/pocketbase_docs_js.md`
- 3순위: 해당 서비스의 `pb_schema.json`, `pb_data/types.d.ts`

## 13) 도구 사용 메모

- PowerShell에서 경로에 괄호나 대괄호가 포함된 파일을 읽을 때는 전체 경로를 따옴표로 감쌉니다.
- 대괄호가 포함된 경로는 필요하면 `-LiteralPath`를 우선 사용합니다.

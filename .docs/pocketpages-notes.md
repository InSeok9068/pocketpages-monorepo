# PocketPages 동작 보충

프로젝트 규칙은 `AGENTS.md`, 일반 기능 설명은 `pocketpages/`를 따른다. 이 문서는 기존 문서의 오래된 예시나 설명에서 놓치기 쉬운 동작만 보충하며, 별도 스킬이나 작업 규칙이 아니다.

기준: PocketPages `0.22.5`. 응답 처리·JSON 감지·슬롯 동작은 로컬 설치본 `apps/booklog/node_modules/pocketpages/dist/index.js`에서 확인했다. 버전 변경 시 설치본과 서비스 타입을 다시 확인한다.

보안 재검토의 근거·재현 결과·미패치 항목은 [2026-11-13 검토 보고서](pocketpages-security-review-2026-11-13.md)에 기록한다. 해당 보고서는 특정 설치본의 검증 기록이며, 전체 안전성 보장이나 별도 프로젝트 규칙이 아니다.

## API 예시를 읽을 때

- `formData`와 `body`는 함수다. `formData.email`이 아니라 `formData().email`로 읽는다. `pocketpages/loading-data.md`와 `pocketpages/context-api/redirect.md`의 일부 예시는 이 점을 반영하지 않는다.
- `$app.findRecordsByFilter`는 옵션 객체가 아니라 `(collection, filter, sort, limit, offset, params)` 순서의 인자를 받는다. `pocketpages/loading-data.md`의 옵션 객체 예시를 복사하지 않는다. 정확한 서명은 서비스의 `pb_data/types.d.ts`로 확인한다.
- `response.status()`는 없다. 상태 코드가 필요하면 `response.html(status, html)` 또는 `response.json(status, value)`로 직접 응답한다.

## 응답과 실행 종료

- `redirect()`나 `response.html/json()`을 호출해도 현재 JavaScript 함수의 남은 코드는 실행된다. 응답 후에는 명시적으로 `return`한다.
- 0.22.5는 로더가 응답을 보냈으면 후속 로더·페이지 렌더링을 중단하고, 페이지가 응답을 보냈으면 레이아웃 처리를 중단한다. 과거 가이드의 “로더에서 응답해도 페이지가 항상 렌더링된다”는 설명을 적용하지 않는다.
- 미들웨어의 자동 진행 여부는 함수 인자 수로 구분한다. `(api)` 형식은 반환 후 자동 진행하고, `(api, next)` 형식은 `next()`를 호출해야 진행한다. 조기 종료 시 직접 응답해야 한다. 상세는 `pocketpages/middleware.md`를 참고한다.
- `Content-Type` 헤더만 설정하는 것은 직접 응답을 보내는 것과 다르다. 0.22.5는 매개변수를 제외한 MIME 타입으로 HTML 여부를 판단하므로 `text/html; charset=utf-8`도 HTML이며, 이 헤더로 레이아웃을 우회할 수 없다.

## JSON 자동 감지

`pocketpages/json.md`의 “유효한 JSON이면 자동 감지” 설명은 범위를 주의한다. 0.22.5는 페이지 출력의 앞뒤 공백을 제거한 뒤 `{` 또는 `[`로 시작하는 경우에만 JSON 파싱을 시도한다. 성공하면 상태 200의 JSON으로 응답하고 레이아웃을 생략한다. 숫자·불리언·문자열 단독 출력까지 자동 JSON 응답이 된다고 가정하지 않는다. 상태 코드와 응답 형식을 명확히 제어하려면 `response.json(status, value)`을 사용한다.

## partial과 경로

- partial은 템플릿 문맥을 상속하지만 부모의 `<script server>` 또는 EJS 블록에서 선언한 `const`·`let` 지역 변수까지 상속하지는 않는다. 필요한 값은 명시적으로 전달한다.
- `include()`와 `resolve()`는 이름으로 찾을 때 상위 `_private`를 탐색하지만 선행 `/`의 기준은 다르다. `include('/blog/_private/card.ejs')`는 `pages/` 기준이고, `resolve('/lib/x')`는 `pages/_private/` 기준이다. `pocketpages/private-files.md`의 `resolve('/products/_private/queries')` 예시는 그대로 사용하지 않는다.
- `../`를 “부모 `_private`로 이동”하는 단축 표기로 가정하지 않는다. 현재 디렉터리의 `_private`를 벗어나는 경로로 해석될 수 있다. 공통 partial을 상위 `_private`로 옮기고 이름으로 찾는 방식을 우선한다.

## 이름 있는 슬롯

`pocketpages/layouts.md`에는 `slot`이 항상 전체 콘텐츠라는 설명이 있지만, 0.22.5는 이름 있는 슬롯을 추출한 뒤 남은 콘텐츠를 기본 `slot`으로 사용한다. 비어 있지 않은 `slots.default`가 있으면 그것을 우선한다.

따라서 `<!-- slot:head -->`, `<!-- slot:body -->`로 나눈 페이지에서는 `slots.head`, `slots.body`를 명시적으로 출력한다. `slot`만 출력하면 이름 있는 슬롯 내용이 빠질 수 있다. 중첩 레이아웃은 각 단계에서 전달받은 콘텐츠를 다시 슬롯으로 파싱한다.

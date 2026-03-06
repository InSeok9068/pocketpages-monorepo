# AGENTS.md

이 문서는 이 저장소에서 작업하는 에이전트/개발자가 PocketPages 아키텍처를 빠르게 이해하고, 일관된 방식으로 수정하기 위한 최소 가이드입니다.

## 1) 프로젝트 한 줄 요약

- 이 레포는 **PocketBase + PocketPages** 기반 SSR 서비스 모음입니다.
- 핵심 실행 컨텍스트는 PocketBase의 `pb_hooks`(JSVM)이며, PocketPages가 라우팅/렌더링 레이어를 제공합니다.

## 2) 아키텍처 개요

- **플랫폼**: PocketBase 서버
- **앱 레이어**: PocketPages (`require('pocketpages')`)
- **페이지 루트**: `pb_hooks/pages`
- **템플릿 엔진**: EJS (`pocketpages-plugin-ejs`)
- **리얼타임**: `pocketpages-plugin-realtime` (SSE/HTMX 연계 가능)
- **클라이언트 상호작용**: Alpine.js
- **디자인 시스템**: UnoCSS Runtime (Attributify Mode 기반 유틸리티 스타일 방식)
- **서버 통신/부분 갱신**: HTMX

요약하면:

- 데이터/인증/권한/API 규칙 = PocketBase
- 파일 기반 라우팅, 레이아웃, 렌더링, 컨텍스트 API = PocketPages
- UI 상호작용 = Alpine.js / 스타일 = UnoCSS Runtime (Attributify Mode) / 서버 통신 = HTMX

## 3) 현재 레포 기준 핵심 경로

- `sample/pb_hooks/pocketpages.pb.js`: PocketPages 부트스트랩 엔트리
- `sample/pb_hooks/pages/+config.js`: PocketPages 플러그인 설정
- `sample/pb_hooks/pages/(site)/+layout.ejs`: 사이트 공통 레이아웃
- `sample/pb_hooks/pages/(site)/index.ejs`: 기본 페이지
- `sample/pb_hooks/pages/api/*`: API 성격 엔드포인트
- `sample/pb_hooks/pages/_private/*`: 부분 템플릿/내부 조각
- `sample/pb_schema.json`: 서비스별 PocketBase 스키마 스냅샷(컬렉션명, 필드명, 필드 타입, 제약 조건 확인용)
- `sample/pb_data/types.d.ts`: 서비스 실행 시 생성되는 PocketBase JSVM 타입 정의(전역 API/객체/시그니처 기준)
- `.docs/pocketpages/*`: PocketPages 로컬 문서 스냅샷
- `.docs/pocketbase/pocketbase_docs_js.md`: PocketBase(+JS 확장) 통합 문서

## 4) 수정 원칙

### A. PocketPages 라우팅/렌더링 레이어

- PocketPages 관점에서는 구조를 **심플하게 유지하는 것**을 우선 원칙으로 삼습니다.
- 과도한 최적화, 이른 추상화, 불필요한 공용화보다 **명시적인 코드**를 우선합니다.
- 한 번만 쓰이는 로직까지 억지로 헬퍼/레이어/추상화로 분리하지 말고, 해당 페이지 문맥에서 바로 읽히는 형태를 기본값으로 둡니다.
- 에이전트와 사람이 모두 빠르게 추적할 수 있도록, 파일 이동이 많고 호출 흐름이 숨겨지는 구조보다 **직접 따라가기 쉬운 구조**를 선호합니다.
- PocketPages는 파일 기반 라우팅과 템플릿 분리가 이미 명확하므로, 그 장점을 해치지 않는 선에서 단순하게 구성합니다.
- 새 기능은 먼저 `sample/pb_hooks/pages`의 파일 기반 라우팅 구조에 맞춰 배치합니다.
- 공통 `<head>`/메타/공통 스크립트는 `+layout.ejs`에 두고, 페이지별 내용은 각 `*.ejs`로 분리합니다.
- 동적 라우트(`[param]`)는 필요한 경우에만 도입합니다.

### B. PocketBase 데이터/JSVM 레이어

- PocketBase 컬렉션/권한 규칙에 의존하는 로직은 문서 기준으로 검증 후 구현합니다.
- 컬렉션 관련 필드명, 필드 타입, relation, 옵션, 제약 조건을 확인해야 할 때는 먼저 해당 서비스 루트의 `pb_schema.json`을 확인합니다.
- `pb_schema.json`을 볼 때는 전체 스키마를 무작정 펼쳐서 훑지 말고, **필요한 컬렉션명으로 필터링해서 필요한 부분만 확인하는 것**을 기본 원칙으로 합니다.
- PocketBase JSVM 코드를 작성할 때는 반드시 해당 서비스의 `pb_data/types.d.ts`를 기준으로 가능한 API/타입만 사용합니다.
- 문서 예시와 서비스의 `pb_data/types.d.ts`가 다를 경우 `pb_data/types.d.ts`를 우선하며, 타입 정의에 없는 심볼/시그니처는 사용하지 않습니다.
- PocketBase `Record`를 EJS에서 렌더링할 때는 `record.fieldName` 직접 접근을 기본값으로 가정하지 말고, 우선 `record.get('fieldName')` 방식으로 읽습니다.

### C. PocketBase 마이그레이션 레이어

- migration에서 relation 필드는 대상 컬렉션이 실제로 저장된 뒤의 `collection.id`를 사용합니다.
- relation 대상 컬렉션 ID를 임의 문자열로 하드코딩하지 않습니다.
- self relation(예: `comments.parent_comment`)은 컬렉션 생성과 동시에 넣지 말고, 컬렉션 저장 후 2차 업데이트로 추가하는 것을 기본 원칙으로 합니다.

### D. 프론트엔드/HTMX/Alpine 레이어

- 간단한 클라이언트 상호작용은 Alpine.js로 처리합니다.
- 디자인/기본 UI 스타일은 UnoCSS Runtime + Attributify Mode 기준으로 구성합니다.
- 스타일을 `class="..."` 하나에 길게 몰아넣지 말고, 가능한 한 Attributify 속성으로 나누어 작성합니다.
- 성격이 비슷한 스타일은 속성 그룹으로 묶습니다.
- 예시: `p-4`, `flex`, `rounded-xl`처럼 단일 속성을 직접 쓰거나, `text="center lg white"`, `border="~ gray-200 rounded-xl"`처럼 그룹화합니다.
- 서버와의 통신 및 부분 렌더 갱신은 HTMX를 우선 사용합니다.
- HTMX로 부분 갱신할 때는 전체 페이지 라우트(`/(site)/index.ejs` 등)를 직접 다시 치지 말고, 가능한 한 `pages/api/*` 아래에 부분 응답 전용 엔드포인트를 만들어 해당 조각만 반환합니다.

### E. 도구/환경 레이어

- PowerShell에서 경로에 괄호가 포함된 파일(예: `(site)`)을 읽거나 검사할 때는 항상 전체 경로를 따옴표로 감쌉니다.

### F. 문서 참조 우선순위

- 1순위: `.docs/pocketpages/*` (프레임워크 동작)
- 2순위: `.docs/pocketbase/pocketbase_docs_js.md` (DB/Auth/API/JS hooks)

## 5) 에이전트 작업 체크리스트

- 변경 전: 수정 대상이 PocketPages 레이어인지 PocketBase 레이어인지 구분
- 변경 전: 동적 라우트가 꼭 필요한지 먼저 검토하고, 정적 경로 + HTMX partial로 더 작게 쪼갤 수 있으면 그 방식부터 시도
- 변경 전: 이 구현이 정말 추상화가 필요한지 먼저 점검하고, 가능하면 더 명시적이고 직접적인 코드로 유지
- 변경 중: `pages` 구조/레이아웃/플러그인 설정 영향 범위 확인
- 변경 중: 에이전트와 사람이 요청 흐름을 파일 기준으로 쉽게 따라갈 수 있는지 확인
- 변경 중: HTMX 요청이 전체 레이아웃 HTML을 다시 받아오지 않는지 확인
- 변경 중: EJS에서 PocketBase `Record` 필드 접근 방식이 맞는지 확인
- 변경 후: 라우트/리다이렉트/API 응답 영향이 있으면, 어떤 항목을 사용자가 확인해야 하는지 명시
- 변경 후: migration 추가 시 startup/초기 부팅 리스크가 있는지 점검하고, 사용자가 확인해야 할 검증 포인트를 함께 남김

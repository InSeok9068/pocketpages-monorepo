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
- **디자인 시스템**: Pico CSS
- **서버 통신/부분 갱신**: HTMX

요약하면:
- 데이터/인증/권한/API 규칙 = PocketBase
- 파일 기반 라우팅, 레이아웃, 렌더링, 컨텍스트 API = PocketPages
- UI 상호작용 = Alpine.js / 스타일 = Pico CSS / 서버 통신 = HTMX

## 3) 현재 레포 기준 핵심 경로

- `sample/pb_hooks/pocketpages.pb.js`: PocketPages 부트스트랩 엔트리
- `sample/pb_hooks/pages/+config.js`: PocketPages 플러그인 설정
- `sample/pb_hooks/pages/(site)/+layout.ejs`: 사이트 공통 레이아웃
- `sample/pb_hooks/pages/(site)/index.ejs`: 기본 페이지
- `sample/pb_hooks/pages/api/*`: API 성격 엔드포인트
- `sample/pb_hooks/pages/_private/*`: 부분 템플릿/내부 조각
- `types.d.ts`: 루트 기준 PocketBase JSVM 타입 정의(전역 API/객체/시그니처 기준)
- `.docs/pocketpages/*`: PocketPages 로컬 문서 스냅샷
- `.docs/pocketbase/pocketbase_docs_js.md`: PocketBase(+JS 확장) 통합 문서

## 4) 요청 처리 흐름(실무용 축약)

1. PocketBase가 요청 수신
2. `pb_hooks`에서 PocketPages가 페이지 라우팅
3. 필요 시 `+load.js` 등에서 데이터 준비
4. EJS 템플릿 렌더링 후 응답
5. 리얼타임/HTMX 사용 시 SSE 갱신 수행

## 5) 수정 원칙

- 새 기능은 먼저 `sample/pb_hooks/pages`의 파일 기반 라우팅 구조에 맞춰 배치합니다.
- 공통 `<head>`/메타/공통 스크립트는 `+layout.ejs`에 두고, 페이지별 내용은 각 `*.ejs`로 분리합니다.
- PocketBase 컬렉션/권한 규칙에 의존하는 로직은 문서 기준으로 검증 후 구현합니다.
- PocketBase JSVM 코드를 작성할 때는 반드시 루트 `types.d.ts`를 기준으로 가능한 API/타입만 사용합니다.
- 문서 예시와 `types.d.ts`가 다를 경우 `types.d.ts`를 우선하며, 타입 정의에 없는 심볼/시그니처는 사용하지 않습니다.
- 프론트엔드 역할 분리 원칙:
  1. 간단한 클라이언트 상호작용은 Alpine.js로 처리
  2. 디자인/기본 UI 스타일은 Pico CSS를 기준으로 구성
  3. 서버와의 통신 및 부분 렌더 갱신은 HTMX를 우선 사용
- 문서 참조 우선순위:
  1. `.docs/pocketpages/*` (프레임워크 동작)
  2. `.docs/pocketbase/pocketbase_docs_js.md` (DB/Auth/API/JS hooks)

## 6) 로컬 실행(샘플)

`sample` 디렉터리에서:

```bash
./pbw.exe pocketbase.exe --dir=pb_data --dev serve
```

## 7) 에이전트 작업 체크리스트

- 변경 전: 수정 대상이 PocketPages 레이어인지 PocketBase 레이어인지 구분
- 변경 중: `pages` 구조/레이아웃/플러그인 설정 영향 범위 확인
- 변경 후: 최소 1회 수동 라우트 확인(렌더링/리다이렉트/API 응답)

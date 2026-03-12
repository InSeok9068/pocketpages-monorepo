# pocketpages-monorepo

> AI 에이전트 안내: 이 문서를 작업 기준으로 사용하지 말고 먼저 `AGENTS.md`를 확인하세요.

| 구분                | PocketPages (SSR)        |
| ------------------- | ------------------------ |
| 목적                | 빠른 MVP                 |
| 핵심가치            | AI 에이전트 협업         |
| 백엔드              | PocketPages (Pocketbase) |
| 프론트엔드          | HTMX, Alpine.js          |
| 템플릿/UI           | EJS                      |
| CSS                 | UnoCSS (Tailwind)        |
| 상태관리            | PB Native Context        |
| 라우팅              | 파일 시스템 (Auto)       |
| DB                  | SQLite (PB)              |
| DB 관리             | PB Admin                 |
| DB <br>마이그레이션 | PB Migration             |
| DB 복구             | File Backup (ZIP)        |
| 인증                | PB Auth + (Cookie)       |
| 인가                | 서버 로직                |
| 객체 저장           | File, AWS S3             |
| 스케줄 작업         | PB cron                  |
| 메시지 큐           | X                        |
| 캐시                | Memory / Server (Store)  |
| 웹 서버             | Caddy                    |
| 서버리스 함수       | Cloudflare Workers       |
| 모니터링            | PB Admin Logs            |
| 로깅                | PB Logs                  |
| 린팅                | custom script            |
| 테스트              | node test (http only)    |
| 빌드 과정           | 불필요                   |
| 배포 방식           | 파일 동기화 (PB 전송)    |
| 모바일              | PWA => Capacitor         |
| 푸시/알림           | FCM / OneSignal          |

PocketBase + PocketPages 기반 SSR 서비스 모노레포입니다.
이 레포는 단순히 PocketPages 앱 여러 개를 모아둔 저장소가 아니라, PocketPages 구조를 더 빨리 읽고 더 안전하게 수정할 수 있게 해주는 VS Code 확장과 진단 스크립트까지 함께 관리합니다.

## 이 레포가 제공하는 것

- `apps/<service>` 단위로 분리된 PocketPages 서비스 구조
- `pb_hooks/pages` 파일 기반 라우팅 중심의 SSR 개발 방식
- EJS + HTMX + Alpine.js 조합으로 유지하는 서버 주도 UI
- PocketBase 스키마와 레포 규칙을 이해하는 VS Code 편집 경험
- `lint`, `diag`, `verify`로 이어지는 로컬 검증 흐름
- `pb_hooks` 동기화 중심의 단순한 배포 방식

## 왜 이런 구성을 쓰는가

이 레포의 기본 방향은 빠른 MVP와 명시적인 구조입니다.
복잡한 SPA 상태 관리나 빌드 파이프라인보다, 파일 경로만 봐도 흐름을 따라갈 수 있는 SSR 구조를 우선합니다.

특히 중요한 점은 "PocketPages 기반 서비스" 자체보다 "PocketPages를 읽고 수정하는 경험"까지 같이 다룬다는 것입니다.
그래서 이 레포에는 서비스 코드뿐 아니라, `.ejs`, `<script server>`, `_private`, `resolve()`, `record.get()` 같은 PocketPages 작업 방식에 맞춘 전용 VS Code 확장이 들어 있습니다.

## 핵심 구성

| 영역          | 선택                                     | 이 레포에서의 의미                                                    |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| 앱 구조       | PocketPages                              | `pb_hooks/pages` 파일 구조 자체가 라우팅과 책임 경계를 설명합니다.    |
| 백엔드 런타임 | PocketBase                               | 인증, DB, admin, migration, cron을 PocketBase 중심으로 처리합니다.    |
| 템플릿        | EJS                                      | SSR 페이지와 partial을 직접적이고 추적 가능하게 유지합니다.           |
| 상호작용      | HTMX, Alpine.js                          | 복잡한 프론트 상태 없이 필요한 부분만 갱신합니다.                     |
| 스타일        | UnoCSS Runtime                           | 빌드 부담 없이 utility class 기반으로 화면을 작성합니다.              |
| 데이터 저장   | SQLite, PocketBase file storage, S3 확장 | PocketBase 기본 저장소를 중심으로 필요 시 객체 스토리지를 연결합니다. |
| 로깅/운영     | PocketBase logs, admin                   | 운영 추적과 관리 도구를 PocketBase 축으로 둡니다.                     |
| 검증          | custom lint, editor diagnostics          | 레포 규칙과 PocketPages 문맥을 같이 검사합니다.                       |
| 배포          | 파일 동기화 기반                         | 빌드 산출물보다 `pb_hooks` 반영 흐름을 단순하게 가져갑니다.           |

## 서비스와 도구 구조

```text
apps/
  sample/                     # 기준 패턴을 보기 좋은 예제 서비스
  kjca/                       # 실제 서비스
tools/
  vscode-pocketpages/         # PocketPages 전용 VS Code 확장
scripts/
  lint-pocketpages.js         # 레포 구조 규칙 검사
  diag-pocketpages.js         # VS Code와 같은 언어 서비스 기반 진단
```

서비스 내부에서는 대체로 아래 구조를 기준으로 작업합니다.

```text
apps/<service>/
  pb_hooks/
    pocketpages.pb.js
    pages/
      +config.js
      (site)/
      api/
      xapi/
      _private/
  pb_schema.json
  pb_data/types.d.ts
  types.d.ts
```

이 구조 덕분에 "이 책임이 페이지인지", "레이아웃 없는 상호작용인지", "내부 partial/service인지"를 경로만 보고 구분할 수 있습니다.

## VS Code PocketPages 확장이 해주는 일

이 레포의 `tools/vscode-pocketpages`는 일반적인 JavaScript 자동완성 플러그인이 아닙니다.
PocketPages 문맥 자체를 이해해서, 실제로 자주 헷갈리는 지점을 편집기 단계에서 바로 잡아주는 것이 목적입니다.

### 1. `<script server>`와 EJS 템플릿을 같이 이해합니다

- PocketPages 전역(`meta`, `redirect`, `resolve`, `request`, `response`, `dbg`) 자동완성
- `<script server>` 내부 completion, hover, signature help, diagnostics
- EJS 태그(`<% %>`, `<%= %>`, `<%- %>`) 안에서도 completion, hover, definition 지원
- 템플릿에서 `<script server>`에 선언한 값으로 바로 정의 이동 가능

즉, `.ejs`를 단순 HTML 파일이 아니라 "서버 코드와 템플릿이 섞인 PocketPages 문서"로 취급합니다.

### 2. 경로와 모듈 연결을 따라갈 수 있게 해줍니다

- `resolve()` 경로 자동완성 및 정의 이동
- `include()` partial 경로 자동완성 및 정의 이동
- `PocketPages: All File References` 명령으로 partial/include, private module resolve+require, static route 링크 역참조 지원
- `href`, `action`, `hx-*`, `redirect()`의 정적 라우트 문자열 자동완성 및 정의 이동
- `resolve()`로 불러온 CommonJS 모듈 export 멤버에 대한 definition, references, rename 지원
- `_private`/route 파일 상단 CodeLens와 에디터 우클릭 `All File References` 명령 지원

즉, 문자열 기반으로 흩어지기 쉬운 PocketPages 경로와 `_private` 모듈 연결을 "이동 가능한 구조"로 바꿔줍니다.

### 3. PocketBase 스키마를 기반으로 실수를 줄입니다

- `pb_schema.json` 기반 컬렉션명 자동완성
- 존재하지 않는 컬렉션 이름 경고
- `record.get('fieldName')` 필드명 자동완성
- 존재하지 않는 필드 이름 경고

즉, 단순 문자열 오타가 런타임까지 가지 않도록 편집기에서 바로 잡습니다.

### 4. `_private` partial locals 흐름도 추적합니다

- `include('...', { ... })`로 넘긴 locals 이름을 partial 안에서 추적
- partial 내부 locals completion, hover, diagnostics 지원
- object literal 기반 전달 값을 따라가며 기본 타입까지 추론

이 기능 덕분에 partial이 "무슨 값을 받아 렌더링하는지"를 호출부와 partial 양쪽에서 같이 확인할 수 있습니다.

### 5. 이 레포 규칙 자체를 진단합니다

확장은 문법 검사만 하지 않고, 이 저장소의 AGENTS 규칙도 일부 반영합니다.

- `params.foo`를 query string처럼 읽는 패턴 경고
- `resolve('/_private/...')`, `resolve('_private/...')` 경고
- `?__flash=...`를 수동으로 붙이는 패턴 경고
- partial에 `api`, `request`, `response`, `resolve`, `params`, `data` 같은 전체 컨텍스트를 통째로 넘기는 패턴 경고
- 일부 항목은 quick fix 제공

즉, 단순 코드 스타일이 아니라 "이 레포에서 유지하려는 구조"를 편집기에서 강제하는 역할을 합니다.

### 6. CLI 진단과도 연결됩니다

루트의 `./task.sh diag`는 `tools/vscode-pocketpages`의 language service를 그대로 사용합니다.
즉, VS Code에서 보이는 PocketPages 진단을 터미널에서도 재현할 수 있습니다.

추가 설명과 설치 방법은 `tools/vscode-pocketpages/README.md`를 보면 됩니다.

## 기본 작업 흐름

Windows 환경에서는 Git Bash 기준으로 아래 흐름을 쓰면 됩니다.

```bash
./task.sh start sample
./task.sh lint sample
./task.sh diag sample
./task.sh verify sample
```

각 명령의 의미는 다음과 같습니다.

- `start`: 서비스 실행
- `lint`: 레포 구조 규칙과 PocketPages 패턴 검사
- `diag`: VS Code PocketPages 진단과 최대한 동일한 결과 확인
- `verify`: `lint`와 `diag`를 함께 실행

즉, 이 레포의 검증은 "일반 JS 린터"보다 "PocketPages 구조와 편집기 경험이 실제로 맞는가"에 더 가깝습니다.

## VS Code 확장 로컬 실행

확장 자체를 수정하거나 로컬에서 설치해 쓰려면 아래 순서로 진행합니다.

```bash
cd tools/vscode-pocketpages
npm install
npm run sanity-check
npm run package:vsix
npm run install:vscode-pocketpages
```

설치 후에는 VS Code에서 `Developer: Reload Window`를 실행해야 새 코드가 반영됩니다.

## 배포 예시

이 레포는 빌드 아티팩트 업로드보다 `pb_hooks` 동기화 흐름에 더 잘 맞습니다.
아래는 서비스별 `pb_hooks`를 원격 서버에 맞춰 올리는 `sftp.json` 예시입니다.

```json
[
  {
    "name": "kjca",
    "host": "146.56.177.250",
    "protocol": "sftp",
    "port": 22,
    "username": "ubuntu",
    "privateKeyPath": "~/.ssh/ssh-key-2023-04-17-DOCKER.key",
    "context": "apps/kjca/pb_hooks",
    "remotePath": "/path/to/kjca/hooks",
    "connectTimeout": 100000,
    "syncOption": {
      "delete": true
    }
  }
]
```

## 문서를 읽는 순서

- 이 레포 전체 방향: `README.md`
- 저장소 작업 규칙: `AGENTS.md`
- PocketPages 편집기 지원 상세: `tools/vscode-pocketpages/README.md`
- 서비스별 스키마와 JSVM 타입: `apps/<service>/pb_schema.json`, `apps/<service>/pb_data/types.d.ts`

# pocketpages-monorepo

> AI 에이전트 안내: 이 문서를 작업 기준으로 사용하지 말고 먼저 `AGENTS.md`를 확인하세요.

| 구분                | PocketPages (SSR)       |
| ------------------- | ----------------------- |
| 목적                | 빠른 MVP                |
| 핵심가치            | AI 에이전트 협업        |
| 백엔드              | PocketPages (PB)        |
| 프론트엔드          | HTMX, Alpine.js         |
| 템플릿/UI           | EJS                     |
| CSS                 | UnoCSS (Tailwind)       |
| 상태관리            | PB Native Context       |
| 라우팅              | 파일 시스템 (Auto)      |
| DB                  | SQLite (PB)             |
| DB 관리             | PB Admin                |
| DB <br>마이그레이션 | PB Migration            |
| DB 복제/복원        | Litestream, LiteFS      |
| 인증                | PB Auth + (Cookie)      |
| 인가                | 서버 로직               |
| 객체 저장           | File, AWS S3            |
| 스케줄 작업         | PB cron                 |
| 메시지 큐           | X                       |
| 캐시                | Memory / Server (Store) |
| 웹 서버             | Caddy                   |
| 서버리스 함수       | Cloudflare Workers      |
| 모니터링            | PB Admin Logs           |
| 로깅                | PB Logs                 |
| 린팅                | custom script           |
| 테스트              | node test (http only)   |
| 빌드 과정           | 불필요                  |
| 배포 방식           | 파일 동기화 (PB 전송)   |
| 모바일              | PWA => Capacitor        |
| 푸시/알림           | FCM / OneSignal         |

---

## 메인 확장 단계

| 단계               | 구조                                        | 목적                    | 다음 신호                            |
| ------------------ | ------------------------------------------- | ----------------------- | ------------------------------------ |
| 1. MVP 검증        | `PocketPages + PocketBase(SQLite)`          | 가장 빠른 출시와 검증   | 운영 부담, 데이터 증가 체감          |
| 2. 초기 성장       | `동일 구조 + 수직 확장`                     | 구조 변경 없이 버티기   | 백업/복구, 쓰기 경쟁, 단일 서버 한계 |
| 3. 저장소 확장     | `PocketPages + PocketBase(PostgreSQL 포크)` | DB/운영 한계 완화       | 캐시, 큐, 락, 비동기 작업 필요 증가  |
| 4. 플랫폼 보강     | `PostgreSQL 포크 + Go 확장 + Redis/큐/S3`   | 플랫폼 레이어 추가      | 특정 도메인이 너무 무거워짐          |
| 5. 하이브리드 분리 | `PocketPages + 병목 도메인만 Go 분리`       | 필요한 부분만 점진 분리 | PocketBase 비중이 작아짐             |
| 6. Go 중심 전환    | `핵심 백엔드 Go 중심`                       | 장기 구조 정리          | 조직/운영 요구가 더 커짐             |

---

## 가로 보조 확장 트랙

- 아래 트랙은 `1~4단계` 어디서든 필요할 때 꺼내 쓰는 보조 수단입니다.

| 트랙                     | 언제                               | 용도                           | 장점                 | 주의점                 |
| ------------------------ | ---------------------------------- | ------------------------------ | -------------------- | ---------------------- |
| A. 순수 JS 라이브러리    | JSVM에서 바로 가능할 때            | 파싱, 검증, 유틸               | 가장 단순함          | JSVM 호환성            |
| B. Go 확장 + JSVM 바인딩 | PocketBase 내부와 강하게 연결될 때 | Redis, 큐, 락, 내부 함수       | 내부 제어 강함       | 유지보수 책임 증가     |
| C. 외부 서버리스 함수    | 본체에서 분리하고 싶을 때          | 브라우저 자동화, 무거운 런타임 | 실패 격리, 독립 배포 | 네트워크 홉, 외부 운영 |

---

## 순수 JS 라이브러리 후보

| 라이브러리          | 용도                                               | 번들러 필요 |
| ------------------- | -------------------------------------------------- | ----------- |
| `fflate`            | ZIP/EPUB 압축 해제, 바이너리 압축 데이터 처리      | X           |
| `fast-xml-parser`   | EPUB 내부 XML, OPF, container.xml 같은 구조 파싱   | X           |
| `papaparse`         | CSV 파싱, CSV 확장자 파일 업로드/가져오기 처리     | X           |
| `node-html-parser`  | HTML 파싱, 본문/메타 추출, 간단한 DOM 탐색         | X           |
| `html-to-text`      | HTML을 구조 있는 텍스트로 변환, 본문 분석 전처리   | O           |
| `linkify-it`        | 본문 URL 탐지, 링크 후보 추출                      | X           |
| `sentence-splitter` | 문장 단위 분리, 텍스트 후처리                      | X           |
| `he`                | HTML entity 인코딩/디코딩                          | X           |
| `fuse.js`           | 클라이언트/서버 간단 검색, 퍼지 매칭               | X           |
| `dayjs`             | 날짜 포맷, 표시용 문자열 처리, 간단한 날짜 계산    | X           |
| `slugify`           | slug 문자열 생성, URL 친화적인 식별자 변환         | X           |
| `lodash`            | 배열/객체/문자열 처리를 위한 범용 JS 유틸리티      | X           |
| `validator`         | 이메일, URL, 숫자/문자열 같은 문자열 단위 검증     | X           |
| `qs`                | 중첩 query string 파싱, 배열/객체 형태 쿼리 직렬화 | X           |
| `zod`               | form/body/query 입력값 런타임 검증                 | X           |

- 현재 실측 기준으로 번들러가 필요했던 케이스는 `html-to-text`만 확인됨
- `qs`: PocketBase JSVM에서는 `6.9.7` exact pin + `require('qs')` 기준으로 사용
- `lodash`: 전체 import보다 메서드별 경로 import 방식(`per-method import`) 권장
  ```js
  const get = require('lodash/get')
  const debounce = require('lodash/debounce')
  const isEmpty = require('lodash/isEmpty')
  ```

---

## 공용 스크립트

- 실행 환경: Windows Git Bash 기준

```bash
./task.sh start <service> [-- <extra args>]
./task.sh kill
./task.sh deploy <service>
./task.sh rollback <service> <version>
./task.sh test [service]
./task.sh lint [service]
./task.sh diag [file-or-service]
./task.sh verify [service]
./task.sh index <service> [--section <name>] [--file <relative-path>] [--json|--pretty]
./task.sh bundle
./task.sh format [-- <extra args>]
```

- `start`: 서비스 실행
- `kill`: 실행 중 프로세스 종료
- `deploy`: 서비스 배포
- `rollback`: 배포 롤백
- `test`: 테스트 실행
- `lint`: 린트 실행
- `diag`: 진단 실행
- `verify`: 린트 + 진단 실행
- `index`: 프로젝트 인덱스 조회
- `bundle`: vendor 번들링
- `format`: 포맷 실행

---

## vscode-pocketpages 설치

```bash
npm --prefix tools/vscode-pocketpages run install:vscode-pocketpages
```

---

## 웹 서버

- 웹 서버: Caddy
- HTTPS: Caddy에서 자동 처리
- 운영 설정: 보안, 압축, 헤더, 타임아웃, body size 제한은 앞단에서 관리

---

## 운영 DB 클라이언트

- 도구: Adminer
- 용도: 운영 DB 조회 및 쿼리 실행

---

## SQLite 복제/복원

- 기본 복제/복원: Litestream
- 장기 운영 확장 옵션: LiteFS (분산 읽기)

---

## SMTP

- 솔루션: Resend
- 추가 후보: AWS SES

---

## Cloudflare Workers

- 용도: 브라우저 자동화, 추가 라이브러리 의존 동작

---

## SFTP 배포 방법

- 도구: VS Code SFTP 확장
- 명령: `SFTP: Sync Local -> Remote`

```json
[
  {
    "name": "kjca-hooks",
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
  },
  {
    "name": "kjca-public",
    "host": "146.56.177.250",
    "protocol": "sftp",
    "port": 22,
    "username": "ubuntu",
    "privateKeyPath": "~/.ssh/ssh-key-2023-04-17-DOCKER.key",
    "context": "apps/kjca/pb_public",
    "remotePath": "/path/to/kjca/public",
    "connectTimeout": 100000,
    "syncOption": {
      "delete": true
    }
  },
  {
    "name": "booklog-hooks",
    "host": "146.56.177.250",
    "protocol": "sftp",
    "port": 22,
    "username": "ubuntu",
    "privateKeyPath": "~/.ssh/ssh-key-2023-04-17-DOCKER.key",
    "context": "apps/booklog/pb_hooks",
    "remotePath": "/path/to/booklog/hooks",
    "connectTimeout": 100000,
    "syncOption": {
      "delete": true
    }
  },
  {
    "name": "booklog-public",
    "agent": "",
    "host": "146.56.177.250",
    "protocol": "sftp",
    "port": 22,
    "username": "ubuntu",
    "privateKeyPath": "~/.ssh/ssh-key-2023-04-17-DOCKER.key",
    "context": "apps/booklog/pb_public",
    "remotePath": "/path/to/booklog/public",
    "connectTimeout": 100000,
    "syncOption": {
      "delete": true
    }
  }
]
```

---

## Git 확장 도구 설치/업데이트

### 설치

```shell
scoop bucket add extras
scoop install delta
scoop install lazygit
```

### 업데이트

```shell
scoop update
scoop update delta
scoop update lazygit
```

---

## nvm 설치 후 global 패키지 의존성 설치

@google/gemini-cli @openai/codex firebase-tools gemini-commit-assistant pnpm ts-node tsx

```shell
node -e "console.log(Object.keys(JSON.parse(require('child_process').execSync('npm list -g --depth=0 --json').toString()).dependencies).join('\n'))"
node -e "console.log(Object.keys(JSON.parse(require('child_process').execSync('npm list -g --depth=0 --json').toString()).dependencies).join(' '))"
```

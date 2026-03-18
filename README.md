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

## 순수 JS 라이브러리 후보

| 라이브러리         | 용도 |
| ------------------ | ---- |
| `fflate`           | ZIP/EPUB 압축 해제, 바이너리 압축 데이터 처리 |
| `fast-xml-parser`  | EPUB 내부 XML, OPF, container.xml 같은 구조 파싱 |
| `papaparse`        | CSV 파싱, CSV 확장자 파일 업로드/가져오기 처리 |
| `dayjs`            | 날짜 포맷, 표시용 문자열 처리, 간단한 날짜 계산 |
| `slugify`          | slug 문자열 생성, URL 친화적인 식별자 변환 |
| `he`               | HTML entity 인코딩/디코딩 |
| `validator`        | 이메일, URL, 숫자/문자열 같은 문자열 단위 검증 |
| `zod`              | form/body/query 입력값 런타임 검증 |

---

## 공용 스크립트

- 실행 환경: Windows Git Bash 기준

```bash
./task.sh start sample
./task.sh kill
./task.sh test sample
./task.sh lint sample
./task.sh diag sample
./task.sh verify sample
./task.sh format
```

- `start`: 서비스 실행
- `kill`: 실행 중인 `pocketbase` / `pbw` 프로세스 종료
- `test`: 서비스별 `__tests__` 아래 `node:test` 실행
- `lint`: 레포 구조 규칙과 PocketPages 패턴 검사
- `diag`: PocketPages 코드 파일(`.ejs`, `.js`, `.cjs`, `.mjs`) 진단 실행
- `verify`: `lint`와 `diag`를 함께 실행
- `format`: 루트 `npm run format` 실행

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

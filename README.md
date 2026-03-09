# pocketpages-monorepo

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

## sftp.json

```json
{
  "name": "kjca",
  "host": "146.56.177.250",
  "protocol": "sftp",
  "port": 22,
  "username": "ubuntu",
  "privateKeyPath": "~/.ssh/ssh-key-2023-04-17-DOCKER.key",
  "context": "apps/kjca/pb_hooks",
  "remotePath": "/path/to/kjca/hooks",
  "connectTimeout": 100000
}
```

# Reader browser tests

실제 리더 템플릿, 브라우저 자산, epub.js를 실행합니다. 서버 API는 로컬 라우트로 모킹하며 실제 DB에 쓰지 않습니다.

저장소 루트에서 서비스에 설치된 Playwright CLI를 사용합니다.

```powershell
node apps/booklog/node_modules/playwright/cli.js test --config=apps/booklog/playwright.config.mjs --output=.cache/booklog-reader-tests --trace=retain-on-failure
```

## Scroll stress

```powershell
node apps/booklog/node_modules/playwright/cli.js test --config=apps/booklog/playwright.config.mjs --grep='Scroll stress' --output=.cache/booklog-scroll-stress --trace=retain-on-failure
```

같은 조건을 반복하려면 `--repeat-each=2`를 추가합니다. 난수 시나리오는 테스트 이름의 고정 seed로 재현할 수 있습니다.

로컬 EPUB을 추가로 검사하려면 파일 경로를 지정합니다. 파일 자체는 저장소에 포함하지 않습니다.

```powershell
$env:BOOKLOG_SCROLL_EPUB = 'C:/path/to/book.epub'
node apps/booklog/node_modules/playwright/cli.js test --config=apps/booklog/playwright.config.mjs --grep='Scroll stress|Supplied EPUB|Reading slowly' --output=.cache/booklog-scroll-fixture --trace=retain-on-failure
```

`BOOKLOG_READER_SCRIPT`에 비교할 이전 리더 JS 경로를 지정하면 동일한 테스트로 수정 전후를 비교할 수 있습니다.
`BOOKLOG_EPUB_SCRIPT`에는 비교할 이전 epub.js 번들 경로를 지정할 수 있습니다. 로컬 번들의 변경 내역은 `pb_hooks/pages/assets/vendor/epubjs-0.3.93.booklog.md`에 기록합니다.

### 검사 조건

- 1px 경계 이동, 느린 읽기, 빠른 챕터 이동, 3,600px 연속 입력
- 최대 2.2초 챕터 읽기 지연, 서로 다른 길이의 챕터, 320×640 화면
- Chromium CPU 6배 감속과 실제 브라우저 터치 입력 합성
- 고정 seed 3종의 속도·방향 변경과 이전 챕터 이미지 높이 변경
- 선택적 로컬 EPUB의 챕터 왕복 이동

스크롤 중 `requestAnimationFrame`마다 표시 문단과 좌표를 기록합니다. 같은 방향에서 12px를 초과하는 역방향 이동과 문단 순서 역전을 검사합니다. 반대 방향 입력 전환 직후 120ms는 관성 전환을 고려해 역방향 판정에서 제외하지만 원본 프레임은 기록합니다.

로딩 종료 후 읽던 문단이 유지되는지, 1.2초 추가 대기 중 위치 변화가 3px 이내인지 확인합니다. 여러 챕터 이동 시 실제로 방문한 챕터 수도 검사합니다. 표시 중인 챕터가 정리 작업으로 파괴되면 실패합니다. 표시 가능한 iframe이 없는 상태가 5초 이상 지속되면 실패합니다. 이 기준은 순간적인 빈 화면이나 프레임 지연이 전혀 없다는 의미는 아닙니다.

테스트 결과의 `stress-observations.json`에 입력 계획, 프레임 좌표, 챕터 로딩 및 이동 기록이 남습니다. 실패 시 스크린샷과 Playwright trace도 남습니다.

### 한계

Windows WebKit은 실제 iPhone Safari가 아닙니다. 휠 검사는 WebKit 데스크톱 엔진과 모바일 크기 화면에서 실행하며, 터치 합성은 Chromium CDP만 사용합니다. iPhone의 관성·바운스, 메모리 압박, OS에 의한 백그라운드 정지는 실기기에서 별도로 확인해야 합니다.

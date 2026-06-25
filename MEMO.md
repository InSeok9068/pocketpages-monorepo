# vscode-pocketpages LSP 전수조사 가이드

이 문서는 `tools/vscode-pocketpages` LSP를 다음에도 다른 에이전트가 같은 기준으로 꼼꼼히 검토할 수 있게 만든 실행 프롬프트다.

목표는 코드 스타일 리뷰가 아니다. 실제 사용자가 VS Code에서 PocketPages `.ejs` / `pb_hooks` 파일을 편집할 때 LSP가 어떻게 동작하는지, completion / diagnostics / hover / definition / references / rename / file watching / cache가 호출 계약과 성능 요구에 맞는지 확인한다.

중요한 전제:

- 이 문서의 사전 판단을 정답으로 취급하지 않는다.
- 코드에서 "fallback이 없다", "동기 스캔이 있다" 같은 사실을 발견해도 바로 심각도로 환산하지 않는다.
- 심각도는 코드 사실, 발생 조건, 실제 사용자 체감 가능성, 재현 가능성을 분리해서 판단한다.
- 관측되지 않은 위험은 추측이라고 표시한다.
- 이전 에이전트의 결론이나 README 문구도 반드시 코드와 테스트로 재검증한다.

## 1. 조사 범위 확정

먼저 파일 목록을 만든다.

```bash
rg --files --hidden tools/vscode-pocketpages -g '!node_modules/**' -g '!dist/**' -g '!*.vsix'
```

반드시 확인할 1차 범위:

- `tools/vscode-pocketpages/package.json`
- `tools/vscode-pocketpages/.vscodeignore`
- `tools/vscode-pocketpages/.gitignore`
- `tools/vscode-pocketpages/README.md`
- `tools/vscode-pocketpages/packages/**`
- `tools/vscode-pocketpages/scripts/**`
- `tools/vscode-pocketpages/.vscode/**`

읽지 않아도 되는 범위와 이유:

- `tools/vscode-pocketpages/node_modules/**`: 외부 dependency 설치물
- `tools/vscode-pocketpages/dist/**`: 빌드 산출물 또는 packaged artifact
- `*.vsix`: 패키징 결과물
- `tools/vscode-pocketpages/images/icon.png`: 바이너리 아이콘. 존재와 패키징 참조만 확인
- `package-lock.json`: dependency 상태와 lockfile 존재 확인용. dependency 이슈가 아니라면 package metadata 중심으로 확인

제외한 파일은 최종 보고서에 반드시 적는다. 단, 제외는 위처럼 생성물/외부 dependency/바이너리에 한정한다. first-party JS, 설정, 문서, 테스트 스크립트는 작아 보여도 모두 확인한다.

## 2. 먼저 전체 구조를 잡기

파일을 무작정 순서대로만 읽지 말고, 아래 흐름 단위로 묶어서 본다. 같은 흐름에 속한 함수는 서로 호출 계약이 맞는지 함께 검증한다.

### VS Code client / server bootstrap

- `packages/vscode-pocketpages/index.js`
- `packages/language-server/server.js`
- `packages/language-server/protocol.js`
- `package.json`
- `.vscodeignore`

확인할 것:

- activation event가 의도한 시점에만 발생하는가
- LSP client/server 연결과 command/request/notification 이름이 일치하는가
- file watcher가 어떤 path를 보고 어떤 payload를 server에 보내는가
- extension host fallback, legacy path, duplicate runtime이 남아 있지 않은가
- package entry와 packaged files가 실제 구조와 맞는가

### document lifecycle / runtime state

- `packages/language-server/services/lifecycle-features.js`
- `packages/language-server/document-runtime-state.js`
- `packages/language-server/request-coordinator.js`
- `packages/language-service/language-service.js`
- `packages/language-service/document-snapshot-manager.js`
- `packages/language-core/language-core.js`
- `packages/language-core/snapshot.js`

확인할 것:

- open/change/close/save 경로에서 document version과 text snapshot이 일관적인가
- change handler가 매 입력마다 비싼 rebuild를 하는지, lazy prepare인지 코드로 확인한다
- stale request가 최신 결과를 덮을 수 있는가
- close 후 document/cache가 정리되는가
- manual save, reload cache, diagnostics refresh가 현재 열린 문서 text를 보존하는가

### parser / virtual code / source mapping

- `packages/language-core/script-server.js`
- `packages/language-core/ejs-template.js`
- `packages/language-core/virtual-code.js`
- `packages/language-core/custom-context.js`
- `packages/language-core/ejs-server-boundary.js`
- `packages/language-core/language-plugin.js`
- `packages/language-service/document-analysis.js`
- `packages/language-service/flow-analysis.js`

확인할 것:

- `<script server>`와 EJS template block을 같은 기준으로 다루는가
- generated offset과 source offset mapping이 깨질 수 있는가
- HTML comment, malformed script tag, nested EJS, partial setup 같은 boundary case가 있는가
- parser 결과가 diagnostics/completion/navigation에서 같은 전제로 쓰이는가

### completion

- `packages/language-server/server.js`
- `packages/language-server/services/completion-helpers.js`
- `packages/language-server/services/custom-features.js`
- `packages/language-server/services/ts-features.js`
- `packages/language-service/features/completion-features.js`
- `packages/language-service/language-service.js`
- `packages/language-service/project-index.js`

확인할 것:

- custom completion과 TypeScript completion의 우선순위가 의도와 맞는가
- trigger character routing이 HTML/EJS path completion과 TS completion을 잘 분리하는가
- completion cache key가 uri/version/offset/triggerKind/triggerCharacter를 충분히 반영하는가
- near-cache는 같은 version + incomplete retrigger 같은 좁은 조건에서만 재사용되는가
- path completion이 cache miss에서 동기 graph scan을 하는지, 그 조건이 실제 체감될 정도인지 판단한다
- label 중복은 LSP 내부 중복인지 VS Code의 다른 provider와 병합된 UI 중복인지 구분한다

### diagnostics / code actions

- `packages/language-server/services/diagnostics-features.js`
- `packages/language-service/features/diagnostics-features.js`
- `packages/language-service/flow-analysis.js`
- `packages/language-service/project-index.js`
- `packages/language-server/document-runtime-state.js`
- `packages/language-server/request-coordinator.js`

확인할 것:

- pull diagnostics resultId가 document snapshot identity와 맞는가
- unchanged result가 stale diagnostics를 숨기지 않는가
- large EJS partial diagnostics와 full diagnostics 전환 조건이 의도와 일치하는가
- `budgetDeferred` / provisional resultId / `finalResultId` 의도가 맞는지 확인한다
- code action이 캐시된 diagnostics를 사용할 수 있는 상황에서 재계산하지 않는가
- diagnostics cancellation과 document version check가 최신 결과만 반환하게 하는가

### navigation / rename / document links / symbols / semantic tokens / inlay hints

- `packages/language-server/services/custom-features.js`
- `packages/language-server/services/ts-features.js`
- `packages/language-server/services/structure-features.js`
- `packages/language-server/ejs-semantic-tokens.js`
- `packages/language-service/features/navigation-features.js`
- `packages/language-service/language-service.js`
- `packages/language-service/project-index.js`

확인할 것:

- custom path definition/reference와 TS fallback의 우선순위가 맞는가
- file rename edit가 include/resolve/require/asset/route path를 과잉 또는 누락 없이 수정하는가
- 같은 caller 파일에 중복 path가 있을 때 모두 수정하는가
- comment/string literal false positive가 없는가
- semantic token 범위가 README의 설명과 실제 구현이 일치하는가
- inlay hint가 schema 추론과 무관한 `.get()`에는 붙지 않는가

### workspace index / file watching / cache

- `packages/language-service/project-index.js`
- `packages/language-service/project-index-report.js`
- `packages/language-service/service-manager.js`
- `packages/language-service/stat-cache.js`
- `packages/language-server/services/lifecycle-features.js`
- `packages/language-server/services/maintenance-features.js`
- `packages/vscode-pocketpages/index.js`

확인할 것:

- app root, pages root, `_private`, route, asset, schema, pb_data types 탐색 기준이 일관적인가
- watched create/change/delete가 app-scoped invalidation으로 이어지는가
- partial invalidation과 full invalidation의 적용 범위가 호출 목적과 일치하는가
- Windows path separator, drive-letter case, URI encode/decode가 깨지지 않는가
- LSP project index와 TypeScript plugin의 watcher/scan fallback 차이를 혼동하지 않는다
- watcher 누락 가능성은 "코드상 fallback 부재"와 "실제로 자주 발생함"을 분리해서 판단한다

### TypeScript plugin

- `packages/typescript-plugin/index.js`
- `packages/typescript-plugin/shared.js`
- `packages/typescript-plugin/package.json`
- `scripts/sync-ts-plugin-package.js`

확인할 것:

- TS plugin이 `.ejs` fileName, external files, quick info, rename, references를 어떻게 가로채는가
- plugin watcher와 tracked file list scan window가 정상 동작하는가
- LRU cleanup과 dispose가 watcher를 닫는가
- LSP service cache와 plugin document cache의 invalidation 경계가 명확한가

### tests / scripts / docs

- `scripts/sanity-check.js`
- `scripts/extension-host-sanity.js`
- `scripts/install-vscode-pocketpages.js`
- `scripts/sync-ts-plugin-package.js`
- `README.md`

확인할 것:

- sanity test가 실제 LSP 흐름을 방어하는지, 단순 문자열 테스트뿐인지 구분한다
- 테스트가 이미 방어하는 영역과 빠진 영역을 분리한다
- 문서가 구현보다 과장되어 있거나 구현과 다른지 확인한다
- 설치/패키징 스크립트가 현재 package 구조와 맞는지 확인한다

## 3. 검증 명령

`tools/vscode-pocketpages`에서 실행 가능한 명령을 먼저 `package.json`으로 확인한다. 없는 script를 있다고 가정하지 않는다.

기본 확인:

```bash
npm test
```

가능하면 추가 확인:

```bash
node scripts/extension-host-sanity.js
```

필요하면 first-party JS syntax check:

```bash
node --check <file>
```

`npm run build`, `npm run typecheck`, `npm run lint`는 script가 있을 때만 실행한다. script가 없으면 "없어서 실행하지 않음"이라고 보고한다.

`npm install`은 dependency 상태가 깨졌거나 lockfile 기준 설치 확인이 필요할 때만 한다. 이미 `node_modules`가 있고 테스트가 돌면 실행 여부와 이유를 명시한다.

## 4. 성능 판단 기준

성능 문제는 "느릴 수 있다"가 아니라 실제 사용자 체감 가능성으로 판단한다.

주요 워크로드 기준:

- 일반 프로젝트: `pb_hooks/pages` 아래 100~150개 first-party 파일
- 큰 프로젝트: 수백 개 이상의 pages/partials/assets
- 큰 EJS: 긴 `<script server>`와 template block이 섞인 파일
- cold path: extension 시작 직후, reload cache 직후, file create/delete/rename 직후 첫 요청
- hot path: 사용자가 타이핑하면서 completion/diagnostics가 반복 요청되는 상황

확인할 비용:

- document change마다 전체 workspace scan이 있는가
- completion 요청마다 parser, graph scan, fs read가 반복되는가
- diagnostics가 너무 자주 full analysis로 들어가는가
- cache hit/miss 전략이 있는가
- cancellation이 실제로 expensive loop 중간에 먹히는가, 아니면 TS host 호출에만 연결되는가
- Map/Set/cache가 열린 문서나 app root 단위로 정리되는가

성능 이슈를 올릴 때는 반드시 조건을 적는다.

예:

- "항상 느림"인지
- "캐시 miss 첫 요청만 느림"인지
- "큰 pages tree + 파일 변경 직후 path completion"인지
- "대형 EJS + recent edit + semantic budget"인지

## 5. 이슈 심각도 기준

심각도는 아래 기준으로만 매긴다.

- Critical: LSP 서버가 죽거나 핵심 기능이 넓은 범위에서 거의 동작하지 않음
- High: completion/diagnostics/definition 등 주요 기능이 일상적인 사용에서 자주 틀리거나 눈에 띄게 느림
- Medium: 특정 조건에서 실제 사용자가 체감 가능한 오동작 또는 성능 저하
- Low: 제한적인 DX 품질 문제, 또는 조건이 좁고 영향이 작은 문제
- No action: 코드상 개선 여지는 있으나 실사용 영향, 수정 리스크, 변경 비용을 고려하면 현재 수정 대상이 아님

주의:

- "코드에 fallback이 없음"은 심각도 근거의 일부일 뿐이다.
- "대형 LSP는 보통 이렇게 함"은 참고 근거일 뿐, 이 프로젝트에서 실제 문제가 된다는 증거가 아니다.
- Critical/High는 재현 경로 또는 매우 강한 코드 근거가 있을 때만 쓴다.
- 실사용 벤치나 재현 결과가 있으면 그 결과를 코드 판단과 분리해서 함께 적는다.

## 6. 중립성 원칙

조사자는 특정 결론을 미리 전제하지 않는다. 이 문서는 어디를 봐야 하는지 알려주는 구조 가이드일 뿐이다.

- "문제가 있다"와 "문제가 없다"를 모두 코드 근거로만 말한다.
- 특정 패턴이 일반적으로 위험하더라도 이 코드베이스에서 실제로 위험한지 따로 확인한다.
- 특정 패턴이 일반적으로 허용되는 패턴이라도 이 코드베이스에서 호출 조건과 캐시 조건이 맞는지 따로 확인한다.
- 이슈를 적을 때는 "코드 사실", "발생 조건", "사용자 영향", "실측 여부"를 분리한다.
- 수정 제안은 반드시 회귀 위험과 유지보수 비용을 함께 적는다.

## 7. 비교 참고 코드베이스

아래 프로젝트들은 널리 사용되는 LSP/언어 도구다. 참고 목적은 "이 프로젝트도 똑같이 바꿔야 한다"가 아니라 유사한 문제를 어떤 구조로 다루는지 비교하는 것이다.

- TypeScript / tsserver: project service, language service host, document snapshot, incremental program reuse
- Vue / Volar: embedded document, source map, template/script 분리, plugin-based language feature routing
- Svelte language tools: mixed template/script/style 처리, generated TypeScript, diagnostics/source mapping
- rust-analyzer: query 기반 incremental analysis, cancellation, snapshot, diagnostics scheduling
- gopls: workspace/package metadata, file watching, debounce, diagnostics and cache invalidation

비교할 때 지킬 원칙:

- 일반론을 길게 설명하지 말고 `vscode-pocketpages`에 실제로 적용 가능한 차이만 적는다.
- 큰 LSP의 구조를 그대로 복사하자는 제안은 피한다.
- 같은 문제를 어떻게 줄이는지 확인하되, 현재 코드의 규모와 요구사항에 비해 과한지 판단한다.
- "대형 LSP도 이렇게 한다"는 말만으로 이슈 심각도를 올리지 않는다.
- 참고할 구조를 발견했다면 그 구조가 이 코드의 어떤 함수/캐시/호출 계약에 대응되는지 연결해서 설명한다.

## 8. 최종 보고서 형식

최종 보고서는 아래 순서로 작성한다.

### A. 전체 결론

- 현재 LSP가 기능 안정성과 성능 면에서 어떤 수준인지 한 문단으로 판단
- "지금 바로 고쳐야 할 것"이 있는지 명확히 말한다

### B. 확인 범위

- 실행한 파일 목록 명령
- 읽은 first-party 파일 목록
- 제외한 파일 목록과 제외 이유
- 실행한 명령과 결과
- 실행하지 못한 명령과 이유

### C. 아키텍처 요약

아래 흐름 단위로 짧게 정리한다.

- VS Code client
- language server
- document lifecycle
- parser / virtual code / source mapping
- completion
- diagnostics / code actions
- navigation / rename / references
- workspace index / cache
- file watching
- TypeScript plugin
- tests / packaging

### D. 주요 이슈 목록

각 이슈는 반드시 아래 형식으로 작성한다.

- 심각도
- 파일/함수 위치
- 코드 사실
- 문제 설명
- 실제 사용자 영향
- 발생 조건
- 재현 가능성
- 성능 영향 여부
- 이미 테스트가 방어하는지 여부
- 메이저 LSP에서는 보통 어떻게 대응하는지
- 수정 방향
- 수정하지 않을 경우의 판단

### E. 캐싱/DX 평가

- cache invalidation 안정성
- document version 처리
- async/cancellation race 가능성
- completion 정확도와 중복 여부
- diagnostics 최신성
- watcher 누락 시 stale 가능성
- Windows/URI/path 안정성
- 사용자가 느림/틀림/깜빡임/오래된 추천으로 체감할 가능성

### F. 성능 평가

- hot path 비용
- cold cache 비용
- 파일 I/O 반복 여부
- workspace scan 비용
- diagnostics scheduling
- memory/cache cleanup
- 100~150개 파일 규모 판단
- 더 큰 workspace에서의 위험

### G. 테스트 평가

- `sanity-check.js`가 방어하는 핵심 흐름
- `extension-host-sanity.js`가 방어하는 영역
- 테스트가 부족한 영역
- 추가할 가치가 있는 테스트
- 삭제할 가치가 있는 테스트
- 테스트 추가가 실익보다 변경 비용이 큰 경우 그 이유

### H. 수정 우선순위

- 지금 바로 고쳐야 하는 것
- 실제 관측 시 고칠 것
- 후순위 hardening
- 현재 수정 대상이 아닌 것
- 제거 후보가 있는지 여부

## 9. 최종 점검 질문

보고서를 끝내기 전에 아래 질문에 직접 답한다.

- client/server/parser/cache/completion/diagnostics/file watcher 흐름 중 안 읽은 연결이 있는가?
- 특정 파일 하나만 보고 전체 결론을 냈는가?
- "코드상 가능성"을 "실제 자주 발생"으로 과장하지 않았는가?
- 테스트가 이미 방어하는 문제를 새 이슈로 올리지 않았는가?
- 수정 제안이 실사용 개선보다 회귀 위험을 더 키우지는 않는가?
- 수정 또는 유지 판단이 코드 근거와 사용자 영향 근거에 맞는가?

보고서의 최종 톤은 단정적이어야 할 부분과 추측인 부분을 분리한다. 판단을 쓸 때는 근거가 코드인지, 테스트인지, 실측인지, 추정인지 함께 적는다.

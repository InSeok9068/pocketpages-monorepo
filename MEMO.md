/workspace/tools/vscode-pocketpages/ 경로의 vscode-pocketpages LSP 프로젝트를 기능 안정성과 성능 관점에서 전수 조사해줘.

목표는 단순 코드 스타일 리뷰가 아니라, 실제 사용자가 VSCode에서 PocketPages 파일을 편집할 때 LSP가 안정적으로 동작하는지, 자동완성/진단/hover/definition/file watching/cache가 정확하고 빠르게 동작하는지 검증하는 것이다.

반드시 다음 절차를 지켜줘.

1. 전체 파일 전수 조사

- 먼저 rg --files tools/vscode-pocketpages 로 전체 파일 목록을 만든다.
- 소스 코드, 설정 파일, 테스트, 문서, 빌드 설정, 샘플 파일을 모두 분류한다.
- 리뷰 대상에서 제외한 파일이 있으면 이유를 명시한다.
- 최종 보고서에 “확인한 파일 목록”과 “제외한 파일 목록”을 반드시 포함한다.
- 일부 파일만 읽고 전체 판단하지 말 것.

2. 기능 안정성 점검
   다음 기능이 실제 LSP 흐름에서 안정적으로 동작하는지 확인한다.

- VSCode extension activation
- client/server 연결
- document open/change/close 처리
- workspace 초기화
- file watch create/change/delete 처리
- completion
- diagnostics
- hover
- definition/reference
- semantic tokens 또는 symbol 처리
- configuration 변경 반영
- parser/AST 생성
- cache invalidation
- multi-root workspace
- Windows/macOS/Linux path 처리
- URI encoding/decoding 처리

각 기능에 대해 다음을 확인한다.

- 입력/출력 규약이 호출자와 맞는가
- null/undefined 예외 가능성이 있는가
- async race condition 가능성이 있는가
- document version을 무시해 오래된 결과가 최신 결과를 덮을 가능성이 있는가
- 파일 삭제/이름 변경 후 stale data가 남는가
- 사용자가 체감 가능한 오동작인가

3. 성능 점검
   특히 타이핑 중 LSP가 느려질 수 있는 구조가 있는지 본다.

- 문서 변경마다 전체 workspace를 다시 스캔하는지
- completion 요청마다 비싼 파싱/파일 I/O를 반복하는지
- diagnostics가 너무 자주 실행되는지
- debounce/throttle/scheduling이 적절한지
- cache hit/miss 전략이 있는지
- 큰 파일, 많은 파일, 다중 workspace에서 병목이 생기는지
- 동기 파일 I/O가 요청 핸들러 안에 있는지
- glob 검색, fs read, parser 실행이 반복 호출되는지
- 메모리 누수 가능성이 있는 Map/Set/cache가 있는지
- 오래된 document/cache가 정리되는지

성능 문제는 반드시 “실제 사용자 체감 가능성” 기준으로 판단한다.
예: 타이핑 지연, 자동완성 지연, 진단 깜빡임, CPU 과점유, 메모리 증가, VSCode extension host 부하.

4. 함수/모듈 계약 검증
   서로 연관된 모듈끼리 묶어서 본다.
   예:

- extension client ↔ language server
- document manager ↔ parser
- parser ↔ completion/diagnostics
- file watcher ↔ workspace index/cache
- config loader ↔ feature modules
- URI/path utility ↔ 모든 파일 접근 코드

각 그룹에서 다음을 검증한다.

- 함수가 기대하는 입력 타입과 실제 호출 값이 일치하는가
- 반환값이 호출자에서 안전하게 처리되는가
- 에러가 삼켜지거나 LSP 전체를 죽일 수 있는가
- 캐시 키가 URI/path/document version 기준으로 일관적인가
- 같은 데이터를 여러 모듈이 서로 다른 기준으로 캐싱하지 않는가

5. 메이저 LSP와 비교
   다음 LSP들이 보통 같은 문제를 어떻게 해결하는지 참고해서 비교한다.

- TypeScript/Volar: project service, virtual document, source map, incremental update
- Svelte LSP: mixed template/script/style 처리, generated code mapping
- Rust Analyzer: query 기반 캐시, incremental analysis, cancellation
- gopls: workspace/package analysis, diagnostics scheduling, file watching

비교는 일반론으로 길게 쓰지 말고, vscode-pocketpages에 실제로 적용 가능한 개선 방향 중심으로 작성한다.

6. 캐싱/DX 집중 점검
   특히 아래를 별도 섹션으로 깊게 본다.

- 문서 변경 후 parser cache가 정확히 무효화되는가
- completion이 오래된 AST나 오래된 workspace index를 참조하지 않는가
- diagnostics가 최신 문서 기준으로만 publish 되는가
- async diagnostics/completion 결과가 document version을 확인하는가
- 파일 생성/삭제/이름 변경 후 import/include/partial 참조가 갱신되는가
- 자동완성 후보가 중복되거나 순서가 불안정하지 않은가
- trigger character 처리와 cursor position 계산이 정확한가
- Windows 경로 구분자와 file URI 처리가 깨지지 않는가
- 사용자가 타이핑할 때 “느림, 틀림, 깜빡임, 오래된 추천”으로 체감될 가능성이 있는가

7. 검증 명령 실행
   가능하면 다음을 확인하고 실행한다.

- npm install 또는 현재 lockfile 기준 dependency 상태 확인
- npm run build
- npm run typecheck
- npm test
- lint 명령이 있으면 실행

실행하지 못한 명령은 이유를 적는다.
실행 결과에서 실패가 있으면 실패 원인과 관련 코드 위치를 연결해서 설명한다.

8. 이슈 분류 기준
   각 이슈는 반드시 아래 기준으로 분류한다.

- Critical: LSP 서버가 죽거나 핵심 기능이 거의 동작하지 않음
- High: 자동완성/진단/definition 등 주요 기능이 자주 틀리거나 느림
- Medium: 특정 조건에서 사용자가 체감 가능한 오동작 또는 성능 저하
- Low: 코드 품질 문제이나 사용자 영향은 제한적
- Not worth fixing: 실제 영향이 낮아 수정 우선순위가 낮음

작은 스타일 문제, 취향 문제, 과한 추상화 제안은 주요 이슈로 올리지 말 것.
반드시 실제 기능 안정성 또는 성능 영향이 있는 것만 우선한다.

9. 최종 보고서 형식
   보고서는 아래 순서로 작성한다.

A. 전체 결론

- 현재 vscode-pocketpages LSP가 기능 안정성과 성능 면에서 좋은 구조인지 한 문단으로 판단

B. 확인 범위

- 읽은 파일 목록
- 제외한 파일 목록과 이유
- 실행한 명령과 결과

C. 아키텍처 요약

- extension client
- language server
- document 관리
- parser/AST
- completion
- diagnostics
- workspace index/cache
- file watching
- config 처리

D. 주요 이슈 목록
각 이슈는 다음 형식으로 작성:

- 심각도
- 파일/함수 위치
- 문제 설명
- 실제 사용자 영향
- 재현 가능성
- 성능 영향 여부
- 메이저 LSP에서는 보통 어떻게 대응하는지
- 수정 방향

E. 캐싱/DX 평가

- cache invalidation 안정성
- document version 처리
- async race 가능성
- 자동완성 정확도
- 진단 최신성
- 타이핑 중 반응성
- stale data 가능성

F. 성능 평가

- 요청별 비용
- 파일 I/O 반복 여부
- workspace scan 비용
- diagnostics scheduling
- memory/cache cleanup
- 대형 workspace에서의 위험

G. 수정 우선순위

- 지금 바로 고쳐야 하는 것
- 다음 단계에서 개선할 것
- 굳이 고치지 않아도 되는 것

중요:

- 코드 근거 없이 일반론만 말하지 말 것.
- 읽지 않은 파일은 읽지 않았다고 명시할 것.
- 추측은 추측이라고 표시할 것.
- 실제 사용자 영향이 없는 작은 문제를 과장하지 말 것.
- 기능 안정성과 성능, 특히 캐싱과 document version 문제를 최우선으로 볼 것.

최종 보고서 작성 전에 “내가 놓쳤을 가능성이 있는 흐름”을 한 번 더 점검하고, client/server/parser/cache/completion/diagnostics/file watcher 흐름 중 누락된 연결이 없는지 재확인해줘.

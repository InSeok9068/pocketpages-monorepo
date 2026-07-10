# Sanity test sections

`npm test`는 네 section을 항상 같은 순서로 실행하는 최종 검증입니다.

1. `contracts`: package/client/server source contract
2. `runtime-snapshot-cache`: runtime state, request coordinator, snapshot, stat cache
3. `path-and-extension-client`: path context and mocked extension client
4. `fixture-integration`: full fixture, language service, watcher, diagnostics, navigation, TypeScript plugin

부분 실행은 전체 검증을 대체하지 않습니다.

- `npm run test:contracts`: 정적 계약까지만 실행
- `npm run test:core`: runtime/snapshot/cache까지 실행
- `npm run test:fast`: fixture 생성 전의 빠른 검증까지 실행
- `npm test`: 모든 기존 검증 실행

Section은 공유 상태와 기존 실행 순서를 보존하기 위해 prefix 단위로 실행합니다. 병렬 실행하지 않으며, 기존 assertion을 삭제하거나 약하게 만들지 않습니다.

새 cache 또는 watcher 기능에는 기능 결과, invalidation 후 결과, 요청당 I/O 비용 검증을 함께 추가합니다.

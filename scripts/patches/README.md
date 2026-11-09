# PocketPages 로컬 패치

패치 대상 버전은 각 앱과 `scripts/new-pocketpages-service.mjs`에서 고정한다. 라이브러리를 업데이트할 때는 패치 파일 이름만 바꾸지 말고 새 배포본 기준으로 차이를 다시 생성하고 검증한다.

## pocketpages 0.22.5

- `pagesRoot` 검사에 `existsSync(path, 'dir')`를 사용한다. `pocketbase-node`의 기본 검사는 Node.js와 달리 파일만 대상으로 하므로 실제 디렉터리가 있어도 시작에 실패할 수 있다.
- 레이아웃 검색의 `$filepath.glob()` 예외와 빈 결과를 처리하여 상위 레이아웃 탐색을 계속한다. 중복 레이아웃 오류는 유지한다.
- debug가 꺼진 상태에서 fingerprint가 일치하는 정적 URL에만 `Cache-Control: public, max-age=31536000, immutable`을 설정한다. 원본 URL과 debug 모드에는 적용하지 않는다.

## pocketpages-plugin-ejs 0.2.0

- Windows의 드라이브 경로, 역슬래시, 대소문자 차이를 고려해 `_private` partial을 찾는다. `pocketbase-node`의 POSIX 경로 처리에만 의존하지 않는다.
- 운영 환경에서는 컴파일된 템플릿을 캐시하고 debug 모드에서는 캐시하지 않는다. 렌더링된 사용자별 HTML을 캐시하는 기능은 아니다.
- 앱의 직접 의존성과 PocketPages 내부에서 해석되는 EJS가 같은 설치본이어야 한다. 이전 `0.1.2`를 함께 설치하지 않는다.

## pocketbase-js-sdk-jsvm 0.28.10001

새 배포본 기준으로 기존 패치를 이전했다. 변경 내용은 `sourceMappingURL` 주석 삭제뿐이며, 인증·쿠키 기능을 수정하는 패치는 아니다.

인증을 사용하는 앱과 신규 서비스 생성기는 `pocketpages-plugin-auth` 0.3.0, `pocketpages-plugin-js-sdk` 0.3.0, SDK 0.28.10001을 함께 고정한다. `pocketpages-plugin-realtime`은 현재 최신인 0.2.0을 유지한다.

## 적용과 검증

각 앱의 `npm install` / `npm ci` 후 `postinstall`에서 `scripts/run-patch-package.js`가 공통 패치와 서비스별 패치를 적용한다. `patch-package` 자체가 없을 때만 건너뛰며, 패치 적용 실패는 오류로 종료한다.

저장소 루트에서:

```sh
node --test scripts/pocketpages-patches.test.mjs
./task.sh lint <service>
```

회귀 테스트는 각 앱의 실제 설치된 dist를 VM에서 로드하고 PocketBase API와 외부 의존성을 대체한다. 실제 PocketBase 서버 실행 검증을 대신하지는 않는다.

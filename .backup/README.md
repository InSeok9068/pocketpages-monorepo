# PocketPages npm 배포본 백업

앱의 `package-lock.json`에 기록된 PocketPages 및 `pocketbase-*` 패키지의 npm 원본 배포본을 보관한다.

## 구성

- `npm/*.tgz`: 패치 적용 전 npm 원본 배포본 12개. 동일 패키지의 여러 버전이 잠금 파일에 있으면 각각 보관한다.
- `npm/manifest.json`: 패키지 이름, 버전, 원본 URL, 잠금 파일의 SHA-512 integrity, 파일 크기, SHA-256, 사용 앱과 백업 시각.
- `patches/`: 백업 시점의 `scripts/patches` 사본. 자동 동기화되지 않는다.

다운로드한 모든 배포본은 앱 잠금 파일의 SHA-512 integrity와 일치하는지 검증했다. 설치된 `node_modules`를 재포장한 파일이 아니므로 로컬 패치는 포함되지 않는다.

## 복구 시 주의

1. 사용할 프로젝트 버전의 `package.json`, `package-lock.json`, 패치 적용 스크립트도 함께 확보한다. 현재는 Git 저장소에서 관리한다.
2. npm에서 배포본을 받을 수 없다면 해당 `.tgz`를 로컬 패키지 경로 또는 사설 레지스트리로 제공하고 의존성 및 잠금 파일을 조정한다. 기존 `npm ci`가 이 폴더를 자동으로 사용하는 것은 아니다.
3. 원본 설치 후 해당 프로젝트 버전의 패치를 적용하고 `node --test scripts/pocketpages-patches.test.mjs`와 서비스 lint 및 실제 서버 동작을 검증한다. `patches/`는 백업 시점의 참고 사본이므로 이후 프로젝트 변경과 구분한다.

이 백업은 프레임워크 관련 배포본 보관용이다. 전체 하위 의존성, Node/npm 도구, PocketBase 실행 파일, DB 및 환경변수는 포함하지 않으며 완전한 오프라인 설치나 앱 전체 복구를 보장하지 않는다.

이 디렉터리는 `.gitignore`에 추가하지 않았다. 로컬 디스크 손실에도 대비하려면 별도 저장장치나 원격 저장소에도 보관한다.

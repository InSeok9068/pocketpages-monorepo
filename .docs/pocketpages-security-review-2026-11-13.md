# PocketPages 0.22.5 보안 재검토 보고서

- 검토일: 2026-11-13
- 대상 저장소: `pocketpages-monorepo`
- 작성 시점 기준 커밋: `1c24735f`
- 목적: 앱 차원의 권한·CSRF 구현과 구분하여, 현재 설치된 PocketPages와 관련 라이브러리에 긴급한 보안 결함이 남아 있는지 확인한다.
- 상태: **검토 완료. SEC-01은 2026-11-13 패치·회귀 검증 완료, SEC-02~05는 미패치**. 아래 최초 재현 기록과 해시는 수정 전 상태를 보존한다. 이 보고서는 검증 기록이며 프로젝트 정책이나 보안 인증서가 아니다.

## 1. 요약

**현재 서비스에서 외부 요청만으로 바로 악용되는 긴급 공격 경로는 이번 검토에서 재현하지 못했다. 그러나 추가 방어가 필요할 수 있는 라이브러리 동작을 확인했으므로, “보완할 부분이 없다”는 결론으로 해석해서는 안 된다.**

실제 PocketBase 서버에서 비정상 인증 쿠키 거부, 비인증 용도 토큰 거부, 비공개 파일 비노출, 동시 EJS 렌더링의 컨텍스트 일치를 확인했다. 별도로 격리된 Node VM에서 예약 키 처리와 경로 해석의 조건부 문제를 재현했다.

| ID     | 발견 사항                                              | 재현 수준                            | 현재 앱에 대한 판단                                                                                                | 권장 대응                                             |
| ------ | ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| SEC-01 | 로컬 Datastar의 예약 키 처리로 prototype 변경 가능     | 실제 플러그인을 격리 VM에서 실행     | `removeSignals()` 사용처는 조사 범위에서 미발견. `requestSignals()`는 사용 중이지만 권한 우회까지 재현한 것은 아님 | 예약 키 차단·own-property 탐색 적용, 영구 테스트 추가 |
| SEC-02 | 코어 `resolve()`에 경로 경계 검사가 없음               | 실제 코어 + 가상 파일시스템          | 조사한 서버 호출 141개는 고정 문자열. 외부 입력이 이름으로 직접 전달되는 호출은 미발견                             | 기존 탐색 규칙을 보존하며 경계 검사 검토              |
| SEC-03 | 코어 deep merge의 결과 객체에 상속 속성이 생길 수 있음 | 실제 코어 함수를 동일 VM 안에서 실행 | 전역 prototype 변경은 관찰되지 않음. 앱의 입력 전달·속성 사용 방식에 따라 영향이 달라짐                            | 예약 키 처리 보완 및 반환 데이터 계약 확인            |
| SEC-04 | 인증 플러그인 기본 로그인 쿠키에 보안 속성 미지정      | 실제 함수·직렬화 및 실제 로그인 응답 | 프로젝트의 `@pocketpages/auth-cookie`가 보완. `booklog`의 최종 쿠키 헤더 확인                                      | 현재 헬퍼 사용 유지, 새 인증 경로에서 누락 방지       |
| SEC-05 | SDK의 `loadFromCookie('pb_auth=null')` 예외            | 실제 SDK를 격리 VM에서 실행          | PocketPages의 현재 쿠키 인증 경로는 해당 메서드를 사용하지 않음                                                    | 일반 오류로 별도 보완 가능                            |

이 표의 우선순위는 내부 보완 판단이며 CVSS 등급이 아니다. 조건부 재현을 곧바로 현재 서비스의 원격 취약점이나 임의 코드 실행으로 확대하지 않는다.

## 2. 검토 기준과 범위

### 2.1 실행 환경

| 항목                    | 확인 값                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| OS·셸                   | Windows, Git Bash                                                 |
| Node.js                 | `v26.13.1`                                                        |
| 실제 서버 검증 바이너리 | `apps/booklog/pocketbase.exe`, 버전 `0.42.2`                      |
| 앱 설정                 | 임시 `.env`의 `APP_ENV=production`                                |
| PocketBase 실행         | 공통 harness를 통해 `serve --dev`, loopback 주소와 별도 포트 사용 |
| 데이터                  | 빈 임시 DB에 저장소 스키마와 합성 fixture 사용자·도서 등을 준비   |

앱 환경이 production이어도 PocketBase 실행 옵션에는 `--dev`가 들어간다. 따라서 이번 실행을 실제 운영 배포 환경과 완전히 같은 검증이라고 부르지 않는다. Node의 `fetch`로 쿠키를 수동 전달했으며 브라우저의 HTTPS·쿠키 저장 동작까지 검증한 것도 아니다.

### 2.2 주요 설치본

| 패키지                  | 버전         | 대표 검토 파일                                                            |
| ----------------------- | ------------ | ------------------------------------------------------------------------- |
| PocketPages             | `0.22.5`     | `apps/booklog/node_modules/pocketpages/dist/index.js`                     |
| 인증 플러그인           | `0.3.0`      | `apps/booklog/node_modules/pocketpages-plugin-auth/dist/index.js`         |
| SDK 플러그인            | `0.3.0`      | `apps/booklog/node_modules/pocketpages-plugin-js-sdk/dist/index.js`       |
| EJS 플러그인            | `0.2.0`      | `apps/booklog/node_modules/pocketpages-plugin-ejs/dist/index.js`          |
| EJS 엔진                | `7.0.2001`   | `apps/booklog/node_modules/pocketbase-ejs/lib/cjs/ejs.js`                 |
| JSVM SDK                | `0.28.10001` | `apps/booklog/node_modules/pocketbase-js-sdk-jsvm/dist/pocketbase.cjs.js` |
| 로컬 Datastar 플러그인  | `1.0.0`      | `packages/pocketpages-plugin-datastar-v1/index.js`                        |
| 프로젝트 인증 쿠키 헬퍼 | 로컬 패키지  | `packages/auth-cookie/index.js`                                           |

`pocketpages-plugin-datastar-v1`의 `v1`은 Datastar 1.x 어댑터를 뜻한다. PocketPages v1/CE의 소스가 아니며, 이번 보고서의 SEC-01은 이 저장소의 로컬 구현에 관한 발견이다.

`booklog`, `gyeolbit`, `homepocket`, `launchboard`, `sample`, `todo`의 코어와 EJS 플러그인은 각각 바이트 해시가 동일함을 확인했다. 실제 HTTP 검증은 이 중 `booklog`의 복사본에서 수행했다.

### 2.3 이미 적용된 패치

신규 발견과 다음 기존 패치를 구분한다.

- 인증 토큰 검증에 `findAuthRecordByToken(token, 'auth')` 적용.
- 인증 토큰·비밀번호·인증 레코드·응답 쿠키 등의 민감 로그 제거.
- EJS 컴파일 캐시의 요청별 컨텍스트 분리와 `finally` 복원.
- 중첩 include 후처리 경로 보완.
- include 이름의 부모 경로·드라이브·UNC·NUL 등 검사.
- Windows include 경로 처리와 페이지 루트 경계 검사.
- 코어 디렉터리 검사, 레이아웃 탐색, 정적 파일 캐시 정책 등의 기존 보완.

패치 설명은 [`scripts/patches/README.md`](../scripts/patches/README.md)를 따른다. SEC-02의 `resolve()`와 SEC-03의 merge는 기존 include 패치의 적용 대상이 아니다.

### 2.4 범위 밖

- 앱 전체의 권한·CSRF·입력 검증 완전성 감사.
- OAuth·OTP·MFA·메일 등 모든 인증 흐름의 외부 서비스 통합 검증.
- PocketBase 자체의 암호학·서버·SQLite 전반 감사.
- 모든 의존성·브라우저 vendor 코드·운영 인프라의 완전한 분석.
- 운영 DB 마이그레이션, 리버스 프록시·TLS·CSP 설정 검증.
- 모든 URL 인코딩·경로·동시성 조합에 대한 퍼징과 부하 시험.
- 신뢰할 수 없는 템플릿·서버 모듈을 실행할 수 있게 만드는 샌드박스 평가.
- PocketBase CE와의 보안 동등성 입증.

## 3. 검토 방법과 증거 수준

### 3.1 직접 소스 검토

설치된 dist와 실제 EJS 엔진을 읽어 다음 흐름을 추적했다.

- 부트스트랩의 파일 수집·라우트 등록과 요청별 라우트 매칭.
- query·쿠키 파싱과 미들웨어·로더 반환 데이터 병합.
- 인증 쿠키 검증과 SDK 클라이언트 캐시의 생성 수명.
- EJS 옵션 전달·출력 이스케이프·include 훅·컴파일 캐시.
- `resolve()`의 파일 탐색·raw 읽기.
- 인증 쿠키 직렬화와 프로젝트의 별도 쿠키 헬퍼.
- 로컬 Datastar의 신호 입력·삭제 경로 구성.

### 3.2 격리 VM 검증

실제 설치본을 Node `vm`에서 실행했다. 필요한 PocketBase API와 파일시스템은 대체했으며, 네트워크 전송은 사용하지 않았다. EJS 검증에는 실제 설치된 엔진을 사용했다.

내부 함수가 공개되지 않은 코어는 **메모리에 로드한 VM에서만** `merge`, `mkResolve`, `stringifySetCookie`를 조회했다. 설치 파일이나 exports를 디스크에서 수정하지 않았다. 예약 키 검증에는 무해한 표시값 `__pocketpages_review_only__`만 사용했다.

VM에서 확인한 동작은 실제 JavaScript 구현에 대한 증거지만, 그 자체로 실제 Goja/HTTP에서 외부 공격이 성립한다는 증거는 아니다.

### 3.3 실제 서버 검증

기존 [`service-harness.mjs`](../packages/test-support/service-harness.mjs)와 `booklog` 테스트의 fixture 준비 방식을 사용했다.

1. `apps/.booklog-security-review-*` 임시 디렉터리 생성.
2. 실제 `pb_hooks` 복사. 예약 작업 실행을 피하려고 `jobs.pb.js` 제외.
3. 외부 도서 검색 모듈을 기존 fixture 스텁으로 대체.
4. 실제 설치된 `node_modules`를 junction으로 연결.
5. 실제 PocketBase 바이너리 복사, 빈 `pb_data`와 스키마·합성 데이터 준비.
6. SDK의 접속 주소를 임시 서버의 loopback 포트로 지정.
7. 임시 페이지·partial·관찰용 플러그인·테스트 전용 토큰 생성 라우트 추가.
8. HTTP 검증 후 서버·임시 DB·훅·페이지를 정리.

실제 인증 토큰 값·비밀번호·쿠키 원문은 보고서에 저장하지 않는다. 원본 서비스 DB와 운영 계정을 사용하지 않았다.

## 4. 상세 발견 사항

### SEC-01. 로컬 Datastar의 예약 키 처리

**분류:** 조건부 prototype 변경 결함. 외부 도달성과 영향은 호출부에 따라 다름.

**현재 상태:** 2026-11-13 패치·회귀 검증 완료. 다음 근거와 재현은 수정 전 코드에 대한 기록이며, 패치 결과는 아래 별도 절에 기록한다.

#### 근거 (수정 전)

`packages/pocketpages-plugin-datastar-v1/index.js:112–139`의 `setSignalRemoval()`은 점으로 구분한 이름을 따라가면서 기존 속성을 조회한다.

```js
if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) {
  target[part] = {}
}
target = target[part]
```

예약 키를 거부하거나 own property인지 확인하지 않기 때문에, 특정 경로에서 상속 객체에 도달할 수 있다.

같은 파일의 `readSignals()`는 `721–737`행에서 JSON 객체임을 확인한 뒤 다음처럼 병합한다.

```js
return Object.assign(result, parsed)
```

일반 객체를 대상으로 할 때 예약 키가 대상의 prototype을 바꿀 수 있다.

#### 재현과 관찰

- 실제 플러그인을 독립 VM에 로드했다.
- 공개된 `realtime.buildRemoveSignalsPayload()`에 예약 경로와 표시용 키를 전달했다.
- 해당 VM의 `Object.prototype`에 표시용 own property가 생기고 값이 `null`이 되는 것을 확인했다.
- 검증 직후 표시용 property를 제거했다. 검토 프로세스의 host prototype을 변경하는 방식으로 실행하지 않았다.
- 별도로 `requestSignals()`에 예약 키를 포함한 JSON 입력과 `{ count: 0 }` 대상 객체를 전달했다.
- 결과 객체의 표시값은 읽히지만 `Object.hasOwn(result, marker)`는 `false`였다. 이 경우 변경된 것은 대상 객체의 prototype이며 전역 prototype 변경은 관찰되지 않았다.

#### 현재 노출 조건

- 조사한 6개 앱의 서버 훅·페이지에서 `removeSignals` 사용처는 발견하지 못했다.
- `requestSignals()`는 `launchboard`의 프로젝트·작업 이동/상태 처리와 `sample`의 Datastar 예제 등에서 사용한다.
- 신호 입력이 가능하다는 것과 현재 권한 우회가 성립한다는 것은 별개다. 이번 검토에서 실제 권한 우회는 재현하지 않았다.
- 특히 `removeSignals()`에 외부 입력을 이름으로 연결하면 해당 VM의 다른 동작에도 영향을 줄 수 있으므로, 함수가 안전한 이름만 받는다고 가정하지 않는다.

#### 권장 대응

예약 키와 경로 구간의 처리 정책을 명시하고, 상속 객체를 따라가지 않도록 보완한다. 일반 신호·중첩 신호·거부 입력·예외 후 prototype 불변성을 회귀 테스트한다. 상속 속성까지 의미가 달라질 수 있으므로 무작정 출력만 바꾸는 패치로 끝내지 않는다.

#### 패치 후 확인 (2026-11-13)

적용 파일: `packages/pocketpages-plugin-datastar-v1/index.js`.

- `__proto__`·`constructor`·`prototype` 경로 구간을 거부한다. 부모 신호가 이미 삭제되는 경우에도 전체 삭제 이름을 먼저 검증한다.
- 삭제 경로를 구성할 때 own property만 따라간다. 같은 이름의 상속 객체가 있어도 그 객체를 수정하지 않는다.
- `readSignals()` / `requestSignals()`는 중첩 객체·배열의 키까지 검사한 후 대상에 복사한다. 명시적인 작업 목록을 사용해 검증 함수의 재귀 호출을 피한다.
- 예약 키를 거부할 때 대상 객체의 값·prototype이나 SSE 출력이 일부라도 변경되지 않는지 검사했다.
- 일반 키·문자열 값, 중첩 신호, 부모 삭제 우선순위, 기본값 객체의 동일성, 얕은 복사 방식은 유지한다. 예를 들어 `constructorName`이나 문자열 값 `__proto__`는 허용한다.
- API 서명과 앱 라우트는 바꾸지 않았다. 기본 입력 오류 처리와 마찬가지로 예외를 던지며, sample의 기존 전역 오류 경계에서는 500 응답으로 처리된다. 새로운 400 응답 정책을 추가한 것은 아니다.

영구 회귀 테스트:

- `packages/pocketpages-plugin-datastar-v1/test/index.test.js`: 기존 코드에서 새 거부 테스트가 `Missing expected exception`으로 실패함을 먼저 확인했다. 수정 후 전체 28개 통과. 이번에 추가한 7개 테스트는 요청·realtime·payload builder·독립 sender의 삭제 진입점, 예약 키, 상속 객체 불변성, 중첩 입력, 원자적 거부, 정상 요청 복구, 깊은 일반 JSON 등을 다룬다.
- `apps/sample/__tests__/root-route.test.mjs`: GET·DELETE·POST의 예약 키 입력 12건을 거부하고 후속 정상 요청이 동작하는 통합 테스트를 추가했다. 해당 테스트와 기존 Datastar 정상 흐름을 선택 실행해 4개 통과했다.
- sample 전체 파일은 최초 실행에서 vendor 버전 기대값 `1.0.4`와 실제 번들 `1.0.5`의 불일치로 13개 중 1개가 실패했다. 이후 테스트 기대값과 README 표기를 `1.0.5`로 정정한 뒤 전체 파일을 재실행하여 **13개 전부 통과**했다. vendor 파일 자체는 변경하지 않았다.
- `./task.sh lint launchboard`, `./task.sh lint sample`과 변경 JS·테스트에 대한 ESLint 통과.
- 기존 PocketPages 회귀 테스트 1,017개도 재실행하여 통과.

저장소 루트에서 전용 패키지 테스트를 실행한다.

```sh
npm --prefix packages/pocketpages-plugin-datastar-v1 test
```

sample의 추가된 HTTP 테스트만 선택할 수 있다. 다른 서비스가 기본 테스트 포트 8090을 사용하지 않는지 먼저 확인한다.

```sh
node --test --test-name-pattern="Datastar signal input" apps/sample/__tests__/root-route.test.mjs
```

수정 후 소스 SHA-256:

```text
packages/pocketpages-plugin-datastar-v1/index.js
34ab70274db51a636b1f12590b76f2a7b58647a49628405c6d3515a684ec298f
```

`launchboard`와 `sample`의 설치 모듈이 이 로컬 소스를 직접 해석하는 것을 확인했다. 실행 중인 서버의 모듈 캐시에 반영하려면 해당 서버를 재시작해야 한다. SEC-02~05의 코드나 브라우저 vendor 번들은 변경하지 않았다.

### SEC-02. `resolve()`의 경로 경계 방어 부족

**분류:** 호출부가 비신뢰 이름을 전달할 때 발생할 수 있는 경로 주입 위험. 현재 직접 노출 경로 미발견.

#### 근거

`apps/booklog/node_modules/pocketpages/dist/index.js:658–685`의 `mkResolve()`는 다음 경로를 조합하여 모듈 존재 여부와 내용을 확인한다.

```js
const finalPath = $filepath.join(currentPath, '_private', path)
return _require(finalPath)
```

include 패치와 달리 부모 경로 구간 거부와 최종 경계 검사가 없다.

#### 재현과 관찰

가상 파일시스템에 실제 데이터와 무관한 표시용 파일 하나만 등록했다.

```text
페이지 루트: /app/pb_hooks/pages
현재 폴더: /app/pb_hooks/pages/section
입력 이름: ../../../review-only.json
mode: raw
표시용 파일: /app/pb_hooks/review-only.json
결과: 루트 밖 표시용 파일 내용 반환
```

실제 코어 함수를 실행한 결과다. 다만 파일 존재·읽기는 스텁이므로, 이 검증을 운영 파일 읽기나 임의 코드 실행의 실증으로 표현하지 않는다. 이번 재현은 `raw` 모드만 대상으로 했다.

JSVM의 서버 코드는 본래 신뢰된 코드이며 `$os`·`require()` 등의 권한도 가진다. 따라서 이 헬퍼를 완전한 샌드박스라고 전제하는 것도 잘못이다. 보완 목적은 실수로 비신뢰 이름이 전달됐을 때의 경로 이탈 방지다.

#### 현재 사용처 확인

처음에는 문자열 패턴으로 조사했고, 보고서 작성 시 TypeScript AST로 첫 번째 인자를 다시 분류했다. 문자열 결합·변수·보간 템플릿을 단순히 문자열로 오인하지 않도록 했다.

| 앱          | 서버 `resolve()` 호출 | 문자열/보간 없는 템플릿 리터럴 | 그 외 인자 |
| ----------- | --------------------: | -----------------------------: | ---------: |
| booklog     |                    59 |                             59 |          0 |
| gyeolbit    |                     1 |                              1 |          0 |
| homepocket  |                     7 |                              7 |          0 |
| launchboard |                    11 |                             11 |          0 |
| sample      |                    32 |                             32 |          0 |
| todo        |                    31 |                             31 |          0 |
| 합계        |                   141 |                            141 |          0 |

범위는 `pb_hooks/pages`의 서버 JS와 EJS의 `<script server>` 블록이다. assets·node_modules는 제외했으며, 간접 호출·다른 별칭·모든 EJS 태그의 의미 분석까지 입증한 표는 아니다. 이 범위에서는 요청 입력이 이름으로 직접 들어가는 호출을 발견하지 못했다.

#### 권장 대응

일반 이름·선행 `/`·상위 `_private` 탐색·Windows 경로 동작을 보존하면서 입력과 최종 경계를 검사한다. 기존 고정 호출이 같은 모듈을 찾는지 별도 회귀 테스트가 필요하다. 심볼릭 링크의 실제 대상 검사 여부는 문자열 경계 방어와 별도로 결정한다.

### SEC-03. 코어 deep merge의 결과 객체 prototype 변경

**분류:** 비신뢰 객체를 병합할 때의 결과 객체 오염. 전역 오염과 구분.

#### 근거

`apps/booklog/node_modules/pocketpages/dist/index.js:89–95`:

```js
function merge(object, ...sources) {
  for (const source of sources)
    forEach(source, (value, key) => {
      const myValue = object[key]
      if (myValue instanceof Object) value = merge(clone(myValue), value)
      object[key] = value
    })
  return object
}
```

이 함수는 미들웨어와 로더의 반환 데이터 병합에 사용된다. 예약 키를 별도로 처리하지 않는다.

#### 재현과 관찰

동일 VM 내부에서 JSON 입력을 생성하고 `merge({}, parsed)`를 실행했다.

- 입력의 예약 키 아래에 표시용 boolean property를 넣었다.
- 결과에서 표시값이 읽혔다.
- 결과의 own property는 아니었다.
- 해당 VM의 `Object.prototype`과 검토 프로세스의 `Object.prototype`에는 표시값이 생기지 않았다.

따라서 **이 재현은 결과 객체의 prototype 변경이지 전역 prototype pollution의 재현이 아니다.**

별도로 코어의 최상위 query 파서는 예약 이름을 버리는 것을 확인했다. 이 merge 결과만으로 query 요청이 자동으로 전역 상태를 오염시킨다고 주장할 수 없다.

#### 현재 노출 조건과 권장 대응

외부 객체를 미들웨어·로더 반환값으로 통째로 전달하거나, 병합 후 상속 속성까지 신뢰하는 경우 영향이 생길 수 있다. 이번 검토에서 실제 앱의 권한 우회로 연결하지는 못했다.

예약 키 처리 정책을 보완하고, 정상적인 중첩 데이터 병합·배열·undefined 처리 등 기존 동작과 함께 검증한다. 앱에서도 반환 데이터는 준비된 명시적 shape로 유지한다.

### SEC-04. 기본 로그인 쿠키의 보안 속성 미지정

**분류:** 라이브러리 기본값의 보완점. 현재 프로젝트가 별도 헬퍼로 대응.

#### 근거

- `pocketpages-plugin-auth/dist/index.js:158–165`: `signIn()`이 `response.cookie('pb_auth', ...)`에 옵션을 넘기지 않는다.
- `pocketpages/dist/index.js:1305–1318`: 기본 쿠키 옵션은 `path: '/'`다.
- 같은 파일의 직렬화 함수는 `httpOnly`, `secure`, `sameSite`가 지정돼야 해당 속성을 추가한다.

실제 함수와 직렬화기를 실행했을 때 기본 로그인 쿠키에는 세 속성이 없었다. 이것만으로 인증 우회를 의미하지는 않지만, SSR 인증 쿠키를 기본 헬퍼에만 맡겨도 자동으로 보호된다고 볼 수 없다.

#### 현재 대응과 검증

[`packages/auth-cookie/index.js`](../packages/auth-cookie/index.js)의 기본값:

- `httpOnly: true`
- `sameSite: 'lax'`
- `APP_ENV=production`이면 `secure: true`

확인한 네 인증 앱의 가입·로그인·로그아웃 페이지는 이 패키지를 사용한다. 실제 HTTP 검증에서는 `booklog`의 `/xapi/auth/sign-in` 응답에서 **마지막 `pb_auth` Set-Cookie 헤더**에 `HttpOnly`, `Secure`, `SameSite=Lax`가 있는지 확인했다.

현재 방식은 인증 플러그인이 쓴 뒤 같은 쿠키를 프로젝트 헬퍼로 다시 쓰는 흐름이다. 이번에는 최종 헤더를 검사했으며, 모든 브라우저·프록시의 쿠키 처리나 토큰 만료·철회 정책 전체를 검증한 것은 아니다.

#### 권장 대응

기존 헬퍼 사용을 유지한다. OAuth·OTP 등 다른 로그인 경로를 추가할 때도 쿠키 정책이 빠지지 않게 검증한다. 로그인 쿠키를 바꾸기 위해 모든 일반 쿠키에 동일 옵션을 강제하는 변경은 별도 호환성 판단 없이 적용하지 않는다.

### SEC-05. SDK의 JSON null 쿠키 처리 오류

**분류:** 일반적인 입력 처리 오류. 현재 PocketPages 인증 경로의 긴급 결함으로 보지 않음.

`pocketbase-js-sdk-jsvm/dist/pocketbase.cjs.js`의 `loadFromCookie()`에는 `null === typeof r` 조건이 있다. `typeof null`은 `'object'`이므로 null을 걸러내지 못한다.

실제 SDK에서 다음 호출이 `TypeError`를 던짐을 확인했다.

```js
client.authStore.loadFromCookie('pb_auth=null')
```

현재 인증 플러그인의 `onRequest()`는 코어의 쿠키 파서와 자체 JSON 처리로 인증하므로 이 메서드를 호출하지 않는다. 실제 HTTP 검증에서도 null 형태 쿠키는 인증되지 않았고 500 응답을 만들지 않았다. 이 결과를 모든 SDK 사용자나 브라우저 사용처까지 확대하지 않는다.

## 5. 정상 동작을 확인한 검증

### 5.1 격리 VM·실제 EJS 엔진

| 검증                           | 관찰 결과                                                          | 한계                                                  |
| ------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| 최상위 query 예약 이름         | 예약 이름이 버려지고 일반 값은 기존 방식으로 파싱됨                | 모든 중첩 입력·파서 조합의 검증은 아님                |
| 잘못된 인증 쿠키 10종          | 인증 레코드·토큰이 요청에 설정되지 않음                            | 인증 조회는 스텁 사용                                 |
| 서로 다른 SDK 플러그인 factory | 한 factory에서 저장한 인증이 다른 factory의 클라이언트에 남지 않음 | 모든 사용자 정의 클라이언트 재사용 방식의 검증은 아님 |
| EJS에 전달한 요청 locals       | HTML 이스케이프 유지, 요청 데이터가 컴파일 옵션을 덮어쓰지 않음    | 검사한 옵션·템플릿에 한정                             |
| 캐시된 EJS의 A/B 요청          | 현재 텍스트로 렌더링하며 컴파일은 1회 재사용                       | 모든 플러그인 조합의 격리 보장은 아님                 |

### 5.2 실제 PocketBase HTTP 검증

| 검증           | 수행 내용                                                                                      | 결과                                  |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| 정상 인증      | 실제 fixture 사용자로 인증 후 쿠키로 `/library` 접근                                           | 200                                   |
| 잘못된 쿠키    | null·배열·빈 객체·숫자·문자열·비정상 token 자료형·레코드만 있는 값·무효 token 등 9종           | 모두 `/auth`로 303, 인증되지 않음     |
| 토큰 용도 제한 | 실제 fixture Record에서 파일·이메일 확인·비밀번호 재설정 토큰을 생성해 쿠키로 전달             | 모두 거부, 303과 인증 쿠키 삭제 확인  |
| 로그인 쿠키    | 실제 로그인 라우트의 마지막 인증 쿠키 헤더 검사                                                | 보안 속성 3종 확인                    |
| 비공개 파일    | 표시용 `_private`·숨김·초안 파일과 일부 인코딩 URL 5개 요청                                    | 200으로 제공되지 않았고 표시값 비노출 |
| 동시 EJS 요청  | 서로 다른 표시값 30개를 동시 요청. partial 출력과 관찰용 후처리 플러그인의 현재 요청 값을 대조 | 30건 모두 일치                        |
| 이스케이프     | `<%= ... %>`에 HTML 특수문자를 전달                                                            | 이스케이프 결과 확인                  |

동시성 검증은 새로 만든 한 페이지·partial·관찰용 플러그인에 대한 정확성 검사다. 처리량 벤치마크나 전체 서비스의 경쟁 상태 부재 입증이 아니다.

### 5.3 실행 출력 발췌

다음은 임시 검증 스크립트의 최종 성공 실행에서 나온 출력이다. 토큰·계정 정보는 포함하지 않는다.

```text
PASS: reserved query names are discarded; normal query parsing preserved
PASS: 10 malformed cookie shapes stay unauthenticated
PASS: separate plugin factories do not share an authenticated SDK client
CONFIRMED: SDK loadFromCookie(null JSON) throws; not used by current cookie-auth path
CONFIRMED: upstream signIn omits cookie flags; project helper sets HttpOnly/Secure/SameSite
CONFIRMED: resolve has no path boundary check when its name is untrusted (synthetic filesystem)
CONFIRMED: deep merge permits inherited keys on its destination; no global prototype change observed
CONFIRMED: Datastar removeSignals can write a reserved path into its VM Object.prototype
CONFIRMED: Datastar readSignals accepts a reserved key that changes the target object prototype only
PASS: actual cached EJS escapes current-request text; request locals do not override compile options
```

```text
PASS: real PocketBase authentication and authenticated SSR page
PASS: 9 malformed/tampered auth cookies remain unauthenticated over HTTP
PASS: real file/verification/password-reset tokens cannot authenticate the SSR cookie session
PASS: the actual booklog sign-in route finishes with hardened cookie attributes
PASS: private/dot/draft files are not served through their direct or encoded URLs
PASS: 30 concurrent real JSVM renders keep include data and postprocessing context aligned
PASS: actual SSR escaped-output tag preserves HTML escaping
Temporary service, DB and hooks removed
```

`CONFIRMED`는 안전성 통과가 아니라 **해당 문제 동작의 재현 성공**을 뜻한다.

### 5.4 기존 회귀 테스트

저장소 루트에서 다음 세 파일을 다시 실행했다.

```sh
node --test scripts/pocketpages-patches.test.mjs scripts/pocketpages-ejs-cache.test.mjs scripts/pocketpages-include-paths.test.mjs
```

최종 실행 결과:

```text
# tests 1017
# pass 1017
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

이는 다양한 중첩 subtest를 합산한 수치이며, 1,017개의 실제 HTTP 보안 공격을 검증했다는 뜻이 아니다. 최초 검토 시에는 새 발견 사항의 영구 회귀 테스트가 없었으며, 이후 SEC-01의 패치와 함께 추가한 테스트는 해당 절에 별도로 기록했다.

### 5.5 파일 노출·사용처 조사

- 6개 앱의 라우트로 노출 가능한 트리를 조사했다.
- assets 밖에서 의도 확인이 필요한 비EJS 파일이나 라우트 트리의 심볼릭 링크는 이 조사에서 발견하지 못했다.
- 이것은 전체 파일 내용의 민감정보 검사나 `_private` 아래 링크의 실제 대상 감사가 아니다.
- 이전 include 경로 검증의 73개 호출·순환 없음 결과와 별도로, 이번에는 `resolve()` 인자 141개를 위 범위에서 확인했다.

## 6. 의존성 advisory 조회

각 앱과 루트에서 `npm audit --json`을 실행했다. dev 의존성도 포함했다. 검토 결과와 자동 advisory는 서로 다른 증거다.

| 범위        | Low | Moderate | High | Critical | npm 종료 코드 |
| ----------- | --: | -------: | ---: | -------: | ------------: |
| booklog     |   2 |        0 |    0 |        0 |             1 |
| gyeolbit    |   0 |        0 |    0 |        0 |             0 |
| homepocket  |   0 |        0 |    0 |        0 |             0 |
| launchboard |   0 |        0 |    0 |        0 |             0 |
| sample      |   0 |        0 |    0 |        0 |             0 |
| todo        |   0 |        0 |    0 |        0 |             0 |
| 저장소 루트 |   0 |        6 |    0 |        0 |             1 |

종료 코드 1은 advisory가 보고됐기 때문이며, 성공했다고 처리하지 않았다.

### booklog

- `deepmerge`: `mergeObject()`의 반환 객체 prototype poisoning advisory.
- `html-to-text`: 위 의존성의 영향을 받아 함께 보고됨.
- `html-to-text 9.0.5`, `deepmerge 4.3.1`은 해당 lockfile에서 `dev: true`다.
- advisory: <https://github.com/advisories/GHSA-gcqx-w48m-w2h4>

SEC-03의 코어 번들 merge는 이 `deepmerge` 패키지가 아니다. 서로 다른 구현을 혼동하지 않는다.

### 저장소 루트

`minimatch`의 globparts amplification에 의한 잠재적 서비스 거부 advisory와 그 영향을 받는 개발 도구 체인이 보고됐다.

- `minimatch`
- `eslint`
- `@eslint/config-array`
- `@eslint/js`
- `@typescript-eslint/typescript-estree`
- `@typescript-eslint/utils`

루트 manifest에는 runtime dependencies가 없고 이 항목들은 개발 도구 체인이다. 보고된 패키지 수를 서로 독립적인 취약점 6개로 해석하지 않는다.

`npm audit fix`나 강제 버전 변경은 수행하지 않았다. 자동 제안은 주요 버전 변경을 포함할 수 있으므로 호환성을 별도로 확인한다. 또한 custom/fork 패키지와 번들 코드는 advisory가 없더라도 안전하다고 보장할 수 없다.

## 7. 재검증 방법과 실행 기록의 한계

### 7.1 현재 저장소에서 바로 실행할 수 있는 항목

저장소 루트의 Windows Git Bash에서:

```sh
node --test scripts/pocketpages-patches.test.mjs scripts/pocketpages-ejs-cache.test.mjs scripts/pocketpages-include-paths.test.mjs
./task.sh test booklog
```

두 번째 명령은 전체 서비스 테스트 실행 방법이며, **이번 재검토에서 전체 `booklog` 테스트를 모두 실행했다는 뜻은 아니다.** 이 명령에는 브라우저 테스트 등 별도 환경이 필요한 항목도 포함된다.

advisory는 각 작업 디렉터리에서 다시 조회한다.

```sh
npm audit --json
```

바이너리 버전은 서비스 디렉터리에서 확인한다.

```sh
./pocketbase.exe --version
```

### 7.2 이번에만 사용한 임시 검증

당시 사용한 파일명:

- `scripts/pocketpages-security-review.tmp.mjs`: 설치본 VM 검증, SEC-01~05 및 EJS 확인.
- `scripts/pocketpages-security-runtime.tmp.mjs`: 임시 PocketBase HTTP 검증.

두 파일과 임시 서비스는 검토 후 삭제했다. **지금 저장소에 남아 있는 실행 가능한 테스트 파일이 아니므로 해당 파일명으로 바로 재실행할 수는 없다.** 위 절차·입력·관찰 결과·출력·해시는 재현을 위한 기록이며 원본 임시 하네스 전체를 보관한 것은 아니다.

SEC-01은 이후 패치와 함께 영구 회귀 테스트를 추가했다. 나머지 보완 패치를 진행할 때도 각 발견을 재현하는 실패 테스트와 수정 후 불변성 검사를 추가해야 한다.

### 7.3 중간 실패와 정리 확인

- VM 검증 준비 중 테스트 소스의 CRLF와 메모리 변환 문자열이 맞지 않아 임시 하네스가 한 번 중단됐다. 임시 하네스만 수정한 후 최종 실행을 완료했다.
- 임시 서비스를 띄우는 검증과 기존 회귀 테스트를 동시에 실행했을 때, 기존 테스트가 `apps/.booklog-security-review-*`를 앱으로 인식하고 없는 `package.json`을 읽으려 해 실패했다.
- 임시 서비스 정리 후 기존 회귀 테스트를 순차 재실행하여 1,017개 통과를 확인했다. 최초 병렬 실패를 제품 보안 결함이나 통과 결과로 숨기지 않는다.
- 임시 폴더·검증 파일 정리 후 `git status --short`가 비어 있고, `apps/.booklog-security-review-*`가 남지 않았음을 확인했다. 보고서 작성으로 추가된 문서 변경은 이 정리 확인 이후의 작업이다.

## 8. 보완 순서와 수용 기준

1. **SEC-01 — 완료:** Datastar 예약 키 처리와 own-property 탐색을 보완하고, 정상 신호·대상 객체·VM prototype 불변성을 회귀 검증했다. 세부 검증 결과와 vendor 버전 기대값 정정 이력은 SEC-01 절을 참고한다.
2. **SEC-02:** `resolve()`의 입력·경계 검사. 기존 이름 탐색·선행 `/`·Windows 동작과 고정 호출의 대상이 유지되는지 검사.
3. **SEC-03:** merge 예약 키 정책 보완. 전역과 결과 객체의 prototype 불변성, 정상적인 데이터 병합 계약을 함께 검사.
4. **SEC-04:** 기존 인증 쿠키 헬퍼를 유지하고 새 로그인 경로에도 동일한 속성 검증 추가.
5. **SEC-05:** SDK null 처리 오류는 현재 인증 경로와 분리하여 소규모 수정 검토.
6. 개발 도구 advisory는 runtime 패치와 분리하여 의존성 호환성 검증 후 처리.

변경 시 실제 설치본 회귀 테스트, 해당 서비스 lint, 실제 HTTP 통합 검증을 다시 수행한다. 테스트만 통과하도록 동작을 제거하거나, 고정 경로 사용처가 깨지는 광범위한 정규화는 피한다.

## 9. 검토 대상 바이트 해시

최초 검토 당시, SEC-01을 수정하기 전에 직접 계산한 SHA-256이다. 수정 전 재현 근거를 보존하기 위해 아래 값을 덮어쓰지 않는다. Datastar의 수정 후 값은 SEC-01 절에 별도로 기록했다. 같은 버전이어도 패치와 줄바꿈 차이로 해시가 달라질 수 있으므로, 버전명만으로 동일 설치본이라고 가정하지 않는다. 코어·EJS 플러그인의 동일성은 6개 앱에서 확인했다.

```text
apps/booklog/node_modules/pocketpages/dist/index.js
2ef7906ed8a36d31ce2ebfd18ad2e70caeabdc537c704675c8c09238d9074062

apps/booklog/node_modules/pocketpages-plugin-auth/dist/index.js
654b607ab465c2c1db2be9f35b8daf9d8a85586c50a5db47ded8bb9692b8c4e9

apps/booklog/node_modules/pocketpages-plugin-js-sdk/dist/index.js
e7ff0788e3a6d619d9d493b45e586c0eaa43b336714aa51e8e8808e94acbac80

apps/booklog/node_modules/pocketpages-plugin-ejs/dist/index.js
ae28d609095d6fd818927ffdd9b5bd69d878bf245c59c48c959466e4639a9023

apps/booklog/node_modules/pocketbase-ejs/lib/cjs/ejs.js
f7a9914221b714cc5a19ab65bfcb185d5dbfb311a558245b651987be6448ef3d

apps/booklog/node_modules/pocketbase-js-sdk-jsvm/dist/pocketbase.cjs.js
94d77482746af925f13d142b0661889e73503eb027f47db609be29a991f6fc0f

packages/pocketpages-plugin-datastar-v1/index.js
647560acc1d491afdd9e01ecff8a9ec3c448641db3e561aca9d9535ae5519af7

packages/auth-cookie/index.js
d5c78433b36e365c1f0f0234fea5b79083faddc5bc3331510ee93dd24e9dadc3

scripts/patches/pocketbase-js-sdk-jsvm+0.28.10001.patch
66bcfe0272a3a60f69a048792f269592664e87d7d22a5498313381d76ec2191f

scripts/patches/pocketpages+0.22.5.patch
17b5522d74d850a3afe92fde48a87a64e655495c564fa57605a8262004636dab

scripts/patches/pocketpages-plugin-auth+0.3.0.patch
4661caf6dd250d993f1216cb7d8a085aa87d11b7e778096a2a7ec8514a14e5a5

scripts/patches/pocketpages-plugin-ejs+0.2.0.patch
3cedae53ac5c10a2edea67e37a5841497c0e0b68f64777158e966b0776b1b9ed

scripts/patches/pocketpages-plugin-js-sdk+0.3.0.patch
3f1de4275f9e4c85293467bda37cce7960a6495c03aaf03b1492315aaf37b802
```

설치된 파일의 줄 번호는 이 스냅샷을 기준으로 한다. 이후 패치·업데이트 후에는 해시와 코드를 다시 확인해야 한다.

## 10. 최종 판단

현재 PocketPages 구조를 즉시 폐기하거나 CE로 이전해야 한다는 결론은 아니다. 기존 패치와 실제 서버 검증은 현재 요청 흐름을 유지할 근거가 된다.

동시에 이번에 발견한 조건부 문제까지 “프레임워크가 작으니 괜찮다”로 넘겨서는 안 된다. **현재 외부 도달성이 확인되지 않은 것과 함수 자체가 안전한 것은 서로 다르다.** 확인된 입력·경계 보완점을 작게 수정하고 영구 테스트로 남기는 방향이 적절하다.

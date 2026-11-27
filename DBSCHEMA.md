# PocketBase Schema Cheat Sheet

기준: PocketBase v0.42.3 소스 (`core/field_*.go`, `core/collection_*.go`, `core/record_model.go`)

## 핵심 규칙

- 필드 옵션 검증(`required`, `min`, `max`, `pattern`, `values`, relation 존재 확인)은 `$app.save()`에서만 실행된다.
- `$app.saveNoValidate()`와 raw SQL 쓰기는 필드 검증을 모두 건너뛴다.
- SQLite에 생성되는 제약은 `NOT NULL` + 기본값, `id` PRIMARY KEY, `indexes`뿐이다. `CHECK`, `FOREIGN KEY`는 없다.
- `cascadeDelete`는 `$app.delete()`에서만 동작한다. raw SQL `DELETE`는 연쇄 처리하지 않는다.
- 컬렉션 `type`, 필드 `type`, relation `collectionId`는 생성 후 변경 불가.

## Collection

### 공통 옵션

| 옵션                                                         | 값                         | 설명                            |
| ------------------------------------------------------------ | -------------------------- | ------------------------------- |
| `id`                                                         | `^\w+$`, 1~100자           | 생성 후 변경 불가               |
| `name`                                                       | `^\w+$`, 1~255자           | 테이블명, 유일                  |
| `type`                                                       | `base` \| `auth` \| `view` | 변경 불가                       |
| `system`                                                     | bool                       | 시스템 컬렉션 여부              |
| `fields`                                                     | Field[]                    | 필드 목록                       |
| `indexes`                                                    | string[]                   | `CREATE [UNIQUE] INDEX ...` SQL |
| `listRule` `viewRule` `createRule` `updateRule` `deleteRule` | `null` \| string           | API 규칙                        |

### API 규칙 값

| 값     | 의미                      |
| ------ | ------------------------- |
| `null` | superuser만 허용 (기본값) |
| `""`   | 누구나 허용               |
| 필터식 | 식을 만족하는 요청만 허용 |

- 규칙은 Record API에만 적용된다. `$app`/`txApp` 직접 조회·저장에는 적용되지 않는다.

### `auth` 전용 옵션

| 옵션                                                                                | 설명                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `authRule`                                                                          | 인증 직후 추가 조건. 기본 `""`. `null`이면 로그인 전체 불가  |
| `manageRule`                                                                        | 다른 auth 레코드 관리 권한. create/update 규칙에 추가로 적용 |
| `authAlert`                                                                         | 새 디바이스 로그인 알림 (`enabled`, `emailTemplate`)         |
| `oauth2`                                                                            | OAuth2 (`enabled`, `providers`, `mappedFields`)              |
| `passwordAuth`                                                                      | 비밀번호 로그인 (`enabled`, `identityFields`)                |
| `mfa`                                                                               | MFA (`enabled`, `duration`, `rule`)                          |
| `otp`                                                                               | OTP (`enabled`, `duration`, `length`, `emailTemplate`)       |
| `authToken` `passwordResetToken` `emailChangeToken` `verificationToken` `fileToken` | 토큰 설정 (`duration`, `secret`)                             |
| `verificationTemplate` `resetPasswordTemplate` `confirmEmailChangeTemplate`         | 메일 템플릿 (`subject`, `body`)                              |

### `view` 전용

| 항목                                   | 규칙                                    |
| -------------------------------------- | --------------------------------------- |
| `viewQuery`                            | 필수 SQL SELECT                         |
| `fields`                               | `viewQuery`에서 자동 생성               |
| `createRule` `updateRule` `deleteRule` | 반드시 `null`                           |
| `indexes`                              | 사용 불가                               |
| relation → view                        | view 컬렉션만 다른 view를 대상으로 가능 |
| realtime                               | 이벤트 없음                             |

## 기본 필드

| 컬렉션               | 필드              | 설정                                                                                                        |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| 모든 타입(view 제외) | `id`              | text, `primaryKey`, `required`, `system`, 15자, `pattern: ^[a-z0-9]+$`, `autogeneratePattern: [a-z0-9]{15}` |
| `auth`               | `email`           | email, `required`, unique index `WHERE email != ''` 필수                                                    |
| `auth`               | `emailVisibility` | bool                                                                                                        |
| `auth`               | `verified`        | bool                                                                                                        |
| `auth`               | `password`        | password, `hidden`, `required`, 기본 `min: 8`                                                               |
| `auth`               | `tokenKey`        | text, `hidden`, `required`, unique index 필수                                                               |

- `created`/`updated`는 자동 생성되지 않는다. 대시보드 UI만 추가한다. 마이그레이션/JSVM에서는 직접 정의한다.
  - `created`: `{ type: "autodate", onCreate: true }`
  - `updated`: `{ type: "autodate", onCreate: true, onUpdate: true }`
- `auth` 시스템 필드는 이름 변경·삭제 불가.

## Field 공통 속성

| 속성          | 설명                              |
| ------------- | --------------------------------- |
| `id`          | 필드 고유 ID                      |
| `name`        | 필드명 = 컬럼명                   |
| `type`        | 필드 타입, 변경 불가              |
| `system`      | 시스템 필드 여부                  |
| `hidden`      | API 응답에서 제외                 |
| `presentable` | 대시보드 relation 미리보기 라벨   |
| `help`        | 대시보드 도움말 (`autodate` 제외) |

## Field Type

| type       | 값                      | SQLite 컬럼                                 | 빈 값           |
| ---------- | ----------------------- | ------------------------------------------- | --------------- |
| `text`     | string                  | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `number`   | float64                 | `NUMERIC DEFAULT 0 NOT NULL`                | `0`             |
| `bool`     | bool                    | `BOOLEAN DEFAULT FALSE NOT NULL`            | `false`         |
| `email`    | string                  | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `url`      | string                  | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `editor`   | HTML string             | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `password` | bcrypt hash             | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `date`     | `Y-m-d H:i:s.uZ` string | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `autodate` | `Y-m-d H:i:s.uZ` string | `TEXT DEFAULT '' NOT NULL`                  | `""`            |
| `select`   | string 또는 string[]    | 단일 `TEXT`, 다중 `JSON DEFAULT '[]'`       | `""` / `[]`     |
| `file`     | 파일명 또는 파일명[]    | 단일 `TEXT`, 다중 `JSON DEFAULT '[]'`       | `""` / `[]`     |
| `relation` | record id 또는 id[]     | 단일 `TEXT`, 다중 `JSON DEFAULT '[]'`       | `""` / `[]`     |
| `json`     | 임의 JSON               | `JSON DEFAULT NULL` (유일하게 nullable)     | `null`          |
| `geoPoint` | `{ lon, lat }`          | `JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL` | `{lon:0,lat:0}` |

- 단일/다중: `maxSelect <= 1` → 단일, `maxSelect >= 2` → 다중 (`select`, `file`, `relation`).

## Field Option

`0`/빈 값 옵션은 "미설정"으로 처리된다. 기본 한도가 있는 경우 아래에 명시한다.

### `text`

| 옵션                  | 규칙                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `min`                 | 최소 글자 수 (rune 기준), `>= 0`                                       |
| `max`                 | 최대 글자 수 (rune 기준), `>= min`. `0`이면 5000                       |
| `pattern`             | 정규식. 빈 값은 검사 안 함                                             |
| `autogeneratePattern` | 새 레코드에서 값이 `""`일 때 정규식으로 생성                           |
| `required`            | `""` 금지                                                              |
| `primaryKey`          | 컬렉션당 1개, 이름 `id` 필수, `pattern`·`required` 필수, `hidden` 불가 |

### `number`

| 옵션       | 규칙                                             |
| ---------- | ------------------------------------------------ |
| `min`      | 최소값. `null`이면 제한 없음 (`0`도 유효한 제한) |
| `max`      | 최대값. `null`이면 제한 없음, `>= min`           |
| `onlyInt`  | 정수만 허용                                      |
| `required` | `0` 금지                                         |

- 값이 `0`이면 `min`/`max`/`onlyInt` 검사를 건너뛴다. `min: 1`이어도 `required` 없이는 `0` 저장 가능.

### `bool`

| 옵션       | 규칙          |
| ---------- | ------------- |
| `required` | `true`만 허용 |

### `email` / `url`

| 옵션            | 규칙             |
| --------------- | ---------------- |
| `onlyDomains`   | 허용 도메인 목록 |
| `exceptDomains` | 금지 도메인 목록 |
| `required`      | `""` 금지        |

- `onlyDomains`와 `exceptDomains`는 동시 사용 불가.
- `url`은 `host`(포트 포함)로 비교한다.

### `editor`

| 옵션          | 규칙                          |
| ------------- | ----------------------------- |
| `maxSize`     | 최대 바이트. `0`이면 5MB      |
| `convertURLs` | 대시보드 에디터 URL 변환 방식 |
| `required`    | `""` 금지                     |

### `password`

| 옵션       | 규칙                                     |
| ---------- | ---------------------------------------- |
| `min`      | 평문 최소 글자 수, 0~71                  |
| `max`      | 평문 최대 글자 수, `min`~71. `0`이면 71  |
| `pattern`  | 평문 정규식                              |
| `cost`     | bcrypt cost, 4~31. `0`이면 bcrypt 기본값 |
| `required` | hash 필수                                |

### `date`

| 옵션       | 규칙                |
| ---------- | ------------------- |
| `min`      | 최소 시각           |
| `max`      | 최대 시각, `>= min` |
| `required` | 빈 값 금지          |

- 빈 값이면 `min`/`max` 검사를 건너뛴다.

### `autodate`

| 옵션       | 규칙                   |
| ---------- | ---------------------- |
| `onCreate` | 생성 시 현재 시각 설정 |
| `onUpdate` | 수정 시 현재 시각 설정 |

- `onCreate`/`onUpdate` 중 하나 이상 필수.
- 저장 전에 값을 직접 바꾸면 자동 시각으로 덮어쓰지 않는다.
- `required`, `help` 없음.

### `select`

| 옵션        | 규칙                              |
| ----------- | --------------------------------- |
| `values`    | 허용값 목록, 필수                 |
| `maxSelect` | 최대 선택 수, `0 ~ values.length` |
| `required`  | 1개 이상 선택                     |

### `file`

| 옵션        | 규칙                                                |
| ----------- | --------------------------------------------------- |
| `maxSize`   | 파일 1개 최대 바이트. `0`이면 5MB                   |
| `maxSelect` | 최대 파일 수                                        |
| `mimeTypes` | 허용 MIME 목록. 빈 값이면 검사 안 함                |
| `thumbs`    | `WxH` `WxHt` `WxHb` `WxHf` `0xH` `Wx0` (`0x0` 불가) |
| `protected` | 파일 토큰 필요. 기본은 공개 (파일명에 랜덤 접미사)  |
| `required`  | 1개 이상                                            |

- 업로드 파일명은 1~150자.

### `relation`

| 옵션            | 규칙                                                      |
| --------------- | --------------------------------------------------------- |
| `collectionId`  | 대상 컬렉션의 실제 `id`, 필수, 변경 불가                  |
| `cascadeDelete` | 아래 삭제 동작 참고                                       |
| `minSelect`     | 최소 연결 수, `>= 0`                                      |
| `maxSelect`     | 최대 연결 수. `minSelect > 0`이면 필수이고 `>= minSelect` |
| `required`      | 1개 이상 연결                                             |

- 저장 시 대상 레코드가 모두 존재하는지 조회로 확인한다 (FK 아님).

### `json`

| 옵션       | 규칙                          |
| ---------- | ----------------------------- |
| `maxSize`  | 최대 바이트. `0`이면 1MB      |
| `required` | `null`, `""`, `[]`, `{}` 금지 |

### `geoPoint`

| 옵션       | 규칙                  |
| ---------- | --------------------- |
| `required` | `{lon:0, lat:0}` 금지 |

- 범위: `lat` -90~90, `lon` -180~180.

## relation 삭제 동작

레코드 B 삭제 시, B를 참조하는 레코드 A마다:

1. A의 relation 값에서 B의 id를 제거한다.
2. `cascadeDelete: true`이고 남은 id가 없으면 → A 삭제.
3. 아니고 `required: true`이고 남은 id가 없으면 → B 삭제 실패.
4. 그 외 → A를 검증 없이 저장.

- 다중 relation에 다른 id가 남아 있으면 `cascadeDelete`여도 A는 삭제되지 않는다.

## 제약 위치

| 제약                                                                                                        | 위치                 | `saveNoValidate`/raw SQL에서 |
| ----------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------- |
| `NOT NULL` + 기본값                                                                                         | SQLite               | 적용                         |
| `id` PRIMARY KEY                                                                                            | SQLite               | 적용                         |
| `indexes` (UNIQUE, 복합, 부분 `WHERE`)                                                                      | SQLite               | 적용                         |
| 필드 옵션 전체 (`required`, `min`, `max`, `pattern`, `values`, `maxSelect`, `maxSize`, `mimeTypes`, 도메인) | 앱 검증              | 미적용                       |
| relation 대상 존재                                                                                          | 앱 검증              | 미적용                       |
| `cascadeDelete`                                                                                             | 앱 (`$app.delete()`) | 미적용                       |
| `autogeneratePattern`, `autodate`                                                                           | 앱 (`$app.save()`)   | raw SQL 미적용               |

## 스키마 변경 시 주의

| 상황                      | 동작 / 규칙                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 필드명                    | `^\w+$`, 1~100자. `null` `true` `false` `_rowid_` `collectionId` `collectionName` `expand` 금지. auth는 `passwordConfirm` `oldPassword`도 금지 |
| 선택 필드에 UNIQUE 인덱스 | 빈 값이 `''`로 저장되어 서로 중복 처리된다. `WHERE field != ''` 부분 인덱스를 쓴다                                                             |
| `maxSelect` 단일 → 다중   | 컬럼이 `JSON`으로 바뀌고 기존 값은 `[값]`으로 변환된다                                                                                         |
| `maxSelect` 다중 → 단일   | 컬럼이 `TEXT`로 바뀌고 **마지막 값만 남는다** (나머지 손실)                                                                                    |
| 컬렉션 `name` 변경        | 테이블명이 바뀐다. raw SQL·`viewQuery`의 테이블명은 직접 수정한다                                                                              |

## 앱 레벨 처리가 필요한 것

| 항목                                  | 이유                           |
| ------------------------------------- | ------------------------------ |
| JSON 내부 구조 검증                   | `json`은 유효 JSON·크기만 검사 |
| 필드 간 조건부 검증                   | 필드 단위 검증만 존재          |
| relation 대상 레코드 상태             | 존재 여부만 확인               |
| `number` 0 / `date` 빈 값의 범위 검사 | 빈 값은 `min`/`max` 생략       |
| 업무 규칙                             | 스키마 표현 불가               |

## `pb_schema.json` 작성 규칙

형식: 컬렉션 객체 배열 (대시보드 Export와 동일). `$app.importCollectionsByMarshaledJSON(json, deleteMissing)`로 적용한다.

### import 동작

| 항목                   | 동작                                                        |
| ---------------------- | ----------------------------------------------------------- |
| 컬렉션 매칭            | `id`로 찾고, 없으면 `name`으로 찾는다                       |
| 필드 매칭              | 필드 `id`로 찾는다                                          |
| 생략한 속성            | 기본값이 아니라 0/빈 값으로 설정된다 (auth 옵션만 기본값)   |
| 컬렉션 `id` 생략       | `pbc_` + crc32(type+name) 자동 생성                         |
| 필드 `id` 생략         | `<type>` + crc32(name) 자동 생성                            |
| `deleteMissing: false` | 파일에 없는 컬렉션·필드를 유지한다                          |
| `deleteMissing: true`  | 파일에 없는 컬렉션과 비시스템 필드를 삭제한다 (데이터 손실) |

### MUST

- 요청받은 변경만 한다. 기존 항목에 속성을 더하거나, `id`·순서·형식을 정리하지 않는다.
- 기존 컬렉션·필드의 `id`는 변경하지 않는다. 이름 변경은 `name`만 바꾼다.
- 새 필드는 같은 파일 안에 있는 같은 타입 필드와 똑같은 속성 구성으로 쓴다.
- 새 컬렉션·필드·인덱스의 `id`와 이름은 같은 파일의 기존 관례를 따른다. 관례가 없을 때만 아래 형식을 쓴다.
  - 필드 `id`: `<type><숫자>` (예: `text1579384326`), 컬렉션 안에서 유일
  - 컬렉션 `id`: `pbc_<숫자>`, 파일 전체에서 유일
  - 인덱스 이름: `idx_<컬렉션>_<용도>`, 파일 전체에서 유일
- relation `collectionId`에는 대상 컬렉션의 `id` 값(`_pb_users_auth_`, `pbc_...`)을 넣는다. 컬렉션 이름은 넣지 않는다.
- auth 컬렉션은 `email`(`WHERE email != ''`)·`tokenKey` unique 인덱스를 유지한다.
- `_superusers` 컬렉션과 `system: true` 필드는 수정하지 않는다.
- 새 컬렉션에는 `created`/`updated` autodate 필드를 직접 추가한다.
- 새 컬렉션에만 API 규칙 기본 `null`을 적용한다 (AGENTS.md 정책). 기존 컬렉션, 시스템 컬렉션(`_`로 시작), `users`의 규칙은 건드리지 않는다.
- `deleteMissing: true`로 import하지 않는다. 필요하면 삭제 대상을 먼저 확인한다.
- 이 파일은 lint의 컬렉션·필드명 기준이다. 필드명을 바꾸면 코드의 `record.get('field')`·filter·sort도 함께 바꾼다.

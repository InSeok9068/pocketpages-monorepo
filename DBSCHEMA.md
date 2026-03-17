# PocketBase Schema Cheat Sheet

## Collection Type

| Type | 설명 | 비고 |
| --- | --- | --- |
| `base` | 일반 데이터 컬렉션 | 기본 타입 |
| `auth` | 인증 기능 포함 컬렉션 | 로그인/토큰/OTP/MFA 옵션 포함 |
| `view` | 읽기 전용 컬렉션 | `viewQuery` 필요, 인덱스 불가 |

## Collection Option

### 공통

| 옵션 | 설명 |
| --- | --- |
| `name` | 컬렉션 이름 |
| `type` | 컬렉션 타입 |
| `fields` | 필드 목록 |
| `indexes` | 인덱스/유니크 제약 SQL 목록 |
| `listRule` | 목록 조회 규칙 |
| `viewRule` | 단건 조회 규칙 |
| `createRule` | 생성 규칙 |
| `updateRule` | 수정 규칙 |
| `deleteRule` | 삭제 규칙 |

### `auth` 전용

| 옵션 | 설명 |
| --- | --- |
| `authRule` | 인증 직후 추가 제약 |
| `manageRule` | 관리자 수준 관리 권한 규칙 |
| `authAlert` | 새 디바이스 로그인 알림 |
| `oauth2` | OAuth2 설정 |
| `passwordAuth` | 비밀번호 로그인 설정 |
| `mfa` | MFA 설정 |
| `otp` | OTP 설정 |
| `authToken` | 인증 토큰 설정 |
| `passwordResetToken` | 비밀번호 재설정 토큰 설정 |
| `emailChangeToken` | 이메일 변경 토큰 설정 |
| `verificationToken` | 이메일 인증 토큰 설정 |
| `fileToken` | 보호 파일 토큰 설정 |
| `verificationTemplate` | 이메일 인증 메일 템플릿 |
| `resetPasswordTemplate` | 비밀번호 재설정 메일 템플릿 |
| `confirmEmailChangeTemplate` | 이메일 변경 확인 메일 템플릿 |

### `view` 전용

| 옵션 | 설명 |
| --- | --- |
| `viewQuery` | view collection을 만드는 SQL SELECT |

## 모든 Field 공통 속성

| 속성 | 설명 |
| --- | --- |
| `name` | 필드명 |
| `id` | 필드 고유 ID |
| `system` | 시스템 필드 여부 |
| `hidden` | API 응답에서 숨김 여부 |
| `presentable` | Dashboard relation preview label 힌트 |

## Field Type

| Field Type | 값 형태 | 주요 용도 |
| --- | --- | --- |
| `text` | 문자열 | 일반 텍스트, slug, 코드값 |
| `number` | 숫자 | 수치, 개수, 정렬값 |
| `bool` | 참/거짓 | 플래그, 동의 여부 |
| `email` | 이메일 문자열 | 이메일 |
| `url` | URL 문자열 | 링크 |
| `editor` | HTML 문자열 | 리치 텍스트 |
| `password` | 비밀번호 문자열 | 비밀번호 |
| `date` | datetime | 일반 날짜/시각 |
| `autodate` | 자동 datetime | 생성/수정 시각 |
| `select` | 문자열 또는 문자열 배열 | enum, 단일/다중 선택 |
| `file` | 파일명 또는 파일명 배열 | 업로드 파일 |
| `relation` | record id 또는 record id 배열 | 컬렉션 간 연결 |
| `json` | JSON 값 | 자유 구조 데이터 |
| `geoPoint` | `{ lon, lat }` | 좌표 |

## Field Option

### `text`

| 옵션 | 설명 |
| --- | --- |
| `min` | 최소 글자 수 |
| `max` | 최대 글자 수 |
| `pattern` | 정규식 패턴 |
| `autogeneratePattern` | 자동 생성 패턴 |
| `required` | 빈 문자열 금지 |
| `primaryKey` | 기본키 여부 |

### `number`

| 옵션 | 설명 |
| --- | --- |
| `min` | 최소값 |
| `max` | 최대값 |
| `onlyInt` | 정수만 허용 |
| `required` | 0이 아닌 값 강제 |

### `bool`

| 옵션 | 설명 |
| --- | --- |
| `required` | 사실상 `true` 강제 |

### `email`

| 옵션 | 설명 |
| --- | --- |
| `onlyDomains` | 허용 도메인 목록 |
| `exceptDomains` | 금지 도메인 목록 |
| `required` | 필수 여부 |

### `url`

| 옵션 | 설명 |
| --- | --- |
| `onlyDomains` | 허용 도메인 목록 |
| `exceptDomains` | 금지 도메인 목록 |
| `required` | 필수 여부 |

### `editor`

| 옵션 | 설명 |
| --- | --- |
| `maxSize` | 최대 바이트 크기 |
| `convertURLs` | URL 변환 여부 |
| `required` | 필수 여부 |

### `password`

| 옵션 | 설명 |
| --- | --- |
| `pattern` | 정규식 패턴 |
| `min` | 최소 길이 |
| `max` | 최대 길이 |
| `cost` | bcrypt cost |
| `required` | 필수 여부 |

### `date`

| 옵션 | 설명 |
| --- | --- |
| `min` | 최소 날짜/시각 |
| `max` | 최대 날짜/시각 |
| `required` | 필수 여부 |

### `autodate`

| 옵션 | 설명 |
| --- | --- |
| `onCreate` | 생성 시 자동 입력 |
| `onUpdate` | 수정 시 자동 입력 |

### `select`

| 옵션 | 설명 |
| --- | --- |
| `values` | 허용값 목록 |
| `maxSelect` | 최대 선택 개수 |
| `required` | 필수 여부 |

### `file`

| 옵션 | 설명 |
| --- | --- |
| `maxSize` | 파일 1개당 최대 크기 |
| `maxSelect` | 최대 파일 개수 |
| `mimeTypes` | 허용 MIME 타입 |
| `thumbs` | 생성 가능한 썸네일 규격 |
| `protected` | 토큰 필요 접근 여부 |
| `required` | 최소 1개 파일 강제 |

### `relation`

| 옵션 | 설명 |
| --- | --- |
| `collectionId` | 대상 컬렉션 ID |
| `cascadeDelete` | 연쇄 삭제 여부 |
| `minSelect` | 최소 연결 수 |
| `maxSelect` | 최대 연결 수 |
| `required` | 필수 여부 |

### `json`

| 옵션 | 설명 |
| --- | --- |
| `maxSize` | 최대 바이트 크기 |
| `required` | 비어 있지 않은 JSON 강제 |

### `geoPoint`

| 옵션 | 설명 |
| --- | --- |
| `required` | 좌표 필수 여부 |

## Field Type별 제약 한눈에 보기

| Field Type | 길이/범위 | 패턴/허용값 | 개수 제한 | 기타 |
| --- | --- | --- | --- | --- |
| `text` | `min`, `max` | `pattern` | - | `autogeneratePattern`, `primaryKey`, `required` |
| `number` | `min`, `max` | - | - | `onlyInt`, `required` |
| `bool` | - | - | - | `required` |
| `email` | - | `onlyDomains`, `exceptDomains` | - | `required` |
| `url` | - | `onlyDomains`, `exceptDomains` | - | `required` |
| `editor` | `maxSize` | - | - | `convertURLs`, `required` |
| `password` | `min`, `max` | `pattern` | - | `cost`, `required` |
| `date` | `min`, `max` | - | - | `required` |
| `autodate` | - | - | - | `onCreate`, `onUpdate` |
| `select` | - | `values` | `maxSelect` | `required` |
| `file` | `maxSize` | `mimeTypes` | `maxSelect` | `thumbs`, `protected`, `required` |
| `relation` | - | 대상 `collectionId` 고정 | `minSelect`, `maxSelect` | `cascadeDelete`, `required` |
| `json` | `maxSize` | - | - | `required` |
| `geoPoint` | - | - | - | `required` |

## DB 레벨 제약

| 분류 | 제약 | 관련 옵션 |
| --- | --- | --- |
| 필수값 | 값 존재 강제 | `required` |
| 문자열 길이 | 최소/최대 길이 | `text.min`, `text.max`, `password.min`, `password.max` |
| 숫자 범위 | 최소/최대 숫자 | `number.min`, `number.max` |
| 날짜 범위 | 최소/최대 날짜 | `date.min`, `date.max` |
| 정규식 | 문자열 패턴 검증 | `text.pattern`, `password.pattern` |
| 정수 강제 | 소수 금지 | `number.onlyInt` |
| enum | 허용값 제한 | `select.values` |
| 선택 개수 | 다중 선택 수 제한 | `select.maxSelect` |
| relation 개수 | 최소/최대 연결 수 | `relation.minSelect`, `relation.maxSelect` |
| relation 대상 | 연결 대상 컬렉션 고정 | `relation.collectionId` |
| 연쇄 삭제 | 부모 삭제 시 자식 정리 | `relation.cascadeDelete` |
| 이메일 도메인 제한 | 허용/금지 도메인 | `email.onlyDomains`, `email.exceptDomains` |
| URL 도메인 제한 | 허용/금지 도메인 | `url.onlyDomains`, `url.exceptDomains` |
| 파일 크기 제한 | 업로드 용량 제한 | `file.maxSize` |
| 파일 개수 제한 | 업로드 개수 제한 | `file.maxSelect` |
| 파일 타입 제한 | MIME 화이트리스트 | `file.mimeTypes` |
| 보호 파일 | 토큰 없는 접근 차단 | `file.protected` |
| JSON 크기 제한 | JSON payload 크기 제한 | `json.maxSize` |
| HTML 크기 제한 | HTML payload 크기 제한 | `editor.maxSize` |
| 자동 생성 | 값 자동 생성 | `text.autogeneratePattern` |
| 자동 시각 | 생성/수정 시각 자동 처리 | `autodate.onCreate`, `autodate.onUpdate` |
| 기본키 | primary key 지정 | `text.primaryKey` |
| 유니크 | 중복 금지 | `indexes` + `CREATE UNIQUE INDEX` |
| 일반 인덱스 | 조회 최적화 | `indexes` + `CREATE INDEX` |
| 복합 인덱스 | 다중 컬럼 인덱스 | `indexes` |
| 부분 인덱스 | 조건부 인덱스 | `indexes` + `WHERE ...` |

## 스키마만으로 잘 안 되는 것

| 항목 | 비고 |
| --- | --- |
| JSON 내부 shape 검증 | 앱 레벨 검증 필요 |
| 필드 간 조건부 검증 | 앱 레벨 검증 필요 |
| 복잡한 업무 규칙 | 앱 레벨 검증 필요 |
| relation 대상 레코드 상태 검증 | 앱 레벨 검증 필요 |

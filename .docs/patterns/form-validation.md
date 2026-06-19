# Form Validation

route entry에서 사용자 입력을 문자열로 정리하고, 도메인 규칙은 가까운 위치에 명시한다. 여러 route에서 공유되는 검증만 `_private` service로 옮긴다.

## Rules

- `undefined`, `null`을 먼저 문자열로 정규화한다.
- email처럼 비교가 필요한 값은 저장 전에 lower-case 등 규칙을 명시한다.
- date-only field는 `dateutil.toDateOnlyIso(...)`를 사용한다.
- 날짜 범위 검색은 `dateutil.startOfDay(...)`, `dateutil.endOfDay(...)`를 사용한다.
- 오류 메시지는 redirect 또는 JSON 응답에서 그대로 사용자에게 보여질 수 있게 짧게 작성한다.
- relation id는 hardcode하지 않는다.

## Skeleton

```ejs
<script server>
  const { dateutil } = require('@pocketpages/utils')

  const form = body()
  const title = String(form.title || '').trim()
  const email = String(form.email || '').trim().toLowerCase()
  const dueDate = String(form.dueDate || '').trim()

  if (!title) throw new Error('제목이 필요합니다.')
  if (!email) throw new Error('이메일이 필요합니다.')

  const input = {
    title,
    email,
    dueDate: dueDate ? dateutil.toDateOnlyIso(dueDate) : '',
  }
</script>
```

## Shared Shape

```ts
declare namespace types {
  type ItemInput = {
    title: string
    email: string
    dueDate: string
  }
}
```

## Check

- `./task.sh index <service> --section schemaUsage`
- `./task.sh lint <service>`

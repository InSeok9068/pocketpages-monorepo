# Private Service Module

여러 route에서 공유되는 도메인 로직은 `_private` CommonJS module로 둔다. 단일 page에서만 쓰는 로직은 page에 남긴다.

## File Shape

- `_private/<domain>/<domain>-service.js`
- `_private/<domain>/*.ejs` for domain partials
- route entry에서 `resolve('<domain>/<domain>-service')`로 불러온다.

## Rules

- `_private` module은 CommonJS만 사용한다.
- 고정 wiring에는 `_private` 상대 이름을 사용한다.
- `_private` module 안에서 `resolve()`를 기본값처럼 이어 붙이지 않는다.
- request-context dependency는 entry에서 고르고 module에 주입한다.
- shared function에는 JSDoc을 쓴다.
- DB write, redirect, response building이 숨겨지지 않게 함수 이름과 호출 지점을 명확하게 둔다.

## Skeleton

```js
/**
 * 입력값을 저장 가능한 형태로 정리합니다.
 * @param {Record<string, any>} form 입력값
 * @returns {types.ItemInput}
 */
function normalizeItemInput(form) {
  return {
    title: String(form.title || '').trim(),
  }
}

/**
 * 항목을 생성합니다.
 * @param {{ app: any, collectionId: string, input: types.ItemInput }} options 생성 옵션
 * @returns {core.Record}
 */
function createItem(options) {
  const collection = options.app.findCollectionByNameOrId(options.collectionId)
  const record = new Record(collection)
  record.set('title', options.input.title)
  options.app.save(record)
  return record
}

module.exports = {
  normalizeItemInput,
  createItem,
}
```

## Entry Usage

```ejs
<script server>
  const itemService = resolve('items/item-service')
  const input = itemService.normalizeItemInput(body())
</script>
```

## Check

- `./task.sh index <service> --section resolveGraph`
- `./task.sh lint <service>`

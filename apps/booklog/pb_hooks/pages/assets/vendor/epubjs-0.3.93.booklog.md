# epub.js 0.3.93: Booklog 변경 사항

`epubjs-0.3.93.min.js`에 아래 수정을 적용했습니다. 라이브러리를 교체할 때 동일한 회귀 테스트로 확인해야 합니다.

## 완성된 챕터 표시

`check()`는 새 챕터의 `display()` 완료 후 재귀적으로 앞뒤 챕터를 더 확인하고, 모든 확인이 끝난 뒤 `update()`에서 본문을 표시했습니다. 빠른 역방향 스크롤과 연속 로딩 지연이 겹치면 이미 렌더링된 챕터까지 숨겨진 상태로 남을 수 있었습니다.

```js
// Before
let m = s.map(t => t.display(this.request));

// After
let m = s.map(t => t.display(this.request).then(t => (t.show(), t)));
```

각 챕터가 준비되면 해당 view의 `show()`를 호출합니다. 기존 `check()`·`update()`와 위치 보정은 유지합니다.

## 늦게 실행되는 정리 작업

`update()`는 화면 밖 view의 `destroy()`를 큐에 넣었습니다. 큐 실행 전에 사용자가 반대 방향으로 이동하면, 예약 당시 화면 밖이었던 view가 현재 화면 안에 들어와도 파괴할 수 있었습니다.

```js
// Before
this.q.enqueue(e.destroy.bind(e));

// After
this.q.enqueue(function (view) {
  let offset = this.settings.offset || 0;
  if (!this.isVisible(view, offset, offset, this.bounds())) view.destroy();
}.bind(this, e));
```

정리 시점에 현재 화면과 기존 offset 기준으로 가시성을 다시 판단합니다. 화면 밖 view는 기존대로 정리합니다. 별도 `scrollTop` 보정은 추가하지 않습니다.

## 불러오는 중 지워진 챕터

`Views.destroy()`는 아직 불러오는 중인 view의 요소도 떼어 냅니다. 떼어진 iframe은 `onload`가 오지 않아 `display()`가 끝나지 않고, 그 view를 기다리던 `check()`와 manager 큐 전체가 멈췄습니다. 표시 전 view는 `abandon()`으로 대기 중인 `load()`를 실패로 끝내고, 이미 버린 view는 `load()`를 바로 실패시킵니다. `check()`는 실패를 받아 다음 작업으로 넘어갑니다.

```js
// Before
destroy(t){t.displayed&&t.destroy(),...}

// After
destroy(t){t.displayed?t.destroy():t.abandon&&t.abandon(),...}
abandon(){this.abandoned=!0,this.pendingLoad&&this.pendingLoad.reject(new Error("View removed while loading"))}
load(t){...if(!this.iframe||this.abandoned)return e.reject(...),i;this.pendingLoad=e;...}
```

## 불러오는 중 다시 호출된 표시

`update()`는 화면 안의 표시 전 view에 `display()`를 다시 부릅니다. `load()`가 `iframe.onload`를 덮어써 먼저 기다리던 쪽이 끝나지 않았습니다. 진행 중인 `display()`는 같은 promise를 돌려줍니다.

```js
display(t){if(this.pendingDisplay)return this.pendingDisplay;...}
```

## 표시 실패

`Rendition._display()`는 manager 표시가 실패하면 `displayerror`만 보내고 promise를 끝내지 않았습니다. 실패를 그대로 돌려줘 호출한 쪽이 대체 위치로 넘어가게 합니다.

```js
// Before
t=>{this.emit(DISPLAY_ERROR,t)}

// After
t=>{this.displaying=void 0,this.emit(DISPLAY_ERROR,t),i.reject(t)}
```

## 검증

`apps/booklog/tests/reader-scroll.spec.mjs`의 `Scroll stress` 시나리오, `reader-features.spec.mjs`의 그림 페이지 다시 열기 검사와 기존 navigation/scroll/audio 검사를 사용합니다. 고정 seed 입력 계획과 프레임별 문단 좌표, 표시 중 view가 파괴되는지, 로딩 종료 후 위치가 유지되는지를 확인합니다. 실제 iPhone Safari 관성 스크롤의 대체 검증은 아닙니다.

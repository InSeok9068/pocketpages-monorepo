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

## 화면 밖 챕터 정리

`update()`는 화면 밖 view를 `destroy()`로 내용만 비우고 목록에는 남겼습니다. 빠르게 스크롤하면 잠깐 화면 밖에 나간 view가 비워졌다가, 다시 화면에 들어오면 `update()`가 처음부터 다시 그렸습니다. 다시 그릴 때 높이가 크게 재졌다가 줄어, 화면 맨 위에 걸친 챕터의 보정만큼 보던 곳이 튀었습니다. 이전 패치(실행 시점에 가시성 재확인)도 이 재표시를 막지는 못했습니다.

`update()`는 더 이상 view를 비우지 않고, 정리는 `trim()`에 맡깁니다. `trim()`은 표시된 view가 아니라 현재 화면과 offset 안에 있는 view를 기준으로, 그 앞뒤 한 개씩만 남기고 `erase()`합니다. `erase()`는 위쪽 view를 지울 때 기존처럼 스크롤을 보정합니다.

```js
// Before
else this.q.enqueue(function (view) { ...isVisible... || view.destroy() }.bind(this, e)), clearTimeout(this.trimTimeout), ...
trim(){for(var t=new n.defer,e=this.views.displayed(),i=e[0],...

// After
else clearTimeout(this.trimTimeout), ...
trim(){var t=new n.defer,f=this.settings.offset||0,b=this.bounds(),e=this.views.all().filter(function(v){return v.displayed&&this.isVisible(v,f,f,b)}.bind(this));if(!e.length)return t.resolve(),t.promise;for(var i=e[0],...
```

화면 근처 view가 하나도 없으면 아무것도 지우지 않습니다.

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

## 첫 높이 측정 전 본문 준비

Booklog continuous manager는 새 view에 `prepareContents()`를 연결합니다. iframe view는 `layout.format()` 뒤, 첫 `expand()` 전에 이 promise를 기다립니다. 이미지 제한 크기·테마·앱 본문 스타일을 먼저 적용하고, 사용 중인 폰트가 loading이면 최대 500ms 동안 `document.fonts.ready`를 기다립니다. 임시 높이가 스크롤 범위에 들어갔다가 줄어드는 상황을 줄입니다. 준비된 view는 `contentsPrepared`로 표시하고, `Rendition.afterDisplayed()`는 content hook을 중복 실행하지 않습니다. render hook과 rendered 이벤트는 기존 표시 경로에 유지합니다.

```js
// iframe view.render(), after layout.format()
Promise.resolve(this.prepareContents ? this.prepareContents() : undefined).then(() => {
  this.addListeners()
  this.expand()
  if (this.settings.forceRight) this.element.style.marginLeft = this.width() + 'px'
})
// Rendition.afterDisplayed(): content hooks were already run for prepared views
if (view.contents && !view.contentsPrepared) { /* existing content hook path */ }
```

준비 callback이 없는 view의 기존 content hook 경로는 유지합니다. 개별 챕터가 준비되면 바로 표시하며, 전체 fill 완료까지 숨기지 않습니다. content hook 실패는 view의 display 실패로 전달되고 기존 큐 복구 경로를 사용합니다.

`reader-scroll.spec.mjs`의 `New chapters finish their content hooks before contributing their first scroll height`는 비동기 스타일 변경과 폰트 로딩 종료가 첫 resize에 반영되고 hook이 중복 호출되지 않는지 확인합니다. 500ms를 넘는 폰트는 기다리기를 끝내므로, 그 뒤의 폰트 교체에 따른 재배치까지 보장하지 않습니다.

## 검증

`apps/booklog/tests/reader-scroll.spec.mjs`의 `Scroll stress` 시나리오, `reader-features.spec.mjs`의 그림 페이지 다시 열기·빠른 위쪽 스크롤·끝에서 챕터 붙이기 검사와 기존 navigation/scroll/audio 검사를 사용합니다. 고정 seed 입력 계획과 프레임별 문단 좌표, 표시 중 view가 파괴되는지, 로딩 종료 후 위치가 유지되는지를 확인합니다. 실제 iPhone Safari 관성 스크롤의 대체 검증은 아닙니다.

/**
 * HTMX 응답에 전역 토스트 이벤트를 추가한다.
 * @param {{header: (name: string, value: string) => void}} response 응답 객체
 * @param {types.AppToastDetail} detail 토스트 정보
 */
function setToastTrigger(response, detail) {
  response.header(
    'HX-Trigger',
    toAsciiJson({
      'app-toast': detail,
    })
  )
}

function toAsciiJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, function (character) {
    return '\\u' + ('0000' + character.charCodeAt(0).toString(16)).slice(-4)
  })
}

module.exports = {
  setToastTrigger,
}

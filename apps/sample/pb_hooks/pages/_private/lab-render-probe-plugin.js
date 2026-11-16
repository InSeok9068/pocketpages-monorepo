const PROBE_MARKER = '__LAB_RENDER_PROBE__'

/**
 * 요청마다 만든 플러그인 인스턴스가 include 렌더에 쓰이는지 확인하는 실험 플러그인을 만든다.
 * @returns {import('pocketpages').Plugin} 요청 id를 partial에 채우는 플러그인
 */
function labRenderProbePluginFactory() {
  let requestProbeId = ''

  return {
    name: 'lab-render-probe',
    onRequest: function ({ request }) {
      requestProbeId = String(request.url.query.probe || '').trim()
    },
    onRender: function ({ content }) {
      if (typeof content !== 'string' || content.indexOf(PROBE_MARKER) === -1) return content

      return content.split(PROBE_MARKER).join(requestProbeId)
    },
  }
}

module.exports = labRenderProbePluginFactory

/* global module */
module.exports = {
  createAiClient: function () {
    return {
      vercelAiGatewayDecision: function () {
        throw new Error('Recommendations must not call a decision model')
      },
      vercelAiGateway: function (request) {
        if (request.model !== 'alibaba/qwen3.5-plus') throw new Error('Unexpected text model')
        const input = JSON.parse(request.input)
        if (!input.verifiedBooks) {
          return {
            ok: true,
            json: {
              suggestions: [1, 2, 3].map(function (index) {
                return { title: '발견한 책 ' + index, author: '추천 저자 ' + index }
              }),
            },
          }
        }
        return {
          ok: true,
          json: {
            recommendations: input.verifiedBooks.map(function (book) {
              return { id: book.id, reason: '소개를 바탕으로 고른 책이에요. <script>window.injected = true</script>' }
            }),
          },
        }
      },
    }
  },
}

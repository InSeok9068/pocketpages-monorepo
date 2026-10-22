/* global module */
function book(ranking, bookname, authors, isbn13) {
  return {
    ranking: String(ranking),
    bookname: bookname,
    authors: authors,
    publisher: '테스트 출판사',
    publication_year: '2024',
    isbn13: isbn13,
    addition_symbol: '03810',
    bookImageURL: 'https://image.example.com/' + isbn13 + '.jpg',
    bookDtlUrl: 'https://data4library.kr/bookV?isbn=' + isbn13,
    loan_count: String(5000 - ranking),
  }
}

module.exports = {
  searchBooks: function () {
    return { numFound: 0, docs: [], raw: {} }
  },
  getBookDetail: function () {
    return { book: null }
  },
  getPopularLoanBooks: function (_config, input) {
    if (input.addCode === '0;1') throw new Error('도서관정보나루 API 요청에 실패했습니다. timeout')
    return {
      numFound: 3,
      docs: [
        book(1, '완독한 책 :소설', '지은이: 첫 저자', '9791100000001'),
        book(2, '도서함에 없는 책', '둘째 저자 지음', '9791100000002'),
        book(3, '완독한 책 :소설', '지은이: 첫 저자', '9791100000003'),
      ],
    }
  },
  getHotTrendBooks: function () {
    return [
      {
        date: '2026-10-21',
        docs: [Object.assign(book(1, '급상승 책', '급상승 저자', '9791100000009'), { difference: '42' })],
      },
    ]
  },
}

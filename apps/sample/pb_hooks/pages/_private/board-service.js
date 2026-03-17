const { slugify } = require('./slugify');

/**
 * 게시판 목록을 정렬해서 조회합니다.
 * @returns {core.Record[]} 게시판 record 목록입니다.
 */
function listBoards() {
  return $app.findRecordsByFilter('boards', '', '+sort_order,+name', 50, 0);
}

/**
 * 공개 여부와 상관없이 slug로 게시판을 찾습니다.
 * @param {unknown} boardSlug 라우트나 폼에서 받은 게시판 slug 값입니다.
 * @returns {core.Record | null} 게시판이 있으면 record, 없으면 null입니다.
 */
function findBoardBySlug(boardSlug) {
  const slug = String(boardSlug || '').trim();

  if (!slug) {
    return null;
  }

  try {
    return $app.findFirstRecordByFilter('boards', 'slug = {:slug}', { slug });
  } catch (error) {
    return null;
  }
}

/**
 * 공개된 게시판 slug로 활성 게시판을 찾습니다.
 * @param {unknown} boardSlug 라우트나 폼에서 받은 게시판 slug 값입니다.
 * @returns {core.Record | null} 활성 게시판이 있으면 record, 없으면 null입니다.
 */
function findActiveBoardBySlug(boardSlug) {
  const slug = String(boardSlug || '').trim();

  if (!slug) {
    return null;
  }

  try {
    return $app.findFirstRecordByFilter('boards', 'slug = {:slug} && is_active = true', { slug });
  } catch (error) {
    return null;
  }
}

/**
 * 게시판 목록 경로를 만듭니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {string} 게시판 상세 경로입니다.
 */
function buildBoardPath(boardSlug) {
  const slug = String(boardSlug || '').trim();

  if (!slug) {
    return '/boards';
  }

  return '/boards/' + encodeURIComponent(slug);
}

/**
 * 게시판 생성 폼 입력값을 정규화합니다.
 * @param {Record<string, any> | null | undefined} form 게시판 폼 원본 값입니다.
 * @returns {types.BoardFormInput} 정규화한 게시판 입력값입니다.
 */
function readBoardForm(form) {
  const safeForm = form && typeof form === 'object' ? form : {};
  const name = String(safeForm.name || '').trim();

  return {
    name: name,
    slug: slugify(safeForm.slug || safeForm.name).slice(0, 80),
    description: String(safeForm.description || '').trim(),
  };
}

/**
 * 게시판 record를 템플릿용 plain object로 바꿉니다.
 * @param {core.Record | null | undefined} board 게시판 record입니다.
 * @returns {types.BoardSummary | null} 템플릿에서 바로 쓸 게시판 요약값입니다.
 */
function toBoardSummary(board) {
  if (!board) {
    return null;
  }

  const slug = String(board.get('slug') || '').trim();

  return {
    id: String(board.id || ''),
    name: String(board.get('name') || '').trim(),
    slug: slug,
    description: String(board.get('description') || '').trim(),
    path: buildBoardPath(slug),
    isActive: !!board.get('is_active'),
  };
}

/**
 * 게시판 record 목록을 템플릿용 plain object 목록으로 바꿉니다.
 * @param {core.Record[] | null | undefined} boards 게시판 record 목록입니다.
 * @returns {types.BoardSummary[]} 템플릿에서 바로 쓸 게시판 요약 목록입니다.
 */
function toBoardSummaries(boards) {
  const safeBoards = Array.isArray(boards) ? boards : [];
  const boardSummaries = [];

  safeBoards.forEach(function (board) {
    const boardSummary = toBoardSummary(board);

    if (boardSummary) {
      boardSummaries.push(boardSummary);
    }
  });

  return boardSummaries;
}

module.exports = {
  buildBoardPath,
  findBoardBySlug,
  findActiveBoardBySlug,
  listBoards,
  readBoardForm,
  slugify,
  toBoardSummaries,
  toBoardSummary,
};

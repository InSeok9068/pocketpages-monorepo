const { slugify } = require('./slugify')

var POST_STATUS_VALUES = {
  draft: true,
  published: true,
  archived: true,
}

/**
 * 게시글 상태값을 허용된 값으로 정규화합니다.
 * @param {unknown} value 상태 원본 값입니다.
 * @param {unknown} fallbackStatus 기본 상태값입니다.
 * @returns {types.PostStatus} 허용된 게시글 상태값입니다.
 */
function normalizePostStatus(value, fallbackStatus) {
  var fallback = String(fallbackStatus || 'draft')
    .trim()
    .toLowerCase()
  var nextStatus = String(value || fallback)
    .trim()
    .toLowerCase()

  if (!POST_STATUS_VALUES[fallback]) {
    fallback = 'draft'
  }

  if (!POST_STATUS_VALUES[nextStatus]) {
    return /** @type {types.PostStatus} */ (fallback)
  }

  return /** @type {types.PostStatus} */ (nextStatus)
}

/**
 * 게시판 상세 경로를 만듭니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {string} 게시판 상세 경로입니다.
 */
function buildBoardPath(boardSlug) {
  const slug = String(boardSlug || '').trim()

  if (!slug) {
    return '/boards'
  }

  return '/boards/' + encodeURIComponent(slug)
}

/**
 * 게시글 상세 경로를 만듭니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @param {unknown} postSlug 게시글 slug 값입니다.
 * @returns {string} 게시글 상세 경로입니다.
 */
function buildPostPath(boardSlug, postSlug) {
  const boardPath = buildBoardPath(boardSlug)
  const slug = String(postSlug || '').trim()

  if (!slug) {
    return boardPath
  }

  return boardPath + '/posts/' + encodeURIComponent(slug)
}

/**
 * 새 글 작성 경로를 만듭니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {string} 새 글 작성 경로입니다.
 */
function buildNewPostPath(boardSlug) {
  const slug = String(boardSlug || '').trim()
  const boardPath = buildBoardPath(slug)

  if (!slug) {
    return boardPath
  }

  return boardPath + '/posts/new'
}

/**
 * 글 수정 경로를 만듭니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @param {unknown} postSlug 게시글 slug 값입니다.
 * @returns {string} 글 수정 경로입니다.
 */
function buildEditPostPath(boardSlug, postSlug) {
  const slug = String(postSlug || '').trim()
  const postPath = buildPostPath(boardSlug, slug)

  if (!slug) {
    return postPath
  }

  return postPath + '/edit'
}

/**
 * 게시판 안에서 글 slug로 게시글을 찾습니다.
 * @param {string | null | undefined} boardId 게시판 record id입니다.
 * @param {unknown} postSlug 라우트나 폼에서 받은 게시글 slug 값입니다.
 * @returns {core.Record | null} 게시글이 있으면 record, 없으면 null입니다.
 */
function findPostByBoardAndSlug(boardId, postSlug) {
  const slug = String(postSlug || '').trim()

  if (!boardId || !slug) {
    return null
  }

  try {
    return $app.findFirstRecordByFilter('posts', 'board = {:boardId} && slug = {:slug}', { boardId: boardId, slug: slug })
  } catch (error) {
    return null
  }
}

/**
 * 게시판의 전체 게시글 목록을 조회합니다.
 * @param {string | null | undefined} boardId 게시판 record id입니다.
 * @returns {core.Record[]} 게시글 record 목록입니다.
 */
function listPostsByBoard(boardId) {
  if (!boardId) {
    return []
  }

  return $app.findRecordsByFilter('posts', 'board = {:boardId}', '-is_notice,-published_at', 50, 0, { boardId: boardId })
}

/**
 * 게시판의 published 게시글 목록을 조회합니다.
 * @param {string | null | undefined} boardId 게시판 record id입니다.
 * @returns {core.Record[]} published 게시글 record 목록입니다.
 */
function listPublishedPostsByBoard(boardId) {
  if (!boardId) {
    return []
  }

  return $app.findRecordsByFilter('posts', 'board = {:boardId} && status = "published"', '-is_notice,-published_at', 50, 0, { boardId: boardId })
}

/**
 * 게시글 폼 입력값을 정규화합니다.
 * @param {Record<string, any> | null | undefined} form 게시글 폼 원본 값입니다.
 * @param {unknown} fallbackStatus 기본 상태값입니다.
 * @returns {types.PostFormInput} 정규화한 게시글 입력값입니다.
 */
function readPostForm(form, fallbackStatus) {
  const safeForm = form && typeof form === 'object' ? form : {}

  return {
    title: String(safeForm.title || '').trim(),
    slug: slugify(safeForm.slug || safeForm.title),
    authorName: String(safeForm.authorName || '').trim(),
    content: String(safeForm.content || '').trim(),
    status: normalizePostStatus(safeForm.status, fallbackStatus || 'draft'),
    isNotice: String(safeForm.isNotice || '') === 'true',
  }
}

/**
 * 게시글 필수 입력값이 모두 있는지 확인합니다.
 * @param {types.PostFormInput} input 정규화한 게시글 입력값입니다.
 * @returns {boolean} 필수 입력값이 모두 있으면 true입니다.
 */
function hasRequiredPostInput(input) {
  if (!input) {
    return false
  }

  return !!input.title && !!input.slug && !!input.authorName && !!input.content
}

/**
 * 게시글 record에 수정 가능한 필드를 반영합니다.
 * @param {core.Record} post 게시글 record입니다.
 * @param {types.PostFormInput} input 정규화한 게시글 입력값입니다.
 * @returns {void}
 */
function applyEditableFields(post, input) {
  post.set('title', input.title)
  post.set('slug', input.slug)
  post.set('content', input.content)
  post.set('author_name', input.authorName)
  post.set('status', input.status)
  post.set('is_notice', input.isNotice)
}

/**
 * 게시글 record를 목록 카드용 plain object로 바꿉니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {types.PostCard | null} 템플릿에서 바로 쓸 게시글 카드 값입니다.
 */
function toPostCard(post, boardSlug) {
  if (!post) {
    return null
  }

  const slug = String(post.get('slug') || '').trim()
  const content = String(post.get('content') || '')

  return {
    slug: slug,
    title: String(post.get('title') || '').trim() || '(untitled post)',
    authorName: String(post.get('author_name') || '').trim() || 'unknown',
    status: normalizePostStatus(post.get('status'), 'draft'),
    isNotice: !!post.get('is_notice'),
    publishedAt: String(post.get('published_at') || post.created || ''),
    viewCount: Number(post.get('view_count') || 0),
    preview: content.replace(/<[^>]*>/g, '').slice(0, 180),
    path: buildPostPath(boardSlug, slug),
  }
}

/**
 * 게시글 record 목록을 목록 카드용 plain object 목록으로 바꿉니다.
 * @param {core.Record[] | null | undefined} posts 게시글 record 목록입니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {types.PostCard[]} 템플릿에서 바로 쓸 게시글 카드 목록입니다.
 */
function toPostCards(posts, boardSlug) {
  const safePosts = Array.isArray(posts) ? posts : []
  const postCards = []

  safePosts.forEach(function (post) {
    const postCard = toPostCard(post, boardSlug)

    if (postCard) {
      postCards.push(postCard)
    }
  })

  return postCards
}

/**
 * 게시글 record를 HTMX 패널용 plain object로 바꿉니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {types.PostPanelItem | null} HTMX 패널에서 바로 쓸 게시글 값입니다.
 */
function toPostPanelItem(post, boardSlug) {
  if (!post) {
    return null
  }

  const slug = String(post.get('slug') || '').trim()

  return {
    title: String(post.get('title') || '').trim() || '(untitled post)',
    authorName: String(post.get('author_name') || '').trim() || 'unknown',
    isNotice: !!post.get('is_notice'),
    publishedAt: String(post.get('published_at') || post.created || ''),
    path: buildPostPath(boardSlug, slug),
  }
}

/**
 * 게시글 record 목록을 HTMX 패널용 plain object 목록으로 바꿉니다.
 * @param {core.Record[] | null | undefined} posts 게시글 record 목록입니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {types.PostPanelItem[]} HTMX 패널에서 바로 쓸 게시글 목록입니다.
 */
function toPostPanelItems(posts, boardSlug) {
  const safePosts = Array.isArray(posts) ? posts : []
  const postItems = []

  safePosts.forEach(function (post) {
    const postItem = toPostPanelItem(post, boardSlug)

    if (postItem) {
      postItems.push(postItem)
    }
  })

  return postItems
}

/**
 * 게시글 record를 상세 화면용 plain object로 바꿉니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @param {unknown} boardSlug 게시판 slug 값입니다.
 * @returns {types.PostDetail | null} 상세 화면에서 바로 쓸 게시글 값입니다.
 */
function toPostDetail(post, boardSlug) {
  if (!post) {
    return null
  }

  const slug = String(post.get('slug') || '').trim()
  const path = buildPostPath(boardSlug, slug)

  return {
    slug: slug,
    title: String(post.get('title') || '').trim() || '(untitled post)',
    authorName: String(post.get('author_name') || '').trim() || 'unknown',
    status: normalizePostStatus(post.get('status'), 'draft'),
    isNotice: !!post.get('is_notice'),
    publishedAt: String(post.get('published_at') || post.created || ''),
    viewCount: Number(post.get('view_count') || 0),
    content: String(post.get('content') || ''),
    path: path,
    editPath: buildEditPostPath(boardSlug, slug),
  }
}

/**
 * 게시글 record를 수정 폼 기본값으로 바꿉니다.
 * @param {core.Record | null | undefined} post 게시글 record입니다.
 * @returns {types.PostFormValues} 수정 폼에 넣을 게시글 기본값입니다.
 */
function toPostFormValues(post) {
  if (!post) {
    return {
      title: '',
      slug: '',
      authorName: '',
      content: '',
      status: 'draft',
      isNotice: false,
    }
  }

  return {
    title: String(post.get('title') || '').trim(),
    slug: String(post.get('slug') || '').trim(),
    authorName: String(post.get('author_name') || '').trim(),
    content: String(post.get('content') || ''),
    status: normalizePostStatus(post.get('status'), 'draft'),
    isNotice: !!post.get('is_notice'),
  }
}

module.exports = {
  applyEditableFields,
  buildEditPostPath,
  buildNewPostPath,
  buildPostPath,
  findPostByBoardAndSlug,
  hasRequiredPostInput,
  listPostsByBoard,
  listPublishedPostsByBoard,
  readPostForm,
  toPostCards,
  toPostDetail,
  toPostFormValues,
  toPostPanelItems,
}

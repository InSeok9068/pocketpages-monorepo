/**
 * 게시판이 게시글을 받을 수 있는 상태인지 판단합니다.
 * @param {core.Record | null | undefined} board 게시판 record입니다.
 * @returns {boolean} 게시글 작성이 가능하면 true입니다.
 */
function canAcceptPosts(board) {
  if (!board) {
    return false;
  }

  return !!board.get("is_active");
}

module.exports = {
  canAcceptPosts,
};

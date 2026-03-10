/** @type {types.SampleBoardService} */
const boardService = {
  findActiveBoardBySlug(boardSlug) {
    const slug = String(boardSlug || "").trim();

    if (!slug) {
      return null;
    }

    try {
      return $app.findFirstRecordByFilter("boards", "slug = {:slug} && is_active = true", { slug });
    } catch (error) {
      return null;
    }
  },

  findPostByBoardAndSlug(boardId, postSlug) {
    const slug = String(postSlug || "").trim();

    if (!boardId || !slug) {
      return null;
    }

    try {
      return $app.findFirstRecordByFilter("posts", "board = {:boardId} && slug = {:slug}", { boardId, slug });
    } catch (error) {
      return null;
    }
  },

  slugify(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200);
  },
};

module.exports = boardService;

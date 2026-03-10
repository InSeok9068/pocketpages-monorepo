declare namespace types {
  type SampleBoardService = {
    findActiveBoardBySlug(boardSlug: unknown): core.Record | null
    findPostByBoardAndSlug(boardId: string | null | undefined, postSlug: unknown): core.Record | null
    slugify(value: unknown): string
  }
}

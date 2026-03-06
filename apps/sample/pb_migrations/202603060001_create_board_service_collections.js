migrate((app) => {
  const boards = new Collection({
    type: "base",
    name: "boards",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      {
        name: "name",
        type: "text",
        required: true,
        min: 1,
        max: 80,
        presentable: true,
      },
      {
        name: "slug",
        type: "text",
        required: true,
        min: 2,
        max: 80,
      },
      {
        name: "description",
        type: "editor",
      },
      {
        name: "is_active",
        type: "bool",
      },
      {
        name: "sort_order",
        type: "number",
        required: false,
        onlyInt: true,
        min: 0,
      },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_boards_slug ON boards (slug)",
      "CREATE INDEX idx_boards_sort_order ON boards (sort_order)",
    ],
  })

  app.save(boards)
  const savedBoards = app.findCollectionByNameOrId("boards")

  const posts = new Collection({
    type: "base",
    name: "posts",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      {
        name: "board",
        type: "relation",
        required: true,
        collectionId: savedBoards.id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      {
        name: "title",
        type: "text",
        required: true,
        min: 1,
        max: 200,
        presentable: true,
      },
      {
        name: "slug",
        type: "text",
        required: true,
        min: 2,
        max: 200,
      },
      {
        name: "content",
        type: "editor",
        required: true,
      },
      {
        name: "author_name",
        type: "text",
        required: true,
        min: 1,
        max: 60,
      },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["draft", "published", "archived"],
      },
      {
        name: "is_notice",
        type: "bool",
      },
      {
        name: "view_count",
        type: "number",
        required: false,
        onlyInt: true,
        min: 0,
      },
      {
        name: "published_at",
        type: "date",
      },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_posts_board_slug ON posts (board, slug)",
      "CREATE INDEX idx_posts_status ON posts (status)",
      "CREATE INDEX idx_posts_published_at ON posts (published_at)",
    ],
  })

  app.save(posts)
  const savedPosts = app.findCollectionByNameOrId("posts")

  const comments = new Collection({
    type: "base",
    name: "comments",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      {
        name: "post",
        type: "relation",
        required: true,
        collectionId: savedPosts.id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      {
        name: "author_name",
        type: "text",
        required: true,
        min: 1,
        max: 60,
      },
      {
        name: "content",
        type: "editor",
        required: true,
      },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["visible", "hidden", "deleted"],
      },
    ],
    indexes: [
      "CREATE INDEX idx_comments_post ON comments (post)",
      "CREATE INDEX idx_comments_status ON comments (status)",
    ],
  })

  app.save(comments)

  const savedComments = app.findCollectionByNameOrId("comments")
  savedComments.fields.add(new RelationField({
    name: "parent_comment",
    required: false,
    collectionId: savedComments.id,
    maxSelect: 1,
    cascadeDelete: false,
  }))
  app.save(savedComments)
}, (app) => {
  const comments = app.findCollectionByNameOrId("comments")
  app.delete(comments)

  const posts = app.findCollectionByNameOrId("posts")
  app.delete(posts)

  const boards = app.findCollectionByNameOrId("boards")
  app.delete(boards)
})

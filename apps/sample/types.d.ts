declare namespace types {
  interface BoardFormInput {
    name: string;
    slug: string;
    description: string;
  }

  interface BoardSummary {
    id: string;
    name: string;
    slug: string;
    description: string;
    path: string;
    isActive: boolean;
  }

  type PostStatus = 'draft' | 'published' | 'archived';

  interface PostFormInput {
    title: string;
    slug: string;
    authorName: string;
    content: string;
    status: PostStatus;
    isNotice: boolean;
  }

  interface PostFormValues extends PostFormInput {}

  interface PostCard {
    slug: string;
    title: string;
    authorName: string;
    status: PostStatus;
    isNotice: boolean;
    publishedAt: string;
    viewCount: number;
    preview: string;
    path: string;
  }

  interface PostPanelItem {
    title: string;
    authorName: string;
    isNotice: boolean;
    publishedAt: string;
    path: string;
  }

  interface PostDetail {
    slug: string;
    title: string;
    authorName: string;
    status: PostStatus;
    isNotice: boolean;
    publishedAt: string;
    viewCount: number;
    content: string;
    path: string;
    editPath: string;
  }
}

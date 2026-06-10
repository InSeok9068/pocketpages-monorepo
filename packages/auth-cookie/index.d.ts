declare namespace pocketpagesAuthCookie {
  type SameSite = 'strict' | 'lax' | 'none'
  /** PocketPages response.cookie()를 가진 응답 객체입니다. */
  type AuthCookieResponse = {
    cookie: <T>(name: string, value: T, options?: Record<string, any>) => void
  }

  /** 영속 PocketBase auth cookie 옵션입니다. */
  interface AuthCookieOptions {
    /** 쿠키 이름입니다. 기본값은 `pb_auth`입니다. */
    cookieName?: string
    /** 쿠키 유지 시간입니다. 기본값은 1년입니다. */
    maxAgeSeconds?: number
    /** 쿠키 path입니다. 기본값은 `/`입니다. */
    path?: string
    /** httpOnly 여부입니다. 기본값은 true입니다. */
    httpOnly?: boolean
    /** SameSite 옵션입니다. 기본값은 `lax`입니다. */
    sameSite?: SameSite
    /** secure 옵션입니다. 기본값은 false입니다. */
    secure?: boolean
  }

  /** PocketBase authWithPassword/authRefresh 결과에서 쿠키에 저장할 값입니다. */
  interface AuthData {
    /** PocketBase auth token입니다. */
    token: string
    /** PocketBase auth record입니다. JSON 직렬화 가능한 plain object로 저장됩니다. */
    record: any
  }

  /** PocketPages 응답에 PocketBase auth cookie를 쓰고 만료시키는 헬퍼입니다. */
  interface AuthCookie {
    /** 응답에 `{ token, record }` auth cookie를 씁니다. */
    writeAuthCookie(response: AuthCookieResponse, authData: AuthData): void
    /** 응답에서 auth cookie를 만료시킵니다. */
    signOut(response: AuthCookieResponse): void
  }
}

declare const pocketpagesAuthCookie: {
  /** PocketPages 영속 auth cookie 헬퍼를 만듭니다. */
  createAuthCookie(options?: pocketpagesAuthCookie.AuthCookieOptions): pocketpagesAuthCookie.AuthCookie
}

export = pocketpagesAuthCookie

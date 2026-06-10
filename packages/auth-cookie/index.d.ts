declare namespace pocketpagesAuthCookie {
  type SameSite = 'strict' | 'lax' | 'none'
  type AuthCookieResponse = {
    cookie: <T>(name: string, value: T, options?: Record<string, any>) => void
  }

  interface AuthCookieOptions {
    cookieName?: string
    maxAgeSeconds?: number
    path?: string
    httpOnly?: boolean
    sameSite?: SameSite
    secure?: boolean
  }

  interface AuthData {
    token: string
    record: any
  }

  interface AuthCookie {
    writeAuthCookie(response: AuthCookieResponse, authData: AuthData): void
    signOut(response: AuthCookieResponse): void
  }
}

declare const pocketpagesAuthCookie: {
  createAuthCookie(options?: pocketpagesAuthCookie.AuthCookieOptions): pocketpagesAuthCookie.AuthCookie
}

export = pocketpagesAuthCookie

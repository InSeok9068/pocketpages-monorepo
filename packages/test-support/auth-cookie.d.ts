export interface SignInCookieOptions {
  /** 사용자 이메일입니다. */
  email: string
  /** 사용자 비밀번호입니다. */
  password: string
  /** 로그인 라우트입니다. 기본값은 `/xapi/auth/sign-in`입니다. */
  path?: string
  /** 이메일 필드 이름입니다. 기본값은 `email`입니다. */
  emailField?: string
  /** 비밀번호 필드 이름입니다. 기본값은 `password`입니다. */
  passwordField?: string
}

/** 응답 Set-Cookie 값을 요청 Cookie 헤더 값으로 바꿉니다. */
export function readCookieHeader(headers: Headers): string

/** 서비스 로그인 라우트를 호출하고 Cookie 헤더 값을 돌려줍니다. */
export function signInAndGetCookieHeader(baseUrl: string, options: SignInCookieOptions): Promise<string>

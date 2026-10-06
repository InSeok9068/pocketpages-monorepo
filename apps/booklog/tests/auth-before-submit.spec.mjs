import { expect, test } from '@playwright/test'

test('로그인 요청 전 인증 폼을 표시한다', async ({ page }) => {
  await page.goto('/auth')

  const signInForm = page.locator('form[action="/xapi/auth/sign-in"]')

  await expect(signInForm).toBeVisible()
  await expect(signInForm.locator('input[name="email"][type="email"]')).toBeVisible()
  await expect(signInForm.locator('input[name="password"][type="password"]')).toBeVisible()
  await expect(signInForm.getByRole('button', { name: '로그인' })).toBeEnabled()
})

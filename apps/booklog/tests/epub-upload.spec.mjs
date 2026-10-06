import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const testDirectory = dirname(fileURLToPath(import.meta.url))

const uploadCases = [
  '귀하신 몸 근골격계 - 어깨부터 목, 무릎, 허리, 발목까지 14일 관절 통증 탈출 솔루션.epub',
  '모두에게 사랑받을 필요는 없다 타인에게 얽매이지 않고 온전한 나로 사는 법.epub',
]

async function signIn(page) {
  const email = process.env.BOOKLOG_EMAIL
  const password = process.env.BOOKLOG_PASSWORD

  if (!email || !password) {
    throw new Error('Set BOOKLOG_EMAIL and BOOKLOG_PASSWORD for the local upload test.')
  }

  await page.goto('/auth')

  const signInForm = page.locator('form[action="/xapi/auth/sign-in"]')
  await signInForm.locator('input[name="email"]').fill(email)
  await signInForm.locator('input[name="password"]').fill(password)

  await Promise.all([
    page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 }),
    signInForm.getByRole('button', { name: '로그인' }).click(),
  ])

  await expect(page.getByRole('button', { name: '책 추가' })).toBeVisible()
}

for (const fileName of uploadCases) {
  const title = `WebKit에서 ${fileName} 업로드 로딩 후 완료 메시지를 표시한다`
  const filePath = resolve(testDirectory, '../.docs', fileName)

  if (!existsSync(filePath)) {
    test.skip(`${title} (EPUB 테스트 파일 없음)`, async () => undefined)
    continue
  }

  test(title, async ({ page }) => {
    test.setTimeout(360_000)

    await signIn(page)

    const uploadForm = page.locator('form[action="/xapi/epub/upload"]')
    const fileInput = uploadForm.locator('input[name="epubFile"]')
    await page.getByRole('button', { name: '책 추가' }).click()
    await expect(page.getByRole('heading', { name: '도서함에 책 넣기' })).toBeVisible()
    await fileInput.setInputFiles(filePath)
    await expect(uploadForm.locator('p[x-show="uploadFileName"]')).toHaveText(fileName)

    const loadingHeading = page.getByRole('heading', { name: '업로드 중입니다' })
    const uploadResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url())

        return url.pathname === '/xapi/epub/upload' && response.request().method() === 'POST'
      },
      { timeout: 300_000 }
    )

    // Native form navigation can outlast the short-lived loading overlay.
    await uploadForm.locator('button[type="submit"]').evaluate((button) => button.click())
    await expect(loadingHeading).toBeVisible({ timeout: 10_000 })

    const response = await uploadResponse
    expect(response.status()).toBe(303)
    await expect(page).toHaveURL((url) => url.pathname === '/', { timeout: 30_000 })
    await expect(page.getByText('EPUB 파일과 도서 메타데이터를 저장했습니다.', { exact: true })).toBeVisible()
    await expect(loadingHeading).toBeHidden()
  })
}

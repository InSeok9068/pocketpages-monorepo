import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { startService } from '@pocketpages/test-support/service-harness'

const require = createRequire(new URL('../package.json', import.meta.url))
const { zipSync, strToU8 } = require('fflate')
const serviceDir = fileURLToPath(new URL('../', import.meta.url))
const appsDir = path.dirname(path.resolve(serviceDir))
const port = 18102
let fixtureDir
let service
let browser

before(async () => {
  fixtureDir = mkdtempSync(path.join(appsDir, '.booklog-forms-test-'))
  mkdirSync(path.join(fixtureDir, 'pb_data'))
  cpSync(path.join(serviceDir, 'pb_hooks'), path.join(fixtureDir, 'pb_hooks'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'jobs.pb.js',
  })
  writeFileSync(
    path.join(fixtureDir, 'pb_hooks/pages/_private/data4library-service.js'),
    readFileSync(new URL('./fixtures/data4library-stub.js', import.meta.url), 'utf8')
  )
  const configPath = path.join(fixtureDir, 'pb_hooks/pages/+config.js')
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      "'pocketpages-plugin-js-sdk'",
      "{ name: 'pocketpages-plugin-js-sdk', host: 'http://127.0.0.1:" + port + "' }"
    )
  )
  const binary = process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase'
  copyFileSync(path.join(serviceDir, binary), path.join(fixtureDir, binary))
  symlinkSync(realpathSync(path.join(serviceDir, 'node_modules')), path.join(fixtureDir, 'node_modules'), 'junction')
  const schema = JSON.parse(readFileSync(path.join(serviceDir, 'pb_schema.json'), 'utf8')).filter(
    (collection) => collection.name !== '_superusers'
  )
  writeFileSync(path.join(fixtureDir, 'pb_hooks/test-schema.json'), JSON.stringify(schema))
  copyFileSync(
    new URL('./fixtures/browser-forms-setup.pb.js', import.meta.url),
    path.join(fixtureDir, 'pb_hooks/test-setup.pb.js')
  )
  writeFileSync(
    path.join(fixtureDir, '.env'),
    'APP_ENV=production\nDATA4LIBRARY_APIKEY=test-key\nONESIGNAL_APPID=\nONESIGNAL_API_KEY=\n'
  )
  service = await startService({ serviceName: path.basename(fixtureDir), port, timeoutMs: 30000 })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
})

after(async () => {
  if (browser) await browser.close()
  if (service) await service.stop()
  if (fixtureDir) {
    const resolved = realpathSync(fixtureDir)
    assert.equal(path.dirname(resolved), realpathSync(appsDir))
    assert.ok(path.basename(resolved).startsWith('.booklog-forms-test-'))
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function signedInPage() {
  const page = await (await browser.newContext()).newPage()
  await page.goto(service.baseUrl + '/auth')
  const form = page.locator('form[action="/xapi/auth/sign-in"]')
  await form.locator('input[name="email"]').fill('forms@example.com')
  await form.locator('input[name="password"]').fill('test-password-1234')
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/'),
    form.getByRole('button', { name: '로그인' }).click(),
  ])
  return page
}

function sampleEpub(title) {
  return zipSync({
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">'
        + title
        + '</dc:identifier><dc:title>'
        + title
        + '</dc:title><dc:creator>테스트 저자</dc:creator><dc:language>ko</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
    ),
    'OEBPS/c1.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>1장</h1><p>'
        + '업로드 화면을 확인하는 본문입니다. '.repeat(80)
        + '</p></body></html>'
    ),
  })
}

test('The sign-in page shows its form before any request, and signing in through it opens the home page', async () => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(service.baseUrl + '/auth')
  const form = page.locator('form[action="/xapi/auth/sign-in"]')
  await form.locator('input[name="email"][type="email"]').waitFor()
  assert.ok(await form.locator('input[name="password"][type="password"]').isVisible())
  assert.ok(await form.getByRole('button', { name: '로그인' }).isEnabled())
  await page.close()

  const signedIn = await signedInPage()
  await signedIn.getByRole('button', { name: '책 추가' }).waitFor()
  await signedIn.close()
})

test('Uploading an EPUB shows the loading screen and then the saved message on the home page', async () => {
  const uploadDir = path.join(fixtureDir, 'uploads')
  mkdirSync(uploadDir, { recursive: true })
  const generated = path.join(uploadDir, '업로드 화면 확인.epub')
  writeFileSync(generated, Buffer.from(sampleEpub('업로드 화면 확인')))
  // 서비스 문서 폴더에 실제 EPUB이 있으면 실제 책으로도 같은 흐름을 확인합니다.
  const files = [
    generated,
    ...[
      '귀하신 몸 근골격계 - 어깨부터 목, 무릎, 허리, 발목까지 14일 관절 통증 탈출 솔루션.epub',
      '모두에게 사랑받을 필요는 없다 타인에게 얽매이지 않고 온전한 나로 사는 법.epub',
    ]
      .map((name) => path.join(serviceDir, '.docs', name))
      .filter((filePath) => existsSync(filePath)),
  ]

  const page = await signedInPage()
  // 작은 파일은 응답이 너무 빨라 로딩 화면이 그려지기 전에 끝나므로, 업로드 응답만 잠시 늦춥니다.
  await page.route('**/xapi/epub/upload', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    return route.continue()
  })

  for (const filePath of files) {
    const fileName = path.basename(filePath)
    const form = page.locator('form[action="/xapi/epub/upload"]')
    await page.getByRole('button', { name: '책 추가' }).click()
    await page.getByRole('heading', { name: '도서함에 책 넣기' }).waitFor()
    await form.locator('input[name="epubFile"]').setInputFiles(filePath)
    assert.equal((await form.locator('p[x-show="uploadFileName"]').textContent()).trim(), fileName)

    const loading = page.getByRole('heading', { name: '업로드 중입니다' })
    const response = page.waitForResponse(
      (item) => new URL(item.url()).pathname === '/xapi/epub/upload' && item.request().method() === 'POST',
      { timeout: 300_000 }
    )
    await form.locator('button[type="submit"]').evaluate((button) => button.click())
    await loading.waitFor({ timeout: 10_000 })

    assert.equal((await response).status(), 303, fileName)
    await page.waitForURL((url) => url.pathname === '/')
    await page.getByText('EPUB 파일과 도서 메타데이터를 저장했습니다.', { exact: true }).waitFor()
    assert.equal(await loading.isVisible(), false, fileName)
  }
  await page.close()
})

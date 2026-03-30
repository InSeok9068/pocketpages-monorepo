import { builtinModules, createRequire } from 'node:module'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, '..')
const appsDir = path.resolve(rootDir, 'apps')
const vendorPathParts = ['pb_hooks', 'pages', '_private', 'vendor']
const builtinNameSet = new Set(
  builtinModules.flatMap((name) => {
    if (name.startsWith('node:')) return [name, name.slice(5)]
    return [name, `node:${name}`]
  })
)

function normalizeMenuAnswer(input) {
  return String(input || '').trim()
}

function buildBundleFileName(libraryName) {
  return `${String(libraryName || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[\\/]/g, '__')}.bundle.js`
}

async function listServices() {
  const entries = await readDirSafe(appsDir)
  const services = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const serviceDir = path.join(appsDir, entry.name)
    const hooksDir = path.join(serviceDir, 'pb_hooks')
    const packageJsonPath = path.join(serviceDir, 'package.json')
    if (!(await exists(hooksDir)) || !(await exists(packageJsonPath))) continue

    services.push({
      name: entry.name,
      serviceDir,
      packageJsonPath,
    })
  }

  return services.sort((a, b) => a.name.localeCompare(b.name))
}

async function readDirSafe(targetDir) {
  try {
    const { readdir } = await import('node:fs/promises')
    return await readdir(targetDir, { withFileTypes: true })
  } catch (error) {
    return []
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    return false
  }
}

async function readServicePackageJson(packageJsonPath) {
  const packageJsonText = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(packageJsonText)
}

function listLibraries(packageJson) {
  const names = new Set()
  const dependencies = packageJson && typeof packageJson === 'object' ? packageJson.dependencies : null
  const devDependencies = packageJson && typeof packageJson === 'object' ? packageJson.devDependencies : null

  if (dependencies && typeof dependencies === 'object') {
    Object.keys(dependencies).forEach((name) => names.add(name))
  }

  if (devDependencies && typeof devDependencies === 'object') {
    Object.keys(devDependencies).forEach((name) => names.add(name))
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b))
}

async function promptSelection(rl, title, items, formatItem) {
  if (!items.length) {
    throw new Error(`${title} 항목이 없습니다.`)
  }

  console.log(`${title}`)
  items.forEach((item, index) => {
    console.log(`  ${index + 1}. ${formatItem(item)}`)
  })

  while (true) {
    const answer = normalizeMenuAnswer(await rl.question('번호 또는 이름을 입력하세요: '))
    if (!answer) continue

    const index = Number(answer)
    if (Number.isInteger(index) && index >= 1 && index <= items.length) {
      return items[index - 1]
    }

    const matched = items.find((item) => {
      const itemName = typeof item === 'string' ? item : item.name
      return itemName === answer
    })
    if (matched) return matched

    console.log('다시 입력해주세요.')
  }
}

async function createPrompter() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return {
      async question(prompt) {
        return rl.question(prompt)
      },
      close() {
        rl.close()
      },
    }
  }

  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
  }

  const answers = text.split(/\r?\n/)
  let index = 0

  return {
    async question(prompt) {
      process.stdout.write(prompt)
      const answer = answers[index] === undefined ? '' : answers[index]
      index += 1
      if (answer) process.stdout.write(`${answer}\n`)
      return answer
    },
    close() {},
  }
}

async function bundleServiceLibrary(service, libraryName) {
  const serviceRequire = createRequire(path.join(service.serviceDir, 'package.json'))
  const entryPoint = serviceRequire.resolve(libraryName)
  const vendorDir = path.join(service.serviceDir, ...vendorPathParts)
  const outfile = path.join(vendorDir, buildBundleFileName(libraryName))

  await mkdir(vendorDir, { recursive: true })

  const result = await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['es2015'],
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    metafile: true,
  })

  const output = result.metafile && result.metafile.outputs ? result.metafile.outputs[outfile] : null
  const builtinImports = output
    ? output.imports.filter((item) => item.external && builtinNameSet.has(item.path)).map((item) => item.path)
    : []

  return {
    entryPoint,
    outfile,
    builtinImports: Array.from(new Set(builtinImports)).sort(),
  }
}

function printBundleSummary(summary) {
  console.log('')
  console.log('번들 생성 완료')
  console.log(`- 서비스: ${summary.serviceName}`)
  console.log(`- 라이브러리: ${summary.libraryName}`)
  console.log(`- 엔트리: ${summary.entryPoint}`)
  console.log(`- 출력: ${summary.outfile}`)
  if (summary.builtinImports.length) {
    console.log(`- 주의: Node builtin 의존이 남아 있습니다 -> ${summary.builtinImports.join(', ')}`)
  } else {
    console.log('- 확인: Node builtin 의존이 번들 결과에 남지 않았습니다')
  }
}

async function main() {
  const services = await listServices()
  if (!services.length) {
    throw new Error('pb_hooks와 package.json이 있는 서비스가 없습니다.')
  }

  const rl = await createPrompter()

  try {
    const service = await promptSelection(rl, '1. 어떤 프로젝트를 진행?', services, (item) => item.name)
    const packageJson = await readServicePackageJson(service.packageJsonPath)
    const libraries = listLibraries(packageJson)

    const libraryName = await promptSelection(rl, '2. 어떤 라이브러리를 진행?', libraries, (item) => item)
    const summary = await bundleServiceLibrary(service, libraryName)

    printBundleSummary({
      serviceName: service.name,
      libraryName,
      entryPoint: summary.entryPoint,
      outfile: summary.outfile,
      builtinImports: summary.builtinImports,
    })
  } finally {
    rl.close()
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})

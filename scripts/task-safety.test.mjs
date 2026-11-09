import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// 실행: node --test scripts/task-safety.test.mjs
// task.sh만 복사한다. Git 변경은 임시 repo에서, 배포 본문은 로컬 fixture에서만 실행한다.
const taskFile = fileURLToPath(new URL('../task.sh', import.meta.url))
const taskSource = readFileSync(taskFile, 'utf8').replaceAll('\r\n', '\n')
const service = 'safety-fixture'
const servicePath = `apps/${service}`
const sources = new Map([
  ['pb_hooks/a-first.js', Buffer.from('module.exports = "first"\n')],
  ['pb_hooks/index.js', Buffer.from('module.exports = "original"\n')],
  ['pb_hooks/z-collision.txt', Buffer.from('archived collision source\n')],
  ['pb_hooks/z-parent/last.js', Buffer.from('module.exports = "last"\n')],
  ['assets/source binary.bin', Buffer.from([0, 255, 13, 10, 128, 0, 42])],
])
const ignored = new Map([
  ['.env', Buffer.from('SECRET=fixture-only\r\n\0\xff', 'latin1')],
  ['pb_data/data.db', Buffer.from([0, 255, 128, 10, 13, 0, 77])],
  ['pb_data/storage/nested/upload.bin', Buffer.from([42, 0, 254, 13, 10])],
  ['node_modules/fixture-package/index.bin', Buffer.from([255, 0, 127, 9])],
])
const networkGuard = `
blocked_network() { printf 'TASK_SAFETY: external command blocked\\n' >&2; return 97; }
ssh() { blocked_network; }
sftp() { blocked_network; }
scp() { blocked_network; }
docker() { blocked_network; }
curl() { blocked_network; }
wget() { blocked_network; }
export -f blocked_network ssh sftp scp docker curl wget
`

function output(result) {
  return `status=${result.status}, signal=${result.signal}\n${result.stdout || ''}${result.stderr || ''}${result.error || ''}`
}

function success(result, message) {
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${message}\n${output(result)}`)
}

function failure(result, message) {
  assert.ifError(result.error)
  assert.equal(result.signal, null, output(result))
  assert.notEqual(result.status, 0, `${message}\n${output(result)}`)
}

function shellPath(file) {
  if (process.platform !== 'win32') return file
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', 'cygpath -u "$1"', 'task-safety-path', file], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  success(result, 'Windows Git Bash의 cygpath가 필요합니다.')
  return result.stdout.trim()
}

function put(root, relative, content) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function tree(root) {
  const entries = []
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name
      const file = path.join(directory, name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) entries.push([relative, 'link', readlinkSync(file)])
      else if (stat.isDirectory()) {
        entries.push([relative, 'directory'])
        visit(file, relative)
      } else entries.push([relative, 'file', readFileSync(file).toString('hex')])
    }
  }
  visit(root, '')
  return entries
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-safety-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  const repo = path.join(root, 'repo with spaces')
  const origin = path.join(root, 'origin.git')
  mkdirSync(repo)
  mkdirSync(path.join(root, 'home'))
  mkdirSync(path.join(root, 'hooks'))
  writeFileSync(path.join(root, 'gitconfig'), '')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^GIT_/i.test(key)
        && !['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH'].includes(key)
        && !key.startsWith('BASH_FUNC_')
    )
  )
  Object.assign(env, {
    HOME: shellPath(path.join(root, 'home')),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: shellPath(path.join(root, 'gitconfig')),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
  })
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000, ...options })
  }
  function git(...args) {
    const result = run('git', ['--no-pager', ...args])
    success(result, `fixture git ${args.join(' ')}`)
    return result.stdout.trim()
  }
  function bash(script, args = []) {
    return run('bash', ['--noprofile', '--norc', '-c', `${networkGuard}\n${script}`, 'task-safety', ...args])
  }
  function task(...args) {
    return bash('source ./task.sh "$@"', args)
  }
  return { root, repo, origin, env, run, git, bash, task }
}

function repository(t) {
  const f = fixture(t)
  copyFileSync(taskFile, path.join(f.repo, 'task.sh'))
  put(
    f.repo,
    '.gitignore',
    [
      `/${servicePath}/.env`,
      `/${servicePath}/pb_data/`,
      `/${servicePath}/node_modules/`,
      `/${servicePath}/pb_hooks/z-collision.txt`,
      `/${servicePath}/pb_hooks/z-parent`,
      '',
    ].join('\n')
  )
  for (const [name, bytes] of sources) put(f.repo, `${servicePath}/${name}`, bytes)
  for (const [name, bytes] of ignored) put(f.repo, `${servicePath}/${name}`, bytes)
  f.git('init', '--initial-branch=main')
  f.git('config', 'user.name', 'Task Safety Fixture')
  f.git('config', 'user.email', 'task-safety@example.invalid')
  f.git('config', 'commit.gpgsign', 'false')
  f.git('config', 'tag.gpgsign', 'false')
  f.git('config', 'core.autocrlf', 'false')
  f.git('config', 'core.hooksPath', shellPath(path.join(f.root, 'hooks')))
  f.git('init', '--bare', f.origin)
  f.git('remote', 'add', 'origin', shellPath(f.origin))
  f.git('add', '--', 'task.sh', '.gitignore')
  for (const name of sources.keys()) f.git('add', '-f', '--', `${servicePath}/${name}`)
  f.git('commit', '-m', 'fixture initial sources')
  assert.equal(f.git('status', '--porcelain'), '')
  return f
}

function archive(f) {
  success(f.task('archive', service), 'archive 성공')
  const tags = f.git('tag', '--list', `archive/${service}/*`).split('\n').filter(Boolean)
  assert.equal(tags.length, 1, 'archive 태그는 하나여야 한다.')
  return tags[0]
}

function archivedRepository(t) {
  const f = repository(t)
  f.tag = archive(f)
  f.git('commit', '-m', 'fixture archive tracked sources')
  // archive의 데이터 보존은 별도 테스트한다. restore 검증은 기존 구현에서도 독립적으로 실행한다.
  for (const [name, bytes] of ignored) put(f.repo, `${servicePath}/${name}`, bytes)
  assert.equal(f.git('status', '--porcelain'), '')
  return f
}

function assertBytes(root, files) {
  for (const [name, bytes] of files) {
    assert.ok(existsSync(path.join(root, name)), `보존/복원되어야 하는 파일: ${name}`)
    assert.deepEqual(readFileSync(path.join(root, name)), bytes, `바이너리 내용 불일치: ${name}`)
  }
}

function assertNoSources(f, except = []) {
  for (const name of sources.keys()) {
    if (!except.includes(name))
      assert.equal(existsSync(path.join(f.repo, servicePath, name)), false, `부분 복원 금지: ${name}`)
  }
  assert.equal(f.git('diff', '--cached', '--name-only'), '', '거부 시 index도 변경되면 안 된다.')
}

test('archive: tracked 소스만 삭제하고 ignored 데이터와 origin 태그를 보존한다', (t) => {
  const f = repository(t)
  const head = f.git('rev-parse', 'HEAD')
  const tag = archive(f)
  assertBytes(path.join(f.repo, servicePath), ignored)
  for (const name of sources.keys()) assert.equal(existsSync(path.join(f.repo, servicePath, name)), false, name)
  assert.equal(f.git('ls-files', '--', servicePath), '', 'tracked 서비스 소스 삭제')
  const staged = f.git('diff', '--cached', '--name-status').split('\n').sort()
  assert.deepEqual(staged, [...sources.keys()].map((name) => `D\t${servicePath}/${name}`).sort())
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'archive는 자동 커밋하지 않는다.')
  assert.equal(f.git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`), `${head}\trefs/tags/${tag}`)
})

test('archive: origin 태그 push 실패 시 소스와 ignored 데이터가 그대로 남는다', (t) => {
  const f = repository(t)
  const before = tree(path.join(f.repo, servicePath))
  f.git('remote', 'set-url', 'origin', shellPath(path.join(f.root, 'missing-origin.git')))
  failure(f.task('archive', service), 'push 실패 시 archive도 실패해야 한다.')
  assert.deepEqual(tree(path.join(f.repo, servicePath)), before)
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.git('tag', '--list', `archive/${service}/*`), '', '실패한 archive 태그 정리')
})

test('restore: archive 커밋 후 ignored remnants만 있는 서비스를 복원한다', (t) => {
  const f = archivedRepository(t)
  success(f.task('restore', f.tag), 'ignored 데이터만 남은 디렉터리는 restore 허용')
  assertBytes(path.join(f.repo, servicePath), sources)
  assertBytes(path.join(f.repo, servicePath), ignored)
})

test('restore: tracked 소스가 있는 기존 서비스는 거부한다', (t) => {
  const f = repository(t)
  const tag = `archive/${service}/fixture`
  f.git('tag', tag)
  const before = tree(path.join(f.repo, servicePath))
  failure(f.task('restore', tag), '기존 서비스 restore 거부')
  assert.deepEqual(tree(path.join(f.repo, servicePath)), before)
  assert.equal(f.git('status', '--porcelain'), '')
})

for (const kind of ['file', 'directory', 'symlink', 'ancestor-file', 'ancestor-symlink']) {
  test(`restore: ignored ${kind} 충돌을 모든 소스 복원 전에 거부한다`, (t) => {
    const f = archivedRepository(t)
    const collision = kind.startsWith('ancestor-') ? 'pb_hooks/z-parent' : 'pb_hooks/z-collision.txt'
    const destination = path.join(f.repo, servicePath, collision)
    mkdirSync(path.dirname(destination), { recursive: true })
    if (kind.includes('symlink')) {
      const target = path.join(f.root, 'outside-target')
      mkdirSync(target)
      put(target, 'keep.bin', Buffer.from([0, 255, 13, 10]))
      try {
        // Windows에서는 관리자 권한 없이 만들 수 있는 실제 directory junction을 사용한다.
        symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          t.skip(`실제 symlink 생성 권한이 없음: ${error.code}`)
          return
        }
        throw error
      }
      assert.ok(lstatSync(destination).isSymbolicLink(), '복사본이 아닌 실제 symlink여야 한다.')
    } else if (kind === 'directory') put(destination, 'keep.bin', Buffer.from([128, 0, 255]))
    else writeFileSync(destination, Buffer.from([0, 255, 128, 13, 10]))
    const before = tree(path.join(f.repo, servicePath))
    const outsideBefore = kind.includes('symlink') ? tree(path.join(f.root, 'outside-target')) : null
    assert.equal(f.git('status', '--porcelain'), '', '충돌 항목은 ignored여야 한다.')
    failure(f.task('restore', f.tag), `${kind} 충돌 restore 거부`)
    assert.deepEqual(tree(path.join(f.repo, servicePath)), before, '기존 데이터와 symlink 보존, 부분 복원 금지')
    assertNoSources(f, kind.startsWith('ancestor-') ? [] : ['pb_hooks/z-collision.txt'])
    if (outsideBefore) assert.deepEqual(tree(path.join(f.root, 'outside-target')), outsideBefore)
  })
}

function deployBody() {
  const start = taskSource.indexOf('deploy_target() {')
  assert.notEqual(start, -1, 'deploy_target 함수가 필요하다.')
  const target = taskSource.slice(start)
  const opener = /^.*bash -s --.*DEPLOY_DELETE_REMOTE.*<<\s*'([^']+)'\s*$/m.exec(target)
  assert.ok(opener, 'deploy_target의 원격 bash heredoc을 찾지 못했다. SSH 호출로 대체하지 않는다.')
  const bodyStart = opener.index + opener[0].length + 1
  const end = target.indexOf(`\n${opener[1]}\n`, bodyStart)
  assert.notEqual(end, -1, '원격 heredoc 종료 delimiter가 필요하다.')
  const body = target.slice(bodyStart, end)
  assert.match(body, /create_history_snapshot/)
  return body
}

function deployment(t, liveFiles, nextFiles) {
  const f = fixture(t)
  const live = path.join(f.root, 'remote with spaces', 'pb_hooks')
  const upload = path.join(f.root, 'upload')
  const archiveFile = path.join(f.root, 'upload.tar.gz')
  mkdirSync(live, { recursive: true })
  mkdirSync(upload)
  mkdirSync(path.join(f.root, 'staging'))
  for (const [name, bytes] of Object.entries(liveFiles)) put(live, name, bytes)
  for (const [name, bytes] of Object.entries(nextFiles)) put(upload, name, bytes)
  success(f.run('tar', ['-czf', shellPath(archiveFile), '-C', shellPath(upload), '.']), 'fixture 배포 archive 생성')
  const script = path.join(f.root, 'remote-deploy.sh')
  put(f.root, 'remote-deploy.sh', `${networkGuard}\n${deployBody()}\n`)
  function deploy(deleteRemote, failSnapshot = false) {
    // 원본 heredoc의 /tmp staging도 fixture 내부로 제한한다. SSH/설정 로더는 실행하지 않는다.
    return f.bash(
      `
mktemp() { command mktemp -d "$TASK_SAFETY_STAGE/stage.XXXXXX"; }
${failSnapshot ? `cp() { printf 'TASK_SAFETY_CP_FAILURE: %s\\n' "$*" >&2; return 73; }\nexport -f cp` : ''}
export -f mktemp
source "$1" "$2" "$3" "$4"
`,
      [shellPath(script), shellPath(archiveFile), shellPath(live), String(deleteRemote)]
    )
  }
  f.env.TASK_SAFETY_STAGE = shellPath(path.join(f.root, 'staging'))
  function snapshot() {
    const history = path.join(path.dirname(live), '.deploy-history', path.basename(live))
    assert.ok(existsSync(history), '배포 이력이 생성되어야 한다.')
    const snapshots = readdirSync(history)
    assert.equal(snapshots.length, 1, 'fixture에는 배포 전 snapshot 하나만 존재해야 한다.')
    return path.join(history, snapshots[0])
  }
  return { ...f, live, deploy, snapshot }
}

test('deploy delete=true: obsolete 파일은 snapshot에 남고 live에서만 제거된다', (t) => {
  const f = deployment(
    t,
    {
      'index.js': 'old source\n',
      'obsolete.bin': Buffer.from([0, 255, 13, 10]),
      'old-dir/deep.bin': Buffer.from([128, 0, 42]),
    },
    { 'index.js': 'new source\n', 'new.js': 'added\n' }
  )
  const before = tree(f.live)
  success(f.deploy(true), '로컬 원격 배포 본문 실행')
  assert.equal(existsSync(path.join(f.live, 'obsolete.bin')), false)
  assert.equal(existsSync(path.join(f.live, 'old-dir')), false)
  assert.equal(readFileSync(path.join(f.live, 'index.js'), 'utf8'), 'new source\n')
  assert.equal(readFileSync(path.join(f.live, 'new.js'), 'utf8'), 'added\n')
  assert.deepEqual(tree(f.snapshot()), before, '삭제 전 원본 전체가 snapshot에 남아야 한다.')
})

for (const deleteRemote of [true, false]) {
  test(`deploy delete=${deleteRemote}: 양방향 file/dir 충돌의 원본이 snapshot에 보존된다`, (t) => {
    const f = deployment(
      t,
      {
        'to-directory': Buffer.from([0, 255, 128]),
        'to-file/original.bin': Buffer.from([13, 10, 0, 42]),
        'index.js': 'old\n',
      },
      {
        'to-directory/new.js': 'new child\n',
        'to-file': 'new file\n',
        'index.js': 'new\n',
      }
    )
    const before = tree(f.live)
    success(f.deploy(deleteRemote), 'file/dir 충돌 배포')
    assert.equal(readFileSync(path.join(f.live, 'to-directory/new.js'), 'utf8'), 'new child\n')
    assert.equal(readFileSync(path.join(f.live, 'to-file'), 'utf8'), 'new file\n')
    assert.deepEqual(tree(f.snapshot()), before)
  })
}

test('deploy delete=false: remote-only 파일은 live와 snapshot에 모두 보존된다', (t) => {
  const f = deployment(
    t,
    {
      'index.js': 'old\n',
      'remote-only/deep.bin': Buffer.from([255, 0, 128, 10]),
    },
    { 'index.js': 'new\n' }
  )
  const before = tree(f.live)
  success(f.deploy(false), 'remote-only 보존 배포')
  assert.deepEqual(readFileSync(path.join(f.live, 'remote-only/deep.bin')), Buffer.from([255, 0, 128, 10]))
  assert.equal(readFileSync(path.join(f.live, 'index.js'), 'utf8'), 'new\n')
  assert.deepEqual(tree(f.snapshot()), before)
})

for (const deleteRemote of [true, false]) {
  test(`deploy delete=${deleteRemote}: snapshot cp 실패 시 live 원본을 전혀 변경하지 않는다`, (t) => {
    const f = deployment(
      t,
      {
        'index.js': 'old\n',
        'obsolete.bin': Buffer.from([0, 128, 255]),
        'to-directory': 'original file\n',
        'to-file/keep.bin': Buffer.from([255, 13, 10, 0]),
      },
      {
        'index.js': 'new\n',
        'to-directory/new.js': 'new child\n',
        'to-file': 'new file\n',
      }
    )
    const before = tree(f.live)
    const result = f.deploy(deleteRemote, true)
    failure(result, 'snapshot 실패 시 배포 실패')
    assert.match(
      result.stderr,
      /TASK_SAFETY_CP_FAILURE: .*\.deploy-history\//,
      'snapshot 복사에서 실패를 주입해야 한다.'
    )
    assert.equal(result.status, 73, output(result))
    assert.deepEqual(tree(f.live), before, 'snapshot 성공 전에는 삭제/충돌 제거/복사를 수행하면 안 된다.')
  })
}

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = fileURLToPath(new URL('./docker-release.sh', import.meta.url))
const sha = (digit) => digit.repeat(40)
const A = sha('a')
const B = sha('b')
const C = sha('c')
const image = 'ghcr.io/example/demo'
const imageId = (digit) => `sha256:${digit.repeat(64)}`
const localImage = (tag, id = imageId('1'), repo = image) => `${repo} ${tag} ${id}`
const cleanupWarning = 'WARNING: Old SHA image cleanup failed; deployment and success history are already committed.'
const shellCandidates = ['sh', 'bash']
if (process.platform === 'win32') {
  for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
    if (base) {
      shellCandidates.push(path.join(base, 'Git', 'bin', 'bash.exe'))
      shellCandidates.push(path.join(base, 'Programs', 'Git', 'bin', 'bash.exe'))
    }
  }
}
const shell = shellCandidates.find((candidate) => spawnSync(candidate, ['-c', ':'], { timeout: 5000 }).status === 0)
assert.ok(shell, 'POSIX sh or Windows Git Bash must be resolvable')
const shellPath = (value) =>
  value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)

const fakeDocker = `#!/bin/sh
set -eu
printf '%s %s %s\\n' "\${1:-}" "\${2:-}" "\${3:-}" >> "$PP_TEST_ROOT/calls"
fail_at() { [ "$PP_TEST_FAIL" != "$1" ] || exit 42; }
case "$1 $2" in
  'compose ps')
    fail_at ps
    if [ -f "$PP_TEST_ROOT/up" ]; then value=$PP_TEST_FINAL_COUNT; else value=$PP_TEST_COUNT; fi
    case "$value" in 0) ;; 1) printf 'container-one\\n' ;; 2) printf 'container-one\\ncontainer-two\\n' ;; esac
    ;;
  'inspect --format')
    case "$3" in
      '{{.Image}}')
        printf '%s\\n' "$*" >> "$PP_TEST_ROOT/cleanup-calls"
        fail_at used-inspect
        [ "$4" != "$PP_TEST_FAIL_CONTAINER" ] || exit 42
        case "$4" in
          stopped-container) printf '%s\\n' "$PP_TEST_STOPPED_IMAGE_ID" ;;
          *) printf '%s\\n' "$PP_TEST_USED_IMAGE_ID" ;;
        esac
        ;;
      *State.Running*)
        fail_at state
        if [ -f "$PP_TEST_ROOT/up" ]; then printf '%s\\n' "$PP_TEST_FINAL_RUNNING"; else printf '%s\\n' "$PP_TEST_RUNNING"; fi
        ;;
      *)
        fail_at inspect
        if [ -f "$PP_TEST_ROOT/up" ]; then
          if [ "$PP_TEST_FINAL_REVISION" = target ]; then cat "$PP_TEST_ROOT/target"; else printf '%s\\n' "$PP_TEST_FINAL_REVISION"; fi
        else printf '%s\\n' "$PP_TEST_REVISION"; fi
        ;;
    esac
    ;;
  'pull '*) fail_at pull; printf '%s\\n' "\${2##*:}" > "$PP_TEST_ROOT/target" ;;
  'image inspect')
    fail_at image-inspect
    if [ "$PP_TEST_IMAGE_REVISION" = target ]; then cat "$PP_TEST_ROOT/target"; else printf '%s\\n' "$PP_TEST_IMAGE_REVISION"; fi
    ;;
  'tag '*) fail_at tag ;;
  'compose stop') fail_at stop ;;
  'compose run')
    fail_at copy
    case " $* " in *' --pull never '*) ;; *) exit 43 ;; esac
    ;;
  'compose up')
    fail_at up
    case " $* " in *' --pull never '*) ;; *) exit 43 ;; esac
    case " $* " in *' --wait '*) ;; *) exit 43 ;; esac
    : > "$PP_TEST_ROOT/up"
    ;;
  'compose exec')
    case " $* " in
      *' caddy validate '*) fail_at validate ;;
      *' caddy reload '*)
        fail_at reload
        if [ "$PP_TEST_FAIL" = record ]; then
          printf 'blocked history directory\\n' > "$PP_TEST_ROOT/Docker-Compose/.deploy-history/demo"
        fi
        ;;
      *) exit 44 ;;
    esac
    ;;
  'image ls')
    printf '%s\\n' "$*" >> "$PP_TEST_ROOT/cleanup-calls"
    [ "$#" = 6 ] && [ "$3" = --no-trunc ] && [ "$4" = --format ] && [ "$5" = '{{.Repository}} {{.Tag}} {{.ID}}' ] && [ "$6" = "$PP_TEST_IMAGE" ] || exit 47
    cat "$PP_TEST_ROOT/Docker-Compose/.deploy-history/demo/successful-shas" > "$PP_TEST_ROOT/cleanup-history"
    printf '%s\\n' "$PP_TEST_LOCAL_IMAGES"
    fail_at image-ls
    ;;
  'ps -aq')
    printf '%s\\n' "$*" >> "$PP_TEST_ROOT/cleanup-calls"
    [ "$#" = 2 ] || exit 48
    printf '%s\\n' "$PP_TEST_USED_CONTAINERS"
    fail_at used-ps
    ;;
  'image rm')
    printf '%s\\n' "$*" >> "$PP_TEST_ROOT/cleanup-calls"
    [ "$#" = 3 ] || exit 49
    case "$3" in -*) exit 49 ;; esac
    printf '%s\\n' "$3" >> "$PP_TEST_ROOT/removals"
    fail_at image-rm
    ;;
  'image prune'|'system prune') printf 'Forbidden global prune\\n' >&2; exit 50 ;;
  *) printf 'Unexpected docker command\\n' >&2; exit 45 ;;
esac
`

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'docker-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const compose = path.join(root, 'Docker-Compose')
  const historyDir = path.join(compose, '.deploy-history', 'demo')
  const historyFile = path.join(historyDir, 'successful-shas')
  mkdirSync(bin)
  mkdirSync(compose)
  writeFileSync(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 })
  writeFileSync(
    path.join(bin, 'git'),
    '#!/bin/sh\nset -eu\nprintf "git %s\\n" "$*" >> "$PP_TEST_ROOT/calls"\n[ "$*" = "pull --ff-only" ]\n',
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(bin, 'sleep'),
    `#!/bin/sh
set -eu
[ "$*" = 5 ]
lock="$PP_TEST_ROOT/Docker-Compose/.deploy-history/.lock"
[ "$(cat "$lock/owner")" = 'another deployment' ] || exit 46
printf '%s\\n' "$1" >> "$PP_TEST_ROOT/sleeps"
count=$(awk 'END { print NR }' "$PP_TEST_ROOT/sleeps")
if [ "$count" = "$PP_TEST_LOCK_RELEASE_AFTER" ]; then
  # Simulate the other owner releasing its own lock, never the deployment process.
  rm "$lock/owner"
  rmdir "$lock"
fi
`,
    { mode: 0o755 }
  )
  if (options.history !== undefined) {
    mkdirSync(historyDir, { recursive: true })
    writeFileSync(historyFile, Array.isArray(options.history) ? `${options.history.join('\n')}\n` : options.history)
  }
  const env = {
    ...process.env,
    PP_TEST_ROOT: shellPath(root),
    PP_TEST_BIN: shellPath(bin),
    PP_TEST_SCRIPT: shellPath(script),
    PP_TEST_FAIL: '',
    PP_TEST_LOCK_RELEASE_AFTER: '',
    PP_DEPLOY_LOCK_RETRIES: '0',
    PP_TEST_COUNT: '1',
    PP_TEST_FINAL_COUNT: '1',
    PP_TEST_REVISION: A,
    PP_TEST_RUNNING: 'true',
    PP_TEST_FINAL_RUNNING: 'true',
    PP_TEST_FINAL_REVISION: 'target',
    PP_TEST_IMAGE_REVISION: 'target',
    PP_TEST_IMAGE: image,
    PP_TEST_LOCAL_IMAGES: '',
    PP_TEST_USED_CONTAINERS: '',
    PP_TEST_USED_IMAGE_ID: imageId('1'),
    PP_TEST_STOPPED_IMAGE_ID: imageId('2'),
    PP_TEST_FAIL_CONTAINER: '',
    PP_DEPLOY_MODE: '',
    PP_DEPLOY_SERVICE: '',
    PP_DEPLOY_IMAGE: '',
    PP_DEPLOY_SHA: '',
    ...options.env,
  }
  return {
    root,
    compose,
    historyFile,
    run(args = ['deploy', 'demo', image, B], overrides = {}) {
      // Resolve only fake commands before invoking the release script, including on Git Bash.
      const result = spawnSync(
        shell,
        [
          '-c',
          'PATH="$PP_TEST_BIN:$PATH"; export PATH; [ "$(command -v docker)" = "$PP_TEST_BIN/docker" ] && [ "$(command -v git)" = "$PP_TEST_BIN/git" ] || exit 99; exec sh "$PP_TEST_SCRIPT" "$@"',
          'docker-release-test',
          ...args,
        ],
        {
          cwd: root,
          env: { ...env, ...overrides },
          encoding: 'utf8',
          timeout: 15000,
        }
      )
      assert.ifError(result.error)
      return result
    },
    history: () => (existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : null),
    calls: () => (existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8') : ''),
    cleanupCalls: () =>
      existsSync(path.join(root, 'cleanup-calls')) ? readFileSync(path.join(root, 'cleanup-calls'), 'utf8') : '',
    removals: () =>
      existsSync(path.join(root, 'removals'))
        ? readFileSync(path.join(root, 'removals'), 'utf8').trim().split('\n')
        : [],
  }
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout)
}
function failed(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout)
  if (pattern) assert.match(result.stderr, pattern)
}

test('deploy verifies, reloads and records success in order; env defaults work', (t) => {
  const f = fixture(t)
  succeeded(f.run([], { PP_DEPLOY_SERVICE: 'demo', PP_DEPLOY_IMAGE: image, PP_DEPLOY_SHA: B }))
  assert.equal(f.history(), `${B}\n`)
  const calls = f.calls()
  const steps = [
    'git pull --ff-only',
    'pull ',
    'image inspect',
    'tag ',
    'compose stop',
    'compose run',
    'compose up',
    'compose ps',
    'inspect --format',
    'compose exec',
    'compose exec',
    'image ls',
  ]
  let offset = 0
  for (const step of steps) {
    const next = calls.indexOf(step, offset)
    assert.ok(next >= offset, `Missing/out-of-order step: ${step}\n${calls}`)
    offset = next + step.length
  }
  assert.equal(readFileSync(path.join(f.root, 'cleanup-history'), 'utf8'), `${B}\n`)
  assert.doesNotMatch(calls, /^(?:image|system) prune/m)
  assert.ok(!existsSync(path.join(f.compose, '.deploy-history', '.lock')))
})

for (const scenario of [
  { name: 'first deploy with no existing container', env: { PP_TEST_COUNT: '0' } },
  { name: 'deploy over an old image without an OCI revision label', env: { PP_TEST_REVISION: '' } },
]) {
  test(`${scenario.name} verifies the new container and records success`, (t) => {
    const f = fixture(t, { env: scenario.env })
    succeeded(f.run())
    assert.equal(f.history(), `${B}\n`)
    const calls = f.calls()
    const upIndex = calls.indexOf('compose up')
    assert.ok(upIndex >= 0)
    assert.doesNotMatch(calls.slice(0, upIndex), /compose ps|^inspect --format/m)
    assert.match(calls.slice(upIndex), /compose ps[\s\S]*inspect --format[\s\S]*compose exec/)
  })
}

test('repeat SHA moves to front uniquely and retains the current plus three rollback targets', (t) => {
  const f = fixture(t, { history: [A, B, C, sha('d')] })
  succeeded(f.run())
  assert.equal(f.history(), [B, A, C, sha('d'), ''].join('\n'))
  succeeded(f.run(['deploy', 'demo', image, sha('f')]))
  assert.equal(f.history(), [sha('f'), B, A, C, ''].join('\n'))
})

for (const scenario of [
  { name: 'failed pull', env: { PP_TEST_FAIL: 'pull' } },
  { name: 'image revision mismatch', env: { PP_TEST_IMAGE_REVISION: C } },
  { name: 'image inspect error', env: { PP_TEST_FAIL: 'image-inspect' } },
]) {
  test(`${scenario.name} fails before stop and preserves history`, (t) => {
    const f = fixture(t, { history: [A], env: scenario.env })
    failed(f.run())
    assert.doesNotMatch(f.calls(), /compose stop|image (?:ls|rm|prune)|^ps -aq/m)
    assert.equal(f.history(), `${A}\n`)
  })
}

for (const stage of ['up', 'copy', 'validate', 'reload']) {
  test(`failed ${stage} does not advance history`, (t) => {
    const f = fixture(t, { history: [A], env: { PP_TEST_FAIL: stage } })
    failed(f.run())
    assert.equal(f.history(), `${A}\n`)
    assert.doesNotMatch(f.calls(), /image (?:ls|rm|prune)|^ps -aq/m)
    assert.ok(!existsSync(path.join(f.compose, '.deploy-history', '.lock')))
  })
}

for (const version of [1, 2, 3]) {
  test(`rollback ${version} selects actual successful deployment, never Git history`, (t) => {
    const history = [A, B, C, sha('d')]
    const f = fixture(t, { history })
    succeeded(f.run(['rollback', 'demo', image, String(version)]))
    assert.equal(readFileSync(path.join(f.root, 'target'), 'utf8'), `${history[version]}\n`)
    assert.equal(f.history().split('\n')[0], history[version])
    assert.doesNotMatch(f.calls(), /git /)
  })
}

for (const env of [{ PP_TEST_RUNNING: 'false' }, { PP_TEST_REVISION: sha('f') }]) {
  test(`rollback recovers latest success from stopped/unrecorded state ${JSON.stringify(env)}`, (t) => {
    const f = fixture(t, { history: [A, B], env })
    succeeded(f.run(['rollback', 'demo', image, '1']))
    assert.equal(readFileSync(path.join(f.root, 'target'), 'utf8'), `${A}\n`)
    assert.equal(f.history(), `${A}\n${B}\n`)
  })
}

test('missing rollback history and unavailable version fail without mutation', (t) => {
  for (const history of [undefined, [A]]) {
    const f = fixture(t, { history })
    failed(f.run(['rollback', 'demo', image, '1']))
    assert.doesNotMatch(f.calls(), /git |pull |compose stop/)
    assert.equal(f.history(), history ? `${A}\n` : null)
  }
})

for (const history of [
  '',
  'bad\n',
  `${'A'.repeat(40)}\n`,
  `${A}\n${A}\n`,
  `${A}\n\n`,
  [A, B, C, sha('d'), sha('e')],
  [A, B, C, sha('d'), sha('e'), sha('f')],
]) {
  test(`corrupt history is rejected: ${JSON.stringify(history)}`, (t) => {
    const f = fixture(t, { history })
    const before = f.history()
    failed(f.run(), /Corrupt success history/)
    assert.equal(f.calls(), '')
    assert.equal(f.history(), before)
  })
}

test('global lock contention never removes another owner lock', (t) => {
  const f = fixture(t)
  const lock = path.join(f.compose, '.deploy-history', '.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(path.join(lock, 'owner'), 'another deployment')
  failed(f.run(), /global deployment lock: .*\.lock.*manually/)
  assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), 'another deployment')
  assert.equal(f.calls(), '')
  assert.ok(!existsSync(path.join(f.root, 'sleeps')), 'Zero retries must fail without sleeping')
})

for (const retries of [undefined, '002']) {
  test(`lock wait succeeds only after the other owner releases it (retries=${retries ?? 'default'})`, (t) => {
    const f = fixture(t)
    const lock = path.join(f.compose, '.deploy-history', '.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(path.join(lock, 'owner'), 'another deployment')
    const result = f.run(undefined, {
      PP_DEPLOY_LOCK_RETRIES: retries,
      PP_TEST_LOCK_RELEASE_AFTER: '2',
    })
    succeeded(result)
    assert.equal(readFileSync(path.join(f.root, 'sleeps'), 'utf8'), '5\n5\n')
    const limit = retries === undefined ? '60' : '2'
    assert.match(result.stderr, /Waiting for global deployment lock: .*\/\.deploy-history\/\.lock/)
    assert.ok(result.stderr.includes(`retrying in 5 seconds: 1/${limit}`))
    assert.ok(result.stderr.includes(`retrying in 5 seconds: 2/${limit}`))
    assert.equal(f.history(), `${B}\n`)
    assert.ok(!existsSync(lock), 'The acquired lock is cleaned up after success')
  })
}

test('lock wait is bounded and leaves another owner lock untouched on exhaustion', (t) => {
  const f = fixture(t, { env: { PP_DEPLOY_LOCK_RETRIES: '2' } })
  const lock = path.join(f.compose, '.deploy-history', '.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(path.join(lock, 'owner'), 'another deployment')
  failed(f.run(), /global deployment lock: .*after 2 retries.*manually/)
  assert.equal(readFileSync(path.join(f.root, 'sleeps'), 'utf8'), '5\n5\n')
  assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), 'another deployment')
  assert.equal(f.calls(), '')
  assert.equal(f.history(), null)
})

test('lock retry setting is validated before filesystem mutation', (t) => {
  const f = fixture(t)
  for (const retries of ['', '-1', '121', '1.5', 'abc', '1 2', '999999999999999999999']) {
    failed(
      f.run(undefined, { PP_DEPLOY_LOCK_RETRIES: retries }),
      /PP_DEPLOY_LOCK_RETRIES must be a number from 0 to 120/
    )
    assert.ok(!existsSync(path.join(f.compose, '.deploy-history')))
  }
  assert.equal(f.calls(), '')
  assert.ok(!existsSync(path.join(f.root, 'sleeps')))
  succeeded(f.run(undefined, { PP_DEPLOY_LOCK_RETRIES: '120' }))
})

for (const env of [
  { PP_TEST_COUNT: '0' },
  { PP_TEST_COUNT: '2' },
  { PP_TEST_FAIL: 'ps' },
  { PP_TEST_REVISION: '' },
  { PP_TEST_REVISION: 'unknown' },
  { PP_TEST_FAIL: 'inspect' },
  { PP_TEST_RUNNING: 'unknown' },
  { PP_TEST_RUNNING: '' },
  { PP_TEST_FAIL: 'state' },
]) {
  test(`rollback with unknown current state fails before pull/stop: ${JSON.stringify(env)}`, (t) => {
    const f = fixture(t, { history: [A, B], env })
    failed(f.run(['rollback', 'demo', image, '1']))
    assert.doesNotMatch(f.calls(), /git |pull |compose stop/)
    assert.equal(f.history(), `${A}\n${B}\n`)
  })
}

for (const env of [
  { PP_TEST_FINAL_COUNT: '0' },
  { PP_TEST_FINAL_COUNT: '2' },
  { PP_TEST_FINAL_REVISION: A },
  { PP_TEST_FINAL_RUNNING: 'false' },
  { PP_TEST_FINAL_RUNNING: 'unknown' },
]) {
  test(`post-up container mismatch prevents Caddy and history update: ${JSON.stringify(env)}`, (t) => {
    const f = fixture(t, { history: [A], env })
    failed(f.run())
    assert.equal(f.history(), `${A}\n`)
    assert.doesNotMatch(f.calls(), /compose exec|image (?:ls|rm|prune)|^ps -aq/m)
  })
}

test('record failure explicitly reports service already changed', (t) => {
  const f = fixture(t, { env: { PP_TEST_FAIL: 'record' } })
  failed(f.run(), /Service has changed successfully, but recording success history failed/)
  assert.doesNotMatch(f.calls(), /image (?:ls|rm|prune)|^ps -aq/m)
})

test('image removal failure warns without reverting deployment or committed history', (t) => {
  const f = fixture(t, { history: [A], env: { PP_TEST_FAIL: 'image-rm', PP_TEST_LOCAL_IMAGES: localImage(C) } })
  const result = f.run()
  succeeded(result)
  assert.match(result.stderr, /WARNING:/)
  assert.deepEqual(f.removals(), [`${image}:${C}`])
  assert.equal(f.history(), `${B}\n${A}\n`)
  assert.equal(readFileSync(path.join(f.root, 'cleanup-history'), 'utf8'), f.history())
  assert.ok(!existsSync(path.join(f.compose, '.deploy-history', '.lock')))
})

test('cleanup keeps only the target and previous success locally while history keeps four', (t) => {
  const older = [C, sha('d')]
  const dropped = sha('e')
  const f = fixture(t, {
    history: [A, ...older, dropped],
    env: { PP_TEST_LOCAL_IMAGES: [B, A, ...older, dropped].map((tag) => localImage(tag)).join('\n') },
  })
  succeeded(f.run())
  assert.equal(f.history(), [B, A, ...older, ''].join('\n'))
  assert.equal(readFileSync(path.join(f.root, 'cleanup-history'), 'utf8'), f.history())
  assert.deepEqual(
    f.removals(),
    [...older, dropped].map((tag) => `${image}:${tag}`)
  )
})

test('cleanup only removes full lowercase SHA tags from the exact repository, never force or global prune', (t) => {
  const ignored = [
    localImage(C, imageId('1'), 'ghcr.io/other/demo'),
    localImage(C, imageId('1'), `${image}-extra`),
    localImage(C, imageId('1'), `${image}/child`),
    ...['release', 'latest', 'abc123', 'g'.repeat(40), C.toUpperCase(), C.slice(1), `${C}0`, '<none>'].map((tag) =>
      localImage(tag)
    ),
    localImage('<none>', imageId('1'), '<none>'),
  ]
  const f = fixture(t, { env: { PP_TEST_LOCAL_IMAGES: [...ignored, localImage(C)].join('\n') } })
  succeeded(f.run())
  assert.deepEqual(f.removals(), [`${image}:${C}`])
  assert.match(
    f.cleanupCalls(),
    /^image ls --no-trunc --format {{\.Repository}} {{\.Tag}} {{\.ID}} ghcr\.io\/example\/demo$/m
  )
  assert.match(f.cleanupCalls(), /^image rm ghcr\.io\/example\/demo:c{40}$/m)
  assert.doesNotMatch(f.cleanupCalls(), /(?:^|\s)(?:--force|-f|prune)(?:\s|$)/m)
  assert.doesNotMatch(f.calls(), /^(?:image|system) prune/m)
})

test('cleanup preserves image IDs used by running and stopped containers, including aliased SHA tags', (t) => {
  const f = fixture(t, {
    env: {
      PP_TEST_LOCAL_IMAGES: [
        localImage(A, imageId('1')),
        localImage(C, imageId('2')),
        localImage(sha('d'), imageId('2')),
        localImage(sha('e'), imageId('3')),
      ].join('\n'),
      PP_TEST_USED_CONTAINERS: 'running-container\nstopped-container',
    },
  })
  succeeded(f.run())
  assert.match(f.cleanupCalls(), /^ps -aq$/m)
  assert.match(f.cleanupCalls(), /^inspect --format {{\.Image}} running-container$/m)
  assert.match(f.cleanupCalls(), /^inspect --format {{\.Image}} stopped-container$/m)
  assert.deepEqual(f.removals(), [`${image}:${sha('e')}`])
})

for (const scenario of [
  { name: 'image listing failure even after partial output', env: { PP_TEST_FAIL: 'image-ls' } },
  { name: 'container listing failure even after partial output', env: { PP_TEST_FAIL: 'used-ps' } },
  { name: 'container image inspection failure', env: { PP_TEST_FAIL: 'used-inspect' } },
  { name: 'later container inspection failure', env: { PP_TEST_FAIL_CONTAINER: 'stopped-container' } },
  ...['', 'unknown', 'sha256:1234', '1'.repeat(64), `sha256:${'g'.repeat(64)}`, `${imageId('1')}\n${imageId('2')}`].map(
    (id) => ({
      name: `invalid used image ID ${JSON.stringify(id)}`,
      env: { PP_TEST_USED_IMAGE_ID: id },
    })
  ),
]) {
  test(`cleanup skips every deletion on ${scenario.name}`, (t) => {
    const f = fixture(t, {
      history: [A],
      env: {
        PP_TEST_LOCAL_IMAGES: localImage(C, imageId('3')),
        PP_TEST_USED_CONTAINERS: 'running-container\nstopped-container',
        ...scenario.env,
      },
    })
    const result = f.run()
    succeeded(result)
    assert.ok(result.stderr.includes(cleanupWarning), result.stderr)
    assert.deepEqual(f.removals(), [])
    assert.equal(f.history(), `${B}\n${A}\n`)
    assert.ok(!existsSync(path.join(f.compose, '.deploy-history', '.lock')))
  })
}

test('an empty local image list requires no deletion or container inspection', (t) => {
  const f = fixture(t)
  succeeded(f.run())
  assert.match(f.cleanupCalls(), /^image ls /m)
  assert.deepEqual(f.removals(), [])
  assert.doesNotMatch(f.cleanupCalls(), /^inspect /m)
})

test('invalid arguments are rejected before commands or history creation', (t) => {
  const f = fixture(t)
  for (const args of [
    ['deploy', '../demo', image, B],
    ['deploy', '-demo', image, B],
    ['deploy', 'Demo', image, B],
    ['deploy', 'demo_name', image, B],
    ['deploy', 'demo', image, 'abc123'],
    ['deploy', 'demo', image, B.toUpperCase()],
    ['rollback', 'demo', image, '0'],
    ['rollback', 'demo', image, '4'],
    ['unknown', 'demo', image, B],
    ['deploy', 'demo', '-image', B],
  ])
    failed(f.run(args))
  assert.equal(f.calls(), '')
  assert.ok(!existsSync(path.join(f.compose, '.deploy-history')))
})

test('workflow builds the OCI revision label and forwards deploy env to the shared script', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-docker.yml', import.meta.url), 'utf8').replaceAll(
    '\r\n',
    '\n'
  )
  const steps = workflow.split(/^      - name: /m)
  const build = steps.find((step) => step.startsWith('Build and push image\n'))
  const restart = steps.find((step) => step.startsWith('Restart Server\n'))
  assert.ok(build, 'Build and push image step must exist')
  assert.ok(restart, 'Restart Server step must exist')
  assert.match(
    build,
    /^          labels: \|\n            org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}$/m
  )
  const env = restart.match(/^        env:\n((?:          .*\n)+)/m)?.[1]
  assert.ok(env, 'Restart Server must define deploy environment variables')
  assert.match(env, /^          PP_DEPLOY_SERVICE: \$\{\{ steps\.svc\.outputs\.service \}\}$/m)
  assert.match(env, /^          PP_DEPLOY_IMAGE: \$\{\{ steps\.svc\.outputs\.image \}\}$/m)
  assert.match(env, /^          PP_DEPLOY_SHA: \$\{\{ github\.sha \}\}$/m)
  assert.match(restart, /^          envs: PP_DEPLOY_SERVICE,PP_DEPLOY_IMAGE,PP_DEPLOY_SHA$/m)
  assert.match(restart, /^          script_path: scripts\/docker-release\.sh$/m)
  assert.doesNotMatch(restart, /^          script:/m, 'Remote deployment must not diverge into an inline script')
})

test('task rollback sends the CRLF-normalized shared script to mocked SSH via sh stdin without Git selection', (t) => {
  const task = readFileSync(new URL('../task.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const rollback = task.match(/^run_docker_rollback\(\) \{\n[\s\S]*?^\}/m)?.[0]
  assert.ok(rollback, 'run_docker_rollback must exist')
  assert.doesNotMatch(rollback, /\bgit\s|FETCH_HEAD|--format=%H/, 'Rollback targets must not be selected from Git')
  assert.match(rollback, /local remote_script="\$ROOT_DIR\/scripts\/docker-release\.sh"/)
  assert.match(rollback, /sed -e 's\/\\r\$\/\/' "\$remote_script"\s*\|/)

  const bash = ['bash', ...shellCandidates.filter((candidate) => /bash(?:\.exe)?$/.test(candidate))].find(
    (candidate) => spawnSync(candidate, ['-c', ':'], { timeout: 5000 }).status === 0
  )
  assert.ok(bash, 'The task.sh entry point requires Bash')
  const f = fixture(t)
  const source = readFileSync(script, 'utf8').replaceAll('\r\n', '\n')
  mkdirSync(path.join(f.root, 'scripts'))
  writeFileSync(path.join(f.root, 'scripts', 'docker-release.sh'), source.replaceAll('\n', '\r\n'))

  // Evaluate only the entry-point function, never task.sh initialization or the received deployment script.
  const harness = `set -euo pipefail
ROOT_DIR=$PP_TEST_ROOT
DOCKER_REGISTRY=ghcr.io
DOCKER_IMAGE_OWNER=example
load_docker_host_config() {
  DOCKER_HOST_ADDR=mock.invalid
  DOCKER_HOST_PORT=2222
  DOCKER_HOST_USERNAME=tester
  DOCKER_HOST_PRIVATE_KEY_PATH=''
  DOCKER_HOST_CONNECT_TIMEOUT_SECONDS=7
}
normalize_bash_path() { printf '%s\\n' "$1"; }
git() { printf 'Forbidden Git invocation\\n' >&2; exit 91; }
docker() { printf 'Forbidden Docker invocation\\n' >&2; exit 92; }
ssh() {
  printf '%s\\n' "$@" >> "$PP_TEST_ROOT/ssh-args"
  local last=''
  for last in "$@"; do :; done
  if [ "$last" = true ]; then return 0; fi
  cat > "$PP_TEST_ROOT/ssh-stdin"
  cat "$PP_TEST_ROOT/ssh-stdin"
}
${rollback}
run_docker_rollback demo 2
`
  const result = spawnSync(bash, ['-c', harness], {
    cwd: f.root,
    env: { ...process.env, PP_TEST_ROOT: shellPath(f.root) },
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.ifError(result.error)
  succeeded(result)
  const sshOptions = [
    '-p',
    '2222',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=7',
    'tester@mock.invalid',
  ]
  assert.equal(
    readFileSync(path.join(f.root, 'ssh-args'), 'utf8'),
    [...sshOptions, 'true', ...sshOptions, 'sh', '-s', '--', 'rollback', 'demo', image, '2', ''].join('\n')
  )
  assert.equal(readFileSync(path.join(f.root, 'ssh-stdin'), 'utf8'), source)
  assert.ok(result.stdout.includes(source), 'Mock SSH must output the local shared script without executing it')
  assert.equal(f.calls(), '', 'No Docker or Git command may run')
})

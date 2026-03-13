import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APPS_DIR = path.join(ROOT_DIR, 'apps');

function parseEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    return {};
  }

  const source = readFileSync(envFilePath, 'utf8');
  const entries = {};

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function resolveServiceDir(serviceName) {
  if (!serviceName) {
    throw new Error('serviceName is required');
  }

  return path.join(APPS_DIR, serviceName);
}

function resolveRunner(serviceDir) {
  const windowsRunner = path.join(serviceDir, 'pbw.exe');
  const windowsPocketBase = path.join(serviceDir, 'pocketbase.exe');
  const unixRunner = path.join(serviceDir, 'pbw');
  const unixPocketBase = path.join(serviceDir, 'pocketbase');

  if (existsSync(windowsRunner) && existsSync(windowsPocketBase)) {
    return [windowsRunner, windowsPocketBase];
  }

  if (existsSync(unixRunner) && existsSync(unixPocketBase)) {
    return [unixRunner, unixPocketBase];
  }

  throw new Error(`pbw/pocketbase binary not found in ${serviceDir}`);
}

async function waitForServer(getBaseUrl, child, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`service exited before readiness check completed (exitCode=${child.exitCode})`);
    }

    const baseUrl = getBaseUrl();

    if (!baseUrl) {
      await delay(250);
      continue;
    }

    try {
      const response = await fetch(baseUrl, { redirect: 'manual' });

      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch (error) {
      if (error.name !== 'TypeError') {
        throw error;
      }
    }

    await delay(250);
  }

  throw new Error(`timed out waiting for ${getBaseUrl()}`);
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    return delay(300);
  }

  child.kill('SIGTERM');
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

/**
 * 테스트용 PocketPages 서비스를 띄우고 종료 함수를 돌려준다.
 * @param {{ serviceName: string, port?: number, timeoutMs?: number }} options
 * @returns {Promise<{ baseUrl: string, stop: () => void }>}
 */
export async function startService(options) {
  const serviceName = options.serviceName;
  const port = options.port || 8090;
  const timeoutMs = options.timeoutMs || 20000;
  const serviceDir = resolveServiceDir(serviceName);
  const [runnerPath, pocketBasePath] = resolveRunner(serviceDir);
  const envFilePath = path.join(serviceDir, '.env');
  const childEnv = {
    ...process.env,
    ...parseEnvFile(envFilePath),
  };
  const args = [
    pocketBasePath,
    'serve',
    '--dev',
    `--dir=${path.join(serviceDir, 'pb_data')}`,
    `--hooksDir=${path.join(serviceDir, 'pb_hooks')}`,
    `--http=127.0.0.1:${port}`,
  ];

  if (existsSync(path.join(serviceDir, 'pb_public'))) {
    args.push(`--publicDir=${path.join(serviceDir, 'pb_public')}`);
  }

  if (existsSync(path.join(serviceDir, 'pb_migrations'))) {
    args.push(`--migrationsDir=${path.join(serviceDir, 'pb_migrations')}`);
  }

  const child = spawn(runnerPath, args, {
    cwd: serviceDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let baseUrl = `http://127.0.0.1:${port}`;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();

    stdout += text;

    const match = text.match(/Server started at (https?:\/\/[^\s]+)/u);

    if (match) {
      baseUrl = match[1];
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(() => baseUrl, child, timeoutMs);
  } catch (error) {
    stopProcessTree(child);
    error.message = `[${serviceName}] ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    throw error;
  }

  return {
    baseUrl,
    async stop() {
      await stopProcessTree(child);
    },
  };
}

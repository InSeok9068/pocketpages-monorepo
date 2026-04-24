#!/usr/bin/env node
'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const {
  ROOT_DIR,
  getDiagIpcPath,
  runDiagnostics,
} = require('./diag-pocketpages-core');

function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let profile = false;
  let noDaemon = false;
  let rawTarget = '';

  while (args.length > 0) {
    const current = args.shift();
    if (current === '--profile') {
      profile = true;
      continue;
    }

    if (current === '--no-daemon') {
      noDaemon = true;
      continue;
    }

    rawTarget = current || '';
    break;
  }

  return {
    profile,
    noDaemon,
    rawTarget,
  };
}

function printRunResult(result) {
  if (result && result.output) {
    process.stdout.write(`${result.output}\n`);
  }

  process.exit(result && Number.isInteger(result.exitCode) ? result.exitCode : 1);
}

function runLocally(options) {
  try {
    const result = runDiagnostics(options.rawTarget, { profile: options.profile });
    printRunResult(result);
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}

function spawnDaemon(pipePath) {
  const daemonScript = path.join(__dirname, 'diag-pocketpages-daemon.js');
  const child = spawn(process.execPath, [daemonScript, '--pipe', pipePath], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function connectToDaemon(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);

    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => reject(error));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithSpawn(pipePath) {
  try {
    return await connectToDaemon(pipePath);
  } catch (_error) {
    spawnDaemon(pipePath);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await connectToDaemon(pipePath);
    } catch (_error) {
      await delay(100);
    }
  }

  throw new Error('Unable to connect to PocketPages diag daemon.');
}

async function runViaDaemon(options) {
  const pipePath = getDiagIpcPath();

  try {
    const socket = await connectWithSpawn(pipePath);
    const payload = JSON.stringify({
      rawTarget: options.rawTarget,
      profile: options.profile,
    });

    let responseText = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      responseText += chunk;
      const newlineIndex = responseText.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const rawResponse = responseText.slice(0, newlineIndex);
      socket.end();

      try {
        const response = JSON.parse(rawResponse);
        if (!response || response.ok !== true || !response.result) {
          throw new Error(response && response.error ? response.error : 'PocketPages diag daemon returned an invalid response.');
        }

        printRunResult(response.result);
      } catch (error) {
        console.error(String(error && error.message ? error.message : error));
        process.exit(1);
      }
    });
    socket.on('error', (error) => {
      console.error(String(error && error.message ? error.message : error));
      process.exit(1);
    });
    socket.write(`${payload}\n`);
  } catch (_error) {
    runLocally(options);
  }
}

const options = parseCliArgs(process.argv.slice(2));
if (options.noDaemon) {
  runLocally(options);
} else {
  runViaDaemon(options);
}

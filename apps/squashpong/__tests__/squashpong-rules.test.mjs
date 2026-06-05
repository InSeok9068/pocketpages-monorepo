import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const rules = require(path.resolve(testDir, '../pb_hooks/pages/assets/squashpong/game-rules.js'));

test('createInitialState sets a one-wall squash court state', () => {
  const state = rules.createInitialState({
    hostCharacter: 'coral',
    guestCharacter: 'violet',
  });

  assert.equal(state.active, 'host');
  assert.equal(state.hostScore, 0);
  assert.equal(state.guestScore, 0);
  assert.equal(state.players.host.character, 'coral');
  assert.equal(state.players.guest.character, 'violet');
  assert.equal(state.awaitingServe, true);
  assert.equal(state.awaitingFrontWall, true);
  assert.equal(state.floorBounces, 0);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);
  assert.ok(state.players.host.y >= rules.WORLD.playerMinY);
});

test('normalizeCharacter falls back to a known character', () => {
  assert.equal(rules.normalizeCharacter('sky'), 'sky');
  assert.equal(rules.normalizeCharacter('missing'), 'lime');
});

test('normalizeInput includes a safe shot selection', () => {
  assert.equal(rules.normalizeInput({ shotType: 'drop', shotSide: -1 }).shotType, 'drop');
  assert.equal(rules.normalizeInput({ shotType: 'missing', shotSide: 0 }).shotType, 'drive');
  assert.equal(rules.normalizeInput({ shotType: 'boast', shotSide: -1 }).shotSide, -1);
});

test('stepState bounces the ball off the front wall', () => {
  const state = rules.createInitialState({});

  state.awaitingServe = false;
  state.ball.x = 270;
  state.ball.y = rules.WORLD.frontWallY + rules.WORLD.ballRadius + 1;
  state.ball.vx = 0;
  state.ball.vy = -320;

  rules.stepState(state, {}, 0.02);

  assert.equal(state.ball.y, rules.WORLD.frontWallY + rules.WORLD.ballRadius);
  assert.ok(state.ball.vy > 0);
});

test('serve waits until the active player swings', () => {
  const state = rules.createInitialState({});

  rules.stepState(state, {}, 0.2);

  assert.equal(state.awaitingServe, true);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);

  const didServe = rules.trySwing(state, 'host', {
    swingId: 1,
  });

  assert.equal(didServe, true);
  assert.equal(state.awaitingServe, false);
  assert.equal(state.awaitingFrontWall, true);
  assert.equal(state.lastHitter, 'host');
  assert.ok(state.ball.vy < 0);
});

test('served ball reaches the front wall without an immediate fault', () => {
  const state = rules.createInitialState({});

  rules.trySwing(state, 'host', {
    swingId: 1,
  });

  for (let index = 0; index < 150 && state.awaitingFrontWall; index += 1) {
    rules.stepState(state, {}, 1 / 60);
  }

  assert.equal(state.hostScore, 0);
  assert.equal(state.guestScore, 0);
  assert.equal(state.awaitingFrontWall, false);
  assert.equal(state.active, 'guest');
});

test('front-court return is forgiving enough to stay in play', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.players.host.x = 235;
  state.players.host.y = rules.WORLD.playerMinY;
  state.ball.x = 238;
  state.ball.y = rules.WORLD.playerMinY - 34;
  state.ball.z = 42;
  state.ball.vx = 0;
  state.ball.vy = 260;
  state.ball.vz = 40;

  const didHit = rules.trySwing(state, 'host', {
    swingId: 1,
  });

  assert.equal(didHit, true);

  for (let index = 0; index < 130 && state.awaitingFrontWall; index += 1) {
    rules.stepState(state, {}, 1 / 60);
  }

  assert.equal(state.hostScore, 0);
  assert.equal(state.guestScore, 0);
  assert.equal(state.awaitingFrontWall, false);
  assert.equal(state.active, 'guest');
});

test('active player swing sends the ball back to the wall and changes turn', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.players.host.x = 235;
  state.players.host.y = 744;
  state.ball.x = 237;
  state.ball.y = 714;
  state.ball.z = 44;
  state.ball.vx = 0;
  state.ball.vy = 360;

  const didHit = rules.trySwing(state, 'host', {
    swingId: 1,
  });

  assert.equal(didHit, true);
  assert.equal(state.active, 'host');
  assert.equal(state.awaitingFrontWall, true);
  assert.equal(state.lastHitter, 'host');
  assert.equal(state.rally, 1);
  assert.ok(state.ball.vy < 0);
  assert.ok(state.players.host.swingTimer > 0);
});

test('drop swing returns short after a low front wall hit', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.players.host.x = 235;
  state.players.host.y = 744;
  state.ball.x = 237;
  state.ball.y = 714;
  state.ball.z = 48;
  state.ball.vx = 0;
  state.ball.vy = 320;

  const didHit = rules.trySwing(state, 'host', {
    swingId: 1,
    shotType: 'drop',
  });

  assert.equal(didHit, true);
  assert.equal(state.lastShotType, 'drop');

  for (let index = 0; index < 160 && state.awaitingFrontWall; index += 1) {
    rules.stepState(state, {}, 1 / 60);
  }

  assert.equal(state.hostScore, 0);
  assert.equal(state.guestScore, 0);
  assert.equal(state.awaitingFrontWall, false);
  assert.ok(state.ball.vy < rules.WORLD.ballSpeed * 0.55);
  assert.ok(state.ball.vz < 80);
});

test('boast swing sends the ball toward the selected side wall first', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.players.host.x = 250;
  state.players.host.y = 744;
  state.ball.x = 252;
  state.ball.y = 714;
  state.ball.z = 52;
  state.ball.vx = 0;
  state.ball.vy = 320;

  const didHit = rules.trySwing(state, 'host', {
    swingId: 1,
    shotType: 'boast',
    shotSide: -1,
  });

  assert.equal(didHit, true);
  assert.equal(state.lastShotType, 'boast');
  assert.ok(state.ball.vx < -300);
  assert.ok(state.ball.vy < 0);
});

test('inactive player swing does not steal the rally', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.players.guest.x = 235;
  state.players.guest.y = 744;
  state.ball.x = 235;
  state.ball.y = 714;
  state.ball.vy = 360;

  const didHit = rules.trySwing(state, 'guest', {
    swingId: 1,
  });

  assert.equal(didHit, false);
  assert.equal(state.active, 'host');
  assert.equal(state.rally, 0);
});

test('front wall hit makes the opponent active', () => {
  const state = rules.createInitialState({});

  state.active = 'host';
  state.awaitingServe = false;
  state.awaitingFrontWall = true;
  state.lastHitter = 'host';
  state.ball.x = 270;
  state.ball.y = rules.WORLD.frontWallY + rules.WORLD.ballRadius + 1;
  state.ball.z = 82;
  state.ball.vx = 0;
  state.ball.vy = -320;

  rules.stepState(state, {}, 0.02);

  assert.equal(state.awaitingFrontWall, false);
  assert.equal(state.active, 'guest');
  assert.equal(state.floorBounces, 0);
  assert.ok(state.ball.vy > 0);
});

test('back wall bounce stays in play', () => {
  const state = rules.createInitialState({});

  state.active = 'guest';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.ball.x = 270;
  state.ball.y = rules.WORLD.backWallY - rules.WORLD.ballRadius + 2;
  state.ball.z = 50;
  state.ball.vx = 0;
  state.ball.vy = 320;

  rules.stepState(state, {}, 0.02);

  assert.equal(state.hostScore, 0);
  assert.equal(state.guestScore, 0);
  assert.equal(state.active, 'guest');
  assert.ok(state.ball.vy < 0);
});

test('second floor bounce awards the point to the hitter', () => {
  const state = rules.createInitialState({});

  state.active = 'guest';
  state.awaitingServe = false;
  state.awaitingFrontWall = false;
  state.lastHitter = 'host';
  state.floorBounces = 1;
  state.ball.x = 270;
  state.ball.y = 700;
  state.ball.z = 2;
  state.ball.vx = 80;
  state.ball.vy = 0;
  state.ball.vz = -120;

  rules.stepState(state, {}, 0.02);

  assert.equal(state.hostScore, 1);
  assert.equal(state.guestScore, 0);
  assert.equal(state.active, 'host');
  assert.equal(state.awaitingServe, true);
  assert.equal(state.floorBounces, 0);
  assert.equal(state.ball.vy, 0);
});

test('players can move into the front court for short drops', () => {
  const state = rules.createInitialState({});

  rules.stepState(
    state,
    {
      host: {
        up: true,
      },
    },
    2
  );

  assert.ok(state.players.host.y < 586);
  assert.equal(state.players.host.y, rules.WORLD.playerMinY);
});

test('movement clamps players inside the playable court', () => {
  const state = rules.createInitialState({});

  rules.stepState(
    state,
    {
      host: {
        up: true,
        left: true,
      },
    },
    4
  );

  assert.equal(state.players.host.x, rules.WORLD.leftX + rules.WORLD.playerRadius);
  assert.equal(state.players.host.y, rules.WORLD.playerMinY);
});

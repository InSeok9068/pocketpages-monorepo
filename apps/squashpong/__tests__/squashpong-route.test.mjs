import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { load } from 'cheerio';

import { startService } from '@pocketpages/test-support/service-harness';

let service;

before(async () => {
  service = await startService({
    serviceName: 'squashpong',
  });
});

after(async () => {
  if (service) {
    await service.stop();
  }
});

async function getJson(path) {
  const response = await fetch(`${service.baseUrl}${path}`);
  const payload = await response.json();

  return { response, payload };
}

async function postJson(path, body) {
  const response = await fetch(`${service.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();

  return { response, payload };
}

async function createRoom(body = {}) {
  const { response, payload } = await postJson('/api/rooms/create', body);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(payload.room.code, /^[A-Z0-9]{6}$/);
  assert.match(payload.room.speedMode, /^(normal|fast|turbo)$/);

  return payload.room.code;
}

test('GET / renders the playable draft page', async () => {
  const response = await fetch(`${service.baseUrl}/`);
  const body = await response.text();
  const $ = load(body);

  assert.equal(response.status, 200);
  assert.equal($('title').text().trim(), 'Squash Pong');
  assert.equal($('h1').first().text().trim(), 'Squash Pong');
  assert.equal($('#lobby-screen').length, 1);
  assert.equal($('#room-screen').is('[hidden]'), true);
  assert.equal($('#game-screen').is('[hidden]'), true);
  assert.equal($('#game-canvas').attr('width'), '540');
  assert.equal($('#game-canvas').attr('height'), '960');
  assert.equal($('#game-canvas').attr('tabindex'), '-1');
  assert.equal($('#create-room').text().trim(), '방 만들기');
  assert.equal($('#join-room').text().trim(), '참가');
  assert.equal($('#solo-play').text().trim(), '솔로 플레이');
  assert.equal($('#copy-link').text().trim(), '초대 링크 복사');
  assert.equal($('#leave-game').text().trim(), '나가기');
  assert.equal($('input[name="speedMode"]').length, 3);
  assert.equal($('input[name="speedMode"][value="normal"]').is('[checked]'), true);
  assert.equal($('#speed-label').text().trim(), '기본');
  assert.equal($('#swing-button').length, 0);
  assert.equal($('[data-control]').length, 0);
  assert.equal($('input[name="character"]').length, 4);
  assert.match(body, /window\.SQUASHPONG_ROOM_CODE = ''/);
  assert.match(body, /\/assets\/squashpong\/game-rules\./);
  assert.match(body, /\/assets\/squashpong\/game\./);
  assert.ok(body.indexOf('/assets/squashpong/game-rules.') < body.indexOf('/assets/squashpong/game.'));
});

test('GET /?room preloads invite room code', async () => {
  const response = await fetch(`${service.baseUrl}/?room=AB12CD`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /window\.SQUASHPONG_ROOM_CODE = 'AB12CD'/);
});

test('GET /games/squashpong redirects legacy game URL to root', async () => {
  const response = await fetch(`${service.baseUrl}/games/squashpong?room=AB12CD`, {
    redirect: 'manual',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?room=AB12CD');
});

test('GET /assets/squashpong/game.js returns the client game script', async () => {
  const response = await fetch(`${service.baseUrl}/assets/squashpong/game.js`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /SquashpongRules/);
  assert.match(body, /RTCPeerConnection/);
  assert.match(body, /createDataChannel\('squashpong'\)/);
  assert.match(body, /requestAnimationFrame\(frame\)/);
  assert.match(body, /startSoloGame/);
  assert.match(body, /updateAiInput/);
  assert.match(body, /setScreen/);
  assert.match(body, /leaveGame/);
  assert.match(body, /getSelectedSpeedMode/);
  assert.match(body, /syncSpeedModeOptions/);
  assert.match(body, /shotType: 'drive'/);
  assert.match(body, /detectShotFromGesture/);
  assert.match(body, /drawShotHint/);
  assert.match(body, /loadImage/);
  assert.match(body, /court\.svg/);
  assert.match(body, /player-lime\.svg/);
  assert.match(body, /drawImage/);
  assert.match(body, /pointerControl/);
  assert.match(body, /handleCourtPointerDown/);
  assert.match(body, /handleCourtPointerEnd/);
  assert.match(body, /getWorldPoint/);
  assert.match(body, /syncCanvasResolution/);
  assert.match(body, /devicePixelRatio/);
  assert.match(body, /imageSmoothingQuality = 'high'/);
  assert.match(body, /createRadialGradient/);
  assert.match(body, /trailGradient/);
  assert.match(body, /COURT_VIEW/);
  assert.match(body, /projectCourtPoint/);
  assert.match(body, /projectFloorLocal/);
  assert.match(body, /drawPolygon/);
  assert.match(body, /floorGradient\.addColorStop\(0, '#f0dca8'\)/);
  assert.match(body, /shirtGradient/);
  assert.match(body, /ctx\.arc\(0, -47, 12/);
  assert.match(body, /runtime\.localInput\.swingId \+= 1/);
});

test('GET /assets/squashpong/court.svg returns the SVG court asset', async () => {
  const response = await fetch(`${service.baseUrl}/assets/squashpong/court.svg`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<svg/);
  assert.match(body, /frontWall/);
  assert.match(body, /floor/);
});

test('GET /assets/squashpong/player-lime.svg returns the SVG player asset', async () => {
  const response = await fetch(`${service.baseUrl}/assets/squashpong/player-lime.svg`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<svg/);
  assert.match(body, /shirt/);
  assert.match(body, /#b7f25a/);
});

test('GET /assets/squashpong/game-rules.js returns testable squash rules', async () => {
  const response = await fetch(`${service.baseUrl}/assets/squashpong/game-rules.js`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /frontWallY/);
  assert.match(body, /backWallY/);
  assert.match(body, /playerMinY/);
  assert.match(body, /awaitingServe/);
  assert.match(body, /ballSpeed: 300/);
  assert.match(body, /SPEED_MODES/);
  assert.match(body, /normalizeSpeedMode/);
  assert.match(body, /outHeight: 260/);
  assert.match(body, /frontWallTargetHeight/);
  assert.match(body, /hitRadius: 78/);
  assert.match(body, /SHOT_TYPES/);
  assert.match(body, /normalizeShotType/);
  assert.match(body, /shotType/);
  assert.match(body, /getFrontWallLift/);
  assert.match(body, /floorBounces/);
  assert.match(body, /trySwing/);
  assert.match(body, /stepState/);
});

test('GET /assets/style.css includes mobile game screens and drag controls', async () => {
  const response = await fetch(`${service.baseUrl}/assets/style.css`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /body\[data-screen=['"]game['"]\]/);
  assert.match(body, /\.lobby-screen/);
  assert.match(body, /\.room-screen/);
  assert.match(body, /\.game-screen/);
  assert.match(body, /100dvh/);
  assert.match(body, /height: 100dvh/);
  assert.match(body, /\.play-surface\.is-dragging/);
  assert.match(body, /safe-area-inset-bottom/);
  assert.match(body, /\.character-list/);
  assert.match(body, /\.speed-mode-list/);
  assert.match(body, /@media \(min-width: 760px\)/);
  assert.match(body, /touch-action: none/);
  assert.doesNotMatch(body, /\.touch-controls/);
  assert.doesNotMatch(body, /\.swing-button/);
});

test('POST /api/rooms/create creates unique in-memory room codes', async () => {
  const firstCode = await createRoom();
  const secondCode = await createRoom();

  assert.notEqual(firstCode, secondCode);
});

test('POST /api/rooms/create stores selected ball speed mode', async () => {
  const { response, payload } = await postJson('/api/rooms/create', {
    speedMode: 'fast',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.room.speedMode, 'fast');
});

test('GET /api/rooms/[roomCode]/offer returns null before host posts offer', async () => {
  const roomCode = await createRoom({
    speedMode: 'turbo',
  });
  const { response, payload } = await getJson(`/api/rooms/${roomCode}/offer`);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.offer, null);
  assert.equal(payload.room.speedMode, 'turbo');
});

test('POST and GET /api/rooms/[roomCode]/offer round-trip host offer and reset answer state', async () => {
  const roomCode = await createRoom();
  const firstOffer = {
    type: 'offer',
    sdp: 'v=0\r\nfirst-offer',
  };
  const answer = {
    type: 'answer',
    sdp: 'v=0\r\nanswer',
  };
  const secondOffer = {
    type: 'offer',
    sdp: 'v=0\r\nsecond-offer',
  };

  const firstPost = await postJson(`/api/rooms/${roomCode}/offer`, {
    offer: firstOffer,
  });
  assert.equal(firstPost.response.status, 200);
  assert.equal(firstPost.payload.ok, true);

  const firstGet = await getJson(`/api/rooms/${roomCode}/offer`);
  assert.deepEqual(firstGet.payload.offer, firstOffer);

  const answerPost = await postJson(`/api/rooms/${roomCode}/answer`, {
    answer,
  });
  assert.equal(answerPost.response.status, 200);

  const answerGet = await getJson(`/api/rooms/${roomCode}/answer`);
  assert.deepEqual(answerGet.payload.answer, answer);

  const secondPost = await postJson(`/api/rooms/${roomCode}/offer`, {
    offer: secondOffer,
  });
  assert.equal(secondPost.response.status, 200);

  const resetAnswerGet = await getJson(`/api/rooms/${roomCode}/answer`);
  assert.equal(resetAnswerGet.payload.answer, null);

  const secondGet = await getJson(`/api/rooms/${roomCode}/offer`);
  assert.deepEqual(secondGet.payload.offer, secondOffer);
});

test('POST and GET /api/rooms/[roomCode]/answer round-trip guest answer', async () => {
  const roomCode = await createRoom();
  const answer = {
    type: 'answer',
    sdp: 'v=0\r\nguest-answer',
  };

  const postResult = await postJson(`/api/rooms/${roomCode}/answer`, {
    answer,
  });
  const getResult = await getJson(`/api/rooms/${roomCode}/answer`);

  assert.equal(postResult.response.status, 200);
  assert.equal(postResult.payload.ok, true);
  assert.equal(getResult.response.status, 200);
  assert.deepEqual(getResult.payload.answer, answer);
});

test('POST and GET /api/rooms/[roomCode]/candidates exchange candidates by opposite role', async () => {
  const roomCode = await createRoom();
  const hostCandidate = {
    candidate: 'candidate:host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
  const guestCandidate = {
    candidate: 'candidate:guest',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };

  const hostPost = await postJson(`/api/rooms/${roomCode}/candidates/host`, {
    candidate: hostCandidate,
  });
  const guestPost = await postJson(`/api/rooms/${roomCode}/candidates/guest`, {
    candidate: guestCandidate,
  });
  const hostRead = await getJson(`/api/rooms/${roomCode}/candidates/host`);
  const guestRead = await getJson(`/api/rooms/${roomCode}/candidates/guest`);

  assert.equal(hostPost.response.status, 200);
  assert.equal(guestPost.response.status, 200);
  assert.equal(hostPost.payload.role, 'host');
  assert.equal(guestPost.payload.role, 'guest');
  assert.equal(hostRead.payload.role, 'host');
  assert.equal(guestRead.payload.role, 'guest');
  assert.deepEqual(hostRead.payload.candidates, [guestCandidate]);
  assert.deepEqual(guestRead.payload.candidates, [hostCandidate]);
});

test('POST /api/rooms/[roomCode]/candidates rejects missing candidate', async () => {
  const roomCode = await createRoom();
  const { response, payload } = await postJson(`/api/rooms/${roomCode}/candidates/host`, {});

  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Candidate is required.');
});

test('room APIs return JSON 404 for unknown rooms', async () => {
  const offerResult = await getJson('/api/rooms/NOPE00/offer');
  const answerResult = await getJson('/api/rooms/NOPE00/answer');
  const candidatesResult = await getJson('/api/rooms/NOPE00/candidates/guest');

  assert.equal(offerResult.response.status, 404);
  assert.equal(offerResult.payload.ok, false);
  assert.equal(answerResult.response.status, 404);
  assert.equal(answerResult.payload.ok, false);
  assert.equal(candidatesResult.response.status, 404);
  assert.equal(candidatesResult.payload.ok, false);
});

test('room APIs reject unsupported methods with JSON 405', async () => {
  const roomCode = await createRoom();
  const response = await fetch(`${service.baseUrl}/api/rooms/${roomCode}/offer`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 405);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'Method not allowed.');
});

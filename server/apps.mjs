import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_IDS = new Map([
  ['whiteboard', 'Whiteboard'],
  ['gartic', 'Gartic Phone'],
]);

const GARTIC_MODES = new Map([
  ['normal', { label: 'Normal', blind: false, peek: false, seed: false, alternate: true }],
  ['secret', { label: 'Secret', blind: true, peek: false, seed: false, alternate: true }],
  ['knockoff', { label: 'Knock-Off', blind: false, peek: true, seed: false, alternate: false }],
  ['complement', { label: 'Complement', blind: false, peek: false, seed: true, alternate: false }],
]);

const GARTIC_SECONDS = new Set([30, 45, 60, 90, 120]);
const MAX_PLAYERS = 12;
const MAX_OBJECTS = 600;
const MAX_STROKE_POINTS = 4000;
const MAX_OP_POINTS = 500;
const MAX_TEXT = 500;
const MAX_PROMPT = 160;
const MAX_DRAWING_JSON = 220_000;
const MAX_DRAWING_STROKES = 500;
const MAX_DRAWING_POINTS = 24_000;
const COORD_LIMIT = 40_000;
const IMAGE_TYPES = new Map([['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'], ['image/webp', '.webp']]);

function clampNumber(value, fallback = 0, limit = COORD_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(-limit, Math.min(limit, Math.round(parsed * 100) / 100));
}

function cleanHex(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : fallback;
}

function cleanUid(value) {
  const text = String(value || '').trim();
  return /^[a-z0-9_-]{6,48}$/i.test(text) ? text : null;
}

function cleanPoints(value, cap) {
  if (!Array.isArray(value)) return [];
  const points = [];
  for (const item of value) {
    if (points.length >= cap * 2) break;
    const parsed = Number(item);
    if (!Number.isFinite(parsed)) return [];
    points.push(clampNumber(parsed));
  }
  if (points.length % 2 === 1) points.pop();
  return points;
}

function cleanDrawing(value) {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(parsed)) return null;
  const strokes = [];
  let total = 0;
  for (const item of parsed.slice(0, MAX_DRAWING_STROKES)) {
    if (!item || typeof item !== 'object') continue;
    const points = cleanPoints(item.points, 3000);
    if (points.length < 2) continue;
    total += points.length / 2;
    if (total > MAX_DRAWING_POINTS) break;
    strokes.push({
      color: cleanHex(item.color, '#f7fbff'),
      width: Math.max(1, Math.min(48, Math.round(Number(item.width) || 4))),
      points,
    });
  }
  const encoded = JSON.stringify(strokes);
  if (encoded.length > MAX_DRAWING_JSON) return null;
  return encoded;
}

function safeParse(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

export function createAppService({ database, uploadDirectory, apiPrefix, sendEvent, randomId, hooks }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_boards (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS app_board_objects (
      uid TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES app_boards(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      z INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS app_board_objects_board_index ON app_board_objects(board_id, z);
    CREATE TABLE IF NOT EXISTS app_board_images (
      storage_name TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES app_boards(id) ON DELETE CASCADE,
      uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS gartic_games (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL,
      host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      total_rounds INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS gartic_games_scope_index ON gartic_games(scope_key, id);
    CREATE TABLE IF NOT EXISTS gartic_pages (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES gartic_games(id) ON DELETE CASCADE,
      book_index INTEGER NOT NULL,
      page_index INTEGER NOT NULL,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(game_id, book_index, page_index)
    ) STRICT;
  `);
  database.exec("UPDATE gartic_games SET phase = 'done' WHERE phase != 'done'");

  const findBoard = database.prepare('SELECT id, scope_key FROM app_boards WHERE scope_key = ?');
  const insertBoard = database.prepare('INSERT INTO app_boards (scope_key, created_at, updated_at) VALUES (?, ?, ?)');
  const touchBoard = database.prepare('UPDATE app_boards SET updated_at = ? WHERE id = ?');
  const listBoardObjects = database.prepare('SELECT uid, author_id, kind, data_json, z FROM app_board_objects WHERE board_id = ? ORDER BY z, uid');
  const countBoardObjects = database.prepare('SELECT COUNT(*) AS count FROM app_board_objects WHERE board_id = ?');
  const nextBoardZ = database.prepare('SELECT COALESCE(MAX(z), 0) + 1 AS next FROM app_board_objects WHERE board_id = ?');
  const findBoardObject = database.prepare('SELECT uid, board_id, author_id, kind, data_json, z FROM app_board_objects WHERE board_id = ? AND uid = ?');
  const insertBoardObject = database.prepare('INSERT INTO app_board_objects (uid, board_id, author_id, kind, data_json, z, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updateBoardObject = database.prepare('UPDATE app_board_objects SET data_json = ?, updated_at = ? WHERE board_id = ? AND uid = ?');
  const deleteBoardObject = database.prepare('DELETE FROM app_board_objects WHERE board_id = ? AND uid = ?');
  const clearBoardObjects = database.prepare('DELETE FROM app_board_objects WHERE board_id = ?');
  const insertBoardImage = database.prepare('INSERT INTO app_board_images (storage_name, board_id, uploaded_by, mime_type, created_at) VALUES (?, ?, ?, ?, ?)');
  const findBoardImage = database.prepare('SELECT storage_name, board_id, mime_type FROM app_board_images WHERE storage_name = ?');
  const findBoardImageForBoard = database.prepare('SELECT storage_name FROM app_board_images WHERE board_id = ? AND storage_name = ?');
  const boardScopeKey = database.prepare('SELECT scope_key FROM app_boards WHERE id = ?');
  const insertGame = database.prepare('INSERT INTO gartic_games (scope_key, host_id, mode, phase, round, total_rounds, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const updateGame = database.prepare('UPDATE gartic_games SET phase = ?, round = ?, state_json = ?, updated_at = ? WHERE id = ?');
  const insertGamePage = database.prepare('INSERT OR REPLACE INTO gartic_pages (game_id, book_index, page_index, author_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const sessions = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function boardFor(scopeKey) {
    const existing = findBoard.get(scopeKey);
    if (existing) return existing;
    const stamp = nowIso();
    insertBoard.run(scopeKey, stamp, stamp);
    return findBoard.get(scopeKey);
  }

  function imageUrl(storageName) {
    return `${apiPrefix}/app-images/${storageName}`;
  }

  function boardObjectPayload(row) {
    const data = safeParse(row.data_json) || {};
    return { ...data, uid: row.uid, kind: row.kind, authorId: Number(row.author_id), z: Number(row.z) };
  }

  function whiteboardSnapshot(scopeKey) {
    const board = boardFor(scopeKey);
    return { objects: listBoardObjects.all(board.id).map(boardObjectPayload) };
  }

  function sanitizeBoardObject(input, boardId, authorId) {
    if (!input || typeof input !== 'object') return { error: 'Invalid object.' };
    const uid = cleanUid(input.uid);
    if (!uid) return { error: 'Invalid object id.' };
    const kind = String(input.kind || '').toLowerCase();
    if (kind === 'stroke') {
      const points = cleanPoints(input.points, MAX_OP_POINTS);
      if (points.length < 2) return { error: 'Empty stroke.' };
      return { uid, kind, data: { color: cleanHex(input.color, '#f7fbff'), width: Math.max(1, Math.min(48, Math.round(Number(input.width) || 4))), points } };
    }
    if (kind === 'text' || kind === 'note') {
      const text = String(input.text || '').slice(0, MAX_TEXT);
      return {
        uid,
        kind,
        data: {
          x: clampNumber(input.x), y: clampNumber(input.y),
          w: Math.max(60, Math.min(1400, clampNumber(input.w, 220))),
          h: kind === 'note' ? Math.max(60, Math.min(1400, clampNumber(input.h, 160))) : undefined,
          text,
          color: cleanHex(input.color, kind === 'note' ? '#f5e6a3' : '#f7fbff'),
          size: Math.max(10, Math.min(96, Math.round(Number(input.size) || 18))),
        },
      };
    }
    if (kind === 'shape') {
      const shape = ['rect', 'ellipse', 'triangle', 'line'].includes(String(input.shape)) ? String(input.shape) : 'rect';
      return {
        uid,
        kind,
        data: {
          shape,
          x: clampNumber(input.x), y: clampNumber(input.y),
          w: clampNumber(input.w, 160), h: clampNumber(input.h, 120),
          color: cleanHex(input.color, '#249cff'),
          filled: Boolean(input.filled),
          width: Math.max(1, Math.min(24, Math.round(Number(input.width) || 4))),
        },
      };
    }
    if (kind === 'image') {
      const url = String(input.url || '');
      const name = url.startsWith(`${apiPrefix}/app-images/`) ? url.slice(`${apiPrefix}/app-images/`.length) : '';
      if (!name || !findBoardImageForBoard.get(boardId, name)) return { error: 'Upload that image again.' };
      return {
        uid,
        kind,
        data: {
          url: imageUrl(name),
          x: clampNumber(input.x), y: clampNumber(input.y),
          w: Math.max(24, Math.min(3000, clampNumber(input.w, 320))),
          h: Math.max(24, Math.min(3000, clampNumber(input.h, 240))),
        },
      };
    }
    return { error: 'Unsupported object.' };
  }

  function applyWhiteboardOp(session, user, op) {
    const board = boardFor(session.scopeKey);
    const stamp = nowIso();
    const type = String(op?.type || '');
    if (type === 'add') {
      if (Number(countBoardObjects.get(board.id)?.count || 0) >= MAX_OBJECTS) return { error: 'This board is full. Delete something first.' };
      const clean = sanitizeBoardObject(op.object, board.id, user.id);
      if (clean.error) return clean;
      if (findBoardObject.get(board.id, clean.uid)) return { error: 'Duplicate object.' };
      const z = Number(nextBoardZ.get(board.id)?.next || 1);
      insertBoardObject.run(clean.uid, board.id, user.id, clean.kind, JSON.stringify(clean.data), z, stamp, stamp);
      touchBoard.run(stamp, board.id);
      return { broadcast: { type: 'add', object: { ...clean.data, uid: clean.uid, kind: clean.kind, authorId: Number(user.id), z } } };
    }
    if (type === 'stroke') {
      const uid = cleanUid(op.uid);
      const row = uid ? findBoardObject.get(board.id, uid) : null;
      if (!row || row.kind !== 'stroke') return { error: 'That stroke is gone.' };
      const points = cleanPoints(op.points, MAX_OP_POINTS);
      if (points.length < 2) return { error: 'Empty stroke.' };
      const data = safeParse(row.data_json) || { points: [] };
      const merged = [...(Array.isArray(data.points) ? data.points : []), ...points].slice(0, MAX_STROKE_POINTS * 2);
      updateBoardObject.run(JSON.stringify({ ...data, points: merged }), stamp, board.id, uid);
      touchBoard.run(stamp, board.id);
      return { broadcast: { type: 'stroke', uid, points } };
    }
    if (type === 'patch') {
      const uid = cleanUid(op.uid);
      const row = uid ? findBoardObject.get(board.id, uid) : null;
      if (!row) return { error: 'That object is gone.' };
      const data = safeParse(row.data_json) || {};
      const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
      const next = { ...data };
      if ('x' in patch) next.x = clampNumber(patch.x, data.x || 0);
      if ('y' in patch) next.y = clampNumber(patch.y, data.y || 0);
      if ('w' in patch) next.w = Math.max(12, Math.min(3000, clampNumber(patch.w, data.w || 120)));
      if ('h' in patch) next.h = Math.max(12, Math.min(3000, clampNumber(patch.h, data.h || 120)));
      if ('color' in patch) next.color = cleanHex(patch.color, data.color || '#f7fbff');
      if ('text' in patch) {
        if (row.kind === 'text' && Number(row.author_id) !== Number(user.id)) return { error: 'Only the author can edit that text.' };
        next.text = String(patch.text || '').slice(0, MAX_TEXT);
      }
      updateBoardObject.run(JSON.stringify(next), stamp, board.id, uid);
      touchBoard.run(stamp, board.id);
      return { broadcast: { type: 'patch', uid, patch: next } };
    }
    if (type === 'delete') {
      const uid = cleanUid(op.uid);
      if (!uid || !findBoardObject.get(board.id, uid)) return { error: 'That object is gone.' };
      deleteBoardObject.run(board.id, uid);
      touchBoard.run(stamp, board.id);
      return { broadcast: { type: 'delete', uid } };
    }
    if (type === 'clear') {
      clearBoardObjects.run(board.id);
      touchBoard.run(stamp, board.id);
      return { broadcast: { type: 'clear' } };
    }
    return { error: 'Unsupported whiteboard action.' };
  }

  function participantList(session) {
    return [...session.members.keys()].map((id) => hooks.publicUser(id)).filter(Boolean);
  }

  function sessionSummary(session) {
    if (!session) return null;
    return {
      appId: session.appId,
      appName: APP_IDS.get(session.appId) || session.appId,
      hostId: Number(session.hostId),
      startedAt: session.startedAt,
      participants: participantList(session),
      participantCount: session.members.size,
    };
  }

  function broadcastSession(scope, session) {
    const payload = {
      scopeKey: scope.key,
      serverId: scope.serverId ?? null,
      channelId: scope.channelId ?? null,
      conversationId: scope.conversationId ?? null,
      session: sessionSummary(session),
    };
    for (const userId of hooks.scopeAudienceIds(scope)) sendEvent(userId, 'app-session', payload);
  }

  function sendToSession(session, event, payload) {
    for (const userId of session.members.keys()) sendEvent(userId, event, payload);
  }

  function garticModeConfig(mode) {
    return GARTIC_MODES.get(mode) || GARTIC_MODES.get('normal');
  }

  function roundKind(game, round) {
    const config = garticModeConfig(game.mode);
    if (!config.alternate) return round === 0 ? 'draw' : 'draw';
    if (round === 0) return 'write';
    return round % 2 === 1 ? 'draw' : 'guess';
  }

  function roundSeconds(game, round) {
    const base = game.seconds;
    const kind = roundKind(game, round);
    if (game.mode === 'knockoff') return round === 0 ? base : Math.max(15, Math.round(base * (0.78 ** round)));
    if (game.mode === 'complement' && round === 0) return Math.max(10, Math.round(base * 0.3));
    if (kind === 'write' || kind === 'guess') return Math.max(20, Math.round(base * 0.6));
    return base;
  }

  function bookIndexFor(game, playerIndex, round) {
    const count = game.players.length;
    return ((playerIndex - round) % count + count) % count;
  }

  function playerIndexOf(game, userId) {
    return game.players.findIndex((player) => Number(player.id) === Number(userId));
  }

  function pageAt(game, bookIndex, pageIndex) {
    return game.books[bookIndex]?.[pageIndex] || null;
  }

  function persistGame(session) {
    const game = session.game;
    if (!game?.id) return;
    updateGame.run(game.phase, game.round, JSON.stringify({
      mode: game.mode,
      seconds: game.seconds,
      players: game.players,
      books: game.books,
      revealIndex: game.revealIndex || 0,
    }), nowIso(), game.id);
  }

  function garticStateFor(session, userId) {
    const game = session.game;
    if (!game) return null;
    const config = garticModeConfig(game.mode);
    const index = playerIndexOf(game, userId);
    const base = {
      mode: game.mode,
      modeLabel: config.label,
      phase: game.phase,
      round: game.round,
      totalRounds: game.totalRounds,
      hostId: Number(game.hostId),
      seconds: game.seconds,
      blind: Boolean(config.blind),
      deadline: game.deadline || null,
      players: game.players.map((player) => ({
        id: Number(player.id),
        username: player.username,
        avatarUrl: player.avatarUrl || null,
        nameStyle: player.nameStyle || null,
        ready: Boolean(player.ready),
        left: Boolean(player.left),
        submitted: Boolean(game.submitted?.[player.id]),
      })),
      playing: index >= 0,
    };
    if (game.phase === 'reveal') {
      const revealIndex = Math.max(0, Math.min(game.books.length - 1, Number(game.revealIndex) || 0));
      base.revealIndex = revealIndex;
      base.revealTotal = game.books.length;
      base.books = game.books.map((pages, bookIndex) => ({
        index: bookIndex,
        owner: game.players[bookIndex] ? { id: Number(game.players[bookIndex].id), username: game.players[bookIndex].username } : null,
        pages: pages.map((page) => ({
          kind: page.kind,
          content: page.content,
          author: game.players.find((player) => Number(player.id) === Number(page.authorId)) || null,
        })),
      }));
      return base;
    }
    if (game.phase !== 'lobby' && index >= 0) {
      const kind = roundKind(game, game.round);
      const bookIndex = bookIndexFor(game, index, game.round);
      const previous = game.round > 0 ? pageAt(game, bookIndex, game.round - 1) : null;
      base.task = {
        kind,
        bookIndex,
        prompt: previous && previous.kind === 'text' ? previous.content : null,
        reference: previous && previous.kind === 'draw' && !config.seed ? previous.content : null,
        seed: config.seed && previous && previous.kind === 'draw' ? previous.content : null,
        peek: Boolean(config.peek) && game.round > 0,
        submitted: Boolean(game.submitted?.[userId]),
        seconds: roundSeconds(game, game.round),
      };
    }
    return base;
  }

  function broadcastGarticState(session) {
    for (const userId of session.members.keys()) {
      sendEvent(userId, 'app-state', { scopeKey: session.scopeKey, appId: 'gartic', state: garticStateFor(session, userId) });
    }
  }

  function clearGarticTimer(session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  function scheduleGarticRound(session) {
    clearGarticTimer(session);
    const game = session.game;
    if (!game || game.phase === 'lobby' || game.phase === 'reveal') return;
    const remaining = Math.max(1000, (game.deadline || Date.now()) - Date.now());
    session.timer = setTimeout(() => {
      session.timer = null;
      advanceGartic(session, true);
    }, remaining + 250);
    session.timer.unref?.();
  }

  function startGarticRound(session, round) {
    const game = session.game;
    game.round = round;
    game.phase = roundKind(game, round);
    game.submitted = {};
    game.deadline = Date.now() + roundSeconds(game, round) * 1000;
    for (const player of game.players) {
      if (player.left) game.submitted[player.id] = true;
    }
    persistGame(session);
    broadcastGarticState(session);
    scheduleGarticRound(session);
    if (game.players.every((player) => game.submitted[player.id])) advanceGartic(session, true);
  }

  function fillMissingPages(session) {
    const game = session.game;
    const stamp = nowIso();
    const kind = roundKind(game, game.round);
    game.players.forEach((player, index) => {
      const bookIndex = bookIndexFor(game, index, game.round);
      if (game.books[bookIndex][game.round]) return;
      const page = { authorId: Number(player.id), kind: kind === 'draw' ? 'draw' : 'text', content: kind === 'draw' ? '[]' : '(no answer)' };
      game.books[bookIndex][game.round] = page;
      if (game.id) insertGamePage.run(game.id, bookIndex, game.round, page.authorId, page.kind, page.content, stamp);
    });
  }

  function advanceGartic(session) {
    const game = session.game;
    if (!game || game.phase === 'lobby' || game.phase === 'reveal') return;
    clearGarticTimer(session);
    fillMissingPages(session);
    const nextRound = game.round + 1;
    if (nextRound >= game.totalRounds) {
      game.phase = 'reveal';
      game.revealIndex = 0;
      game.deadline = null;
      persistGame(session);
      broadcastGarticState(session);
      return;
    }
    startGarticRound(session, nextRound);
  }

  function startGarticGame(session, user, payload) {
    const roster = [...session.members.keys()];
    if (roster.length < 2) return { error: 'Gartic Phone needs at least 2 players in the call.' };
    if (roster.length > MAX_PLAYERS) return { error: `Gartic Phone supports up to ${MAX_PLAYERS} players.` };
    const mode = GARTIC_MODES.has(String(payload.mode)) ? String(payload.mode) : 'normal';
    const seconds = GARTIC_SECONDS.has(Number(payload.seconds)) ? Number(payload.seconds) : 60;
    const players = roster.map((id) => {
      const publicRow = hooks.publicUser(id) || { id, username: 'Player' };
      return { ...publicRow, ready: true, left: false };
    });
    const stamp = nowIso();
    const totalRounds = Math.max(2, players.length);
    const game = {
      id: 0,
      mode,
      seconds,
      hostId: Number(user.id),
      players,
      totalRounds,
      books: players.map(() => []),
      phase: 'write',
      round: 0,
      submitted: {},
      deadline: null,
      revealIndex: 0,
    };
    const inserted = insertGame.run(session.scopeKey, user.id, mode, 'write', 0, totalRounds, JSON.stringify({ mode, seconds, players, books: game.books, revealIndex: 0 }), stamp, stamp);
    game.id = Number(inserted.lastInsertRowid);
    session.game = game;
    startGarticRound(session, 0);
    return { ok: true };
  }

  function submitGarticPage(session, user, round, rawContent) {
    const game = session.game;
    if (!game || game.phase === 'lobby' || game.phase === 'reveal') return { error: 'That game is not accepting answers.' };
    if (Number(round) !== Number(game.round)) return { error: 'That round already ended.' };
    const index = playerIndexOf(game, user.id);
    if (index < 0) return { error: 'You are not in this game.' };
    if (game.submitted[user.id]) return { error: 'You already submitted this round.' };
    const kind = roundKind(game, game.round);
    let content;
    if (kind === 'draw') {
      content = cleanDrawing(rawContent);
      if (content == null) return { error: 'That drawing could not be saved.' };
    } else {
      content = String(rawContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
      if (!content) return { error: kind === 'write' ? 'Write a prompt first.' : 'Describe the drawing first.' };
    }
    const bookIndex = bookIndexFor(game, index, game.round);
    const page = { authorId: Number(user.id), kind: kind === 'draw' ? 'draw' : 'text', content };
    game.books[bookIndex][game.round] = page;
    game.submitted[user.id] = true;
    if (game.id) insertGamePage.run(game.id, bookIndex, game.round, page.authorId, page.kind, page.content, nowIso());
    persistGame(session);
    broadcastGarticState(session);
    if (game.players.every((player) => game.submitted[player.id])) advanceGartic(session);
    return { ok: true };
  }

  function endSession(scope, reason = 'ended') {
    const session = sessions.get(scope.key);
    if (!session) return;
    clearGarticTimer(session);
    if (session.game) {
      session.game.phase = 'done';
      persistGame(session);
    }
    sessions.delete(scope.key);
    sendToSession(session, 'app-closed', { scopeKey: scope.key, reason });
    broadcastSession(scope, null);
  }

  function leaveSession(scope, userId, { silent = false } = {}) {
    const session = sessions.get(scope.key);
    if (!session || !session.members.has(Number(userId))) return;
    session.members.delete(Number(userId));
    if (session.game) {
      const player = session.game.players.find((item) => Number(item.id) === Number(userId));
      if (player) {
        player.left = true;
        if (session.game.phase !== 'lobby' && session.game.phase !== 'reveal') session.game.submitted[player.id] = true;
      }
    }
    if (!session.members.size) {
      endSession(scope, 'empty');
      return;
    }
    if (Number(session.hostId) === Number(userId)) session.hostId = [...session.members.keys()][0];
    if (session.game && session.game.phase !== 'lobby' && session.game.phase !== 'reveal') {
      const active = session.game.players.filter((item) => !item.left);
      if (active.length < 1) {
        session.game.phase = 'reveal';
        session.game.deadline = null;
        clearGarticTimer(session);
        persistGame(session);
      } else if (session.game.players.every((item) => session.game.submitted[item.id])) {
        advanceGartic(session);
      }
    }
    if (!silent) {
      broadcastSession(scope, session);
      if (session.appId === 'gartic') broadcastGarticState(session);
      else sendToSession(session, 'app-presence', { scopeKey: scope.key, session: sessionSummary(session) });
    }
  }

  function joinSession(scope, user, socket) {
    const session = sessions.get(scope.key);
    if (!session) return { error: 'That app is no longer running.' };
    if (session.members.size >= MAX_PLAYERS && !session.members.has(Number(user.id))) return { error: 'This app session is full.' };
    session.members.set(Number(user.id), { socket });
    const snapshot = session.appId === 'whiteboard' ? whiteboardSnapshot(session.scopeKey) : null;
    sendEvent(user.id, 'app-ready', {
      scopeKey: scope.key,
      appId: session.appId,
      session: sessionSummary(session),
      snapshot,
      state: session.appId === 'gartic' ? garticStateFor(session, user.id) : null,
    });
    broadcastSession(scope, session);
    if (session.appId === 'gartic') broadcastGarticState(session);
    else sendToSession(session, 'app-presence', { scopeKey: scope.key, session: sessionSummary(session) });
    return { ok: true };
  }

  function handleClientEvent(user, message, socket) {
    const event = String(message?.event || '');
    if (!event.startsWith('app-')) return false;
    const payload = message.payload || {};
    const scope = hooks.resolveScope(user, payload);
    if (!scope || scope.error) {
      sendEvent(user.id, 'app-error', { scopeKey: payload.scopeKey || null, error: scope?.error || 'That app space is unavailable.' });
      return true;
    }
    if (!hooks.canUseScope(user.id, scope)) {
      sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'Join the voice call to use apps.' });
      return true;
    }
    const existing = sessions.get(scope.key);

    if (event === 'app-start') {
      const appId = String(payload.appId || '');
      if (!APP_IDS.has(appId)) {
        sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'That app is not available.' });
        return true;
      }
      if (existing && existing.appId !== appId) {
        if (existing.members.size) {
          sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: `${APP_IDS.get(existing.appId)} is already running here.` });
          return true;
        }
        endSession(scope, 'replaced');
      }
      if (!sessions.has(scope.key)) {
        sessions.set(scope.key, {
          scopeKey: scope.key,
          scope,
          appId,
          hostId: Number(user.id),
          startedAt: nowIso(),
          members: new Map(),
          game: null,
          timer: null,
        });
      }
      const result = joinSession(scope, user, socket);
      if (result.error) sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: result.error });
      return true;
    }

    if (event === 'app-join') {
      const result = joinSession(scope, user, socket);
      if (result.error) sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: result.error });
      return true;
    }

    if (event === 'app-leave') {
      leaveSession(scope, user.id);
      sendEvent(user.id, 'app-closed', { scopeKey: scope.key, reason: 'left' });
      return true;
    }

    if (event === 'app-end') {
      if (!existing) return true;
      if (Number(existing.hostId) !== Number(user.id) && !hooks.canModerateScope(user, scope)) {
        sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'Only the host can end this app.' });
        return true;
      }
      endSession(scope, 'ended');
      return true;
    }

    if (event === 'app-event') {
      if (!existing || !existing.members.has(Number(user.id))) {
        sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'Join the app first.' });
        return true;
      }
      const op = payload.op && typeof payload.op === 'object' ? payload.op : null;
      if (!op) return true;
      if (existing.appId === 'whiteboard') {
        const result = applyWhiteboardOp(existing, user, op);
        if (result.error) {
          sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: result.error });
          return true;
        }
        for (const userId of existing.members.keys()) {
          if (Number(userId) === Number(user.id)) continue;
          sendEvent(userId, 'app-event', { scopeKey: scope.key, appId: 'whiteboard', fromId: Number(user.id), op: result.broadcast });
        }
        return true;
      }
      if (existing.appId === 'gartic') {
        const type = String(op.type || '');
        if (type === 'start') {
          if (Number(existing.hostId) !== Number(user.id)) {
            sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'Only the host can start the game.' });
            return true;
          }
          if (existing.game && existing.game.phase !== 'reveal' && existing.game.phase !== 'done') {
            sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: 'A game is already running.' });
            return true;
          }
          const result = startGarticGame(existing, user, op);
          if (result.error) sendEvent(user.id, 'app-error', { scopeKey: scope.key, error: result.error });
          return true;
        }
        if (type === 'reset') {
          if (Number(existing.hostId) !== Number(user.id)) return true;
          clearGarticTimer(existing);
          if (existing.game) {
            existing.game.phase = 'done';
            persistGame(existing);
          }
          existing.game = null;
          broadcastGarticState(existing);
          sendToSession(existing, 'app-state', { scopeKey: scope.key, appId: 'gartic', state: null });
          return true;
        }
        if (type === 'skip') {
          if (Number(existing.hostId) !== Number(user.id)) return true;
          if (existing.game) advanceGartic(existing);
          return true;
        }
        if (type === 'reveal-next') {
          if (Number(existing.hostId) !== Number(user.id)) return true;
          if (!existing.game || existing.game.phase !== 'reveal') return true;
          existing.game.revealIndex = Math.min(
            Math.max(0, existing.game.books.length - 1),
            (Number(existing.game.revealIndex) || 0) + 1,
          );
          persistGame(existing);
          broadcastGarticState(existing);
          return true;
        }
        return true;
      }
      return true;
    }

    return true;
  }

  function handleDisconnect(user, socket) {
    for (const session of [...sessions.values()]) {
      const member = session.members.get(Number(user.id));
      if (!member || member.socket !== socket) continue;
      leaveSession(session.scope, user.id);
    }
  }

  function dropScopeMember(userId, scopeKey) {
    const session = sessions.get(scopeKey);
    if (!session) return;
    leaveSession(session.scope, userId);
  }

  function dropUserEverywhere(userId) {
    for (const session of [...sessions.values()]) {
      if (session.members.has(Number(userId))) leaveSession(session.scope, userId);
    }
  }

  function closeScope(scopeKey) {
    const session = sessions.get(scopeKey);
    if (session) endSession(session.scope, 'closed');
  }

  function liveSessionsForServer(serverId) {
    const map = {};
    for (const session of sessions.values()) {
      if (session.scope.kind !== 'channel' || Number(session.scope.serverId) !== Number(serverId)) continue;
      map[String(session.scope.channelId)] = sessionSummary(session);
    }
    return map;
  }

  function sessionForScopeKey(scopeKey) {
    const session = sessions.get(scopeKey);
    return session ? sessionSummary(session) : null;
  }

  async function handleRequest({ method, path, request, response, user, sendJson, readJson, formFile }) {
    if (method === 'POST' && path === '/api/apps/whiteboard/images') {
      const file = await formFile(request, 'image');
      const extension = file && IMAGE_TYPES.get(String(file.type || '').toLowerCase());
      const scopeKey = String(file?.scopeKey || '');
      if (!extension || !file.bytes?.length || file.bytes.length > 8 * 1024 * 1024) {
        return sendJson(response, 400, { error: 'Choose a PNG, JPG, GIF, or WebP up to 8 MB.' });
      }
      const scope = hooks.scopeFromKey(scopeKey);
      if (!scope) return sendJson(response, 404, { error: 'That app space is unavailable.' });
      const session = sessions.get(scope.key);
      if (!session || session.appId !== 'whiteboard' || !session.members.has(Number(user.id))) {
        return sendJson(response, 403, { error: 'Join the whiteboard first.' });
      }
      const board = boardFor(scope.key);
      const storageName = `board-${randomId(18)}${extension}`;
      writeFileSync(join(uploadDirectory, storageName), file.bytes, { mode: 0o600 });
      insertBoardImage.run(storageName, board.id, user.id, String(file.type).toLowerCase(), nowIso());
      return sendJson(response, 201, { url: imageUrl(storageName) });
    }

    const imageMatch = path.match(/^\/api\/app-images\/(board-[a-z2-7]+\.(?:png|jpg|gif|webp))$/i);
    if (method === 'GET' && imageMatch) {
      const row = findBoardImage.get(imageMatch[1].toLowerCase());
      if (!row) return sendJson(response, 404, { error: 'Image not found.' });
      const scopeKey = boardScopeKey.get(row.board_id)?.scope_key;
      const scope = scopeKey ? hooks.scopeFromKey(scopeKey) : null;
      if (!scope || !hooks.canSeeScope(user.id, scope)) return sendJson(response, 404, { error: 'Image not found.' });
      const filePath = join(uploadDirectory, row.storage_name);
      if (!existsSync(filePath)) return sendJson(response, 404, { error: 'Image not found.' });
      return hooks.sendFile(request, response, filePath, row.mime_type);
    }

    if (method === 'GET' && path === '/api/apps/session') {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const scope = hooks.scopeFromKey(String(url.searchParams.get('scopeKey') || ''));
      if (!scope || !hooks.canSeeScope(user.id, scope)) return sendJson(response, 404, { error: 'That app space is unavailable.' });
      return sendJson(response, 200, { scopeKey: scope.key, session: sessionForScopeKey(scope.key) });
    }

    if (method === 'POST' && path === '/api/apps/gartic/submit') {
      let input = {};
      try { input = await readJson(request); } catch (error) { return sendJson(response, 400, { error: error.message }); }
      const scope = hooks.scopeFromKey(String(input.scopeKey || ''));
      if (!scope) return sendJson(response, 404, { error: 'That app space is unavailable.' });
      const session = sessions.get(scope.key);
      if (!session || session.appId !== 'gartic' || !session.members.has(Number(user.id))) {
        return sendJson(response, 403, { error: 'Join the game first.' });
      }
      const result = submitGarticPage(session, user, Number(input.round), input.content);
      if (result.error) return sendJson(response, 400, { error: result.error });
      return sendJson(response, 200, { ok: true, state: garticStateFor(session, user.id) });
    }

    if (method === 'GET' && path === '/api/apps/whiteboard') {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      const scope = hooks.scopeFromKey(String(url.searchParams.get('scopeKey') || ''));
      if (!scope || !hooks.canSeeScope(user.id, scope)) return sendJson(response, 404, { error: 'That app space is unavailable.' });
      return sendJson(response, 200, { scopeKey: scope.key, ...whiteboardSnapshot(scope.key) });
    }

    return false;
  }

  return {
    handleClientEvent,
    handleDisconnect,
    handleRequest,
    dropScopeMember,
    dropUserEverywhere,
    closeScope,
    liveSessionsForServer,
    sessionForScopeKey,
    catalog: [...APP_IDS.entries()].map(([id, name]) => ({ id, name })),
  };
}

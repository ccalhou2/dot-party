'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  MAX_PLAYERS: 2,
  COLORS: 8,
  LENGTH: 5,
  TURN_MS: 30000,
  GRACE_MS: 20000,
  DOT_POINTS: 10,
  SOLVE_BONUS: 20,
  SKIPS_TO_KICK: 2
};

const rooms = new Map();
const uid = () => crypto.randomBytes(8).toString('hex');
const sanitize = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'Player';

const nameKey = n => sanitize(n).toLowerCase();
const nameTaken = (room, rawName) => {
  const key = nameKey(rawName);
  return room.players.some(p => !p.left && nameKey(p.name) === key);
};

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function makeSecret() {
  const pool = [...Array(CONFIG.COLORS).keys()];
  const out = [];
  for (let i = 0; i < CONFIG.LENGTH; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

const seqKey = seq => seq.join(',');

function newPlayer(name, token) {
  return {
    id: uid(),
    token: token || uid(),
    name: sanitize(name),
    socketId: null,
    connected: true,
    left: false,
    score: 0,
    board: Array(CONFIG.LENGTH).fill(null),
    known: [],
    history: [],
    skips: 0
  };
}

function newRoom() {
  return {
    code: makeCode(),
    players: [],
    state: 'lobby',
    secret: null,
    claimed: new Map(),
    order: [],
    pointer: 0,
    currentId: null,
    deadline: null,
    turnSeq: 0,
    timer: null,
    grace: new Map(),
    log: [],
    winnerIds: [],
    endReason: null,
    rematchVotes: new Set()
  };
}

/* ---------- views ---------- */

function publicState(room) {
  return {
    code: room.code,
    state: room.state,
    currentId: room.currentId,
    deadline: room.deadline,
    turnSeq: room.turnSeq,
    now: Date.now(),
    endReason: room.endReason,
    winnerIds: room.winnerIds,
    secret: room.state === 'ended' ? room.secret : null,
    rematchVotes: [...room.rematchVotes],
    rematchNeeded: room.players.filter(p => !p.left).length,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      left: p.left,
      submitted: p.history.length,
      skips: p.skips
    })),
    // public log: sequence only. Never greens / yellows.
    log: room.log.map(e => ({
      name: e.name,
      sequence: e.sequence || null,
      skipped: !!e.skipped
    }))
  };
}

function playerState(room, p) {
  return {
    ...publicState(room),
    you: {
      id: p.id,
      name: p.name,
      score: p.score,
      board: p.board,
      known: p.known,
      history: p.history, // includes greens / yellows — private to the guesser
      canAct: room.state === 'playing' && room.currentId === p.id && !p.left
    }
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', playerState(room, p));
  }
}

function lobbyList() {
  return [...rooms.values()]
    .filter(r => r.state === 'lobby' && r.players.length < CONFIG.MAX_PLAYERS)
    .map(r => ({ code: r.code, players: r.players.length, max: CONFIG.MAX_PLAYERS }));
}

function broadcastLobbies() {
  io.to('lobby').emit('lobbies', lobbyList());
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  for (const t of room.grace.values()) clearTimeout(t);
  rooms.delete(room.code);
  broadcastLobbies();
}

/* ---------- turn engine (round-robin) ---------- */

function startTurn(room) {
  clearTimeout(room.timer);
  if (room.state !== 'playing') return;
  if (room.order.length <= 1) {
    endGame(room, 'not-enough');
    return;
  }
  room.turnSeq++;
  room.pointer = Math.max(0, Math.min(room.pointer, room.order.length - 1));
  room.currentId = room.order[room.pointer];
  const current = room.players.find(p => p.id === room.currentId);
  if (current) current.board = Array(CONFIG.LENGTH).fill(null);
  room.deadline = Date.now() + CONFIG.TURN_MS;
  const seq = room.turnSeq;
  room.timer = setTimeout(() => onTimeout(room, seq), CONFIG.TURN_MS);
  emitRoom(room);
}

function nextTurn(room) {
  if (room.state !== 'playing') return;
  const len = room.order.length;
  if (len <= 1) {
    endGame(room, 'not-enough');
    return;
  }
  room.pointer = (room.pointer + 1) % len;
  startTurn(room);
}

function peekNext(room) {
  const len = room.order.length;
  if (len <= 1) return null;
  return { id: room.order[(room.pointer + 1) % len] };
}

function onTimeout(room, seq) {
  if (room.state !== 'playing' || room.turnSeq !== seq) return;
  const p = room.players.find(x => x.id === room.currentId);
  if (!p) return;

  p.skips++;
  room.log.push({ playerId: p.id, name: p.name, skipped: true });
  p.history.push({ skipped: true });
  p.board = Array(CONFIG.LENGTH).fill(null);

  if (p.skips >= CONFIG.SKIPS_TO_KICK) {
    const sockId = p.socketId;
    if (sockId) {
      const s = io.sockets.sockets.get(sockId);
      if (s) {
        s.leave(room.code);
        s.data.roomCode = null;
        s.data.playerId = null;
        s.join('lobby');
      }
      io.to(sockId).emit('kicked');
      io.to(sockId).emit('state', null);
    }
    p.socketId = null;
    removeFromGame(room, p.id);
  } else {
    nextTurn(room);
  }
}

/* ---------- game flow ---------- */

function startGame(room) {
  if (room.state === 'playing') return { ok: false, error: 'Game already in progress' };
  if (room.state !== 'lobby' && room.state !== 'ended') {
    return { ok: false, error: 'Cannot start now' };
  }

  room.players = room.players.filter(p => !p.left);
  const active = room.players.filter(p => p.connected);
  if (active.length < 2) return { ok: false, error: 'Need 2 players' };

  for (const p of room.players) {
    p.score = 0;
    p.board = Array(CONFIG.LENGTH).fill(null);
    p.known = [];
    p.history = [];
    p.skips = 0;
  }
  room.secret = makeSecret();
  room.claimed = new Map();
  room.log = [];
  room.rematchVotes = new Set();
  room.state = 'playing';
  room.endReason = null;
  room.winnerIds = [];

  const ids = active.map(p => p.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  room.order = ids;
  room.pointer = 0;
  startTurn(room);
  broadcastLobbies();
  return { ok: true };
}

function handleSubmit(room, player, board) {
  if (room.state !== 'playing') return { ok: false, error: 'Game is not running' };
  if (room.currentId !== player.id) return { ok: false, error: 'Not your turn' };
  if (!Array.isArray(board) || board.length !== CONFIG.LENGTH) {
    return { ok: false, error: 'Need 5 dots' };
  }
  if (board.some(c => !Number.isInteger(c) || c < 0 || c >= CONFIG.COLORS)) {
    return { ok: false, error: 'Need 5 dots' };
  }
  if (new Set(board).size !== CONFIG.LENGTH) {
    return { ok: false, error: 'All 5 dots must be different colors' };
  }

  // every sequence in the public log is known wrong — retrying one is a wasted turn
  const key = seqKey(board);
  if (room.log.some(e => e.sequence && seqKey(e.sequence) === key)) {
    return { ok: false, error: 'That exact order was already tried' };
  }

  player.board = board.slice();
  player.skips = 0;

  // greens: exact color + position. yellows: color present, wrong position.
  const greenPos = [];
  const yellowPos = [];
  const secretLeft = [];
  for (let i = 0; i < CONFIG.LENGTH; i++) {
    if (board[i] === room.secret[i]) greenPos.push(i);
    else secretLeft.push(room.secret[i]);
  }
  for (let i = 0; i < CONFIG.LENGTH; i++) {
    if (board[i] === room.secret[i]) continue;
    const idx = secretLeft.indexOf(board[i]);
    if (idx !== -1) {
      yellowPos.push(i);
      secretLeft.splice(idx, 1);
    }
  }
  const greens = greenPos.length;
  const yellows = yellowPos.length;

  // claim points: first player to put a dot exactly right takes the pool entry
  let points = 0;
  for (const i of greenPos) {
    if (!room.claimed.has(i)) {
      room.claimed.set(i, player.id);
      points += CONFIG.DOT_POINTS;
    }
    if (!player.known.some(k => k.pos === i && k.color === board[i])) {
      player.known.push({ pos: i, color: board[i] });
    }
  }

  const solved = greens === CONFIG.LENGTH;
  const bonus = solved ? CONFIG.SOLVE_BONUS : 0;
  player.score += points + bonus;

  player.history.push({
    sequence: board.slice(),
    greens,
    yellows,
    greenPos,
    yellowPos,
    points: points + bonus
  });

  room.log.push({ playerId: player.id, name: player.name, sequence: board.slice() });

  player.board = Array(CONFIG.LENGTH).fill(null);

  clearTimeout(room.timer);

  if (solved) endGame(room, 'solved', player.id);
  else nextTurn(room);

  return { ok: true, greens, yellows, greenPos, yellowPos, points: points + bonus, solved };
}

function computeWinners(room, solverId) {
  const max = Math.max(...room.players.map(p => p.score));
  const top = room.players.filter(p => p.score === max).map(p => p.id);
  if (top.length === 1) return top;
  if (solverId && top.includes(solverId)) return [solverId];
  return top;
}

function endGame(room, reason, solverId = null) {
  if (room.state === 'ended') return;
  clearTimeout(room.timer);
  room.state = 'ended';
  room.endReason = reason;
  room.deadline = null;
  room.currentId = null;
  room.winnerIds = computeWinners(room, solverId);
  room.rematchVotes = new Set();
  emitRoom(room);
  broadcastLobbies();
}

function removeFromGame(room, playerId) {
  const p = room.players.find(x => x.id === playerId);
  if (!p || p.left) return;
  p.left = true;
  p.connected = false;
  room.rematchVotes.delete(playerId);

  const gt = room.grace.get(playerId);
  if (gt) {
    clearTimeout(gt);
    room.grace.delete(playerId);
  }

  if (room.players.every(x => x.left)) {
    deleteRoom(room);
    return;
  }

  if (room.state !== 'playing') {
    emitRoom(room);
    broadcastLobbies();
    return;
  }

  const wasCurrent = room.currentId === playerId;
  const nxt = wasCurrent ? peekNext(room) : null;
  room.order = room.order.filter(id => id !== playerId);

  if (room.order.length <= 1) {
    endGame(room, 'not-enough');
    return;
  }

  if (wasCurrent && nxt && room.order.includes(nxt.id)) {
    room.pointer = room.order.indexOf(nxt.id);
    startTurn(room);
  } else {
    room.pointer = Math.max(0, room.order.indexOf(room.currentId));
    emitRoom(room);
  }
  broadcastLobbies();
}

/* ---------- sockets ---------- */

function attach(socket, room, player) {
  socket.leave('lobby');
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  player.socketId = socket.id;
  player.connected = true;

  const gt = room.grace.get(player.id);
  if (gt) {
    clearTimeout(gt);
    room.grace.delete(player.id);
  }

  emitRoom(room);
  broadcastLobbies();
}

app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

io.on('connection', socket => {
  socket.join('lobby');
  socket.data.roomCode = null;
  socket.data.playerId = null;
  socket.emit('lobbies', lobbyList());

  socket.on('lobbies:list', () => socket.emit('lobbies', lobbyList()));

  socket.on('room:create', (payload, ack) => {
    const p = newPlayer(payload && payload.name, payload && payload.token);
    const room = newRoom();
    room.players.push(p);
    rooms.set(room.code, room);
    attach(socket, room, p);
    ack && ack({ ok: true, code: room.code, token: p.token });
  });

  socket.on('room:join', (payload, ack) => {
    const code = String((payload && payload.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'No room with that code' });
    if (room.state !== 'lobby') return ack && ack({ ok: false, error: 'That game is already in progress' });
    if (room.players.length >= CONFIG.MAX_PLAYERS) return ack && ack({ ok: false, error: 'That room is full' });
    if (nameTaken(room, payload && payload.name)) {
      return ack && ack({ ok: false, error: 'That name is already taken in this room' });
    }

    const p = newPlayer(payload.name, payload.token);
    room.players.push(p);
    attach(socket, room, p);
    ack && ack({ ok: true, code: room.code, token: p.token });
  });

  socket.on('room:resume', (payload, ack) => {
    const token = payload && payload.token;
    if (!token) return ack && ack({ ok: false });
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.token === token);
      if (p) {
        attach(socket, room, p);
        return ack && ack({ ok: true, code: room.code, token });
      }
    }
    ack && ack({ ok: false });
  });

  socket.on('game:start', (_, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'No room' });
    const isMember = room.players.some(p => p.id === socket.data.playerId);
    if (!isMember) return ack && ack({ ok: false, error: 'Not in this room' });
    const res = startGame(room);
    ack && ack(res);
  });

  socket.on('game:rematch', (_, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'No room' });
    const p = room.players.find(x => x.id === socket.data.playerId);
    if (!p) return ack && ack({ ok: false, error: 'Not in this room' });
    if (room.state !== 'ended') return ack && ack({ ok: false, error: 'Game is not over' });
    if (p.left) return ack && ack({ ok: false, error: 'You have left the room' });

    room.rematchVotes.add(p.id);

    const needed = room.players.filter(x => !x.left);
    const allVoted = needed.length >= 2 && needed.every(x => room.rematchVotes.has(x.id));

    if (allVoted) {
      const res = startGame(room);
      if (!res.ok) {
        room.rematchVotes.delete(p.id);
        emitRoom(room);
      }
      return ack && ack(res);
    }

    emitRoom(room);
    ack && ack({ ok: true, waiting: true });
  });

  socket.on('turn:update', payload => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing') return;
    const p = room.players.find(x => x.id === socket.data.playerId);
    if (!p || room.currentId !== p.id) return;
    const b = payload && payload.board;
    if (!Array.isArray(b) || b.length !== CONFIG.LENGTH) return;
    if (b.some(c => c !== null && (!Number.isInteger(c) || c < 0 || c >= CONFIG.COLORS))) return;
    p.board = b.slice();
  });

  socket.on('turn:submit', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack && ack({ ok: false, error: 'No room' });
    const p = room.players.find(x => x.id === socket.data.playerId);
    if (!p) return ack && ack({ ok: false, error: 'Not in this room' });
    const res = handleSubmit(room, p, payload && payload.board);
    ack && ack(res);
  });

  socket.on('room:leave', () => {
    const room = rooms.get(socket.data.roomCode);
    const pid = socket.data.playerId;
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.leave(room ? room.code : '');
    socket.join('lobby');
    socket.emit('state', null);

    if (!room) {
      socket.emit('lobbies', lobbyList());
      return;
    }

    const p = room.players.find(x => x.id === pid);
    if (!p) {
      socket.emit('lobbies', lobbyList());
      return;
    }

    p.socketId = null;
    p.connected = false;

    if (room.state === 'lobby') {
      room.players = room.players.filter(x => x.id !== p.id);
      if (room.players.length === 0) deleteRoom(room);
      else {
        emitRoom(room);
        broadcastLobbies();
      }
    } else {
      removeFromGame(room, p.id);
    }

    socket.emit('lobbies', lobbyList());
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.find(x => x.id === socket.data.playerId);
    if (!p) return;

    if (room.state === 'lobby') {
      room.players = room.players.filter(x => x.id !== p.id);
      if (room.players.length === 0) deleteRoom(room);
      else {
        emitRoom(room);
        broadcastLobbies();
      }
      return;
    }

    p.connected = false;
    const t = setTimeout(() => {
      const still = room.players.find(x => x.id === p.id);
      if (still && !still.connected) removeFromGame(room, p.id);
    }, CONFIG.GRACE_MS);
    room.grace.set(p.id, t);
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dot Party listening on http://localhost:${PORT}`));
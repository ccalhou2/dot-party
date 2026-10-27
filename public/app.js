const socket = io();
const PALETTE = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];
const LENGTH = 5;

const $ = s => document.querySelector(s);

let room = null;
let board = Array(LENGTH).fill(null);
let selected = null;
let offset = 0; // server clock - client clock
let token = localStorage.getItem('dc_token') || null;

/* ---------- boot ---------- */

const nameInput = $('#name');
nameInput.value = localStorage.getItem('dc_name') || '';
nameInput.addEventListener('input', () => localStorage.setItem('dc_name', nameInput.value));

if (token) {
  socket.emit('room:resume', { token }, res => {
    if (!res || !res.ok) token = null;
  });
}

socket.on('connect', () => {
  if (!room) socket.emit('lobbies:list');
});

/* ---------- helpers ---------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function shakeSubmit() {
  const b = $('#submit');
  b.classList.remove('shake');
  void b.offsetWidth;
  b.classList.add('shake');
}

// mini dot strip. greenPos -> bold green ring, yellowPos -> bold yellow ring.
function miniDots(seq, greenPos = [], yellowPos = []) {
  const wrap = document.createElement('div');
  wrap.className = 'mini';
  seq.forEach((c, i) => {
    const d = document.createElement('i');
    d.style.background = PALETTE[c];
    d.className = greenPos.includes(i) ? 'g' : yellowPos.includes(i) ? 'y' : 'n';
    wrap.appendChild(d);
  });
  return wrap;
}

function confirmedColors(history) {
  const set = new Set();
  for (const e of history || []) {
    if (e.skipped) continue;
    (e.greenPos || []).forEach(i => set.add(e.sequence[i]));
    (e.yellowPos || []).forEach(i => set.add(e.sequence[i]));
  }
  return [...set];
}

function colorName(i) {
  return ['Red','Orange','Yellow','Green','Blue','Purple','Pink','Teal'][i] || '?';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------- events ---------- */

socket.on('lobbies', list => {
  if (room) return;
  const box = $('#lobbylist');
  $('#roomcount').textContent = list.length ? `(${list.length})` : '';
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">No open rooms yet — create one.</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'lobbyrow';
    row.innerHTML = `<div><span class="code-sm">${r.code}</span></div>
      <div class="muted small">${r.players}/${r.max}</div>`;
    row.addEventListener('click', () => joinRoom(r.code));
    box.appendChild(row);
  }
});

socket.on('state', s => {
  if (!s) {
    room = null;
    show('home');
    socket.emit('lobbies:list');
    return;
  }
  room = s;
  offset = s.now - Date.now();
  if (s.state === 'playing' && s.you) {
    board = s.you.board.slice();
    if (!s.you.canAct) selected = null;
  }
  render();
});

socket.on('kicked', () => {
  token = null;
  localStorage.removeItem('dc_token');
  room = null;
  toast('You were removed for missing two turns in a row.');
  show('home');
});

$('#create').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return toast('Enter a name first');
  socket.emit('room:create', { name, token }, res => {
    if (!res || !res.ok) return toast((res && res.error) || 'Could not create room');
    token = res.token;
    localStorage.setItem('dc_token', token);
  });
});

$('#join').addEventListener('click', () => joinRoom($('#code').value));

function joinRoom(code) {
  const name = nameInput.value.trim();
  if (!name) return toast('Enter a name first');
  socket.emit('room:join', { code: String(code || '').toUpperCase().trim(), name, token }, res => {
    if (!res || !res.ok) {
      const err = (res && res.error) || 'Could not join';
      toast(err);
      if (/name/i.test(err)) { nameInput.focus(); nameInput.select(); }
      return;
    }
    token = res.token;
    localStorage.setItem('dc_token', token);
  });
}

$('#start').addEventListener('click', () => {
  socket.emit('game:start', {}, res => {
    if (res && !res.ok) toast(res.error);
  });
});

$('#leave1').addEventListener('click', () => socket.emit('room:leave'));
$('#leave2').addEventListener('click', () => socket.emit('room:leave'));
$('#backhome').addEventListener('click', () => socket.emit('room:leave'));
$('#rematch').addEventListener('click', () => {
  socket.emit('game:rematch', {}, res => {
    if (res && !res.ok) toast(res.error);
  });
});

$('#submit').addEventListener('click', () => {
  if (!room || !room.you || !room.you.canAct) return;
  if (board.some(c => c === null)) {
    shakeSubmit();
    return toast('Place all 5 dots first');
  }
  socket.emit('turn:submit', { board }, res => {
    if (!res || !res.ok) {
      shakeSubmit();
      return toast((res && res.error) || 'Could not submit');
    }
    selected = null;
    toast(`${res.greens} right spot${res.greens === 1 ? '' : 's'}, ${res.yellows} right color`);
  });
});

$('#board').addEventListener('click', e => {
  const slot = e.target.closest('.slot');
  if (!slot || !room || !room.you || !room.you.canAct) return;
  const i = Number(slot.dataset.i);
  if (selected === null) {
    selected = i;
  } else if (selected === i) {
    selected = null;
  } else {
    const t = board[selected];
    board[selected] = board[i];
    board[i] = t;
    selected = null;
  }
  pushBoard();
});

$('#palette').addEventListener('click', e => {
  const sw = e.target.closest('.swatch');
  if (!sw || !room || !room.you || !room.you.canAct) return;
  const c = Number(sw.dataset.c);
  if (board.includes(c)) return;

  let target = selected;
  if (target === null) target = board.indexOf(null);
  if (target === -1) {
    toast('Tap a dot first, then a color');
    return;
  }

  board[target] = c;
  selected = null;
  pushBoard();
});

function pushBoard() {
  socket.emit('turn:update', { board: board.slice() });
  renderGame();
}

/* ---------- render ---------- */

function render() {
  if (!room) return show('home');
  if (room.state === 'lobby') { show('lobby'); renderLobby(); }
  else if (room.state === 'playing') { show('game'); renderGame(); }
  else { show('end'); renderEnd(); }
}

function renderLobby() {
  $('#lobbycode').textContent = room.code;

  const box = $('#lobbyplayers');
  box.innerHTML = '';
  for (const p of room.players) {
    const el = document.createElement('div');
    el.className = 'chip' + (p.id === room.you?.id ? ' you' : '');
    el.innerHTML = `<span>${escapeHtml(p.name)}</span>` +
      (p.id === room.you?.id ? '<span class="badge">YOU</span>' : '');
    box.appendChild(el);
  }

  const startBtn = $('#start');
  const enough = room.players.length >= 2;
  startBtn.style.display = 'block';
  startBtn.disabled = !enough;
  startBtn.textContent = enough ? 'Start game' : 'Waiting for player 2…';
  $('#lobbyhint').textContent = enough
    ? 'Either player can start.'
    : 'Share the room code — 2 players needed.';
}

function renderGame() {
  const you = room.you;
  $('#gamecode').textContent = room.code;

  const current = room.players.find(p => p.id === room.currentId);
  const yourTurn = !!(you && you.canAct);
  $('#turnline').textContent = current
    ? (yourTurn ? 'Your turn' : `${current.name}'s turn`)
    : '—';
  $('#turnline').style.color = yourTurn ? 'var(--good)' : 'var(--txt)';

  const sc = $('#scores');
  sc.innerHTML = '';
  for (const p of [...room.players].sort((a, b) => b.score - a.score)) {
    const d = document.createElement('div');
    d.className = 'score' + (p.id === room.currentId ? ' current' : '');
    d.innerHTML = `<span>${escapeHtml(p.name)}${p.left ? ' (out)' : ''}${p.connected ? '' : ' ⚠'}</span>
                   <span class="pts">${p.score}</span>`;
    sc.appendChild(d);
  }

  const bEl = $('#board');
  bEl.innerHTML = '';
  bEl.classList.toggle('locked', !yourTurn);
  for (let i = 0; i < LENGTH; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot' + (board[i] !== null ? ' filled' : '') + (selected === i ? ' sel' : '');
    slot.dataset.i = i;
    if (board[i] !== null) {
      slot.style.background = PALETTE[board[i]];
      const known = (you?.known || []).some(k => k.pos === i && k.color === board[i]);
      if (known) slot.classList.add('known');
    }
    bEl.appendChild(slot);
  }

  const pal = $('#palette');
  pal.innerHTML = '';
  PALETTE.forEach((c, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (board.includes(i) ? ' used' : '');
    sw.style.background = c;
    sw.dataset.c = i;
    pal.appendChild(sw);
  });

  $('#submit').disabled = !yourTurn;
  $('#submit').textContent = yourTurn ? 'Submit guess' : 'Waiting…';

  const known = you?.known || [];
  const present = confirmedColors(you?.history);
  const bits = [];
  if (known.length) bits.push('Exact: ' + known.map(k => `#${k.pos + 1}=${colorName(k.color)}`).join(', '));
  if (present.length) bits.push(`Colors present (${present.length}/5): ` + present.map(colorName).join(', '));
  $('#yourknown').textContent = bits.length ? bits.join(' · ') : 'No confirmed information yet.';

  const h = $('#yourhistory');
  h.innerHTML = '';
  const hist = (you?.history || []).slice().reverse();
  if (!hist.length) h.innerHTML = '<div class="empty">No guesses yet.</div>';
  for (const e of hist) {
    const row = document.createElement('div');
    row.className = 'hrow' + (e.skipped ? ' skip' : '');
    if (e.skipped) {
      row.innerHTML = '<span>SKIPPED</span><span class="meta">no submission</span>';
    } else {
      row.appendChild(miniDots(e.sequence, e.greenPos, e.yellowPos));
      row.insertAdjacentHTML('beforeend',
        `<span class="pips">${e.greens}✓ ${e.yellows}~</span>` +
        `<span class="meta">${e.points ? '+' + e.points : '0'} pts</span>`);
    }
    h.appendChild(row);
  }

  const pl = $('#publiclog');
  pl.innerHTML = '';
  const log = room.log.slice().reverse();
  if (!log.length) pl.innerHTML = '<div class="empty">No submissions yet.</div>';
  for (const e of log) {
    const row = document.createElement('div');
    row.className = 'hrow' + (e.skipped ? ' skip' : '');
    if (e.skipped) {
      row.innerHTML = `<span>${escapeHtml(e.name)}</span><span class="meta">SKIPPED</span>`;
    } else {
      row.innerHTML = `<span>${escapeHtml(e.name)}</span>`;
      row.appendChild(miniDots(e.sequence));
    }
    pl.appendChild(row);
  }

  updateTimer();
}

function renderEnd() {
  const winners = room.players.filter(p => room.winnerIds.includes(p.id));
  $('#endtitle').textContent = winners.length === 1
    ? `${winners[0].name} wins!`
    : `Shared win: ${winners.map(w => w.name).join(' & ')}`;

  const reasons = { solved: 'The code was cracked.', 'not-enough': 'The other player left.' };
  $('#endreason').textContent = reasons[room.endReason] || '';

  const s = $('#secret');
  s.innerHTML = '';
  (room.secret || []).forEach(c => {
    const slot = document.createElement('div');
    slot.className = 'slot filled';
    slot.style.background = PALETTE[c];
    s.appendChild(slot);
  });

  const es = $('#endscores');
  es.innerHTML = '';
  for (const p of [...room.players].sort((a, b) => b.score - a.score)) {
    const d = document.createElement('div');
    d.className = 'score';
    d.innerHTML = `<span>${escapeHtml(p.name)}${p.left ? ' (out)' : ''}</span>
                   <span class="pts">${p.score}</span>`;
    es.appendChild(d);
  }

  const el = $('#endlog');
  el.innerHTML = '';
  for (const e of room.log) {
    const row = document.createElement('div');
    row.className = 'hrow' + (e.skipped ? ' skip' : '');
    if (e.skipped) {
      row.innerHTML = `<span>${escapeHtml(e.name)}</span><span class="meta">SKIPPED</span>`;
    } else {
      row.innerHTML = `<span>${escapeHtml(e.name)}</span>`;
      row.appendChild(miniDots(e.sequence));
    }
    el.appendChild(row);
  }

    const meId = room.you?.id;
  const needed = room.rematchNeeded || 0;
  const votes = (room.rematchVotes || []).length;
  const voted = !!meId && (room.rematchVotes || []).includes(meId);
  const btn = $('#rematch');
  const hint = $('#rematchhint');

  if (needed < 2) {
    btn.disabled = true;
    btn.textContent = 'Opponent left';
    hint.textContent = 'Leave the room to start a new game.';
  } else if (voted) {
    btn.disabled = true;
    btn.textContent = `Waiting for opponent (${votes}/${needed})…`;
    hint.textContent = 'Both players must agree to a rematch.';
  } else {
    btn.disabled = false;
    btn.textContent = votes > 0 ? 'Accept rematch' : 'Rematch';
    hint.textContent = votes > 0
      ? 'Opponent is ready for another round.'
      : 'Both players must agree to a rematch.';
  }
}

setInterval(() => {
  if (room && room.state === 'playing' && room.deadline) updateTimer();
}, 100);

function updateTimer() {
  const fill = $('#timerfill');
  if (!room || !room.deadline) { fill.style.width = '0%'; return; }
  const left = Math.max(0, room.deadline - (Date.now() + offset));
  fill.style.width = Math.max(0, Math.min(100, (left / 30000) * 100)) + '%';
}
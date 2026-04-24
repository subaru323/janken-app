const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const genId = () => Math.random().toString(36).substring(2, 7).toUpperCase();

function judge(choices) {
  const hands = [...new Set(Object.values(choices))];
  if (hands.length !== 2) return { draw: true, winners: [], losers: [] };
  const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  const [a, b] = hands;
  const winHand = beats[a] === b ? a : b;
  const entries = Object.entries(choices);
  return {
    draw: false, winHand,
    winners: entries.filter(([, h]) => h === winHand).map(([id]) => id),
    losers:  entries.filter(([, h]) => h !== winHand).map(([id]) => id),
  };
}

function snap(room) {
  return {
    roomId: room.id, round: room.round, state: room.state, hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, hasChosen: !!p.choice })),
  };
}

const bcast = (id) => { const r = rooms.get(id); if (r) io.to(id).emit('room_update', snap(r)); };

function doResult(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.state = 'result';
  const choices = {};
  room.players.forEach(p => { if (p.choice) choices[p.id] = p.choice; });
  const result = judge(choices);
  result.winners.forEach(id => { const p = room.players.find(q => q.id === id); if (p) p.score++; });
  io.to(roomId).emit('phase_result', { choices, result, snap: snap(room) });
  room.round++;
}

function startRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room._t1); clearTimeout(room._t2);
  room.state = 'countdown';
  room.players.forEach(p => { p.choice = null; });
  io.to(roomId).emit('phase_countdown', { snap: snap(room) });
  room._t1 = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || r.state !== 'countdown') return;
    r.state = 'choosing';
    io.to(roomId).emit('phase_choose', { snap: snap(r) });
    r._t2 = setTimeout(() => {
      const r2 = rooms.get(roomId);
      if (r2 && r2.state === 'choosing') doResult(roomId);
    }, 15000);
  }, 3500);
}

function findRoom(sid) {
  for (const r of rooms.values()) if (r.players.find(p => p.id === sid)) return r;
}

function doLeave(socket) {
  const room = findRoom(socket.id);
  if (!room) return;
  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx < 0) return;
  const name = room.players[idx].name;
  room.players.splice(idx, 1);
  socket.leave(room.id);
  if (room.players.length === 0) { rooms.delete(room.id); return; }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  if (room.players.length < 2 && room.state !== 'lobby') {
    clearTimeout(room._t1); clearTimeout(room._t2);
    room.state = 'lobby';
    room.players.forEach(p => { p.choice = null; });
    io.to(room.id).emit('notice', `${name}が退出。人数不足のためロビーへ戻ります`);
    bcast(room.id);
    return;
  }
  io.to(room.id).emit('notice', `${name}が退出しました`);
  bcast(room.id);
  if (room.state === 'choosing' && room.players.every(p => p.choice)) {
    clearTimeout(room._t2);
    doResult(room.id);
  }
}

io.on('connection', socket => {
  socket.on('create_room', ({ name }) => {
    const id = genId();
    rooms.set(id, { id, players: [{ id: socket.id, name, score: 0, choice: null }], state: 'lobby', round: 1, hostId: socket.id });
    socket.join(id);
    socket.emit('room_created', { roomId: id });
    bcast(id);
  });

  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room) return socket.emit('join_error', 'ルームが見つかりません');
    if (room.state !== 'lobby') return socket.emit('join_error', 'ゲームが進行中です');
    if (room.players.length >= 8) return socket.emit('join_error', '満員です（最大8人）');
    room.players.push({ id: socket.id, name, score: 0, choice: null });
    socket.join(room.id);
    socket.emit('room_joined', { roomId: room.id });
    bcast(room.id);
  });

  socket.on('start_game', () => {
    const room = findRoom(socket.id);
    if (!room || socket.id !== room.hostId || room.state !== 'lobby') return;
    if (room.players.length < 2) return socket.emit('join_error', '2人以上必要です');
    startRound(room.id);
  });

  socket.on('choose', ({ hand }) => {
    const room = findRoom(socket.id);
    if (!room || room.state !== 'choosing') return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p || p.choice) return;
    p.choice = hand;
    bcast(room.id);
    if (room.players.every(p => p.choice)) { clearTimeout(room._t2); doResult(room.id); }
  });

  socket.on('next_round', () => {
    const room = findRoom(socket.id);
    if (!room || socket.id !== room.hostId || room.state !== 'result') return;
    startRound(room.id);
  });

  socket.on('leave_room', () => doLeave(socket));
  socket.on('disconnect', () => doLeave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));

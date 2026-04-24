const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { roomId: { players: [{ id, name, choice }], round, scores } }
const rooms = {};

function generateRoomId() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function judge(a, b) {
  if (a === b) return 'draw';
  if (
    (a === 'rock' && b === 'scissors') ||
    (a === 'scissors' && b === 'paper') ||
    (a === 'paper' && b === 'rock')
  ) return 'win';
  return 'lose';
}

io.on('connection', (socket) => {
  // ルーム作成
  socket.on('create_room', ({ name }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [{ id: socket.id, name, choice: null }],
      round: 1,
      scores: {}
    };
    rooms[roomId].scores[socket.id] = 0;
    socket.join(roomId);
    socket.emit('room_created', { roomId, playerIndex: 0 });
  });

  // ルーム参加
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { message: 'ルームが見つかりません' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'ルームが満員です' });
      return;
    }
    room.players.push({ id: socket.id, name, choice: null });
    room.scores[socket.id] = 0;
    socket.join(roomId);

    const names = room.players.map(p => p.name);
    io.to(roomId).emit('game_start', { names, round: room.round });
    socket.emit('room_joined', { roomId, playerIndex: 1 });
  });

  // 手を選択
  socket.on('choose', ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.choice) return;
    player.choice = choice;

    // 相手に「選択済み」を通知（手は隠す）
    socket.to(roomId).emit('opponent_chose');

    // 両者が選択済みなら勝敗判定
    if (room.players.every(p => p.choice)) {
      const [p0, p1] = room.players;
      const result0 = judge(p0.choice, p1.choice);
      const result1 = result0 === 'draw' ? 'draw' : (result0 === 'win' ? 'lose' : 'win');

      if (result0 === 'win') room.scores[p0.id]++;
      if (result1 === 'win') room.scores[p1.id]++;

      io.to(roomId).emit('round_result', {
        choices: { [p0.id]: p0.choice, [p1.id]: p1.choice },
        results: { [p0.id]: result0, [p1.id]: result1 },
        scores: room.scores,
        round: room.round
      });

      room.round++;
      room.players.forEach(p => { p.choice = null; });
    }
  });

  // 次のラウンドへ
  socket.on('next_round', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('round_start', { round: room.round });
  });

  // 切断処理
  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        socket.to(roomId).emit('opponent_left');
        delete rooms[roomId];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
});

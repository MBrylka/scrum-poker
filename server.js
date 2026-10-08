const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'scrum-poker.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set');
}
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROUND_TIMEOUT_SECONDS = 25;

// Rate limiters
const createRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many rooms created. Please wait.' }
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait.' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many admin requests. Please wait.' }
});

const app = express();
// Trust only the configured number of proxy hops. The default is no proxy.
const trustProxy = Number.parseInt(process.env.TRUST_PROXY || '0', 10);
app.set('trust proxy', Number.isFinite(trustProxy) && trustProxy > 0 ? trustProxy : false);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: true }
});

const roomState = {};

// ===== REST API =====

app.post('/api/rooms', createRoomLimiter, (req, res) => {
  const { name } = req.body;
  const id = crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)').run(id, name || 'Scrum Poker');
  res.json({ id, name: name || 'Scrum Poker' });
});

app.get('/api/rooms/:id', generalApiLimiter, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// Admin endpoints

function requireAdmin(req, res) {
  const pwd = req.headers['x-admin-password'];
  if (!pwd || pwd !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/rooms', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rooms = db.prepare('SELECT id, name, created_at FROM rooms ORDER BY created_at DESC').all();
  res.json(rooms);
});

app.delete('/api/admin/rooms/:id', adminLimiter, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  // kick anyone still in the room via socket
  if (roomState[id]) {
    delete roomState[id];
    io.to(id).emit('room-deleted');
  }
  io.in(id).socketsLeave(id);
  res.json({ success: true });
});

// ===== Socket.io =====

io.on('connection', (socket) => {
  let currentRoom = null;

  // Per-socket rate limiting
  const rateLimitBuckets = {};
  const checkRateLimit = (event, windowMs, max) => {
    const now = Date.now();
    if (!rateLimitBuckets[event]) rateLimitBuckets[event] = [];
    rateLimitBuckets[event] = rateLimitBuckets[event].filter(t => now - t < windowMs);
    if (rateLimitBuckets[event].length >= max) {
      socket.emit('error-msg', `Rate limit exceeded. Please slow down.`);
      return false;
    }
    rateLimitBuckets[event].push(now);
    return true;
  };

  socket.on('join-room', ({ roomId, username, participantId }) => {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      socket.emit('error-msg', 'Room not found');
      return;
    }

    currentRoom = roomId;

    if (!roomState[roomId]) {
      roomState[roomId] = {
        users: {}, votes: {}, revealedVotes: null, revealed: false,
        countdown: null, timeoutTimer: null, timeoutRemaining: null
      };
      roomState[roomId].activities = [];
    }

    const state = roomState[roomId];
    participantId = String(participantId || '');
    if (!participantId) {
      socket.emit('error-msg', 'A participant session is required');
      return;
    }

    const isNewParticipant = !state.users[participantId];
    if (state.revealed && isNewParticipant) {
      state.votes = {};
      state.revealedVotes = null;
      state.revealed = false;
      for (const user of Object.values(state.users)) user.voted = false;
    } else if (state.countdown && isNewParticipant) {
      clearInterval(state.countdown);
      state.countdown = null;
      if (Object.keys(state.votes).length > 0) startRoundTimeout(roomId);
    }

    if (!state.users[participantId]) {
      state.users[participantId] = { username, voted: false, sockets: new Set() };
    }
    const user = state.users[participantId];
    if (user.cleanupTimer) clearTimeout(user.cleanupTimer);
    user.cleanupTimer = null;
    user.username = username;
    user.sockets.add(socket.id);
    socket.participantId = participantId;

    socket.join(roomId);
    io.to(roomId).emit('room-state', serializeState(roomId));
    if (isNewParticipant) addActivity(roomId, 'join', username);
  });

  socket.on('vote', ({ value }) => {
    if (!checkRateLimit('vote', 10000, 20)) return;
    if (!currentRoom) return;
    const state = roomState[currentRoom];
    if (!state || state.revealed) return;

    const participantId = socket.participantId;
    if (!participantId || !state.users[participantId]) return;
    state.votes[participantId] = value;
    state.users[participantId].voted = true;

    if (Object.keys(state.votes).length === 1) startRoundTimeout(currentRoom);

    const userCount = Object.keys(state.users).length;
    const votedCount = Object.keys(state.votes).length;

    io.to(currentRoom).emit('voted', { count: votedCount, total: userCount });
    io.to(currentRoom).emit('room-state', serializeState(currentRoom));

    if (votedCount >= userCount && userCount > 0) {
      startCountdown(currentRoom);
    }
  });

  socket.on('force-reveal', () => {
    if (!checkRateLimit('force-reveal', 30000, 5)) return;
    if (!currentRoom) return;
    const state = roomState[currentRoom];
    if (!state || state.revealed || Object.keys(state.votes).length === 0) return;

    startCountdown(currentRoom);
  });

  socket.on('reset', () => {
    if (!checkRateLimit('reset', 30000, 5)) return;
    if (!currentRoom) return;
    const state = roomState[currentRoom];
    if (!state) return;

    state.votes = {};
    state.revealedVotes = null;
    state.revealed = false;
    if (state.countdown) clearInterval(state.countdown);
    state.countdown = null;
    if (state.timeoutTimer) clearInterval(state.timeoutTimer);
    state.timeoutTimer = null;
    state.timeoutRemaining = null;

    for (const user of Object.values(state.users)) {
      user.voted = false;
    }

    io.to(currentRoom).emit('reset-votes');
    io.to(currentRoom).emit('room-state', serializeState(currentRoom));
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !roomState[currentRoom]) return;

    const state = roomState[currentRoom];
    const participantId = socket.participantId;
    const user = participantId && state.users[participantId];
    if (!user) return;
    user.sockets.delete(socket.id);
    if (user.sockets.size === 0) {
      user.cleanupTimer = setTimeout(() => {
        if (user.sockets.size > 0 || roomState[currentRoom] !== state) return;
        delete state.users[participantId];
        if (!state.revealed) delete state.votes[participantId];
        addActivity(currentRoom, 'leave', user.username);
        if (Object.keys(state.users).length === 0) {
          delete roomState[currentRoom];
        } else {
          io.to(currentRoom).emit('room-state', serializeState(currentRoom));
        }
      }, 5000);
    }

    const userCount = Object.keys(state.users).length;

    if (userCount === 0) {
      delete roomState[currentRoom];
    } else {
      io.to(currentRoom).emit('room-state', serializeState(currentRoom));
    }
  });

});

function startRoundTimeout(roomId) {
  const state = roomState[roomId];
  if (!state || state.timeoutTimer) return;

  let remaining = ROUND_TIMEOUT_SECONDS;
  state.timeoutRemaining = remaining;
  state.timeoutTimer = setInterval(() => {
    if (!roomState[roomId] || state.revealed) {
      clearInterval(state.timeoutTimer);
      state.timeoutTimer = null;
      return;
    }
    remaining--;
    state.timeoutRemaining = remaining;
    io.to(roomId).emit('round-timeout', remaining);
    if (remaining <= 0) {
      clearInterval(state.timeoutTimer);
      state.timeoutTimer = null;
      state.timeoutRemaining = null;
      startCountdown(roomId);
    }
  }, 1000);
}

function addActivity(roomId, type, username) {
  const state = roomState[roomId];
  if (!state) return;
  state.activities.unshift({ type, username, at: new Date().toISOString() });
  state.activities = state.activities.slice(0, 12);
  io.to(roomId).emit('room-activity', state.activities[0]);
}

function startCountdown(roomId) {
  const state = roomState[roomId];
  let count = 3;

  if (state.countdown) return;

  state.countdown = setInterval(() => {
    io.to(roomId).emit('countdown', count);
    if (count <= 0) {
      clearInterval(state.countdown);
      state.countdown = null;
      if (state.timeoutTimer) clearInterval(state.timeoutTimer);
      state.timeoutTimer = null;
      state.timeoutRemaining = null;
      state.revealed = true;
      state.revealedVotes = { ...state.votes };
      io.to(roomId).emit('reveal', { ...state.revealedVotes });
      io.to(roomId).emit('room-state', serializeState(roomId));
    }
    count--;
  }, 1000);
}

function serializeState(roomId) {
  const state = roomState[roomId];
  if (!state) return null;

  return {
    users: Object.entries(state.users).map(([id, u]) => ({
      id,
      username: u.username,
      voted: u.voted,
      connected: u.sockets.size > 0
    })),
    revealed: state.revealed,
    votes: state.revealed ? { ...state.revealedVotes } : {},
    activities: state.activities || [],
    timeoutRemaining: state.timeoutRemaining,
    totalUsers: Object.keys(state.users).length,
    votedCount: Object.keys(state.votes).length
  };
}

server.listen(PORT, () => {
  console.log(`Scrum Poker server running on port ${PORT}`);
});

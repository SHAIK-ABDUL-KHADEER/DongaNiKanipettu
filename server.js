const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load words
const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf-8'));
const ALL_WORDS = wordsData.words;

// In-memory room storage
const rooms = {};

// Clean up old rooms every 30 minutes (rooms older than 6 hours)
setInterval(() => {
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  for (const id in rooms) {
    if (now - rooms[id].createdAt > SIX_HOURS) {
      delete rooms[id];
    }
  }
}, 30 * 60 * 1000);

// ─── API ROUTES ──────────────────────────────────────────────

// Create a new room
app.post('/api/create-room', (req, res) => {
  const { players, imposterCount } = req.body;

  if (!players || !Array.isArray(players) || players.length < 3) {
    return res.status(400).json({ error: 'At least 3 players required' });
  }

  const maxImposters = Math.floor(players.length / 4) || 1;
  const imposters = Math.min(imposterCount || 1, maxImposters);

  const roomId = uuidv4().slice(0, 8);

  rooms[roomId] = {
    id: roomId,
    players: players,
    creator: players[0],
    imposterCount: imposters,
    currentRound: 0,
    currentWord: null,
    imposters: [],
    claimed: {},
    wordHistory: [],
    createdAt: Date.now()
  };

  res.json({ roomId });
});

// Get room info
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    id: room.id,
    players: room.players,
    creator: room.creator,
    imposterCount: room.imposterCount,
    currentRound: room.currentRound,
    hasWord: !!room.currentWord,
    claimed: room.claimed
  });
});

// Player claims their name
app.post('/api/room/:roomId/claim/:playerName', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const playerName = decodeURIComponent(req.params.playerName);

  if (!room.players.includes(playerName)) {
    return res.status(400).json({ error: 'Player not in this game' });
  }

  // Generate a unique token for this player
  const token = uuidv4().slice(0, 12);
  room.claimed[playerName] = token;

  res.json({ success: true, token });
});

// Creator triggers new word
app.post('/api/room/:roomId/new-word', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const { playerName } = req.body;
  if (playerName !== room.creator) {
    return res.status(403).json({ error: 'Only the game creator can start a new round' });
  }

  // Pick a random word that hasn't been used recently
  let availableWords = ALL_WORDS.filter(w => !room.wordHistory.includes(w));
  if (availableWords.length === 0) {
    // Reset history if all words used
    room.wordHistory = [];
    availableWords = [...ALL_WORDS];
  }

  const word = availableWords[Math.floor(Math.random() * availableWords.length)];
  room.currentWord = word;
  room.wordHistory.push(word);
  room.currentRound++;

  // Randomly select imposters
  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  room.imposters = shuffled.slice(0, room.imposterCount);

  // Reset who has seen the word this round
  room.seenThisRound = {};

  res.json({ success: true, round: room.currentRound });
});

// Player gets their word
app.get('/api/room/:roomId/player/:playerName', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const playerName = decodeURIComponent(req.params.playerName);

  if (!room.players.includes(playerName)) {
    return res.status(400).json({ error: 'Player not in this game' });
  }

  if (!room.currentWord) {
    return res.json({ waiting: true, round: 0 });
  }

  const isImposter = room.imposters.includes(playerName);

  res.json({
    round: room.currentRound,
    isImposter: isImposter,
    word: isImposter ? null : room.currentWord
  });
});

// Serve all HTML routes through index for SPA-like routing
app.get('/room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/share', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', uptime: process.uptime() });
});

// ─── SELF-PING CRON (keeps Render free tier awake) ───────────
app.listen(PORT, () => {
  console.log(`🎮 Donga Ni Kanipettu server running on port ${PORT}`);

  // Self-ping every 14 minutes to prevent Render from sleeping
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    const INTERVAL = 14 * 60 * 1000; // 14 minutes
    setInterval(() => {
      const http = require(RENDER_URL.startsWith('https') ? 'https' : 'http');
      http.get(`${RENDER_URL}/api/health`, (res) => {
        console.log(`[CRON] Self-ping: ${res.statusCode}`);
      }).on('error', (err) => {
        console.log(`[CRON] Self-ping failed: ${err.message}`);
      });
    }, INTERVAL);
    console.log(`🔄 Self-ping cron active (every 14 min) → ${RENDER_URL}`);
  }
});

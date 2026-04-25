// server.js - Node.js + Socket.io server za Preferans
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage (za demo - zameni sa bazom za produkciju)
const users = new Map();      // socketId -> userData
const games = new Map();      // gameId -> gameData
const waitingPlayers = [];    // Queue for players waiting for game

// ===== GAME LOGIC HELPERS =====
function createDeck() {
  const suits = ['S','H','D','C'];
  const values = ['7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const v of values) deck.push({suit:s, value:v});
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function initGame(gameId, settings) {
  const deck = createDeck();
  const hands = [deck.slice(0,10), deck.slice(10,20), deck.slice(20,30)];
  const talon = deck.slice(30,32);
  
  return {
    id: gameId,
    settings,
    players: [],
    spectators: [],
    hands,
    talon,
    phase: 'bidding',
    contract: null,
    currentBidder: 0,
    highestBid: null,
    bidHistory: [],
    currentTrick: 0,
    trickCards: [null,null,null],
    trickStarter: 0,
    currentTurn: 0,
    scores: {},
    tricks: []
  };
}

// ===== SOCKET.IO HANDLERS =====
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // User joins with username
  socket.on('user:join', (userData) => {
    users.set(socket.id, { ...userData, socketId: socket.id });
    socket.broadcast.emit('user:online', { username: userData.username, displayName: userData.displayName });
    socket.emit('user:joined', { success: true, username: userData.username });
    updatePlayerList();
  });

  // Create new game
  socket.on('game:create', (settings) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const gameId = 'game_' + Date.now() + '_' + Math.random().toString(36).substr(2,6);
    const game = initGame(gameId, settings);
    game.host = user.username;
    game.players.push({ username: user.username, displayName: user.displayName, socketId: socket.id, ready: true });
    game.scores[user.username] = 0;
    
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('game:created', { gameId, game });
    broadcastGameList();
  });

  // Join existing game
  socket.on('game:join', ({ gameId }) => {
    const user = users.get(socket.id);
    const game = games.get(gameId);
    if (!user || !game) return socket.emit('error', { message: 'Game not found' });
    if (game.players.length >= 3) return socket.emit('error', { message: 'Game is full' });
    
    game.players.push({ username: user.username, displayName: user.displayName, socketId: socket.id, ready: true });
    game.scores[user.username] = 0;
    socket.join(gameId);
    
    io.to(gameId).emit('game:update', { game });
    if (game.players.length === 3) {
      // Start game when 3 players joined
      setTimeout(() => startBidding(gameId), 2000);
    }
  });

  // Make a bid
  socket.on('game:bid', ({ gameId, level, suit }) => {
    const game = games.get(gameId);
    const user = users.get(socket.id);
    if (!game || !user) return;
    
    const playerIdx = game.players.findIndex(p => p.username === user.username);
    if (playerIdx !== game.currentBidder) return;
    
    // Process bid
    if (level && suit) {
      const bidValue = getBidValue(level, suit);
      if (!game.highestBid || bidValue > getBidValue(game.highestBid.level, game.highestBid.suit)) {
        game.highestBid = { level, suit, player: playerIdx };
      }
    }
    
    game.bidHistory.push({ player: playerIdx, level, suit });
    game.currentBidder = (game.currentBidder + 1) % 3;
    
    // Check if bidding is complete
    const consecutivePasses = game.bidHistory.slice().reverse().findIndex(b => b.level) === -1 ? 
      game.bidHistory.filter(b => !b.level).length : 
      game.bidHistory.slice().reverse().findIndex(b => b.level);
    
    if (consecutivePasses >= 2 && game.highestBid) {
      endBidding(gameId);
    } else {
      io.to(gameId).emit('game:update', { game });
      // Trigger next bot bid if needed
      setTimeout(() => processBotBid(gameId), 800);
    }
  });

  // Play a card
  socket.on('game:play', ({ gameId, suit, value }) => {
    const game = games.get(gameId);
    const user = users.get(socket.id);
    if (!game || !user || game.phase !== 'playing') return;
    
    const playerIdx = game.players.findIndex(p => p.username === user.username);
    if (playerIdx !== game.currentTurn) return;
    
    const hand = game.hands[playerIdx];
    const cardIdx = hand.findIndex(c => c.suit === suit && c.value === value);
    if (cardIdx < 0) return;
    
    // Follow suit rule
    if (game.trickCards[game.trickStarter]) {
      const ledSuit = game.trickCards[game.trickStarter].suit;
      const hasLedSuit = hand.some(c => c.suit === ledSuit);
      if (hasLedSuit && suit !== ledSuit) {
        return socket.emit('error', { message: 'Morate da pratite boju!' });
      }
    }
    
    // Play card
    const card = hand.splice(cardIdx, 1)[0];
    game.trickCards[playerIdx] = card;
    game.currentTurn = (game.currentTurn + 1) % 3;
    
    io.to(gameId).emit('game:update', { game });
    
    // Check if trick is complete
    if (game.trickCards.every(c => c !== null)) {
      setTimeout(() => resolveTrick(gameId), 600);
    } else {
      setTimeout(() => processBotPlay(gameId), 700);
    }
  });

  // Chat
  socket.on('chat:send', ({ gameId, text }) => {
    const user = users.get(socket.id);
    if (!user) return;
    io.to(gameId).emit('chat:message', {
      username: user.username,
      displayName: user.displayName,
      text,
      time: Date.now()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      // Remove from any game
      for (const [gameId, game] of games) {
        const idx = game.players.findIndex(p => p.socketId === socket.id);
        if (idx >= 0) {
          game.players.splice(idx, 1);
          io.to(gameId).emit('game:update', { game });
          if (game.players.length === 0) games.delete(gameId);
        }
      }
      users.delete(socket.id);
      socket.broadcast.emit('user:offline', { username: user.username });
      updatePlayerList();
    }
  });
});

// ===== GAME LOGIC FUNCTIONS =====
function getBidValue(level, suit) {
  const order = {'S':1,'C':2,'D':3,'H':4,'NT':5};
  return suit === 'NT' ? level * 10 + 5 : level * 10 + order[suit];
}

function startBidding(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  game.phase = 'bidding';
  game.currentBidder = 0;
  game.bidHistory = [];
  game.highestBid = null;
  
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => processBotBid(gameId), 1000);
}

function endBidding(gameId) {
  const game = games.get(gameId);
  if (!game || !game.highestBid) {
    // All passed - new hand
    resetHand(gameId);
    return;
  }
  
  game.contract = game.highestBid;
  game.phase = 'playing';
  
  // Give talon to bidder
  const bidder = game.contract.player;
  game.hands[bidder].push(...game.talon);
  game.talon = [];
  sortHand(game.hands[bidder]);
  
  game.currentTurn = bidder;
  game.trickStarter = bidder;
  
  io.to(gameId).emit('game:update', { game });
}

function resolveTrick(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  const ledSuit = game.trickCards[game.trickStarter].suit;
  const contractSuit = game.contract.suit;
  let winner = game.trickStarter;
  let winningCard = game.trickCards[game.trickStarter];
  
  const valOrder = {'7':0,'8':1,'9':2,'10':3,'J':4,'Q':5,'K':6,'A':7};
  
  for (let i = 0; i < 3; i++) {
    if (i === game.trickStarter) continue;
    const c = game.trickCards[i];
    if (!c) continue;
    
    if (contractSuit !== 'NT' && c.suit === contractSuit) {
      if (winningCard.suit !== contractSuit) { winner = i; winningCard = c; }
      else if (valOrder[c.value] > valOrder[winningCard.value]) { winner = i; winningCard = c; }
    } else if (c.suit === ledSuit && winningCard.suit !== contractSuit) {
      if (valOrder[c.value] > valOrder[winningCard.value]) { winner = i; winningCard = c; }
    }
  }
  
  game.tricks.push({ cards: [...game.trickCards], winner });
  game.currentTrick++;
  game.trickCards = [null, null, null];
  game.trickStarter = winner;
  game.currentTurn = winner;
  
  // Check if hand is done
  if (game.hands[0].length === 0 && game.hands[1].length === 0 && game.hands[2].length === 0) {
    setTimeout(() => endHand(gameId), 1000);
  } else {
    io.to(gameId).emit('game:update', { game });
    setTimeout(() => processBotPlay(gameId), 800);
  }
}

function endHand(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  // Calculate scores (simplified)
  const points = [0, 0, 0];
  for (const t of game.tricks) {
    for (const c of t.cards) {
      const val = c.value === 'A' ? 11 : c.value === '10' ? 10 : c.value === 'K' ? 4 : c.value === 'Q' ? 3 : c.value === 'J' ? 2 : 0;
      points[t.winner] += val;
    }
  }
  
  // Update scores
  const sorted = points.map((p, i) => ({i, p})).sort((a,b) => b.p - a.p);
  const gamePts = [0, 0, 0];
  gamePts[sorted[0].i] = 3; gamePts[sorted[1].i] = 1;
  
  for (let i = 0; i < 3; i++) {
    const username = game.players[i].username;
    game.scores[username] = (game.scores[username] || 0) + gamePts[i];
  }
  
  io.to(gameId).emit('game:update', { game });
  
  // Next hand or end game
  setTimeout(() => {
    if (game.currentTrick >= game.settings.numHands * 10) {
      // Game over
      io.to(gameId).emit('game:ended', { scores: game.scores });
      games.delete(gameId);
    } else {
      resetHand(gameId);
    }
  }, 3000);
}

function resetHand(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  const deck = createDeck();
  game.hands = [deck.slice(0,10), deck.slice(10,20), deck.slice(20,30)];
  game.talon = deck.slice(30,32);
  for (let i = 0; i < 3; i++) sortHand(game.hands[i]);
  
  game.phase = 'bidding';
  game.currentBidder = (game.currentBidder + 1) % 3;
  game.bidHistory = [];
  game.highestBid = null;
  game.currentTrick = 0;
  game.tricks = [];
  game.trickCards = [null, null, null];
  
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => startBidding(gameId), 2000);
}

function sortHand(hand) {
  const suitOrd = {'S':0,'C':1,'D':2,'H':3};
  const valOrd = {'7':0,'8':1,'9':2,'10':3,'J':4,'Q':5,'K':6,'A':7};
  hand.sort((a,b) => {
    if (suitOrd[a.suit] !== suitOrd[b.suit]) return suitOrd[a.suit] - suitOrd[b.suit];
    return valOrd[a.value] - valOrd[b.value];
  });
}

// ===== BOT LOGIC =====
function processBotBid(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== 'bidding') return;
  
  const currentPlayer = game.players[game.currentBidder];
  if (!currentPlayer) return;
  
  // Check if it's a human player (has socket connected)
  const isHuman = [...users.values()].some(u => u.socketId === currentPlayer.socketId);
  if (isHuman) return; // Wait for human
  
  // Bot logic: simple random bid
  setTimeout(() => {
    const g = games.get(gameId);
    if (!g || g.phase !== 'bidding') return;
    
    if (Math.random() > 0.3 && (!g.highestBid || Math.random() > 0.5)) {
      const level = Math.floor(Math.random() * 2) + 1;
      const suits = ['S','C','D','H','NT'];
      const suit = suits[Math.floor(Math.random() * suits.length)];
      io.to(gameId).emit('game:bid', { gameId, level, suit });
      // Simulate server-side bid processing
      handleBotBid(gameId, game.currentBidder, level, suit);
    } else {
      handleBotBid(gameId, game.currentBidder, null, null); // Pass
    }
  }, 1000 + Math.random() * 1500);
}

function handleBotBid(gameId, playerIdx, level, suit) {
  const game = games.get(gameId);
  if (!game) return;
  
  if (level && suit) {
    const bidValue = getBidValue(level, suit);
    if (!game.highestBid || bidValue > getBidValue(game.highestBid.level, game.highestBid.suit)) {
      game.highestBid = { level, suit, player: playerIdx };
    }
  }
  game.bidHistory.push({ player: playerIdx, level, suit });
  game.currentBidder = (game.currentBidder + 1) % 3;
  
  const consecutivePasses = game.bidHistory.slice().reverse().findIndex(b => b.level);
  if (consecutivePasses >= 2 && game.highestBid) {
    endBidding(gameId);
  } else {
    io.to(gameId).emit('game:update', { game });
    setTimeout(() => processBotBid(gameId), 800);
  }
}

function processBotPlay(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== 'playing') return;
  
  const currentPlayer = game.players[game.currentTurn];
  if (!currentPlayer) return;
  
  const isHuman = [...users.values()].some(u => u.socketId === currentPlayer.socketId);
  if (isHuman) return;
  
  // Bot plays random valid card
  setTimeout(() => {
    const g = games.get(gameId);
    if (!g || g.phase !== 'playing') return;
    
    const hand = g.hands[g.currentTurn];
    if (!hand || hand.length === 0) return;
    
    let validCards = [...hand];
    
    // Follow suit if possible
    if (g.trickCards[g.trickStarter]) {
      const ledSuit = g.trickCards[g.trickStarter].suit;
      const follow = hand.filter(c => c.suit === ledSuit);
      if (follow.length > 0) validCards = follow;
    }
    
    const card = validCards[Math.floor(Math.random() * validCards.length)];
    // Simulate play
    handleBotPlay(gameId, g.currentTurn, card.suit, card.value);
  }, 800 + Math.random() * 1000);
}

function handleBotPlay(gameId, playerIdx, suit, value) {
  const game = games.get(gameId);
  if (!game) return;
  
  const hand = game.hands[playerIdx];
  const cardIdx = hand.findIndex(c => c.suit === suit && c.value === value);
  if (cardIdx < 0) return;
  
  const card = hand.splice(cardIdx, 1)[0];
  game.trickCards[playerIdx] = card;
  game.currentTurn = (game.currentTurn + 1) % 3;
  
  io.to(gameId).emit('game:update', { game });
  
  if (game.trickCards.every(c => c !== null)) {
    setTimeout(() => resolveTrick(gameId), 600);
  } else {
    setTimeout(() => processBotPlay(gameId), 700);
  }
}

// ===== BROADCAST HELPERS =====
function updatePlayerList() {
  const players = [...users.values()].map(u => ({
    username: u.username,
    displayName: u.displayName,
    online: true
  }));
  io.emit('players:list', players);
}

function broadcastGameList() {
  const gameList = [...games.values()].map(g => ({
    id: g.id,
    name: g.settings.name || 'Partija',
    players: g.players.map(p => p.displayName),
    status: g.phase,
    settings: g.settings
  }));
  io.emit('games:list', gameList);
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Preferans server running on port ${PORT}`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
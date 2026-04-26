const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(__dirname));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const users = new Map();
const usersDB = new Map();
const games = new Map();

// ===== GAME HELPERS =====
function createDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  const values = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) for (const v of values) deck.push({ suit: s, value: v });
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  const suitOrd = { 'S': 0, 'C': 1, 'D': 2, 'H': 3 };
  const valOrd = { '7': 0, '8': 1, '9': 2, '10': 3, 'J': 4, 'Q': 5, 'K': 6, 'A': 7 };
  hand.sort((a, b) => {
    if (suitOrd[a.suit] !== suitOrd[b.suit]) return suitOrd[a.suit] - suitOrd[b.suit];
    return valOrd[a.value] - valOrd[b.value];
  });
}

function getBidValue(level, suit) {
  const order = { 'S': 1, 'C': 2, 'D': 3, 'H': 4, 'NT': 5 };
  return suit === 'NT' ? level * 10 + 5 : level * 10 + order[suit];
}

function calculateContractPoints(level, suit, isIgra) {
  let base = level * 2;
  if (isIgra) base += 2;
  return base;
}

function initGame(gameId, settings) {
  const deck = createDeck();
  const talon = deck.slice(0, 2);
  const hands = [deck.slice(2, 12), deck.slice(12, 22), deck.slice(22, 32)];
  return {
    id: gameId,
    settings,
    players: [],
    hands,
    talon,
    dealerIndex: 0,
    phase: 'waiting', // ✅ PROMENJENO: prvo je waiting
    contract: null,
    currentBidder: 0,
    highestBid: null,
    bidHistory: [],
    currentTrick: 0,
    trickCards: [null, null, null],
    trickStarter: 0,
    currentTurn: 0,
    scores: {},
    tricks: [],
    refaCount: 0,
    maxRefas: settings.maxRefas || 2
  };
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // ODMAH POŠALJI LISTU IGARA NOVOM KORISNIKU
  socket.emit('games:list', getGamesList());

  socket.on('auth:register', ({ username, password }) => {
    if (usersDB.has(username)) {
      return socket.emit('auth:error', 'Korisnik već postoji');
    }
    usersDB.set(username, { 
      password, 
      stats: { totalHands: 0, playedHands: 0, wins: 0, losses: 0 },
      profilePic: 'https://via.placeholder.com/50',
      blockedUsers: []
    });
    socket.emit('auth:success', { 
      username, 
      stats: usersDB.get(username).stats,
      profilePic: usersDB.get(username).profilePic,
      blockedUsers: usersDB.get(username).blockedUsers
    });
  });

  socket.on('auth:login', ({ username, password }) => {
    const user = usersDB.get(username);
    if (!user || user.password !== password) {
      return socket.emit('auth:error', 'Pogrešan username ili lozinka');
    }
    socket.emit('auth:success', { 
      username, 
      stats: user.stats,
      profilePic: user.profilePic,
      blockedUsers: user.blockedUsers
    });
    // Pošalji liste igara nakon login-a
    socket.emit('games:list', getGamesList());
  });

  socket.on('user:stats', (username) => {
    const user = usersDB.get(username);
    socket.emit('user:stats', user ? user.stats : { totalHands: 0, playedHands: 0 });
  });

  socket.on('profile:updateBlock', ({ myUsername, targetUsername, action }) => {
    const user = usersDB.get(myUsername);
    if (!user) return;
    if (action === 'add' && !user.blockedUsers.includes(targetUsername)) {
      user.blockedUsers.push(targetUsername);
    } else if (action === 'remove') {
      user.blockedUsers = user.blockedUsers.filter(u => u !== targetUsername);
    }
    socket.emit('profile:updated', { blockedUsers: user.blockedUsers });
  });

  socket.on('profile:updatePic', ({ myUsername, picUrl }) => {
    const user = usersDB.get(myUsername);
    if (user) {
      user.profilePic = picUrl;
      socket.emit('profile:updatedPic', { picUrl });
    }
  });

  // ✅ POPRAVLJENO: Uvek vraća sve igre
  socket.on('games:list', () => {
    socket.emit('games:list', getGamesList());
  });

  socket.on('chat:global', ({ text, username }) => {
    io.emit('chat:global', { text, username });
  });

  socket.on('user:join', (userData) => {
    users.set(socket.id, { ...userData, socketId: socket.id });
    socket.broadcast.emit('user:online', { username: userData.username, displayName: userData.displayName });
    socket.emit('user:joined', { success: true, username: userData.username });
    updatePlayerList();
  });

  // ✅ POPRAVLJENO: Kreiranje igre
  socket.on('game:create', (settings) => {
    const user = users.get(socket.id);
    if (!user) {
      console.log('❌ Nema user-a za socket:', socket.id);
      return;
    }
    
    const gameId = 'game_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const game = initGame(gameId, settings);
    game.host = user.username;
    game.players.push({ username: user.username, displayName: user.displayName, socketId: socket.id, ready: true });
    game.scores[user.username] = 0;
    
    games.set(gameId, game); // ✅ ČUVAJ IGRU
    socket.join(gameId);
    
    console.log('✅ Igra kreirana:', gameId, 'Broj igara:', games.size);
    
    // Pošalji creator-u
    socket.emit('game:created', { gameId, game });
    
    // ✅ POŠALJI SVIMA AŽURIRANU LISTU
    io.emit('games:list', getGamesList());
  });

  // ✅ POPRAVLJENO: Pridruživanje igri
  socket.on('game:join', ({ gameId }) => {
    const user = users.get(socket.id);
    const game = games.get(gameId);
    
    if (!user) return socket.emit('error', { message: 'User not found' });
    if (!game) return socket.emit('error', { message: 'Igra ne postoji' });
    if (game.players.length >= 3) return socket.emit('error', { message: 'Igra je puna' });
    
    game.players.push({ username: user.username, displayName: user.displayName, socketId: socket.id, ready: true });
    game.scores[user.username] = 0;
    socket.join(gameId);
    
    console.log('✅ Igrač se pridružio:', user.username, 'U igri:', game.players.length, '/3');
    
    // Pošalji ažuriranje svima u igri
    io.to(gameId).emit('game:update', { game });
    
    // Ažuriraj listu igara za sve
    io.emit('games:list', getGamesList());
    
    // Ako ima 3 igrača, pokreni igru
    if (game.players.length === 3) {
      console.log('🎮 Počinje igra sa 3 igrača!');
      setTimeout(() => startBidding(gameId), 2000);
    }
  });

  socket.on('game:bid', ({ gameId, level, suit, isIgra = false }) => {
    const game = games.get(gameId);
    const user = users.get(socket.id);
    if (!game || !user) return;
    const playerIdx = game.players.findIndex(p => p.username === user.username);
    if (playerIdx !== game.currentBidder) return;
    if (level && suit) {
      const bidValue = getBidValue(level, suit);
      if (!game.highestBid || bidValue > getBidValue(game.highestBid.level, game.highestBid.suit) || (level === game.highestBid.level && isIgra)) {
        game.highestBid = { level, suit, player: playerIdx, isIgra };
      }
    }
    game.bidHistory.push({ player: playerIdx, level, suit, isIgra });
    game.currentBidder = (game.currentBidder + 1) % 3;
    const recentPasses = game.bidHistory.slice(-2).filter(b => !b.level).length;
    if (recentPasses >= 2 && game.highestBid) endBidding(gameId);
    else {
      io.to(gameId).emit('game:update', { game });
      setTimeout(() => processBotBid(gameId), 800);
    }
  });

  socket.on('game:play', ({ gameId, suit, value }) => {
    const game = games.get(gameId);
    const user = users.get(socket.id);
    if (!game || !user || game.phase !== 'playing') return;
    const playerIdx = game.players.findIndex(p => p.username === user.username);
    if (playerIdx !== game.currentTurn) return;
    const hand = game.hands[playerIdx];
    const cardIdx = hand.findIndex(c => c.suit === suit && c.value === value);
    if (cardIdx < 0) return;
    if (game.trickCards[game.trickStarter]) {
      const ledSuit = game.trickCards[game.trickStarter].suit;
      const hasLedSuit = hand.some(c => c.suit === ledSuit);
      if (hasLedSuit && suit !== ledSuit) return socket.emit('error', { message: 'Morate da pratite boju!' });
    }
    const card = hand.splice(cardIdx, 1)[0];
    game.trickCards[playerIdx] = card;
    game.currentTurn = (game.currentTurn + 1) % 3;
    io.to(gameId).emit('game:update', { game });
    if (game.trickCards.every(c => c !== null)) setTimeout(() => resolveTrick(gameId), 600);
    else setTimeout(() => processBotPlay(gameId), 700);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      for (const [gameId, game] of games) {
        const idx = game.players.findIndex(p => p.socketId === socket.id);
        if (idx >= 0) {
          game.players.splice(idx, 1);
          io.to(gameId).emit('game:update', { game });
          if (game.players.length === 0) {
            games.delete(gameId);
            io.emit('games:list', getGamesList());
          }
        }
      }
      users.delete(socket.id);
      socket.broadcast.emit('user:offline', { username: user.username });
      updatePlayerList();
    }
  });
});

// ===== HELPER FUNKCIJE =====
function getGamesList() {
  const list = [...games.values()].map(g => ({
    id: g.id,
    name: g.settings.name || 'Sto',
    players: g.players.map(p => p.displayName),
    status: g.phase,
    settings: g.settings
  }));
  console.log('📋 Lista igara:', list.length, 'igara');
  return list;
}

function updatePlayerList() {
  const players = [...users.values()].map(u => ({ username: u.username, displayName: u.displayName, online: true }));
  io.emit('players:list', players);
}

// ===== GAME FLOW =====
function startBidding(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  game.phase = 'bidding';
  game.currentBidder = (game.dealerIndex + 1) % 3;
  game.bidHistory = [];
  game.highestBid = null;
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => processBotBid(gameId), 1000);
}

function endBidding(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  if (!game.highestBid) {
    if (game.refaCount < game.maxRefas) game.refaCount++;
    io.to(gameId).emit('game:refaUpdate', { refaCount: game.refaCount, maxRefas: game.maxRefas });
    io.to(gameId).emit('game:update', { game });
    resetHand(gameId);
    return;
  }
  game.contract = { ...game.highestBid };
  game.phase = 'playing';
  const bidderIdx = game.contract.player;
  if (!game.contract.isIgra) {
    game.hands[bidderIdx].push(...game.talon);
    game.talon = [];
    sortHand(game.hands[bidderIdx]);
  } else { game.talon = []; }
  game.trickStarter = (game.dealerIndex + 1) % 3;
  game.currentTurn = game.trickStarter;
  io.to(gameId).emit('game:update', { game });
}

function resolveTrick(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const ledSuit = game.trickCards[game.trickStarter].suit;
  const contractSuit = game.contract.suit;
  let winner = game.trickStarter;
  let winningCard = game.trickCards[game.trickStarter];
  const valOrder = { '7': 0, '8': 1, '9': 2, '10': 3, 'J': 4, 'Q': 5, 'K': 6, 'A': 7 };
  const isAdutGame = contractSuit !== 'NT' && game.contract.level !== 6;
  for (let i = 0; i < 3; i++) {
    if (i === game.trickStarter) continue;
    const c = game.trickCards[i];
    if (!c) continue;
    if (isAdutGame && c.suit === contractSuit) {
      if (winningCard.suit !== contractSuit) { winner = i; winningCard = c; }
      else if (valOrder[c.value] > valOrder[winningCard.value]) { winner = i; winningCard = c; }
    } else if (c.suit === ledSuit) {
      if (winningCard.suit === ledSuit && valOrder[c.value] > valOrder[winningCard.value]) { winner = i; winningCard = c; }
    }
  }
  game.tricks.push({ cards: [...game.trickCards], winner });
  game.currentTrick++;
  game.trickCards = [null, null, null];
  game.trickStarter = winner;
  game.currentTurn = winner;
  if (game.hands[0].length === 0 && game.hands[1].length === 0 && game.hands[2].length === 0) setTimeout(() => endHand(gameId), 1000);
  else {
    io.to(gameId).emit('game:update', { game });
    setTimeout(() => processBotPlay(gameId), 800);
  }
}

function endHand(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const tricksWon = [0, 0, 0];
  game.tricks.forEach(t => tricksWon[t.winner]++);
  const bidderIdx = game.contract.player;
  const bidderTricks = tricksWon[bidderIdx];
  let contractFulfilled = false;
  const { level, suit, isIgra } = game.contract;
  if (suit === 'NT' && level === 8) contractFulfilled = bidderTricks === 10;
  else if (suit === 'NT' && level === 7) contractFulfilled = bidderTricks >= 6;
  else if (level === 6) contractFulfilled = bidderTricks === 0;
  else contractFulfilled = bidderTricks >= 6;
  let basePoints = calculateContractPoints(level, suit, isIgra);
  let finalPoints = contractFulfilled ? basePoints : -basePoints;
  if (game.refaCount > 0) {
    finalPoints *= Math.pow(2, game.refaCount);
    game.refaCount = 0;
  }
  for (let i = 0; i < 3; i++) {
    const username = game.players[i].username;
    if (i === bidderIdx) game.scores[username] = (game.scores[username] || 0) + finalPoints;
    else game.scores[username] = (game.scores[username] || 0) - finalPoints;
  }
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => {
    if (game.currentTrick >= game.settings.numHands * 10) {
      io.to(gameId).emit('game:ended', { scores: game.scores });
      games.delete(gameId);
      io.emit('games:list', getGamesList());
    } else { resetHand(gameId); }
  }, 3000);
}

function resetHand(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  game.dealerIndex = (game.dealerIndex + 1) % 3;
  const deck = createDeck();
  const talon = deck.slice(0, 2);
  game.hands = [deck.slice(2, 12), deck.slice(12, 22), deck.slice(22, 32)];
  game.talon = talon;
  for (let i = 0; i < 3; i++) sortHand(game.hands[i]);
  game.phase = 'bidding';
  game.currentBidder = (game.dealerIndex + 1) % 3;
  game.bidHistory = [];
  game.highestBid = null;
  game.contract = null;
  game.currentTrick = 0;
  game.tricks = [];
  game.trickCards = [null, null, null];
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => startBidding(gameId), 2000);
}

function processBotBid(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== 'bidding') return;
  const currentPlayer = game.players[game.currentBidder];
  if (!currentPlayer) return;
  const isHuman = [...users.values()].some(u => u.socketId === currentPlayer.socketId);
  if (isHuman) return;
  setTimeout(() => {
    const g = games.get(gameId);
    if (!g || g.phase !== 'bidding') return;
    if (Math.random() > 0.3 && (!g.highestBid || Math.random() > 0.5)) {
      const level = Math.floor(Math.random() * 2) + 1;
      const suits = ['S', 'C', 'D', 'H', 'NT'];
      const suit = suits[Math.floor(Math.random() * suits.length)];
      handleBotBid(gameId, game.currentBidder, level, suit, false);
    } else { handleBotBid(gameId, game.currentBidder, null, null, false); }
  }, 1000 + Math.random() * 1500);
}

function handleBotBid(gameId, playerIdx, level, suit, isIgra) {
  const game = games.get(gameId);
  if (!game) return;
  if (level && suit) {
    const bidValue = getBidValue(level, suit);
    if (!game.highestBid || bidValue > getBidValue(game.highestBid.level, game.highestBid.suit)) {
      game.highestBid = { level, suit, player: playerIdx, isIgra };
    }
  }
  game.bidHistory.push({ player: playerIdx, level, suit, isIgra });
  game.currentBidder = (game.currentBidder + 1) % 3;
  const recentPasses = game.bidHistory.slice(-2).filter(b => !b.level).length;
  if (recentPasses >= 2 && game.highestBid) endBidding(gameId);
  else {
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
  setTimeout(() => {
    const g = games.get(gameId);
    if (!g || g.phase !== 'playing') return;
    const hand = g.hands[g.currentTurn];
    if (!hand || hand.length === 0) return;
    let validCards = [...hand];
    if (g.trickCards[g.trickStarter]) {
      const ledSuit = g.trickCards[g.trickStarter].suit;
      const follow = hand.filter(c => c.suit === ledSuit);
      if (follow.length > 0) validCards = follow;
    }
    const card = validCards[Math.floor(Math.random() * validCards.length)];
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
  if (game.trickCards.every(c => c !== null)) setTimeout(() => resolveTrick(gameId), 600);
  else setTimeout(() => processBotPlay(gameId), 700);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

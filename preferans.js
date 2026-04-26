const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

// ✅ ISPRAVKA PUTANJE: Pošto si rekao da nemaš 'public' folder,
// ovo servira fajlove direktno iz root foldera gde je index.html
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server);

// In-memory storage
const users = new Map();
const games = new Map();
const waitingPlayers = [];

// ===== GAME LOGIC HELPERS =====
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
    return valOrd[a.value] - valOrd[a.value];
  });
}

function getBidValue(level, suit) {
  const order = { 'S': 1, 'C': 2, 'D': 3, 'H': 4, 'NT': 5 };
  // NT (Sans/Preferans) su jači
  return suit === 'NT' ? level * 10 + 5 : level * 10 + order[suit];
}

// ✅ ISPRAVKA BODOVANJA
function calculateContractPoints(level, suit, isIgra) {
  let base = level * 2;
  // Ako je IGRA (bez talona), vrednost raste za 2
  if (isIgra) base += 2; 
  return base;
}

// ===== INITIALIZATION =====
function initGame(gameId, settings) {
  const deck = createDeck();
  
  // ✅ ISPRAVKA DELJENJA: Prvo 2 karte u talon, pa 10 svakom (5 pa 3 redosled)
  const talon = deck.slice(0, 2);
  const hands = [deck.slice(2, 12), deck.slice(12, 22), deck.slice(22, 32)];

  return {
    id: gameId,
    settings,
    players: [],
    spectators: [],
    hands,
    talon,
    // ✅ ISPRAVKA DELITELJA
    dealerIndex: 0, 
    phase: 'bidding',
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
    // ✅ ISPRAVKA REFE
    refaCount: 0,
    maxRefas: settings.maxRefas || 2
  };
}

// ===== SOCKET.IO HANDLERS =====
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  socket.on('user:join', (userData) => {
    users.set(socket.id, { ...userData, socketId: socket.id });
    socket.broadcast.emit('user:online', { username: userData.username, displayName: userData.displayName });
    socket.emit('user:joined', { success: true, username: userData.username });
    updatePlayerList();
  });

  socket.on('game:create', (settings) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const gameId = 'game_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const game = initGame(gameId, settings);
    game.host = user.username;
    game.players.push({ username: user.username, displayName: user.displayName, socketId: socket.id, ready: true });
    game.scores[user.username] = 0;
    
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('game:created', { gameId, game });
    broadcastGameList();
  });

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
      setTimeout(() => startBidding(gameId), 2000);
    }
  });

  socket.on('game:bid', ({ gameId, level, suit, isIgra = false }) => {
    const game = games.get(gameId);
    const user = users.get(socket.id);
    if (!game || !user) return;
    
    const playerIdx = game.players.findIndex(p => p.username === user.username);
    if (playerIdx !== game.currentBidder) return;
    
    // Procesuiranje licitacije
    if (level && suit) {
      const bidValue = getBidValue(level, suit);
      // Provera da li je ponuda jača (ili ako je IGRA na istom nivou, što je jače)
      if (!game.highestBid || bidValue > getBidValue(game.highestBid.level, game.highestBid.suit) || (level === game.highestBid.level && isIgra)) {
        game.highestBid = { level, suit, player: playerIdx, isIgra };
      }
    }
    
    game.bidHistory.push({ player: playerIdx, level, suit, isIgra });
    game.currentBidder = (game.currentBidder + 1) % 3;
    
    // Provera da li je licitacija završena (2 uzastopna 'dalje' / pass)
    // Simplifikovana logika za pass: ako nema level/suit
    const recentPasses = game.bidHistory.slice(-2).filter(b => !b.level).length;
    
    if (recentPasses >= 2 && game.highestBid) {
      endBidding(gameId);
    } else {
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
    
    // Pravilo praćenja boje
    if (game.trickCards[game.trickStarter]) {
      const ledSuit = game.trickCards[game.trickStarter].suit;
      const hasLedSuit = hand.some(c => c.suit === ledSuit);
      if (hasLedSuit && suit !== ledSuit) {
        return socket.emit('error', { message: 'Morate da pratite boju!' });
      }
    }
    
    const card = hand.splice(cardIdx, 1)[0];
    game.trickCards[playerIdx] = card;
    game.currentTurn = (game.currentTurn + 1) % 3;
    
    io.to(gameId).emit('game:update', { game });
    
    if (game.trickCards.every(c => c !== null)) {
      setTimeout(() => resolveTrick(gameId), 600);
    } else {
      setTimeout(() => processBotPlay(gameId), 700);
    }
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
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

// ===== GAME FLOW FUNCTIONS =====

function startBidding(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  game.phase = 'bidding';
  // ✅ ISPRAVKA: Prvi licitira igrač DESNO od delitelja
  game.currentBidder = (game.dealerIndex + 1) % 3;
  game.bidHistory = [];
  game.highestBid = null;
  
  io.to(gameId).emit('game:update', { game });
  setTimeout(() => processBotBid(gameId), 1000);
}

function endBidding(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  
  // ✅ ISPRAVKA: Ako nema najviše ponude (svi dali "dalje")
  if (!game.highestBid) {
    // Dodaje se REFA
    if (game.refaCount < game.maxRefas) {
      game.refaCount++;
    }
    io.to(gameId).emit('game:refaUpdate', { refaCount: game.refaCount, maxRefas: game.maxRefas });
    io.to(gameId).emit('game:update', { game });
    resetHand(gameId);
    return;
  }
  
  // Ugovor je prihvaćen
  game.contract = { ...game.highestBid };
  game.phase = 'playing';
  
  const bidderIdx = game.contract.player;
  
  // ✅ ISPRAVKA: Ako je IGRA (bez talona), nosilac NE uzima talon
  if (!game.contract.isIgra) {
    game.hands[bidderIdx].push(...game.talon);
    game.talon = [];
    sortHand(game.hands[bidderIdx]);
  } else {
    // Ako je IGRA, talon ostaje nepodignut (ili se tretira kao mrtav)
    game.talon = []; 
  }
  
  // ✅ ISPRAVKA: Prvi štih vodi igrač DESNO od delitelja (NE nosilac)
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
  
  // Logika za adut/betl/sans
  const isAdutGame = contractSuit !== 'NT' && game.contract.level !== 6; // 6 je Betl, 7 Sans (NT), 8 Preferans (NT)
  
  for (let i = 0; i < 3; i++) {
    if (i === game.trickStarter) continue;
    const c = game.trickCards[i];
    if (!c) continue;
    
    if (isAdutGame && c.suit === contractSuit) {
      // Adut seče
      if (winningCard.suit !== contractSuit) { winner = i; winningCard = c; }
      else if (valOrder[c.value] > valOrder[winningCard.value]) { winner = i; winningCard = c; }
    } else if (c.suit === ledSuit) {
      // Ista boja kojom je početo
      if (winningCard.suit !== contractSuit && winningCard.suit !== ledSuit) {
         // Ova grana retko pada ovde jer je ledSuit uvek validan osim ako je adut već u pitanju
      }
      if (winningCard.suit === ledSuit && valOrder[c.value] > valOrder[winningCard.value]) {
        winner = i; winningCard = c;
      }
    }
  }
  
  game.tricks.push({ cards: [...game.trickCards], winner });
  game.currentTrick++;
  game.trickCards = [null, null, null];
  game.trickStarter = winner;
  game.currentTurn = winner;
  
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
  
  // Brojanje štihova
  const tricksWon = [0, 0, 0];
  game.tricks.forEach(t => tricksWon[t.winner]++);
  
  const bidderIdx = game.contract.player;
  const bidderTricks = tricksWon[bidderIdx];
  let contractFulfilled = false;
  
  const { level, suit, isIgra } = game.contract;
  
  // ✅ ISPRAVKA: Tačni uslovi za prolaz
  if (suit === 'NT' && level === 8) contractFulfilled = bidderTricks === 10;   // Preferans = 10
  else if (suit === 'NT' && level === 7) contractFulfilled = bidderTricks >= 6; // Sans = 6
  else if (level === 6) contractFulfilled = bidderTricks === 0;                 // Betl = 0
  else contractFulfilled = bidderTricks >= 6;                                   // Adutske (2-5) = 6
  
  // ✅ ISPRAVKA: Obračun poena
  let basePoints = calculateContractPoints(level, suit, isIgra);
  let finalPoints = contractFulfilled ? basePoints : -basePoints;
  
  // ✅ ISPRAVKA: Primena Refe (duplira bodove)
  if (game.refaCount > 0) {
    finalPoints *= Math.pow(2, game.refaCount);
    // Refa se resetuje nakon odigrane ruke
    game.refaCount = 0; 
  }
  
  // Upis u skor
  for (let i = 0; i < 3; i++) {
    const username = game.players[i].username;
    if (i === bidderIdx) {
      game.scores[username] = (game.scores[username] || 0) + finalPoints;
    } else {
      // Pratitelji dobijaju suprotan predznak
      game.scores[username] = (game.scores[username] || 0) - finalPoints;
    }
  }
  
  io.to(gameId).emit('game:update', { game });
  
  setTimeout(() => {
    if (game.currentTrick >= game.settings.numHands * 10) {
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
  
  // ✅ ISPRAVKA: Rotacija delitelja
  game.dealerIndex = (game.dealerIndex + 1) % 3;
  
  const deck = createDeck();
  const talon = deck.slice(0, 2);
  game.hands = [deck.slice(2, 12), deck.slice(12, 22), deck.slice(22, 32)];
  game.talon = talon;
  for (let i = 0; i < 3; i++) sortHand(game.hands[i]);
  
  game.phase = 'bidding';
  // ✅ ISPRAVKA: Prvi licitira desno od novog delitelja
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

// ===== BOT LOGIC =====
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
    
    // Jednostavan bot: nasumično licitira ili prolazi
    if (Math.random() > 0.3 && (!g.highestBid || Math.random() > 0.5)) {
      const level = Math.floor(Math.random() * 2) + 1;
      const suits = ['S', 'C', 'D', 'H', 'NT'];
      const suit = suits[Math.floor(Math.random() * suits.length)];
      // Bot ne igra "IGRA" u ovoj prostoj verziji, samo normalno
      handleBotBid(gameId, game.currentBidder, level, suit, false);
    } else {
      handleBotBid(gameId, game.currentBidder, null, null, false);
    }
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
  if (recentPasses >= 2 && game.highestBid) {
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
  
  if (game.trickCards.every(c => c !== null)) {
    setTimeout(() => resolveTrick(gameId), 600);
  } else {
    setTimeout(() => processBotPlay(gameId), 700);
  }
}

// ===== BROADCAST HELPERS =====
function updatePlayerList() {
  const players = [...users.values()].map(u => ({ username: u.username, displayName: u.displayName, online: true }));
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
  console.log(` Preferans server running on port ${PORT}`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});

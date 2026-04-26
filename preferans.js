const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve your HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Game state storage
let games = [];

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send the current list of games immediately upon connection
    socket.emit('refresh_games', games);

    // Handle game creation
    socket.on('create_game', (name) => {
        const newGame = {
            id: Math.random().toString(36).substr(2, 9), // Unique ID
            name: name,
            players: 1,
            status: 'Waiting',
            playerIds: [socket.id]
        };
        
        games.push(newGame);
        socket.join(newGame.id); // Put the creator in the room
        
        // Update everyone's lobby
        io.emit('refresh_games', games);
    });

    // Handle joining a game
    socket.on('join_game', (gameId) => {
        const game = games.find(g => g.id === gameId);
        
        if (game && game.players < 3) {
            game.players++;
            game.playerIds.push(socket.id);
            socket.join(gameId);

            if (game.players === 3) {
                game.status = 'Full';
            }

            io.emit('refresh_games', games);
        } else {
            socket.emit('error', 'Game is full or doesn\'t exist');
        }
    });

    socket.on('disconnect', () => {
        // Optional: Logic to remove games if the creator leaves
        console.log('User disconnected');
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Preferans server running on http://localhost:${PORT}`);
});

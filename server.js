// server.js - Backend WebRTC para Walkie-Talkie con Socket.io
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 10e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Almacenamiento en memoria
const channels = new Map();
const users = new Map();

// Endpoints HTTP
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: '🎙️ Walkie-Talkie WebRTC Server Running',
    version: '2.0.0 (WebRTC)',
    channels: channels.size,
    users: users.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    channels: channels.size,
    users: users.size
  });
});

app.get('/channels', (req, res) => {
  const channelList = Array.from(channels.entries()).map(([id, data]) => ({
    id,
    userCount: data.users.size,
    users: Array.from(data.users.values()).map(u => ({
      userId: u.userId,
      socketId: u.socketId,
      joinedAt: u.joinedAt
    }))
  }));
  res.json(channelList);
});

// Socket.io - Manejo de señalización WebRTC
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);
  
  users.set(socket.id, {
    socketId: socket.id,
    connectedAt: new Date(),
    currentChannel: null,
    userId: null
  });

  socket.emit('connected', { 
    socketId: socket.id,
    timestamp: Date.now()
  });

  // Unirse a un canal
  socket.on('join-channel', ({ channelId, userId }) => {
    console.log(`📡 ${userId} joining channel ${channelId}`);
    
    // Crear canal si no existe
    if (!channels.has(channelId)) {
      channels.set(channelId, {
        id: channelId,
        users: new Map(),
        createdAt: new Date(),
        messageCount: 0
      });
    }
    
    const channel = channels.get(channelId);
    
    // Agregar usuario al canal
    channel.users.set(socket.id, {
      userId,
      socketId: socket.id,
      joinedAt: new Date()
    });
    
    // Actualizar info del usuario
    const user = users.get(socket.id);
    if (user) {
      user.currentChannel = channelId;
      user.userId = userId;
    }
    
    // Unirse a la sala de Socket.io
    socket.join(channelId);
    
    // Obtener lista de usuarios actuales (excluyendo al que se une)
    const userList = Array.from(channel.users.values())
      .filter(u => u.socketId !== socket.id)
      .map(u => u.userId);
    
    // Enviar lista de usuarios al que se une
    socket.emit('channel-users', userList);
    
    // Notificar a otros usuarios
    socket.to(channelId).emit('user-joined', userId);
    
    console.log(`✅ ${userId} joined channel ${channelId}. Total users: ${channel.users.size}`);
  });

  // Salir de un canal
  socket.on('leave-channel', ({ channelId, userId }) => {
    console.log(`👋 ${userId} leaving channel ${channelId}`);
    
    const channel = channels.get(channelId);
    if (channel) {
      channel.users.delete(socket.id);
      socket.leave(channelId);
      socket.to(channelId).emit('user-left', userId);
      
      // Eliminar canal si está vacío
      if (channel.users.size === 0) {
        channels.delete(channelId);
        console.log(`🗑️ Channel ${channelId} deleted (empty)`);
      }
    }
    
    const user = users.get(socket.id);
    if (user) {
      user.currentChannel = null;
    }
  });

  // ========== SEÑALIZACIÓN WEBRTC ==========

  // Reenviar oferta WebRTC
  socket.on('webrtc-offer', ({ to, offer }) => {
    console.log(`📤 WebRTC offer from ${socket.id} to ${to}`);
    
    // Encontrar el socketId del usuario destino
    const targetSocketId = findSocketIdByUserId(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-offer', {
        from: users.get(socket.id)?.userId || socket.id,
        offer: offer
      });
    } else {
      console.log(`❌ User ${to} not found for WebRTC offer`);
    }
  });

  // Reenviar respuesta WebRTC
  socket.on('webrtc-answer', ({ to, answer }) => {
    console.log(`📤 WebRTC answer from ${socket.id} to ${to}`);
    
    const targetSocketId = findSocketIdByUserId(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-answer', {
        from: users.get(socket.id)?.userId || socket.id,
        answer: answer
      });
    } else {
      console.log(`❌ User ${to} not found for WebRTC answer`);
    }
  });

  // Reenviar candidato ICE
  socket.on('ice-candidate', ({ to, candidate }) => {
    const targetSocketId = findSocketIdByUserId(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', {
        from: users.get(socket.id)?.userId || socket.id,
        candidate: candidate
      });
    }
  });

  // ========== SEÑALES DE TRANSMISIÓN ==========

  // Señal de inicio de transmisión
  socket.on('transmission-start', ({ channelId, userId }) => {
    console.log(`🔴 ${userId} started transmission in ${channelId}`);
    socket.to(channelId).emit('transmission-start', { 
      userId, 
      timestamp: Date.now() 
    });

    const channel = channels.get(channelId);
    if (channel) {
      channel.messageCount++;
    }
  });

  // Señal de fin de transmisión
  socket.on('transmission-end', ({ channelId, userId }) => {
    console.log(`⏹️ ${userId} ended transmission in ${channelId}`);
    socket.to(channelId).emit('transmission-end', { 
      userId, 
      timestamp: Date.now() 
    });
  });

  // ========== UTILIDADES ==========

  // Ping/pong para mantener conexión
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });

  // Solicitar lista de usuarios de un canal
  socket.on('get-channel-users', ({ channelId }) => {
    const channel = channels.get(channelId);
    if (channel) {
      const userList = Array.from(channel.users.values()).map(u => u.userId);
      socket.emit('channel-users', userList);
    } else {
      socket.emit('channel-users', []);
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    
    const user = users.get(socket.id);
    if (user && user.currentChannel) {
      const channel = channels.get(user.currentChannel);
      if (channel) {
        channel.users.delete(socket.id);
        socket.to(user.currentChannel).emit('user-left', user.userId);
        
        if (channel.users.size === 0) {
          channels.delete(user.currentChannel);
          console.log(`🗑️ Channel ${user.currentChannel} deleted (empty after disconnect)`);
        }
      }
    }
    
    users.delete(socket.id);
  });

  // Manejo de errores
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Función auxiliar para encontrar socketId por userId
function findSocketIdByUserId(userId) {
  for (const [socketId, user] of users.entries()) {
    if (user.userId === userId) {
      return socketId;
    }
  }
  return null;
}

// Limpieza periódica de canales vacíos
setInterval(() => {
  let cleaned = 0;
  for (const [channelId, channel] of channels.entries()) {
    if (channel.users.size === 0) {
      channels.delete(channelId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} empty channels`);
  }
}, 60000); // Cada minuto

// Estadísticas cada 5 minutos
setInterval(() => {
  const totalMessages = Array.from(channels.values())
    .reduce((sum, ch) => sum + (ch.messageCount || 0), 0);
  
  const channelStats = Array.from(channels.entries()).map(([id, ch]) => ({
    id,
    users: ch.users.size,
    messages: ch.messageCount
  }));

  console.log(`📊 Stats - Channels: ${channels.size}, Users: ${users.size}, Total Messages: ${totalMessages}`);
  if (channelStats.length > 0) {
    console.log('Active channels:', channelStats);
  }
}, 300000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   🎙️  Walkie-Talkie WebRTC Server       ║
╠═══════════════════════════════════════════╣
║   Port: ${PORT.toString().padEnd(33)} ║
║   Host: 0.0.0.0${' '.repeat(28)} ║
║   Mode: WebRTC P2P + Relay${' '.repeat(15)} ║
║   Time: ${new Date().toLocaleTimeString().padEnd(33)} ║
╠═══════════════════════════════════════════╣
║   Endpoints:                              ║
║   GET  /                                  ║
║   GET  /health                            ║
║   GET  /channels                          ║
╠═══════════════════════════════════════════╣
║   WebRTC Signaling:                       ║
║   • webrtc-offer                          ║
║   • webrtc-answer                         ║
║   • ice-candidate                         ║
║   • transmission-start/end                ║
╚═══════════════════════════════════════════╝

🔊 WebSocket ready on ws://0.0.0.0:${PORT}
🌐 Audio streaming via WebRTC (low latency)
  `);
});

// Manejo de errores
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('⏸️ Shutting down gracefully...');
  
  // Notificar a todos los clientes
  io.emit('server-shutdown', { message: 'Server is shutting down' });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
  
  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

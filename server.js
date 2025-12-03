// server.js - Backend para Walkie-Talkie con Socket.io
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 10e6, // 10MB para audio
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Crear directorio para almacenar audio temporal
const audioDir = path.join(__dirname, 'audio_temp');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}

// Servir archivos de audio
app.use('/audio', express.static(audioDir));

// Configurar multer para subir archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, audioDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.m4a`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Almacenamiento en memoria
const channels = new Map();
const users = new Map();

// Limpiar archivos de audio antiguos (más de 1 hora)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  fs.readdir(audioDir, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(audioDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        
        if (now - stats.mtimeMs > oneHour) {
          fs.unlink(filePath, err => {
            if (!err) console.log(`🗑️ Deleted old audio file: ${file}`);
          });
        }
      });
    });
  });
}, 5 * 60 * 1000); // Cada 5 minutos

// Endpoints HTTP
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: '🎙️ Walkie-Talkie Server Running',
    version: '1.0.0',
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
      joinedAt: u.joinedAt
    }))
  }));
  res.json(channelList);
});

// Endpoint para subir audio (alternativa a Socket.io para archivos grandes)
app.post('/upload-audio', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioUrl = `/audio/${req.file.filename}`;
    const { channelId, userId } = req.body;

    console.log(`📤 Audio uploaded by ${userId} for channel ${channelId}`);

    // Notificar a usuarios del canal
    io.to(channelId).emit('audio-message', {
      userId,
      audioUrl: `${req.protocol}://${req.get('host')}${audioUrl}`,
      timestamp: Date.now()
    });

    res.json({ 
      success: true, 
      audioUrl,
      filename: req.file.filename
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);
  
  users.set(socket.id, {
    socketId: socket.id,
    connectedAt: new Date(),
    currentChannel: null,
    userId: null
  });

  // Enviar mensaje de bienvenida
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

  // Transmisión de audio via base64 (para chunks pequeños)
  socket.on('audio-data', (data) => {
    const { channelId, userId, audioData, timestamp } = data;
    
    console.log(`🎤 ${userId} sending audio to channel ${channelId} (${audioData ? audioData.length : 0} bytes)`);
    
    // Reenviar audio a todos excepto al emisor
    socket.to(channelId).emit('audio-received', {
      userId,
      audioData,
      timestamp: timestamp || Date.now()
    });

    // Incrementar contador de mensajes
    const channel = channels.get(channelId);
    if (channel) {
      channel.messageCount++;
    }
  });

  // Transmisión de audio via URL (después de subirlo)
  socket.on('audio-url', (data) => {
    const { channelId, userId, audioUrl, timestamp } = data;
    
    console.log(`🎤 ${userId} sharing audio URL to channel ${channelId}: ${audioUrl}`);
    
    socket.to(channelId).emit('audio-message', {
      userId,
      audioUrl,
      timestamp: timestamp || Date.now()
    });

    const channel = channels.get(channelId);
    if (channel) {
      channel.messageCount++;
    }
  });

  // Señal de inicio de transmisión
  socket.on('transmission-start', ({ channelId, userId }) => {
    console.log(`🔴 ${userId} started transmission in ${channelId}`);
    socket.to(channelId).emit('transmission-start', { userId, timestamp: Date.now() });
  });

  // Señal de fin de transmisión
  socket.on('transmission-end', ({ channelId, userId }) => {
    console.log(`⏹️ ${userId} ended transmission in ${channelId}`);
    socket.to(channelId).emit('transmission-end', { userId, timestamp: Date.now() });
  });

  // Streaming de audio en chunks (para baja latencia)
  socket.on('audio-chunk', (data) => {
    const { channelId, chunk, sequence } = data;
    
    // Reenviar chunk inmediatamente sin logging (para evitar spam)
    socket.to(channelId).emit('audio-chunk', {
      userId: users.get(socket.id)?.userId,
      chunk,
      sequence,
      timestamp: Date.now()
    });
  });

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

  // WebRTC Signaling (Señalización)
  
  // Usuario crea una oferta WebRTC
  socket.on('webrtc-offer', ({ channelId, userId, offer }) => {
    console.log(`📤 WebRTC offer from ${userId} in channel ${channelId}`);
    
    // Reenviar oferta a todos los demás en el canal
    socket.to(channelId).emit('webrtc-offer', {
      userId,
      offer
    });
  });

  // Usuario responde con answer
  socket.on('webrtc-answer', ({ channelId, userId, answer, targetUserId }) => {
    console.log(`📤 WebRTC answer from ${userId} to ${targetUserId}`);
    
    // Enviar answer específicamente al usuario objetivo
    const channel = channels.get(channelId);
    if (channel) {
      const targetUser = Array.from(channel.users.values()).find(
        u => u.userId === targetUserId
      );
      
      if (targetUser) {
        io.to(targetUser.socketId).emit('webrtc-answer', {
          userId,
          answer
        });
      }
    }
  });

  // ICE Candidate exchange
  socket.on('webrtc-ice-candidate', ({ channelId, userId, candidate, targetUserId }) => {
    console.log(`🧊 ICE candidate from ${userId}`);
    
    if (targetUserId) {
      // Enviar a usuario específico
      const channel = channels.get(channelId);
      if (channel) {
        const targetUser = Array.from(channel.users.values()).find(
          u => u.userId === targetUserId
        );
        
        if (targetUser) {
          io.to(targetUser.socketId).emit('webrtc-ice-candidate', {
            userId,
            candidate
          });
        }
      }
    } else {
      // Broadcast a todos en el canal
      socket.to(channelId).emit('webrtc-ice-candidate', {
        userId,
        candidate
      });
    }
  });

  // Solicitar conexión WebRTC con usuario específico
  socket.on('request-webrtc-connection', ({ channelId, userId, targetUserId }) => {
    console.log(`🤝 ${userId} requesting WebRTC connection with ${targetUserId}`);
    
    const channel = channels.get(channelId);
    if (channel) {
      const targetUser = Array.from(channel.users.values()).find(
        u => u.userId === targetUserId
      );
      
      if (targetUser) {
        io.to(targetUser.socketId).emit('webrtc-connection-request', {
          userId
        });
      }
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
  console.log(`📊 Stats - Channels: ${channels.size}, Users: ${users.size}, Total Messages: ${totalMessages}`);
}, 300000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  console.log(`
╔════════════════════════════════════════╗
║   🎙️  Walkie-Talkie Server Running   ║
╠════════════════════════════════════════╣
║   Port: ${PORT.toString().padEnd(29)} ║
║   Host: 0.0.0.0${' '.repeat(22)} ║
║   Time: ${new Date().toLocaleTimeString().padEnd(29)} ║
╠════════════════════════════════════════╣
║   Endpoints:                           ║
║   GET  /                               ║
║   GET  /health                         ║
║   GET  /channels                       ║
║   POST /upload-audio                   ║
╚════════════════════════════════════════╝

📡 WebSocket ready on ws://0.0.0.0:${PORT}
  `);
  
  console.log('💡 Para probar localmente, usa una de estas URLs:');
  console.log(`   - http://localhost:${PORT}`);
  console.log(`   - http://192.168.x.x:${PORT} (reemplaza con tu IP local)`);
  console.log('');
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
    
    // Limpiar archivos temporales
    fs.readdir(audioDir, (err, files) => {
      if (!err) {
        files.forEach(file => {
          fs.unlink(path.join(audioDir, file), () => {});
        });
      }
    });
    
    process.exit(0);
  });
  
  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

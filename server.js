const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const ESP32_UDP_PORT = 4210;

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// UDP client for ESP32 communication
const udpClient = dgram.createSocket('udp4');

// Store ESP32 IP per client
const clientConfigs = new Map();

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('✓ Browser client connected');
  
  let esp32IP = null;
  let lastCommandTime = Date.now();
  let safetyTimer = null;

  // Safety timeout: if no commands in 250ms, send STOP
  const startSafetyTimer = () => {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      if (esp32IP) {
        sendToESP32('STOP');
        console.log('⚠ Safety timeout - sending STOP');
      }
    }, 250);
  };

  const sendToESP32 = (command) => {
    if (!esp32IP) return;
    
    const message = Buffer.from(command);
    udpClient.send(message, ESP32_UDP_PORT, esp32IP, (err) => {
      if (err) {
        console.error('UDP send error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to send to ESP32' }));
      }
    });
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'config':
          // Store ESP32 IP address
          esp32IP = data.ip;
          console.log(`📡 ESP32 IP configured: ${esp32IP}`);
          ws.send(JSON.stringify({ type: 'config_ack', ip: esp32IP }));
          break;
          
        case 'drive':
          // Drive command with left/right values
          const { left, right } = data;
          
          // Clamp values to [-1, 1]
          const l = Math.max(-1, Math.min(1, left));
          const r = Math.max(-1, Math.min(1, right));
          
          // Format: "left,right\n"
          const command = `${l.toFixed(3)},${r.toFixed(3)}\n`;
          sendToESP32(command);
          
          lastCommandTime = Date.now();
          startSafetyTimer();
          break;
          
        case 'stop':
          // Emergency stop
          sendToESP32('STOP\n');
          console.log('🛑 EMERGENCY STOP');
          break;
          
        case 'fire':
          // Fire button command
          sendToESP32('FIRE\n');
          console.log('🔥 FIRE BUTTON PRESSED');
          break;
      }
    } catch (error) {
      console.error('Message parse error:', error);
    }
  });

  ws.on('close', () => {
    console.log('✗ Browser client disconnected');
    if (safetyTimer) clearTimeout(safetyTimer);
    if (esp32IP) {
      sendToESP32('STOP\n');
      console.log('🛑 Client disconnected - sending STOP');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Helper function to get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  const localIP = getLocalIP();
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║  🤖 EEZY ESP32 Controller Server     ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🖥️  Local:   http://localhost:${PORT}`);
  console.log(`📱 Network: http://${localIP}:${PORT}`);
  console.log(`\n💡 Waiting for connections...\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  udpClient.close();
  server.close();
  process.exit(0);
});


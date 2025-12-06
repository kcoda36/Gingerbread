const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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

// Python autonomous process management
let pythonProcess = null;
let pythonRunning = false;

function startPythonAutonomous(mode, esp32IP) {
  // If process already running, just change mode
  if (pythonProcess && pythonRunning) {
    console.log(`🔄 Changing mode to: ${mode}`);
    changePythonMode(mode);
    return;
  }
  
  console.log(`🤖 Starting autonomous mode: ${mode}`);
  console.log(`📡 ESP32 IP: ${esp32IP}`);
  
  // Spawn Python process
  pythonProcess = spawn('python3', [
    path.join(__dirname, 'autonomous_gingerbread.py'),
    '--mode', mode,
    '--esp32-ip', esp32IP
  ]);
  
  pythonRunning = true;
  
  // Handle stdout
  pythonProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    console.log(`🐍 Python: ${message}`);
    
    // Broadcast status to all connected clients
    broadcastToClients({
      type: 'autonomous_status',
      message: message,
      running: true
    });
  });
  
  // Handle stderr
  pythonProcess.stderr.on('data', (data) => {
    const error = data.toString().trim();
    console.error(`🐍 Python Error: ${error}`);
    
    broadcastToClients({
      type: 'autonomous_error',
      message: error
    });
  });
  
  // Handle process exit
  pythonProcess.on('close', (code) => {
    console.log(`🐍 Python process exited with code ${code}`);
    pythonRunning = false;
    pythonProcess = null;
    
    broadcastToClients({
      type: 'autonomous_status',
      message: 'Autonomous mode stopped',
      running: false
    });
  });
  
  // Broadcast started status
  broadcastToClients({
    type: 'autonomous_started',
    mode: mode,
    running: true
  });
}

function changePythonMode(mode) {
  if (pythonProcess && pythonRunning) {
    // Send mode change command via stdin
    const modeCommand = mode.toUpperCase() + '\n';
    console.log(`📤 Sending mode change: ${mode}`);
    pythonProcess.stdin.write(modeCommand);
    
    broadcastToClients({
      type: 'autonomous_mode_changed',
      mode: mode,
      running: true
    });
    
    return true;
  }
  return false;
}

function stopPythonAutonomous() {
  if (pythonProcess) {
    console.log('🛑 Stopping autonomous mode...');
    
    // Try graceful shutdown first
    pythonProcess.kill('SIGTERM');
    
    // Force kill after 1 second if still running
    setTimeout(() => {
      if (pythonProcess) {
        console.log('⚠️  Process didn\'t stop, force killing with SIGKILL...');
        try {
          pythonProcess.kill('SIGKILL');
        } catch (e) {
          console.error('Error force killing:', e);
        }
        pythonProcess = null;
        pythonRunning = false;
      }
    }, 1000);
    
    pythonProcess = null;
    pythonRunning = false;
    
    broadcastToClients({
      type: 'autonomous_stopped',
      running: false
    });
    
    return true;
  }
  return false;
}

function broadcastToClients(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

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
          
        case 'start_autonomous':
          // Start autonomous mode or change mode
          if (!esp32IP) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'ESP32 IP not configured' 
            }));
            break;
          }
          
          const mode = data.mode || 'search_left';
          startPythonAutonomous(mode, esp32IP);
          ws.send(JSON.stringify({ 
            type: 'autonomous_ack', 
            mode: mode,
            running: true 
          }));
          break;
          
        case 'change_mode':
          // Change mode of running process
          if (!pythonRunning) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'No autonomous process running' 
            }));
            break;
          }
          
          const newMode = data.mode || 'stopped';
          changePythonMode(newMode);
          ws.send(JSON.stringify({ 
            type: 'autonomous_ack', 
            mode: newMode,
            running: true 
          }));
          break;
          
        case 'stop_autonomous':
          // Stop autonomous mode (kill process)
          const stopped = stopPythonAutonomous();
          ws.send(JSON.stringify({ 
            type: 'autonomous_ack', 
            running: false,
            stopped: stopped
          }));
          break;
          
        case 'autonomous_status':
          // Query autonomous mode status
          ws.send(JSON.stringify({
            type: 'autonomous_status',
            running: pythonRunning
          }));
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
  
  // Stop Python autonomous process if running
  if (pythonProcess) {
    console.log('🛑 Stopping autonomous process...');
    pythonProcess.kill('SIGTERM');
  }
  
  udpClient.close();
  server.close();
  process.exit(0);
});


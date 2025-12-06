// EEZY ESP32 Controller - Client Side JavaScript

class ESP32Controller {
  constructor() {
    this.ws = null;
    this.esp32IP = null;
    this.connected = false;
    
    // Control state
    this.keysDown = new Set();
    this.currentLeft = 0;
    this.currentRight = 0;
    
    // Gamepad state
    this.gamepad = null;
    this.gamepadConnected = false;
    this.gamepadDeadzone = 0.15; // Ignore small stick movements
    this.lastFireButtonState = false;
    
    // Gingerbread autonomous mode state
    this.gingerbreadMode = false;
    
    // Telemetry
    this.packetCount = 0;
    this.sendRate = 0;
    this.lastSendTimes = [];
    
    // Send frequency (50 Hz = 20ms interval)
    this.sendInterval = 20;
    this.controlLoop = null;
    
    // Relay state polling
    this.relayPollInterval = null;
    
    this.init();
  }
  
  init() {
    // Login screen handlers
    document.getElementById('connect-btn').addEventListener('click', () => this.connect());
    document.getElementById('esp32-ip').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.connect();
    });
    
    // Control screen handlers
    document.getElementById('disconnect-btn').addEventListener('click', () => this.disconnect());
    document.getElementById('stop-btn').addEventListener('click', () => this.emergencyStop());
    
    // Fire button - hold to activate, release to deactivate
    const fireBtn = document.getElementById('fire-btn');
    fireBtn.addEventListener('mousedown', () => this.relayOn());
    fireBtn.addEventListener('mouseup', () => this.relayOff());
    fireBtn.addEventListener('mouseleave', () => this.relayOff());
    fireBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.relayOn();
    });
    fireBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.relayOff();
    });
    fireBtn.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.relayOff();
    });
    
    // Gingerbread fire button - same behavior as main fire button
    const gingerbreadFireBtn = document.getElementById('gingerbread-fire-btn');
    gingerbreadFireBtn.addEventListener('mousedown', () => this.relayOn());
    gingerbreadFireBtn.addEventListener('mouseup', () => this.relayOff());
    gingerbreadFireBtn.addEventListener('mouseleave', () => this.relayOff());
    gingerbreadFireBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.relayOn();
    });
    gingerbreadFireBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.relayOff();
    });
    gingerbreadFireBtn.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.relayOff();
    });
    
    document.getElementById('gingerbread-mode-btn').addEventListener('click', () => this.toggleGingerbreadMode());
    document.getElementById('close-gingerbread-btn').addEventListener('click', () => this.toggleGingerbreadMode());
    
    // Autonomous mode button handlers (in gingerbread overlay)
    document.getElementById('search-left-btn').addEventListener('click', () => this.startAutonomous('search_left'));
    document.getElementById('search-right-btn').addEventListener('click', () => this.startAutonomous('search_right'));
    document.getElementById('track-btn').addEventListener('click', () => this.startAutonomous('track'));
    document.getElementById('follow-btn').addEventListener('click', () => this.startAutonomous('follow'));
    document.getElementById('stop-autonomous-btn').addEventListener('click', () => this.stopAutonomous());
    
    // Quick autonomous buttons (on main page)
    document.getElementById('quick-search-left').addEventListener('click', () => this.startAutonomous('search_left'));
    document.getElementById('quick-search-right').addEventListener('click', () => this.startAutonomous('search_right'));
    document.getElementById('quick-track').addEventListener('click', () => this.startAutonomous('track'));
    document.getElementById('quick-follow').addEventListener('click', () => this.startAutonomous('follow'));
    
    
    // Keypad button handlers
    document.querySelectorAll('.key-btn').forEach(btn => {
      const key = btn.dataset.key;
      
      btn.addEventListener('mousedown', () => this.keyDown(key));
      btn.addEventListener('mouseup', () => this.keyUp(key));
      btn.addEventListener('mouseleave', () => this.keyUp(key));
      
      // Touch support
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.keyDown(key);
      });
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.keyUp(key);
      });
    });
    
    // Keyboard controls
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    
    // Gamepad event listeners
    window.addEventListener('gamepadconnected', (e) => this.onGamepadConnected(e));
    window.addEventListener('gamepaddisconnected', (e) => this.onGamepadDisconnected(e));
  }
  
  connect() {
    const ipInput = document.getElementById('esp32-ip');
    this.esp32IP = ipInput.value.trim();
    
    if (!this.esp32IP) {
      alert('Please enter ESP32 IP address');
      return;
    }
    
    // Validate IP format (basic)
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(this.esp32IP)) {
      alert('Invalid IP address format');
      return;
    }
    
    this.updateStatus('connecting', 'CONNECTING...');
    
    // Connect to Node.js WebSocket server
    const wsURL = `ws://${window.location.hostname}:${window.location.port || 3000}`;
    this.ws = new WebSocket(wsURL);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      // Send ESP32 IP configuration
      this.send({ type: 'config', ip: this.esp32IP });
    };
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'config_ack') {
        this.connected = true;
        this.switchScreen('control');
        this.updateStatus('connected', 'CONNECTED');
        document.getElementById('esp32-ip-display').textContent = this.esp32IP;
        this.startControlLoop();
        this.updateGamepadStatus();
      }
      
      if (data.type === 'error') {
        console.error('Error:', data.message);
        this.updateStatus('error', 'ERROR');
      }
      
      if (data.type === 'autonomous_started' || data.type === 'autonomous_ack' || data.type === 'autonomous_mode_changed') {
        if (data.running) {
          const displayMode = (data.mode || 'active').toUpperCase().replace('_', ' ');
          this.updateAutonomousStatus(displayMode, true);
        } else {
          this.updateAutonomousStatus('INACTIVE', false);
        }
      }
      
      if (data.type === 'autonomous_stopped') {
        this.updateAutonomousStatus('INACTIVE', false);
      }
      
      if (data.type === 'autonomous_status') {
        if (data.message) {
          console.log('🤖 Autonomous:', data.message);
        }
        if (data.running !== undefined) {
          this.updateAutonomousStatus(data.running ? 'RUNNING' : 'INACTIVE', data.running);
        }
      }
      
      if (data.type === 'autonomous_error') {
        console.error('🤖 Autonomous Error:', data.message);
        this.updateAutonomousStatus('ERROR', false);
      }
    };
    
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.updateStatus('error', 'CONNECTION ERROR');
      alert('Failed to connect to server. Make sure the server is running.');
    };
    
    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.connected = false;
      this.stopControlLoop();
      if (document.getElementById('control-screen').classList.contains('active')) {
        this.updateStatus('disconnected', 'DISCONNECTED');
      }
    };
  }
  
  disconnect() {
    if (this.ws) {
      this.send({ type: 'stop' });
      this.ws.close();
    }
    this.stopControlLoop();
    this.keysDown.clear();
    this.switchScreen('login');
  }
  
  switchScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`${screen}-screen`).classList.add('active');
  }
  
  updateStatus(state, text) {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    
    indicator.className = 'status-indicator';
    if (state === 'connected') {
      indicator.classList.add('connected');
    }
    
    statusText.textContent = text;
  }
  
  // Control loop - sends commands at 50 Hz
  startControlLoop() {
    this.controlLoop = setInterval(() => {
      this.computeAndSendControl();
    }, this.sendInterval);
    
    // Start polling relay state
    this.startRelayPolling();
  }
  
  stopControlLoop() {
    if (this.controlLoop) {
      clearInterval(this.controlLoop);
      this.controlLoop = null;
    }
    
    this.stopRelayPolling();
  }
  
  startRelayPolling() {
    // Poll relay state every 500ms
    this.relayPollInterval = setInterval(() => {
      this.pollRelayState();
    }, 500);
  }
  
  stopRelayPolling() {
    if (this.relayPollInterval) {
      clearInterval(this.relayPollInterval);
      this.relayPollInterval = null;
    }
  }
  
  async pollRelayState() {
    if (!this.esp32IP) return;
    
    try {
      const response = await fetch(`http://${this.esp32IP}/relay/state`, {
        method: 'GET'
      });
      const state = await response.text();
      
      const relayStatus = document.getElementById('relay-status');
      if (state === '1') {
        relayStatus.textContent = '🔥 ON';
        relayStatus.style.color = 'var(--accent-fire)';
      } else {
        relayStatus.textContent = 'OFF';
        relayStatus.style.color = 'var(--text-secondary)';
      }
    } catch (error) {
      // Silently fail - relay polling is not critical
      document.getElementById('relay-status').textContent = '---';
      document.getElementById('relay-status').style.color = 'var(--text-secondary)';
    }
  }
  
  computeAndSendControl() {
    if (!this.connected) return;
    
    // CRITICAL: Skip ALL control when gingerbread mode is active
    // Python autonomous script has FULL control of ESP32
    if (this.gingerbreadMode) {
      return; // Don't send ANY commands - Python is in control!
    }
    
    let throttle = 0;
    let turn = 0;
    
    if (this.cameraMode) {
      // Camera control mode
      if (this.handDetected && this.fistClosed) {
        // Only drive if fist is closed
        const deadzoneMin = -this.deadzoneWidth / 2;
        const deadzoneMax = this.deadzoneWidth / 2;
        
        if (this.handPosition < deadzoneMin) {
          // Left zone - turn left
          turn = -1 * Math.abs((this.handPosition - deadzoneMin) / (0.5 - this.deadzoneWidth / 2));
          turn = Math.max(-1, turn);
          throttle = 0.6; // Forward speed
        } else if (this.handPosition > deadzoneMax) {
          // Right zone - turn right
          turn = Math.abs((this.handPosition - deadzoneMax) / (0.5 - this.deadzoneWidth / 2));
          turn = Math.min(1, turn);
          throttle = 0.6; // Forward speed
        } else {
          // Deadzone - go straight
          turn = 0;
          throttle = 0.6; // Forward speed
        }
      } else {
        // No hand detected or fist not closed - stop
        throttle = 0;
        turn = 0;
      }
    } else {
      // Keyboard control mode
      // Forward/Backward
      if (this.keysDown.has('up')) throttle += 1;
      if (this.keysDown.has('down')) throttle -= 1;
      
      // Left/Right
      if (this.keysDown.has('left')) turn -= 1;
      if (this.keysDown.has('right')) turn += 1;
      
      // Gamepad input (additive with keyboard)
      const gamepadInput = this.processGamepadInput();
      throttle += gamepadInput.throttle;
      turn += gamepadInput.turn;
      
      // Handle gamepad fire button
      if (gamepadInput.fire && !this.lastFireButtonState) {
        this.relayOn();
      } else if (!gamepadInput.fire && this.lastFireButtonState) {
        this.relayOff();
      }
      this.lastFireButtonState = gamepadInput.fire;
      
      // Handle gamepad emergency stop
      if (gamepadInput.stop) {
        this.emergencyStop();
      }
    }
    
    // Convert to tank drive (differential)
    let left = throttle + turn;
    let right = throttle - turn;
    
    // Clamp to [-1, 1]
    left = Math.max(-1, Math.min(1, left));
    right = Math.max(-1, Math.min(1, right));
    
    // Smooth transition (exponential moving average)
    // Higher smoothing = faster response (0.8 = 80% of target value each update)
    const smoothing = 0.8;
    this.currentLeft = this.currentLeft * (1 - smoothing) + left * smoothing;
    this.currentRight = this.currentRight * (1 - smoothing) + right * smoothing;
    
    // Send to server
    this.send({
      type: 'drive',
      left: this.currentLeft,
      right: this.currentRight
    });
    
    // Update telemetry
    this.updateTelemetry();
  }
  
  updateTelemetry() {
    // Update motor values in header
    document.getElementById('left-value').textContent = this.currentLeft.toFixed(3);
    document.getElementById('right-value').textContent = this.currentRight.toFixed(3);
    
    // Calculate send rate
    const now = Date.now();
    this.lastSendTimes.push(now);
    this.lastSendTimes = this.lastSendTimes.filter(t => now - t < 1000);
    this.sendRate = this.lastSendTimes.length;
    
    document.getElementById('send-rate').textContent = `${this.sendRate} Hz`;
  }
  
  emergencyStop() {
    this.keysDown.clear();
    this.currentLeft = 0;
    this.currentRight = 0;
    this.send({ type: 'stop' });
    this.updateButtonStates();
    
    // Kill autonomous mode if it's running
    if (this.gingerbreadMode) {
      this.stopAutonomous();
    }
    
    // Visual feedback
    const btn = document.getElementById('stop-btn');
    btn.style.transform = 'scale(0.9)';
    setTimeout(() => btn.style.transform = '', 100);
  }
  
  async relayOn() {
    if (!this.esp32IP) return;
    
    try {
      await fetch(`http://${this.esp32IP}/relay/on`, {
        method: 'GET',
        mode: 'no-cors'
      });
      console.log('🔥 Relay ON');
      
      // Visual feedback
      const btn = document.getElementById('fire-btn');
      btn.classList.add('active');
      btn.style.transform = 'scale(0.95)';
    } catch (error) {
      console.error('Relay ON error:', error);
    }
  }
  
  async relayOff() {
    if (!this.esp32IP) return;
    
    try {
      await fetch(`http://${this.esp32IP}/relay/off`, {
        method: 'GET',
        mode: 'no-cors'
      });
      console.log('🔥 Relay OFF');
      
      // Visual feedback
      const btn = document.getElementById('fire-btn');
      btn.classList.remove('active');
      btn.style.transform = 'scale(1)';
    } catch (error) {
      console.error('Relay OFF error:', error);
    }
  }
  
  keyDown(key) {
    this.keysDown.add(key);
    this.updateButtonStates();
  }
  
  keyUp(key) {
    this.keysDown.delete(key);
    this.updateButtonStates();
  }
  
  updateButtonStates() {
    document.querySelectorAll('.key-btn').forEach(btn => {
      const key = btn.dataset.key;
      if (this.keysDown.has(key)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
  
  handleKeyDown(e) {
    if (!this.connected) return;
    
    // Prevent default for control keys
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd', 'f'].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
    
    // Map keys
    const keyMap = {
      'ArrowUp': 'up',
      'w': 'up',
      'W': 'up',
      'ArrowDown': 'down',
      's': 'down',
      'S': 'down',
      'ArrowLeft': 'left',
      'a': 'left',
      'A': 'left',
      'ArrowRight': 'right',
      'd': 'right',
      'D': 'right'
    };
    
    if (keyMap[e.key]) {
      this.keyDown(keyMap[e.key]);
    }
    
    // Special keys
    if (e.key === ' ') {
      this.emergencyStop();
    }
  }
  
  handleKeyUp(e) {
    if (!this.connected) return;
    
    const keyMap = {
      'ArrowUp': 'up',
      'w': 'up',
      'W': 'up',
      'ArrowDown': 'down',
      's': 'down',
      'S': 'down',
      'ArrowLeft': 'left',
      'a': 'left',
      'A': 'left',
      'ArrowRight': 'right',
      'd': 'right',
      'D': 'right'
    };
    
    if (keyMap[e.key]) {
      this.keyUp(keyMap[e.key]);
    }
  }
  
  // Gamepad Support
  onGamepadConnected(e) {
    console.log('🎮 Gamepad connected:', e.gamepad.id);
    this.gamepadConnected = true;
    this.updateGamepadStatus();
  }
  
  onGamepadDisconnected(e) {
    console.log('🎮 Gamepad disconnected:', e.gamepad.id);
    this.gamepadConnected = false;
    this.gamepad = null;
    this.updateGamepadStatus();
  }
  
  updateGamepadStatus() {
    const statusElement = document.getElementById('gamepad-status');
    if (statusElement) {
      if (this.gamepadConnected) {
        statusElement.textContent = '🎮 CONNECTED';
        statusElement.style.color = '#00d4ff';
      } else {
        statusElement.textContent = '🎮 NO GAMEPAD';
        statusElement.style.color = '#666';
      }
    }
  }
  
  getGamepadInput() {
    // Get the latest gamepad state
    const gamepads = navigator.getGamepads();
    if (!gamepads) return null;
    
    // Find connected gamepad
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i] && gamepads[i].connected) {
        this.gamepad = gamepads[i];
        return this.gamepad;
      }
    }
    return null;
  }
  
  processGamepadInput() {
    const gp = this.getGamepadInput();
    if (!gp) return { throttle: 0, turn: 0, fire: false, stop: false };
    
    // PS5 Controller Mapping:
    // Axes: 0=Left X, 1=Left Y, 2=Right X, 3=Right Y
    // Buttons: 0=X, 1=O, 2=Square, 3=Triangle, 
    //          4=L1, 5=R1, 6=L2, 7=R2,
    //          8=Share, 9=Options, 10=L3, 11=R3,
    //          12=D-Up, 13=D-Down, 14=D-Left, 15=D-Right
    
    const leftStickX = gp.axes[0] || 0;
    const leftStickY = gp.axes[1] || 0;
    const rightTrigger = gp.buttons[7] ? gp.buttons[7].value : 0; // R2
    const optionsButton = gp.buttons[9] ? gp.buttons[9].pressed : false;
    
    // Apply deadzone
    const applyDeadzone = (value) => {
      return Math.abs(value) < this.gamepadDeadzone ? 0 : value;
    };
    
    let throttle = -applyDeadzone(leftStickY); // Inverted (up is negative)
    let turn = applyDeadzone(leftStickX);
    
    // Handle D-pad as alternative control
    if (gp.buttons[12] && gp.buttons[12].pressed) throttle = 1;  // D-Up
    if (gp.buttons[13] && gp.buttons[13].pressed) throttle = -1; // D-Down
    if (gp.buttons[14] && gp.buttons[14].pressed) turn = -1;     // D-Left
    if (gp.buttons[15] && gp.buttons[15].pressed) turn = 1;      // D-Right
    
    // Fire button (R2 trigger)
    const fire = rightTrigger > 0.5;
    
    return {
      throttle,
      turn,
      fire,
      stop: optionsButton
    };
  }
  
  // Gingerbread Autonomous Mode
  toggleGingerbreadMode() {
    this.gingerbreadMode = !this.gingerbreadMode;
    const overlay = document.getElementById('gingerbread-overlay');
    const btn = document.getElementById('gingerbread-mode-btn');
    
    if (this.gingerbreadMode) {
      btn.classList.add('active');
      overlay.classList.add('active');
    } else {
      btn.classList.remove('active');
      overlay.classList.remove('active');
      // Kill autonomous process when closing overlay
      if (this.connected) {
        console.log('🛑 Closing gingerbread mode - killing Python process');
        this.send({ type: 'stop_autonomous' });
      }
    }
  }
  
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      this.packetCount++;
    }
  }
  
  // Autonomous Mode Control
  startAutonomous(mode) {
    if (!this.connected) {
      alert('Please connect to ESP32 first');
      return;
    }
    
    console.log(`🤖 Switching to autonomous mode: ${mode}`);
    
    // Send as mode change (will start if not running, or change mode if running)
    this.send({
      type: 'start_autonomous',
      mode: mode
    });
    
    // Visual feedback
    this.updateAutonomousStatus(`Mode: ${mode}`, true);
  }
  
  stopAutonomous() {
    console.log('🛑 KILLING autonomous process');
    
    // STOP = Kill the Python process entirely
    this.send({
      type: 'stop_autonomous'
    });
    
    // Visual feedback
    this.updateAutonomousStatus('STOPPED - Process killed', false);
  }
  
  updateAutonomousStatus(text, isActive) {
    const statusElement = document.getElementById('autonomous-status-text');
    if (statusElement) {
      statusElement.textContent = text;
      
      if (isActive) {
        statusElement.style.color = 'var(--success)';
        statusElement.style.fontWeight = '700';
      } else {
        statusElement.style.color = 'var(--text-secondary)';
        statusElement.style.fontWeight = '400';
      }
    }
  }
}

// Initialize controller when page loads
document.addEventListener('DOMContentLoaded', () => {
  new ESP32Controller();
});


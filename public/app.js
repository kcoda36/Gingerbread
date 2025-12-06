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
    
    // Camera control state
    this.cameraMode = false;
    this.handPosition = 0; // -1 to 1, 0 is center
    this.handDetected = false;
    this.fistClosed = false;
    this.cameraStream = null;
    this.hands = null;
    this.camera = null;
    
    // Gingerbread tracking state
    this.gingerbreadMode = false;
    this.gingerbreadPosition = 0;
    this.gingerbreadDetected = false;
    this.gingerbreadStream = null;
    this.gingerbreadAnimationFrame = null;
    this.blobSize = 0;
    
    // Deadzone configuration (30% width in center, 40% height in center)
    this.deadzoneWidth = 0.30;
    this.deadzoneHeight = 0.40;
    
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
    document.getElementById('fire-btn').addEventListener('click', () => this.fireButton());
    document.getElementById('fullscreen-btn').addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('camera-mode-btn').addEventListener('click', () => this.toggleCameraMode());
    document.getElementById('close-camera-btn').addEventListener('click', () => this.toggleCameraMode());
    document.getElementById('gingerbread-mode-btn').addEventListener('click', () => this.toggleGingerbreadMode());
    document.getElementById('close-gingerbread-btn').addEventListener('click', () => this.toggleGingerbreadMode());
    
    // Listen for fullscreen changes
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButton());
    document.addEventListener('webkitfullscreenchange', () => this.updateFullscreenButton());
    document.addEventListener('mozfullscreenchange', () => this.updateFullscreenButton());
    document.addEventListener('msfullscreenchange', () => this.updateFullscreenButton());
    
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
    
    // Fire button touch support
    const fireBtn = document.getElementById('fire-btn');
    fireBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.fireButton();
    });
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
      }
      
      if (data.type === 'error') {
        console.error('Error:', data.message);
        this.updateStatus('error', 'ERROR');
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
    
    let throttle = 0;
    let turn = 0;
    
    if (this.gingerbreadMode) {
      // Gingerbread tracking mode
      if (this.gingerbreadDetected) {
        const deadzoneMin = -this.deadzoneWidth / 2;
        const deadzoneMax = this.deadzoneWidth / 2;
        
        if (this.gingerbreadPosition < deadzoneMin) {
          // Left zone - turn left
          turn = -1 * Math.abs((this.gingerbreadPosition - deadzoneMin) / (0.5 - this.deadzoneWidth / 2));
          turn = Math.max(-1, turn);
          throttle = 0.5; // Forward speed
        } else if (this.gingerbreadPosition > deadzoneMax) {
          // Right zone - turn right
          turn = Math.abs((this.gingerbreadPosition - deadzoneMax) / (0.5 - this.deadzoneWidth / 2));
          turn = Math.min(1, turn);
          throttle = 0.5; // Forward speed
        } else {
          // Deadzone - go straight
          turn = 0;
          throttle = 0.5; // Forward speed
        }
      } else {
        // No gingerbread detected - stop
        throttle = 0;
        turn = 0;
      }
    } else if (this.cameraMode) {
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
    }
    
    // Convert to tank drive (differential)
    let left = throttle + turn;
    let right = throttle - turn;
    
    // Clamp to [-1, 1]
    left = Math.max(-1, Math.min(1, left));
    right = Math.max(-1, Math.min(1, right));
    
    // Smooth transition (exponential moving average)
    const smoothing = this.cameraMode ? 0.4 : 0.3;
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
    // Update motor values
    document.getElementById('left-value').textContent = this.currentLeft.toFixed(3);
    document.getElementById('right-value').textContent = this.currentRight.toFixed(3);
    
    // Update bars (convert -1 to 1 → 0 to 100%)
    const leftPercent = (Math.abs(this.currentLeft) * 100);
    const rightPercent = (Math.abs(this.currentRight) * 100);
    document.getElementById('left-bar').style.width = `${leftPercent}%`;
    document.getElementById('right-bar').style.width = `${rightPercent}%`;
    
    // Calculate send rate
    const now = Date.now();
    this.lastSendTimes.push(now);
    this.lastSendTimes = this.lastSendTimes.filter(t => now - t < 1000);
    this.sendRate = this.lastSendTimes.length;
    
    document.getElementById('send-rate').textContent = `${this.sendRate} Hz`;
    document.getElementById('packet-count').textContent = this.packetCount;
  }
  
  emergencyStop() {
    this.keysDown.clear();
    this.currentLeft = 0;
    this.currentRight = 0;
    this.send({ type: 'stop' });
    this.updateButtonStates();
    
    // Visual feedback
    const btn = document.getElementById('stop-btn');
    btn.style.transform = 'scale(0.9)';
    setTimeout(() => btn.style.transform = '', 100);
  }
  
  async fireButton() {
    this.send({ type: 'fire' });
    
    // Send HTTP request directly to ESP32 to toggle relay
    if (this.esp32IP) {
      try {
        const response = await fetch(`http://${this.esp32IP}/relay/toggle`, {
          method: 'GET',
          mode: 'no-cors' // ESP32 has CORS enabled, but no-cors as fallback
        });
        console.log('🔥 Relay toggled');
      } catch (error) {
        console.error('Relay toggle error:', error);
      }
    }
    
    // Visual feedback
    const btn = document.getElementById('fire-btn');
    btn.style.transform = 'scale(0.9)';
    setTimeout(() => btn.style.transform = '', 150);
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
    if (e.key === 'f' || e.key === 'F') {
      this.fireButton();
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
  
  toggleFullscreen() {
    const elem = document.documentElement;
    
    // Check if currently in fullscreen
    const isFullscreen = document.fullscreenElement || 
                         document.webkitFullscreenElement || 
                         document.mozFullScreenElement || 
                         document.msFullscreenElement;
    
    if (!isFullscreen) {
      // Enter fullscreen
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(err => {
          console.error('Error attempting to enable fullscreen:', err);
        });
      } else if (elem.webkitRequestFullscreen) { // Safari
        elem.webkitRequestFullscreen();
      } else if (elem.mozRequestFullScreen) { // Firefox
        elem.mozRequestFullScreen();
      } else if (elem.msRequestFullscreen) { // IE11
        elem.msRequestFullscreen();
      } else {
        console.warn('Fullscreen API not supported');
        alert('Fullscreen mode is not supported on this browser');
      }
    } else {
      // Exit fullscreen
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) { // Safari
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) { // Firefox
        document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) { // IE11
        document.msExitFullscreen();
      }
    }
  }
  
  updateFullscreenButton() {
    const btn = document.getElementById('fullscreen-btn');
    if (!btn) return;
    
    const isFullscreen = document.fullscreenElement || 
                         document.webkitFullscreenElement || 
                         document.mozFullScreenElement || 
                         document.msFullscreenElement;
    
    const icon = btn.querySelector('.fullscreen-icon');
    if (isFullscreen) {
      icon.textContent = '⛶';
      btn.title = 'Exit Fullscreen';
    } else {
      icon.textContent = '⛶';
      btn.title = 'Enter Fullscreen';
    }
  }
  
  // Camera Mode
  async toggleCameraMode() {
    this.cameraMode = !this.cameraMode;
    const overlay = document.getElementById('camera-overlay');
    const btn = document.getElementById('camera-mode-btn');
    
    if (this.cameraMode) {
      btn.classList.add('active');
      overlay.classList.add('active');
      await this.startCamera();
    } else {
      btn.classList.remove('active');
      overlay.classList.remove('active');
      this.stopCamera();
    }
  }
  
  async startCamera() {
    try {
      // Request camera access
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });
      
      const video = document.getElementById('camera-video');
      video.srcObject = this.cameraStream;
      
      // Initialize MediaPipe Hands
      this.hands = new Hands({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
        }
      });
      
      this.hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      
      this.hands.onResults((results) => this.onHandResults(results));
      
      // Start camera
      this.camera = new Camera(video, {
        onFrame: async () => {
          await this.hands.send({ image: video });
        },
        width: 640,
        height: 480
      });
      
      this.camera.start();
      
      console.log('📷 Camera started with hand tracking');
    } catch (error) {
      console.error('Camera access error:', error);
      alert('Unable to access camera. Please allow camera permissions.');
      this.toggleCameraMode();
    }
  }
  
  stopCamera() {
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    }
    
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
      this.cameraStream = null;
    }
    
    if (this.hands) {
      this.hands.close();
      this.hands = null;
    }
    
    this.handDetected = false;
    this.handPosition = 0;
    
    console.log('📷 Camera stopped');
  }
  
  calculateHandCenter(landmarks) {
    // Calculate the center of all landmarks
    let sumX = 0, sumY = 0;
    for (const landmark of landmarks) {
      sumX += landmark.x;
      sumY += landmark.y;
    }
    return {
      x: sumX / landmarks.length,
      y: sumY / landmarks.length
    };
  }
  
  detectFist(landmarks) {
    // Detect closed fist by checking if fingertips are close to palm
    // landmarks: 0=wrist, 4=thumb tip, 8=index tip, 12=middle tip, 16=ring tip, 20=pinky tip
    const wrist = landmarks[0];
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const pinkyTip = landmarks[20];
    
    // Calculate distances from fingertips to wrist
    const distance = (p1, p2) => {
      return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    };
    
    const thumbDist = distance(thumbTip, wrist);
    const indexDist = distance(indexTip, wrist);
    const middleDist = distance(middleTip, wrist);
    const ringDist = distance(ringTip, wrist);
    const pinkyDist = distance(pinkyTip, wrist);
    
    // Average distance when hand is open (roughly 0.3-0.4)
    // When closed, fingers are closer (roughly 0.1-0.2)
    const avgDist = (indexDist + middleDist + ringDist + pinkyDist) / 4;
    
    // Threshold: if average distance is less than 0.18, it's a fist
    return avgDist < 0.18;
  }
  
  onHandResults(results) {
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    const video = document.getElementById('camera-video');
    
    // Set canvas size to match the displayed size of video element
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Check if hand is detected
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const landmarks = results.multiHandLandmarks[0];
      this.handDetected = true;
      
      // Calculate hand center (average of all landmarks)
      const handCenter = this.calculateHandCenter(landmarks);
      
      // Detect if fist is closed
      this.fistClosed = this.detectFist(landmarks);
      
      // Position: don't flip - hand right = positive (turn right), hand left = negative (turn left)
      this.handPosition = (handCenter.x - 0.5);
      
      // DON'T mirror in JavaScript - CSS already mirrors both video and canvas!
      // Just draw normally, CSS handles the mirroring
      
      // Draw connections manually
      const connections = [
        [0,1],[1,2],[2,3],[3,4], // Thumb
        [0,5],[5,6],[6,7],[7,8], // Index
        [0,9],[9,10],[10,11],[11,12], // Middle
        [0,13],[13,14],[14,15],[15,16], // Ring
        [0,17],[17,18],[18,19],[19,20], // Pinky
        [5,9],[9,13],[13,17] // Palm
      ];
      
      ctx.strokeStyle = this.fistClosed ? '#00ff88' : '#00d4ff';
      ctx.lineWidth = 3;
      
      for (const [start, end] of connections) {
        const startLm = landmarks[start];
        const endLm = landmarks[end];
        
        ctx.beginPath();
        ctx.moveTo(startLm.x * canvas.width, startLm.y * canvas.height);
        ctx.lineTo(endLm.x * canvas.width, endLm.y * canvas.height);
        ctx.stroke();
      }
      
      // Draw landmark points
      ctx.fillStyle = this.fistClosed ? '#00ff88' : '#ff2e63';
      for (const lm of landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 4, 0, 2 * Math.PI);
        ctx.fill();
      }
      
      // Draw center indicator
      const centerX = handCenter.x * canvas.width;
      const centerY = handCenter.y * canvas.height;
      
      ctx.beginPath();
      ctx.arc(centerX, centerY, 15, 0, 2 * Math.PI);
      ctx.fillStyle = this.fistClosed ? '#00ff88' : '#ffaa00';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
      
      // Draw center dot
      ctx.beginPath();
      ctx.arc(centerX, centerY, 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#000';
      ctx.fill();
      
      // Update UI
      document.getElementById('hand-status').textContent = 'YES';
      document.getElementById('hand-status').style.color = 'var(--success)';
      
      document.getElementById('fist-status').textContent = this.fistClosed ? '👊 YES' : 'NO';
      document.getElementById('fist-status').style.color = this.fistClosed ? 'var(--success)' : 'var(--text-secondary)';
      
      document.getElementById('hand-position').textContent = this.handPosition.toFixed(3);
      
      // Determine command
      const deadzoneMin = -this.deadzoneWidth / 2;
      const deadzoneMax = this.deadzoneWidth / 2;
      let command = 'STOP';
      
      // Update zone highlights
      document.querySelectorAll('.zone').forEach(z => z.classList.remove('active'));
      
      if (this.fistClosed) {
        if (this.handPosition < deadzoneMin) {
          command = '← TURN LEFT';
          // Camera is mirrored, so swap the zone highlights
          document.querySelector('.zone-right').classList.add('active');
        } else if (this.handPosition > deadzoneMax) {
          command = 'TURN RIGHT →';
          // Camera is mirrored, so swap the zone highlights
          document.querySelector('.zone-left').classList.add('active');
        } else {
          command = '↑ FORWARD';
        }
      } else {
        command = 'STOP (Open Hand)';
      }
      
      document.getElementById('hand-command').textContent = command;
      
    } else {
      this.handDetected = false;
      this.fistClosed = false;
      this.handPosition = 0;
      
      document.getElementById('hand-status').textContent = 'NO';
      document.getElementById('hand-status').style.color = 'var(--text-secondary)';
      document.getElementById('fist-status').textContent = 'NO';
      document.getElementById('fist-status').style.color = 'var(--text-secondary)';
      document.getElementById('hand-position').textContent = '---';
      document.getElementById('hand-command').textContent = 'STOP';
      
      document.querySelectorAll('.zone').forEach(z => z.classList.remove('active'));
    }
  }
  
  // Gingerbread Mode
  async toggleGingerbreadMode() {
    // Close hand mode if open
    if (this.cameraMode) {
      await this.toggleCameraMode();
    }
    
    this.gingerbreadMode = !this.gingerbreadMode;
    const overlay = document.getElementById('gingerbread-overlay');
    const btn = document.getElementById('gingerbread-mode-btn');
    
    if (this.gingerbreadMode) {
      btn.classList.add('active');
      overlay.classList.add('active');
      await this.startGingerbreadTracking();
    } else {
      btn.classList.remove('active');
      overlay.classList.remove('active');
      this.stopGingerbreadTracking();
    }
  }
  
  async startGingerbreadTracking() {
    try {
      // Request camera access
      this.gingerbreadStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });
      
      const video = document.getElementById('gingerbread-video');
      video.srcObject = this.gingerbreadStream;
      
      // Wait for video to be ready
      await new Promise(resolve => {
        video.onloadedmetadata = () => {
          video.play();
          resolve();
        };
      });
      
      // Start processing loop
      this.processGingerbreadFrame();
      
      console.log('🍪 Gingerbread tracking started');
    } catch (error) {
      console.error('Camera access error:', error);
      alert('Unable to access camera. Please allow camera permissions.');
      this.toggleGingerbreadMode();
    }
  }
  
  stopGingerbreadTracking() {
    if (this.gingerbreadAnimationFrame) {
      cancelAnimationFrame(this.gingerbreadAnimationFrame);
      this.gingerbreadAnimationFrame = null;
    }
    
    if (this.gingerbreadStream) {
      this.gingerbreadStream.getTracks().forEach(track => track.stop());
      this.gingerbreadStream = null;
    }
    
    this.gingerbreadDetected = false;
    this.gingerbreadPosition = 0;
    this.blobSize = 0;
    
    console.log('🍪 Gingerbread tracking stopped');
  }
  
  processGingerbreadFrame() {
    if (!this.gingerbreadMode) return;
    
    const video = document.getElementById('gingerbread-video');
    const canvas = document.getElementById('gingerbread-canvas');
    const ctx = canvas.getContext('2d');
    
    // Set canvas size to match video display
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    
    // Draw video frame to canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // Detect brown pixels and find largest blob
    const brownMask = new Uint8Array(canvas.width * canvas.height);
    
    // Pass 1: Detect brown pixels
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Check if pixel is brown (gingerbread color)
      if (this.isBrown(r, g, b)) {
        brownMask[i / 4] = 1;
      }
    }
    
    // Find largest connected blob
    const blob = this.findLargestBlob(brownMask, canvas.width, canvas.height);
    
    // Clear canvas and redraw
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (blob && blob.size > 500) { // Minimum size threshold
      this.gingerbreadDetected = true;
      this.blobSize = blob.size;
      
      // Calculate position relative to center
      this.gingerbreadPosition = (blob.centerX / canvas.width) - 0.5;
      
      // Draw blob outline
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 3;
      ctx.strokeRect(blob.minX, blob.minY, blob.maxX - blob.minX, blob.maxY - blob.minY);
      
      // Draw center crosshair
      ctx.fillStyle = '#00ff88';
      ctx.beginPath();
      ctx.arc(blob.centerX, blob.centerY, 10, 0, 2 * Math.PI);
      ctx.fill();
      
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(blob.centerX - 15, blob.centerY);
      ctx.lineTo(blob.centerX + 15, blob.centerY);
      ctx.moveTo(blob.centerX, blob.centerY - 15);
      ctx.lineTo(blob.centerX, blob.centerY + 15);
      ctx.stroke();
      
      // Update UI
      document.getElementById('gingerbread-status').textContent = 'YES';
      document.getElementById('gingerbread-status').style.color = 'var(--success)';
      document.getElementById('blob-size').textContent = blob.size;
      document.getElementById('gingerbread-position').textContent = this.gingerbreadPosition.toFixed(3);
      
      // Update zones
      const deadzoneMin = -this.deadzoneWidth / 2;
      const deadzoneMax = this.deadzoneWidth / 2;
      let command = 'STOP';
      
      document.querySelectorAll('#gingerbread-overlay .zone').forEach(z => z.classList.remove('active'));
      
      if (this.gingerbreadPosition < deadzoneMin) {
        command = '← TURN LEFT';
        document.querySelector('#gingerbread-overlay .zone-left').classList.add('active');
      } else if (this.gingerbreadPosition > deadzoneMax) {
        command = 'TURN RIGHT →';
        document.querySelector('#gingerbread-overlay .zone-right').classList.add('active');
      } else {
        command = '↑ FORWARD';
      }
      
      document.getElementById('gingerbread-command').textContent = command;
      
    } else {
      this.gingerbreadDetected = false;
      this.blobSize = 0;
      
      document.getElementById('gingerbread-status').textContent = 'NO';
      document.getElementById('gingerbread-status').style.color = 'var(--text-secondary)';
      document.getElementById('blob-size').textContent = '0';
      document.getElementById('gingerbread-position').textContent = '---';
      document.getElementById('gingerbread-command').textContent = 'STOP';
      
      document.querySelectorAll('#gingerbread-overlay .zone').forEach(z => z.classList.remove('active'));
    }
    
    // Continue processing
    this.gingerbreadAnimationFrame = requestAnimationFrame(() => this.processGingerbreadFrame());
  }
  
  isBrown(r, g, b) {
    // Brown detection: looking for gingerbread color
    // Brown is: red-dominant, with moderate green, low blue
    // Typical gingerbread: RGB around (139, 90, 43) to (210, 150, 90)
    
    // Must be somewhat red
    if (r < 80) return false;
    
    // Red should be dominant
    if (r < g || r < b) return false;
    
    // Green should be moderate (not too high, not too low)
    if (g < 40 || g > r * 0.85) return false;
    
    // Blue should be lowest
    if (b > g || b > r * 0.6) return false;
    
    // Check overall brightness (not too dark, not too bright)
    const brightness = (r + g + b) / 3;
    if (brightness < 60 || brightness > 180) return false;
    
    return true;
  }
  
  findLargestBlob(mask, width, height) {
    const visited = new Uint8Array(width * height);
    let largestBlob = null;
    let largestSize = 0;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        
        if (mask[idx] === 1 && visited[idx] === 0) {
          // Start flood fill
          const blob = this.floodFill(mask, visited, x, y, width, height);
          
          if (blob.size > largestSize) {
            largestSize = blob.size;
            largestBlob = blob;
          }
        }
      }
    }
    
    return largestBlob;
  }
  
  floodFill(mask, visited, startX, startY, width, height) {
    const stack = [[startX, startY]];
    let size = 0;
    let sumX = 0, sumY = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      const idx = y * width + x;
      
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (visited[idx] === 1 || mask[idx] === 0) continue;
      
      visited[idx] = 1;
      size++;
      sumX += x;
      sumY += y;
      
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      
      // Add neighbors
      stack.push([x + 1, y]);
      stack.push([x - 1, y]);
      stack.push([x, y + 1]);
      stack.push([x, y - 1]);
    }
    
    return {
      size,
      centerX: sumX / size,
      centerY: sumY / size,
      minX,
      maxX,
      minY,
      maxY
    };
  }
  
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      this.packetCount++;
    }
  }
}

// Initialize controller when page loads
document.addEventListener('DOMContentLoaded', () => {
  new ESP32Controller();
});


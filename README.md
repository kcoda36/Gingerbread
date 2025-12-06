# 🍪 Gingerbread Bot

An autonomous ESP32-based robot that tracks and follows gingerbread cookies using computer vision!

## Features

### 🎮 Manual Control Modes
- **Keyboard Control**: WASD or Arrow keys for driving
- **Hand Tracking**: Control with hand gestures via webcam
- **Gingerbread Tracking**: Browser-based color tracking

### 🤖 Autonomous Mode (NEW!)
Server-side Python autonomous tracking with OpenCV:
- **Search Left/Right**: Robot spins to search for gingerbread
- **Track Mode**: Automatically follows detected gingerbread
- **Real-time Vision**: Python popup window shows detection overlay
- **Multi-client Control**: Trigger autonomous modes from any connected device

## Architecture

```
Browser UI ←→ Node.js Server ←→ Python (OpenCV) ←→ ESP32 Robot
                                      ↓
                              OpenCV Window (Visual Feedback)
```

## Installation

### 1. Install Node.js Dependencies
```bash
npm install
```

### 2. Install Python Dependencies
```bash
pip3 install -r requirements.txt
```

Requirements:
- `opencv-python` - Computer vision
- `numpy` - Array operations

### 3. ESP32 Setup
Upload `controller.c` to your ESP32 using Arduino IDE or PlatformIO.

Configure WiFi credentials in the code:
```c
static const char* WIFI_SSID = "YOUR_WIFI";
static const char* WIFI_PASS = "YOUR_PASSWORD";
```

## Usage

### Start the Server
```bash
node server.js
```

Server will start on:
- Local: `http://localhost:3000`
- Network: `http://<your-ip>:3000`

### Connect to Robot
1. Open the web interface
2. Enter your ESP32's IP address
3. Click "INITIATE CONNECTION"

### Manual Control
- Use on-screen buttons or keyboard (WASD/Arrows)
- Press `F` for fire (relay toggle)
- Press `SPACE` for emergency stop

### Autonomous Mode
1. Click **🍪 GINGERBREAD** button
2. Choose an autonomous mode:
   - **🔄 SEARCH LEFT**: Robot spins counterclockwise until gingerbread is found
   - **🔃 SEARCH RIGHT**: Robot spins clockwise until gingerbread is found
   - **🎯 TRACK**: Directly enters tracking mode (if gingerbread visible)
   - **⬛ STOP**: Emergency stop autonomous mode

3. Python process starts on server with OpenCV window showing:
   - Live camera feed
   - Detection overlay
   - Deadzone visualization
   - Current mode status

4. Keyboard controls in Python window:
   - `L` - Switch to Search Left
   - `R` - Switch to Search Right
   - `T` - Switch to Track mode
   - `S` - Stop
   - `ESC` - Exit autonomous mode

### Autonomous Behavior
- **Search Mode**: Robot spins until brown (gingerbread) object is detected
- **Auto-Switch**: Automatically switches from Search → Track when target found
- **Lost Target**: If target lost for 2 seconds, switches back to Search Left
- **Deadzone**: 30% center deadzone - robot goes straight when target is centered
- **Differential Steering**: Smooth turning based on target position

## Hardware

### ESP32 Pinout
```
LEFT MOTOR:   DIR=15, STEP=2
RIGHT MOTOR:  DIR=17, STEP=5
ENABLE:       PIN=33 (active-low)
RELAY (FIRE): PIN=13
```

### Required Hardware
- ESP32 Dev Board
- 2x Stepper Motor Drivers (e.g., A4988, DRV8825)
- 2x Stepper Motors
- Relay Module (optional, for firing mechanism)
- Power Supply (appropriate for your motors)
- USB Webcam or Laptop camera (for autonomous mode)

## Color Detection Tuning

To adjust gingerbread detection for your specific lighting/cookie:

Edit `autonomous_gingerbread.py`:
```python
# Line ~235 - Adjust HSV color range
lower_brown = np.array([8, 60, 60])   # H, S, V lower bounds
upper_brown = np.array([25, 255, 200]) # H, S, V upper bounds
```

HSV Color Guide:
- **H (Hue)**: 8-25 for brown/orange tones
- **S (Saturation)**: 60-255 for color intensity
- **V (Value)**: 60-200 for brightness range

## Network Configuration

### Port Configuration
- **HTTP/WebSocket**: 3000 (configurable in `server.js`)
- **ESP32 UDP**: 4210 (default)

### Firewall
Ensure these ports are open:
- TCP 3000 (Node.js server)
- UDP 4210 (ESP32 communication)

## Troubleshooting

### Python Camera Not Working
```bash
# List available cameras
python3 -c "import cv2; print([i for i in range(10) if cv2.VideoCapture(i).isOpened()])"

# Try different camera index
python3 autonomous_gingerbread.py --camera 1 --esp32-ip <IP>
```

### No Gingerbread Detection
1. Check lighting conditions
2. Adjust HSV color ranges in code
3. Ensure minimum blob size threshold is appropriate
4. Test with actual gingerbread (brown/tan color)

### ESP32 Not Responding
1. Check WiFi connection and IP address
2. Verify ESP32 is on same network
3. Check UDP port (4210)
4. Test with manual control mode first

### WebSocket Connection Fails
1. Ensure Node.js server is running
2. Check firewall settings
3. Verify network allows WebSocket connections

## Development

### Project Structure
```
Gingerbread/
├── autonomous_gingerbread.py  # Python autonomous tracking
├── server.js                  # Node.js WebSocket/UDP server
├── controller.c               # ESP32 firmware
├── package.json              # Node.js dependencies
├── requirements.txt          # Python dependencies
└── public/
    ├── index.html           # Web UI
    ├── app.js              # Client JavaScript
    └── styles.css          # Styling
```

### Adding New Autonomous Modes
1. Add mode to `Mode` enum in `autonomous_gingerbread.py`
2. Implement behavior in main control loop
3. Add button to `index.html`
4. Add event handler in `app.js`

## Credits

Created for EEZY robotics platform

## License

MIT License - Feel free to use and modify!

---

🍪 **Happy Gingerbread Hunting!** 🤖

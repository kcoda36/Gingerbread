#!/usr/bin/env python3
"""
Autonomous Gingerbread Tracking System
Tracks brown gingerbread objects and controls ESP32 robot autonomously
"""

import cv2
import numpy as np
import socket
import time
import argparse
import sys
from dataclasses import dataclass
from enum import Enum

class Mode(Enum):
    SEARCH_LEFT = "search_left"
    SEARCH_RIGHT = "search_right"
    TRACK = "track"
    STOPPED = "stopped"

@dataclass
class GingerbreadBlob:
    center_x: float
    center_y: float
    size: int
    detected: bool

class AutonomousGingerbreadController:
    def __init__(self, esp32_ip, udp_port=4210, camera_index=0):
        self.esp32_ip = esp32_ip
        self.udp_port = udp_port
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        # Camera setup
        print(f"Initializing camera {camera_index}...")
        self.cap = cv2.VideoCapture(camera_index)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        
        if not self.cap.isOpened():
            raise RuntimeError("Failed to open camera")
        
        print("Camera initialized successfully")
        
        # Control parameters
        self.deadzone_width = 0.30  # 30% center deadzone
        self.search_speed = 0.35  # Rotation speed when searching
        self.track_speed = 0.5  # Forward speed when tracking
        self.turn_gain = 0.8  # How aggressively to turn
        
        # State
        self.mode = Mode.STOPPED
        self.last_detection_time = 0
        self.detection_timeout = 2.0  # seconds
        self.running = True
        
        print(f"Connected to ESP32 at {esp32_ip}:{udp_port}")
        
    def send_command(self, left, right):
        """Send UDP command to ESP32"""
        command = f"L:{left:.3f},R:{right:.3f}"
        try:
            self.sock.sendto(command.encode(), (self.esp32_ip, self.udp_port))
        except Exception as e:
            print(f"Error sending command: {e}")
        
    def stop(self):
        """Emergency stop"""
        self.send_command(0, 0)
        
    def spin_left(self):
        """Spin in place counterclockwise"""
        self.send_command(-self.search_speed, self.search_speed)
        
    def spin_right(self):
        """Spin in place clockwise"""
        self.send_command(self.search_speed, -self.search_speed)
        
    def track_gingerbread(self, blob):
        """Track detected gingerbread with differential steering"""
        if not blob.detected:
            self.stop()
            return
            
        # Get frame width from camera
        frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        
        # Calculate position relative to center (-0.5 to 0.5)
        position = (blob.center_x / frame_width) - 0.5
        
        deadzone_min = -self.deadzone_width / 2
        deadzone_max = self.deadzone_width / 2
        
        if position < deadzone_min:
            # Turn left (normalize turn amount)
            turn = -self.turn_gain * abs((position - deadzone_min) / (0.5 - self.deadzone_width / 2))
            turn = max(-1, turn)
            left = self.track_speed + turn
            right = self.track_speed - turn
            self.send_command(left, right)
            
        elif position > deadzone_max:
            # Turn right (normalize turn amount)
            turn = self.turn_gain * abs((position - deadzone_max) / (0.5 - self.deadzone_width / 2))
            turn = min(1, turn)
            left = self.track_speed + turn
            right = self.track_speed - turn
            self.send_command(left, right)
            
        else:
            # In deadzone - go straight
            self.send_command(self.track_speed, self.track_speed)
            
    def detect_gingerbread(self, frame):
        """Detect brown gingerbread blob in frame"""
        # Convert to HSV color space
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        
        # Brown color range in HSV
        # Adjust these values based on your gingerbread color
        # H: 10-20 (orange-brown), S: 50-255 (saturated), V: 50-200 (not too dark/bright)
        lower_brown = np.array([8, 60, 60])
        upper_brown = np.array([25, 255, 200])
        
        # Create mask for brown pixels
        mask = cv2.inRange(hsv, lower_brown, upper_brown)
        
        # Morphological operations to clean up noise
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        
        # Find contours
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return GingerbreadBlob(0, 0, 0, False)
            
        # Find largest contour
        largest = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(largest)
        
        # Minimum size threshold
        if area < 500:
            return GingerbreadBlob(0, 0, 0, False)
            
        # Calculate center of mass
        M = cv2.moments(largest)
        if M["m00"] == 0:
            return GingerbreadBlob(0, 0, 0, False)
            
        cx = int(M["m10"] / M["m00"])
        cy = int(M["m01"] / M["m00"])
        
        return GingerbreadBlob(cx, cy, int(area), True)
        
    def draw_overlay(self, frame, blob):
        """Draw detection overlay on frame"""
        height, width = frame.shape[:2]
        
        # Draw center deadzone (full height)
        deadzone_width_px = int(width * self.deadzone_width)
        deadzone_x1 = (width - deadzone_width_px) // 2
        deadzone_x2 = deadzone_x1 + deadzone_width_px
        
        # Draw deadzone rectangle with dashed effect
        overlay = frame.copy()
        cv2.rectangle(overlay, 
                     (deadzone_x1, 0), 
                     (deadzone_x2, height),
                     (255, 212, 0), -1)
        cv2.addWeighted(overlay, 0.15, frame, 0.85, 0, frame)
        
        # Draw deadzone border
        cv2.rectangle(frame, 
                     (deadzone_x1, 0), 
                     (deadzone_x2, height),
                     (0, 212, 255), 2)
        
        # Draw center line
        cv2.line(frame, (width//2, 0), (width//2, height), (0, 255, 0), 2)
        
        # Draw left/right zone labels
        cv2.putText(frame, "LEFT", (50, height//2), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 255, 255), 3)
        cv2.putText(frame, "RIGHT", (width-180, height//2), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 255, 255), 3)
        
        # Draw detection
        if blob.detected:
            # Draw bounding circle
            cv2.circle(frame, (int(blob.center_x), int(blob.center_y)), 
                      25, (0, 255, 0), 3)
            
            # Draw center point
            cv2.circle(frame, (int(blob.center_x), int(blob.center_y)), 
                      10, (0, 255, 0), -1)
            
            # Draw crosshair
            cv2.line(frame, 
                    (int(blob.center_x)-30, int(blob.center_y)), 
                    (int(blob.center_x)+30, int(blob.center_y)), 
                    (255, 255, 255), 3)
            cv2.line(frame, 
                    (int(blob.center_x), int(blob.center_y)-30), 
                    (int(blob.center_x), int(blob.center_y)+30), 
                    (255, 255, 255), 3)
            
            # Status text - detected
            cv2.rectangle(frame, (5, 5), (400, 60), (0, 255, 0), -1)
            cv2.rectangle(frame, (5, 5), (400, 60), (255, 255, 255), 2)
            cv2.putText(frame, f"DETECTED | Size: {blob.size}", 
                       (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
        else:
            # Status text - searching
            cv2.rectangle(frame, (5, 5), (400, 60), (0, 0, 255), -1)
            cv2.rectangle(frame, (5, 5), (400, 60), (255, 255, 255), 2)
            cv2.putText(frame, "SEARCHING...", 
                       (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        
        # Mode indicator at bottom
        mode_text = f"MODE: {self.mode.value.upper()}"
        text_size = cv2.getTextSize(mode_text, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)[0]
        cv2.rectangle(frame, (5, height-55), (text_size[0]+20, height-5), (255, 255, 0), -1)
        cv2.rectangle(frame, (5, height-55), (text_size[0]+20, height-5), (255, 255, 255), 2)
        cv2.putText(frame, mode_text, 
                   (15, height-20), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
        
        # Instructions
        cv2.putText(frame, "ESC=Exit | S=Stop | L=Search Left | R=Search Right | T=Track", 
                   (10, height-70), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        return frame
        
    def run(self, initial_mode):
        """Main control loop"""
        self.mode = Mode[initial_mode.upper()]
        print(f"🤖 Starting autonomous mode: {self.mode.value}")
        print(f"🍪 ESP32 IP: {self.esp32_ip}")
        print("=" * 60)
        
        try:
            while self.running:
                ret, frame = self.cap.read()
                if not ret:
                    print("❌ Failed to grab frame")
                    break
                
                # Detect gingerbread
                blob = self.detect_gingerbread(frame)
                
                # State machine
                if self.mode == Mode.SEARCH_LEFT:
                    if blob.detected:
                        # Found it! Switch to tracking
                        print("✅ Gingerbread detected! Switching to TRACK mode")
                        self.mode = Mode.TRACK
                        self.last_detection_time = time.time()
                    else:
                        self.spin_left()
                        
                elif self.mode == Mode.SEARCH_RIGHT:
                    if blob.detected:
                        print("✅ Gingerbread detected! Switching to TRACK mode")
                        self.mode = Mode.TRACK
                        self.last_detection_time = time.time()
                    else:
                        self.spin_right()
                        
                elif self.mode == Mode.TRACK:
                    if blob.detected:
                        self.track_gingerbread(blob)
                        self.last_detection_time = time.time()
                    else:
                        # Lost target - check timeout
                        if time.time() - self.last_detection_time > self.detection_timeout:
                            print("⚠️  Lost target! Switching to SEARCH_LEFT")
                            self.mode = Mode.SEARCH_LEFT
                        else:
                            # Keep moving forward briefly
                            self.send_command(0.3, 0.3)
                            
                elif self.mode == Mode.STOPPED:
                    self.stop()
                    
                # Draw overlay and display
                display_frame = self.draw_overlay(frame.copy(), blob)
                cv2.imshow("🍪 Autonomous Gingerbread Tracker", display_frame)
                
                # Check for keyboard input
                key = cv2.waitKey(1) & 0xFF
                if key == 27:  # ESC
                    print("🛑 ESC pressed - exiting...")
                    break
                elif key == ord('s') or key == ord('S'):
                    print("🛑 Stop mode activated")
                    self.mode = Mode.STOPPED
                elif key == ord('l') or key == ord('L'):
                    print("🔄 Search Left mode activated")
                    self.mode = Mode.SEARCH_LEFT
                elif key == ord('r') or key == ord('R'):
                    print("🔃 Search Right mode activated")
                    self.mode = Mode.SEARCH_RIGHT
                elif key == ord('t') or key == ord('T'):
                    print("🎯 Track mode activated")
                    self.mode = Mode.TRACK
                    
        except KeyboardInterrupt:
            print("\n⚠️  Interrupted by user")
        except Exception as e:
            print(f"❌ Error: {e}")
        finally:
            print("🛑 Stopping autonomous mode...")
            self.stop()
            time.sleep(0.1)
            self.cap.release()
            cv2.destroyAllWindows()
            print("✅ Autonomous mode stopped cleanly")

def main():
    parser = argparse.ArgumentParser(description='Autonomous Gingerbread Tracking System')
    parser.add_argument('--mode', default='search_left', 
                       choices=['search_left', 'search_right', 'track', 'stopped'],
                       help='Initial autonomous mode')
    parser.add_argument('--esp32-ip', required=True,
                       help='ESP32 IP address')
    parser.add_argument('--udp-port', type=int, default=4210,
                       help='UDP port for ESP32 (default: 4210)')
    parser.add_argument('--camera', type=int, default=0,
                       help='Camera index (default: 0)')
    
    args = parser.parse_args()
    
    try:
        controller = AutonomousGingerbreadController(
            args.esp32_ip, 
            args.udp_port,
            args.camera
        )
        controller.run(args.mode)
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()


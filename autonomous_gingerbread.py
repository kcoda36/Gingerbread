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
    min_x: int = 0
    max_x: int = 0
    min_y: int = 0
    max_y: int = 0

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
        self.deadzone_radius = 0.10  # 10% deadzone radius from center
        self.search_speed = 0.35  # Rotation speed when searching
        self.track_speed = 0.5  # Forward speed when tracking
        self.turn_gain = 1.2  # How aggressively to turn (higher = more responsive)
        
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
        """Track detected gingerbread with differential steering based on distance from center"""
        if not blob.detected:
            self.stop()
            return
            
        # Get frame dimensions
        frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        # Calculate center of frame
        center_x = frame_width / 2.0
        center_y = frame_height / 2.0
        
        # Calculate horizontal distance from center (normalized -1 to 1)
        # Positive = right of center, Negative = left of center
        dx = (blob.center_x - center_x) / center_x
        
        # Calculate absolute distance from center (for deadzone check)
        distance = abs(dx)
        
        # Deadzone: if within deadzone radius, go straight
        if distance <= self.deadzone_radius:
            # Dead center - go straight forward
            self.send_command(self.track_speed, self.track_speed)
        else:
            # Outside deadzone - turn proportional to distance
            # Remove deadzone offset to make turning smooth
            adjusted_distance = (distance - self.deadzone_radius) / (1.0 - self.deadzone_radius)
            
            # Calculate turn amount (proportional to distance from center)
            turn = self.turn_gain * adjusted_distance
            turn = min(1.0, turn)  # Clamp to max turn rate
            
            # Apply turn direction
            if dx > 0:
                # Target is right of center - turn right
                left = self.track_speed + turn
                right = self.track_speed - turn
            else:
                # Target is left of center - turn left
                left = self.track_speed - turn
                right = self.track_speed + turn
            
            # Clamp motor speeds to [-1, 1]
            left = max(-1.0, min(1.0, left))
            right = max(-1.0, min(1.0, right))
            
            self.send_command(left, right)
            
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
        
        # Get bounding rectangle
        x, y, w, h = cv2.boundingRect(largest)
        
        return GingerbreadBlob(
            center_x=cx, 
            center_y=cy, 
            size=int(area), 
            detected=True,
            min_x=x,
            max_x=x + w,
            min_y=y,
            max_y=y + h
        )
        
    def draw_overlay(self, frame, blob):
        """Draw detection overlay on frame"""
        height, width = frame.shape[:2]
        center_x = width // 2
        center_y = height // 2
        
        # Calculate deadzone radius in pixels
        deadzone_radius_px = int(width * self.deadzone_radius)
        
        # Draw center crosshair (screen center)
        cv2.line(frame, (center_x - 30, center_y), (center_x + 30, center_y), (0, 255, 0), 3)
        cv2.line(frame, (center_x, center_y - 30), (center_x, center_y + 30), (0, 255, 0), 3)
        cv2.circle(frame, (center_x, center_y), 8, (0, 255, 0), -1)
        
        # Draw deadzone circle (centered on frame center)
        overlay = frame.copy()
        cv2.circle(overlay, (center_x, center_y), deadzone_radius_px, (0, 212, 255), -1)
        cv2.addWeighted(overlay, 0.2, frame, 0.8, 0, frame)
        
        # Draw deadzone border
        cv2.circle(frame, (center_x, center_y), deadzone_radius_px, (0, 212, 255), 3)
        
        # Draw center vertical line for reference
        cv2.line(frame, (center_x, 0), (center_x, height), (0, 255, 0), 2)
        
        # Draw left/right zone labels
        cv2.putText(frame, "LEFT", (30, height//2), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 100, 100), 3)
        cv2.putText(frame, "RIGHT", (width-150, height//2), 
                   cv2.FONT_HERSHEY_SIMPLEX, 1.2, (100, 255, 100), 3)
        
        # Draw detection
        if blob.detected:
            blob_x = int(blob.center_x)
            blob_y = int(blob.center_y)
            
            # Calculate distance from center
            dx = blob_x - center_x
            dy = blob_y - center_y
            distance_from_center = np.sqrt(dx*dx + dy*dy)
            
            # Choose color based on deadzone
            if distance_from_center <= deadzone_radius_px:
                color = (0, 255, 0)  # Green - in deadzone (go straight)
            else:
                color = (0, 255, 255)  # Yellow - outside deadzone (turning)
            
            # Draw actual bounding box around detected blob
            cv2.rectangle(frame,
                         (blob.min_x, blob.min_y),
                         (blob.max_x, blob.max_y),
                         color, 3)
            
            # Draw center point of blob
            cv2.circle(frame, (blob_x, blob_y), 12, color, -1)
            cv2.circle(frame, (blob_x, blob_y), 15, (255, 255, 255), 2)
            
            # Draw crosshair on blob center
            cv2.line(frame, 
                    (blob_x - 25, blob_y), 
                    (blob_x + 25, blob_y), 
                    (255, 255, 255), 2)
            cv2.line(frame, 
                    (blob_x, blob_y - 25), 
                    (blob_x, blob_y + 25), 
                    (255, 255, 255), 2)
            
            # Draw line from blob center to frame center
            cv2.line(frame, (blob_x, blob_y), (center_x, center_y), (255, 0, 255), 2)
            
            # Draw distance text
            distance_text = f"Dist: {distance_from_center:.0f}px"
            cv2.putText(frame, distance_text, 
                       (blob_x + 20, blob_y - 20), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            
            # Calculate horizontal offset from center (normalized)
            offset_x = (blob_x - center_x) / center_x
            direction = "CENTER" if distance_from_center <= deadzone_radius_px else ("RIGHT" if offset_x > 0 else "LEFT")
            
            # Status text - detected
            status_text = f"DETECTED | {direction} | Offset: {offset_x:.2f}"
            cv2.rectangle(frame, (5, 5), (550, 60), (0, 255, 0), -1)
            cv2.rectangle(frame, (5, 5), (550, 60), (255, 255, 255), 2)
            cv2.putText(frame, status_text, 
                       (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
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


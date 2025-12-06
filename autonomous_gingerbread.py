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
import select
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
        self.deadzone_radius = 0.15  # 15% deadzone radius from center (increased from 10%)
        self.min_turn_threshold = 0.15  # Minimum turn amount to actually turn (prevents jitter)
        self.search_speed = 0.4  # Rotation speed when searching
        self.track_speed = 0.6  # Forward speed when tracking
        self.turn_gain = 1.5  # How aggressively to turn (higher = more responsive)
        
        # State
        self.mode = Mode.STOPPED
        self.last_detection_time = 0
        self.detection_timeout = 2.0  # seconds
        self.running = True
        
        # Position smoothing (exponential moving average)
        self.smoothed_x = None
        self.smoothing_factor = 0.3  # 0 = no smoothing, 1 = instant
        
        # Command tracking for display
        self.last_command_left = 0.0
        self.last_command_right = 0.0
        
        print(f"Connected to ESP32 at {esp32_ip}:{udp_port}")
        
    def send_command(self, left, right):
        """Send UDP command to ESP32"""
        # Store for display
        self.last_command_left = left
        self.last_command_right = right
        
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
            self.smoothed_x = None  # Reset smoothing when no detection
            return
            
        # Get frame dimensions
        frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        
        # Apply smoothing to blob position to reduce jitter
        if self.smoothed_x is None:
            self.smoothed_x = blob.center_x
        else:
            self.smoothed_x = (self.smoothing_factor * blob.center_x + 
                             (1 - self.smoothing_factor) * self.smoothed_x)
        
        # Calculate center of frame
        center_x = frame_width / 2.0
        
        # Calculate horizontal distance from center (normalized -1 to 1)
        # Use smoothed position to reduce jitter
        dx = (self.smoothed_x - center_x) / center_x
        
        # Calculate absolute distance from center
        distance = abs(dx)
        
        # Deadzone: if within deadzone radius, STOP (target is centered!)
        if distance <= self.deadzone_radius:
            # Target is centered - STOP (we've "caught" it)
            self.send_command(0.0, 0.0)
            return
        
        # Outside deadzone - calculate turn amount
        # Remove deadzone offset to make turning smooth
        adjusted_distance = (distance - self.deadzone_radius) / (1.0 - self.deadzone_radius)
        
        # Calculate turn amount (proportional to distance from center)
        turn = self.turn_gain * adjusted_distance
        turn = min(1.0, turn)  # Clamp to max turn rate
        
        # Apply minimum turn threshold - if turn is too small, still stop (close enough to center)
        if turn < self.min_turn_threshold:
            self.send_command(0.0, 0.0)
            return
        
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
        
        # Calculate zone radii in pixels
        deadzone_radius_px = int(width * self.deadzone_radius)
        
        # Draw center crosshair (screen center)
        cv2.line(frame, (center_x - 30, center_y), (center_x + 30, center_y), (0, 255, 0), 3)
        cv2.line(frame, (center_x, center_y - 30), (center_x, center_y + 30), (0, 255, 0), 3)
        cv2.circle(frame, (center_x, center_y), 8, (0, 255, 0), -1)
        
        # Draw deadzone circle (green - goes straight)
        overlay = frame.copy()
        cv2.circle(overlay, (center_x, center_y), deadzone_radius_px, (0, 255, 0), -1)
        cv2.addWeighted(overlay, 0.15, frame, 0.85, 0, frame)
        cv2.circle(frame, (center_x, center_y), deadzone_radius_px, (0, 255, 0), 3)
        
        # Add text label for deadzone
        cv2.putText(frame, "DEADZONE", (center_x - 50, center_y), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        
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
            
            # Calculate turn amount for display
            dx_norm = (blob_x - center_x) / center_x
            distance_norm = abs(dx_norm)
            
            # Determine status
            if distance_from_center <= deadzone_radius_px:
                color = (0, 0, 255)  # Red - in deadzone (STOPPED - target centered!)
                status = "🎯 CENTERED - STOPPED"
            else:
                # Check if turn would be applied
                adjusted_dist = (distance_norm - self.deadzone_radius) / (1.0 - self.deadzone_radius)
                turn_amount = self.turn_gain * adjusted_dist
                
                if turn_amount < self.min_turn_threshold:
                    color = (0, 255, 255)  # Yellow - outside deadzone but below turn threshold
                    status = "STOPPED (below threshold)"
                else:
                    color = (255, 0, 255)  # Magenta - actively turning
                    status = "TURNING"
            
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
            direction = "RIGHT" if offset_x > 0 else "LEFT"
            
            # Status text - detected with action  
            status_text = f"DETECTED | {status}"
            if "CENTERED" not in status:
                status_text += f" | {direction} {abs(offset_x):.2f}"
            
            text_width = 750
            status_bg_color = (0, 0, 255) if "STOPPED" in status or "CENTERED" in status else (0, 255, 0)
            cv2.rectangle(frame, (5, 5), (text_width, 60), status_bg_color, -1)
            cv2.rectangle(frame, (5, 5), (text_width, 60), (255, 255, 255), 2)
            cv2.putText(frame, status_text, 
                       (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        else:
            # Status text - searching
            cv2.rectangle(frame, (5, 5), (400, 60), (0, 0, 255), -1)
            cv2.rectangle(frame, (5, 5), (400, 60), (255, 255, 255), 2)
            cv2.putText(frame, "SEARCHING...", 
                       (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        
        # Command display at bottom - LARGE AND PROMINENT
        cmd_text = f"SENDING >>> LEFT: {self.last_command_left:+.3f}  |  RIGHT: {self.last_command_right:+.3f}"
        cmd_text_size = cv2.getTextSize(cmd_text, cv2.FONT_HERSHEY_SIMPLEX, 1.0, 3)[0]
        
        # Command box background
        cmd_box_height = 80
        cv2.rectangle(frame, (0, height-cmd_box_height), (width, height), (0, 0, 0), -1)
        
        # Determine color based on commands
        if abs(self.last_command_left) < 0.01 and abs(self.last_command_right) < 0.01:
            cmd_color = (0, 0, 255)  # Red = STOPPED
            action_text = "⬛ STOPPED"
        elif abs(self.last_command_left - self.last_command_right) < 0.01:
            cmd_color = (0, 255, 0)  # Green = STRAIGHT
            action_text = "↑ FORWARD"
        else:
            cmd_color = (255, 0, 255)  # Magenta = TURNING
            if self.last_command_left > self.last_command_right:
                action_text = "↱ TURN RIGHT"
            else:
                action_text = "↰ TURN LEFT"
        
        # Draw command text
        cv2.putText(frame, cmd_text, 
                   (15, height-45), cv2.FONT_HERSHEY_SIMPLEX, 1.0, cmd_color, 3)
        
        # Draw action indicator
        cv2.putText(frame, action_text, 
                   (15, height-10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, cmd_color, 2)
        
        # Mode indicator (top of command box)
        mode_text = f"MODE: {self.mode.value.upper()}"
        cv2.putText(frame, mode_text, 
                   (width-250, height-50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        
        return frame
        
    def check_stdin_command(self):
        """Check for mode change commands from stdin (non-blocking)"""
        if sys.platform == 'win32':
            # Windows doesn't support select on stdin
            return
        
        # Check if there's input available (non-blocking)
        if select.select([sys.stdin], [], [], 0)[0]:
            try:
                line = sys.stdin.readline().strip()
                if line:
                    print(f"📨 Received command: {line}")
                    
                    if line == 'STOP':
                        self.mode = Mode.STOPPED
                        print("🛑 Switching to STOP mode")
                    elif line == 'SEARCH_LEFT':
                        self.mode = Mode.SEARCH_LEFT
                        print("🔄 Switching to SEARCH LEFT mode")
                    elif line == 'SEARCH_RIGHT':
                        self.mode = Mode.SEARCH_RIGHT
                        print("🔃 Switching to SEARCH RIGHT mode")
                    elif line == 'TRACK':
                        self.mode = Mode.TRACK
                        print("🎯 Switching to TRACK mode")
            except Exception as e:
                print(f"⚠️  Error reading stdin: {e}")
    
    def run(self, initial_mode):
        """Main control loop"""
        self.mode = Mode[initial_mode.upper()]
        print(f"🤖 Starting autonomous mode: {self.mode.value}")
        print(f"🍪 ESP32 IP: {self.esp32_ip}")
        print("=" * 60)
        print("💡 Mode can be changed from web UI or keyboard")
        print("=" * 60)
        
        try:
            while self.running:
                # Check for mode change commands from stdin
                self.check_stdin_command()
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
                            self.smoothed_x = None  # Reset smoothing
                        else:
                            # Keep previous command briefly (momentum)
                            pass
                            
                elif self.mode == Mode.STOPPED:
                    # STOP mode - actively send stop commands
                    self.stop()
                    self.smoothed_x = None  # Reset smoothing
                    
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


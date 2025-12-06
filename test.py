import RPi.GPIO as GPIO
import time

GPIO.setmode(GPIO.BCM)

STEP_PIN = 21
DIR_PIN = 20
ENABLE_PIN = 16

GPIO.setup(ENABLE_PIN, GPIO.OUT)
GPIO.output(ENABLE_PIN, GPIO.LOW)  # ENABLE driver (active-low)


class NonBlockingStepper:
    """Non-blocking stepper motor controller similar to AccelStepper"""
    
    def __init__(self, step_pin, dir_pin):
        self.step_pin = step_pin
        self.dir_pin = dir_pin
        self.speed = 0.0  # steps per second
        self.last_step_time = 0.0
        self.step_state = False
        GPIO.setup(step_pin, GPIO.OUT, initial=GPIO.LOW)
        GPIO.setup(dir_pin, GPIO.OUT, initial=GPIO.LOW)
    
    def set_speed(self, steps_per_sec):
        """Set speed in steps per second (can be positive or negative)"""
        # Update direction pin based on sign
        dir_state = GPIO.HIGH if steps_per_sec >= 0 else GPIO.LOW
        GPIO.output(self.dir_pin, dir_state)
        
        # DEBUG: Print what we're setting
        print(f"  → Setting DIR pin to {'HIGH' if dir_state else 'LOW'} (speed: {steps_per_sec})")
        print(f"  → Actual DIR pin reads: {GPIO.input(self.dir_pin)}")
        
        # Longer delay for direction setup time (try 1ms to be safe)
        time.sleep(0.001)  # 1 millisecond - much longer than spec
        
        # Reset step timer to prevent immediate rapid stepping
        self.last_step_time = time.perf_counter()
        self.speed = steps_per_sec
    
    def run_speed(self):
        """
        Call this as fast as possible in your main loop.
        Non-blocking - returns immediately if not time to step.
        """
        if self.speed == 0:
            return
        
        now = time.perf_counter()
        interval = 1.0 / abs(self.speed)  # seconds between steps
        
        if (now - self.last_step_time) >= interval:
            # Time for next step - generate pulse with proper width
            GPIO.output(self.step_pin, GPIO.HIGH)
            time.sleep(0.000002)  # 2 microsecond pulse width - critical for TMC2209!
            GPIO.output(self.step_pin, GPIO.LOW)
            self.last_step_time = now


# Create stepper instance
stepper = NonBlockingStepper(STEP_PIN, DIR_PIN)

try:
    print("\n=== TEST 1: DIR=HIGH (positive speed) ===")
    stepper.set_speed(5000)  # Start slower for testing
    start_time = time.time()
    while time.time() - start_time < 2.0:
        stepper.run_speed()
    
    print("\n=== Stopping and waiting ===")
    stepper.set_speed(0)
    time.sleep(2)
    
    print("\n=== TEST 2: DIR=LOW (negative speed) ===")
    stepper.set_speed(-5000)  # Reverse
    start_time = time.time()
    while time.time() - start_time < 2.0:
        stepper.run_speed()
    
    print("\n=== Stopping and waiting ===")
    stepper.set_speed(0)
    time.sleep(2)
    
    # Try the opposite logic to see if direction is just inverted
    print("\n=== TEST 3: Trying INVERTED logic (HIGH for negative) ===")
    GPIO.output(DIR_PIN, GPIO.HIGH)  # Manually set HIGH
    time.sleep(0.001)
    print(f"  → Manually set DIR to HIGH, reads: {GPIO.input(DIR_PIN)}")
    stepper.speed = -5000  # Set speed without changing DIR
    start_time = time.time()
    while time.time() - start_time < 2.0:
        stepper.run_speed()
    
    print("\nDone! Did any of the tests move in reverse?")
    stepper.set_speed(0)

finally:
    GPIO.output(ENABLE_PIN, GPIO.HIGH)  # Disable driver
    GPIO.cleanup()

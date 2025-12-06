#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <AccelStepper.h>

// -------------------- Pinout --------------------
static const uint8_t L_DIR  = 15;
static const uint8_t L_STEP = 2;
static const uint8_t R_DIR  = 17;
static const uint8_t R_STEP = 5;
static const uint8_t EN_PIN = 33; // active-low enable

// Relay (FIRE) pin
static const uint8_t RELAY_PIN = 13;
static const bool RELAY_ACTIVE_LOW = false; // Set true if your relay is active-low

// -------------------- Wi-Fi config --------------------
// Option A: join existing Wi-Fi
static const char* WIFI_SSID = "EEZYWIFI";
static const char* WIFI_PASS = "Engineezy36";

// Option B: fallback AP if Wi-Fi join fails
static const bool  ENABLE_FALLBACK_AP = true;
static const char* AP_SSID = "ESP32-TANK";
static const char* AP_PASS = "drive-drive"; // >= 8 chars

// UDP port to listen on
static const uint16_t UDP_PORT = 4210;

// -------------------- Motion tuning --------------------
static const float MAX_SPEED_SPS     = 10000.0f;   // steps/sec
static const float RAMP_SPS_PER_S    = 30000.0f;   // steps/sec^2 style slew
static const uint32_t COMMAND_TTL_MS = 250;        // stop if no UDP within this time
static const bool INVERT_LEFT  = true;
static const bool INVERT_RIGHT = false;

// -------------------- Steppers --------------------
AccelStepper leftStepper (AccelStepper::DRIVER, L_STEP, L_DIR);
AccelStepper rightStepper(AccelStepper::DRIVER, R_STEP, R_DIR);

// -------------------- HTTP Server --------------------
WebServer server(80);
static volatile bool relayState = false;

// -------------------- UDP --------------------
WiFiUDP udp;
static char rxBuf[128];

// Latest received command from network (normalized -1..1)
static float netL = 0.0f, netR = 0.0f;
static uint32_t lastNetRxMs = 0;

// Current/target speeds (steps/sec)
static float curL = 0.0f, curR = 0.0f;
static float tgtL = 0.0f, tgtR = 0.0f;

// -------------------- Relay Control --------------------
static inline void setRelay(bool on) {
  relayState = on;
  digitalWrite(RELAY_PIN, (RELAY_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
}

// -------------------- Helpers --------------------
static float clampf(float x, float lo, float hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

static float slew(float cur, float tgt, float maxDelta) {
  float d = tgt - cur;
  if (d >  maxDelta) d =  maxDelta;
  if (d < -maxDelta) d = -maxDelta;
  return cur + d;
}

// Parse a UDP payload like:
//   "0.25,-0.30"
//   "L:0.25,R:-0.30"
//   "STOP"
//   "FIRE"
static bool parseCommand(const char* s, float &outL, float &outR) {
  // Trim leading spaces
  while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;

  if (strncasecmp(s, "STOP", 4) == 0) {
    outL = 0.0f; outR = 0.0f;
    return true;
  }

  if (strncasecmp(s, "FIRE", 4) == 0) {
    setRelay(!relayState); // Toggle relay
    return false; // Don't update motor commands
  }

  // Try "L:..,R:.."
  float l, r;
  if (sscanf(s, "L:%f,R:%f", &l, &r) == 2) {
    outL = clampf(l, -1.0f, 1.0f);
    outR = clampf(r, -1.0f, 1.0f);
    return true;
  }

  // Try "l,r"
  if (sscanf(s, "%f,%f", &l, &r) == 2) {
    outL = clampf(l, -1.0f, 1.0f);
    outR = clampf(r, -1.0f, 1.0f);
    return true;
  }

  return false;
}

static void printNetworkInfo() {
  Serial.println();
  Serial.println("=== EEZY ESP32 Controller ===");
  Serial.printf("UDP listen port: %u\n", UDP_PORT);
  Serial.printf("HTTP server port: 80\n");
  Serial.printf("Max speed: %.0f steps/s | Ramp: %.0f steps/s^2 | TTL: %ums\n",
                MAX_SPEED_SPS, RAMP_SPS_PER_S, COMMAND_TTL_MS);
  Serial.println("UDP commands:");
  Serial.println("  0.6,-0.6");
  Serial.println("  L:0.6,R:-0.6");
  Serial.println("  STOP");
  Serial.println("  FIRE");
  Serial.println("HTTP endpoints:");
  Serial.println("  /relay/on");
  Serial.println("  /relay/off");
  Serial.println("  /relay/toggle");
  Serial.println("  /relay/state");
  Serial.println();
  Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("Wi-Fi mode: %s\n", (WiFi.getMode() == WIFI_MODE_AP) ? "AP" : "STA");
  Serial.println("==============================");
  Serial.println();
}

static bool connectWiFiSTA(uint32_t timeoutMs = 8000) {
  WiFi.mode(WIFI_MODE_STA);
  WiFi.setSleep(false); // reduce latency/jitter
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(50);
  }
  return WiFi.status() == WL_CONNECTED;
}

static void startFallbackAP() {
  WiFi.mode(WIFI_MODE_AP);
  WiFi.setSleep(false);
  WiFi.softAP(AP_SSID, AP_PASS);
}

// -------------------- HTTP Handlers --------------------
static void replyText(const String& s) {
  // CORS headers for browser access
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(200, "text/plain", s);
}

static void handleOptions() {
  // Preflight CORS
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

static void handleRelayOn() {
  setRelay(true);
  replyText("1");
}

static void handleRelayOff() {
  setRelay(false);
  replyText("0");
}

static void handleRelayToggle() {
  setRelay(!relayState);
  replyText(relayState ? "1" : "0");
}

static void handleRelayState() {
  replyText(relayState ? "1" : "0");
}

// -------------------- UDP --------------------
static void pollUDP() {
  int packetSize = udp.parsePacket();
  if (packetSize <= 0) return;

  int n = udp.read(rxBuf, (int)sizeof(rxBuf) - 1);
  if (n <= 0) return;
  rxBuf[n] = '\0';

  float l, r;
  if (parseCommand(rxBuf, l, r)) {
    // Apply inversion here so clients always think "positive = forward"
    if (INVERT_LEFT)  l = -l;
    if (INVERT_RIGHT) r = -r;

    netL = l;
    netR = r;
    lastNetRxMs = millis();
  }

  // Optional: small ACK (comment out if you want pure one-way)
  // udp.beginPacket(udp.remoteIP(), udp.remotePort());
  // udp.printf("OK %.2f %.2f\n", netL, netR);
  // udp.endPacket();
}

// -------------------- Arduino --------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, LOW); // enable drivers (active-low)

  // Initialize relay pin
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false); // OFF at boot

  leftStepper.setMaxSpeed(MAX_SPEED_SPS);
  rightStepper.setMaxSpeed(MAX_SPEED_SPS);
  leftStepper.setSpeed(0);
  rightStepper.setSpeed(0);

  bool ok = connectWiFiSTA();
  if (!ok && ENABLE_FALLBACK_AP) {
    Serial.println("Wi-Fi join failed, starting AP...");
    startFallbackAP();
  } else if (!ok) {
    Serial.println("Wi-Fi join failed (AP disabled). Motors will remain stopped.");
  }

  udp.begin(UDP_PORT);
  
  // Setup HTTP server routes
  server.on("/relay/on", HTTP_GET, handleRelayOn);
  server.on("/relay/off", HTTP_GET, handleRelayOff);
  server.on("/relay/toggle", HTTP_GET, handleRelayToggle);
  server.on("/relay/state", HTTP_GET, handleRelayState);
  
  // CORS preflight handlers
  server.on("/relay/on", HTTP_OPTIONS, handleOptions);
  server.on("/relay/off", HTTP_OPTIONS, handleOptions);
  server.on("/relay/toggle", HTTP_OPTIONS, handleOptions);
  server.on("/relay/state", HTTP_OPTIONS, handleOptions);
  
  server.begin();
  
  printNetworkInfo();

  // Start "stopped"
  lastNetRxMs = 0;
  netL = netR = 0.0f;
}

void loop() {
  // Keep step generation as fast as possible
  leftStepper.runSpeed();
  rightStepper.runSpeed();

  // Handle HTTP requests
  server.handleClient();

  // Always poll network quickly
  pollUDP();

  // Update targets at a reasonable control rate
  static uint32_t lastCtrlUs = 0;
  uint32_t nowUs = micros();
  if ((uint32_t)(nowUs - lastCtrlUs) >= 5000) { // 5ms
    float dt = (lastCtrlUs == 0) ? 0.005f : (nowUs - lastCtrlUs) * 1e-6f;
    lastCtrlUs = nowUs;

    bool netActive = (lastNetRxMs != 0) && ((millis() - lastNetRxMs) <= COMMAND_TTL_MS);

    float cmdL = netActive ? netL : 0.0f;
    float cmdR = netActive ? netR : 0.0f;

    tgtL = cmdL * MAX_SPEED_SPS;
    tgtR = cmdR * MAX_SPEED_SPS;

    float maxDelta = RAMP_SPS_PER_S * dt;
    curL = slew(curL, tgtL, maxDelta);
    curR = slew(curR, tgtR, maxDelta);

    leftStepper.setSpeed(curL);
    rightStepper.setSpeed(curR);
  }

  // Debug at low rate
  static uint32_t lastPrintMs = 0;
  uint32_t nowMs = millis();
  if (nowMs - lastPrintMs >= 500) {
    lastPrintMs = nowMs;
    bool netActive = (lastNetRxMs != 0) && ((millis() - lastNetRxMs) <= COMMAND_TTL_MS);
    Serial.printf("net=%s  cmd(%.2f,%.2f)  cur(%.0f,%.0f)  relay=%s  ip=%s\n",
                  netActive ? "ON " : "OFF",
                  netL, netR,
                  curL, curR,
                  relayState ? "ON " : "OFF",
                  WiFi.localIP().toString().c_str());
  }
}

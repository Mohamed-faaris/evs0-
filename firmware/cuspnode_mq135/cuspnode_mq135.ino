/*
 * CuspNode MQ-135 — ESP32 DevKit Arduino firmware
 * AP+STA Wi-Fi, NVS credential management, HTTP API, LED and Serial CLI.
 * MQTT broker settings are provisioned into NVS from the Serial CLI.
 */

#include <Arduino.h>
#include "emqx_ca.h"
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <MQTT.h>
#include <time.h>
#include <esp_sntp.h>

// Increment this for each firmware release. Build date/time are set by the compiler.
#define FIRMWARE_VERSION "1.1.0"
#define FIRMWARE_BUILD_DATE __DATE__
#define FIRMWARE_BUILD_TIME __TIME__

// Forward declaration: Arduino's prototype generator may emit function
// declarations before the full struct definition below.
struct LedPattern;

// ============================================================
// USER CONFIGURATION
// ============================================================

// CHANGE THIS HOTSPOT PASSWORD if you want a different local AP password.
const char* const HOTSPOT_SSID = "cuspnode-mq135";
const char* const HOTSPOT_PASSWORD = "31053105";

// First-boot default SSID. Password is deliberately blank.
// Add the real password through the local portal or Serial CLI.
// Do not commit personal Wi-Fi passwords to source control.
const char* const DEFAULT_WIFI_SSID = "Faaris";
const char* const DEFAULT_WIFI_PASSWORD = "";

// Verify LED pin/polarity for your board revision.
constexpr uint8_t MQ135_PIN = 34;       // AO through a voltage divider
constexpr uint8_t LED_PIN = 2;          // Common onboard LED
constexpr uint8_t BUTTON_PIN = 0;       // Common BOOT button, active LOW
constexpr bool LED_ACTIVE_LOW = false;

constexpr uint8_t MAX_WIFI_NETWORKS = 10;
constexpr uint32_t SENSOR_INTERVAL_MS = 1000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 30000;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 50;

WebServer server(80);
Preferences preferences;

struct WiFiEntry { String ssid; String password; };
WiFiEntry networks[MAX_WIFI_NETWORKS];
uint8_t networkCount = 0;

struct MQTTConfig {
  String host;
  uint16_t port;
  String protocol;
  String username;
  String password;
  bool enabled;
};
MQTTConfig mqttConfig = {"", 8883, "mqtts", "", "", false};

const char* const DEVICE_ID = "device-001";
constexpr uint32_t MQTT_RECONNECT_INTERVAL_MS = 5000;
constexpr uint32_t MQTT_TELEMETRY_INTERVAL_MS = 5000;
constexpr uint32_t NTP_RETRY_INTERVAL_MS = 30000;
constexpr time_t VALID_UNIX_TIME = 1700000000; // 2023-11-14

WiFiClientSecure mqttTlsClient;
MQTTClient mqttClient(768);
String mqttAvailabilityTopic;
bool mqttStateDirty = true;
bool ntpConfigured = false;
bool ntpTimeSynced = false;
uint32_t lastNtpConfigMs = 0;
uint32_t lastMQTTConnectAttemptMs = 0;
uint32_t lastMQTTTelemetryMs = 0;
uint32_t mqttTelemetrySequence = 0;

static const char MQTT_OFFLINE_PAYLOAD[] =
  R"JSON({"device_id":"device-001","status":"offline"})JSON";

// Used by NVS configuration changes before the transport helpers are defined.
void disconnectMQTTGracefully();

enum DeviceState : uint8_t {
  BOOTING, WIFI_SCANNING, WIFI_CONNECTING,
  WIFI_CONNECTED, NO_WIFI, SENSOR_ERROR
};
DeviceState currentState = BOOTING;

bool wifiConnected = false;
bool hotspotActive = false;
bool sensorValid = false;
String connectedSSID;

int sensorADC = 0;
uint32_t sensorMilliVolts = 0;
float adcVoltage = 0.0f;
float estimatedModuleAOVoltage = 0.0f;

uint32_t lastSensorReadMs = 0;
uint32_t lastWiFiRetryMs = 0;
uint32_t wifiAttemptStartedMs = 0;

struct LedPattern {
  const uint16_t* durations;
  const bool* levels;
  uint8_t count;
};

uint32_t ledStepStartedMs = 0;
uint8_t ledStep = 0;
bool lastButtonReading = HIGH;
bool stableButtonState = HIGH;
uint32_t buttonChangedMs = 0;
String serialLine;

// ---------------- State logger ----------------

const char* stateName(DeviceState state) {
  switch (state) {
    case BOOTING: return "BOOTING";
    case WIFI_SCANNING: return "WIFI_SCANNING";
    case WIFI_CONNECTING: return "WIFI_CONNECTING";
    case WIFI_CONNECTED: return "WIFI_CONNECTED";
    case NO_WIFI: return "NO_WIFI";
    case SENSOR_ERROR: return "SENSOR_ERROR";
    default: return "UNKNOWN";
  }
}

void setState(DeviceState next) {
  if (currentState == next) return;

  Serial.printf("[STATE] %s -> %s | uptime=%lu s\n",
    stateName(currentState), stateName(next), millis() / 1000UL);

  currentState = next;
  mqttStateDirty = true;
  ledStep = 0;
  ledStepStartedMs = millis();
}

// ---------------- LED patterns ----------------

const uint16_t bootDur[] = {1000, 1000};
const bool bootLvl[] = {true, false};
const uint16_t scanDur[] = {100, 100, 100, 700};
const bool scanLvl[] = {true, false, true, false};
const uint16_t connectDur[] = {120, 120, 120, 640};
const bool connectLvl[] = {true, false, true, false};
const uint16_t wifiDur[] = {100, 100, 100, 100, 100, 1500};
const bool wifiLvl[] = {true, false, true, false, true, false};
const uint16_t noWifiDur[] = {80, 80};
const bool noWifiLvl[] = {true, false};
const uint16_t errorDur[] = {700, 200, 150, 950};
const bool errorLvl[] = {true, false, true, false};

LedPattern getLedPattern() {
  switch (currentState) {
    case BOOTING: return {bootDur, bootLvl, 2};
    case WIFI_SCANNING: return {scanDur, scanLvl, 4};
    case WIFI_CONNECTING: return {connectDur, connectLvl, 4};
    case WIFI_CONNECTED: return {wifiDur, wifiLvl, 6};
    case NO_WIFI: return {noWifiDur, noWifiLvl, 2};
    case SENSOR_ERROR: return {errorDur, errorLvl, 4};
    default: return {bootDur, bootLvl, 2};
  }
}

void writeLed(bool on) {
  digitalWrite(LED_PIN, (on != LED_ACTIVE_LOW) ? HIGH : LOW);
}

void updateLed() {
  const LedPattern pattern = getLedPattern();
  if (millis() - ledStepStartedMs >= pattern.durations[ledStep]) {
    ledStepStartedMs = millis();
    ledStep = (ledStep + 1) % pattern.count;
  }
  writeLed(pattern.levels[ledStep]);
}

// ---------------- NVS Wi-Fi storage ----------------

void saveNetworks() {
  preferences.begin("cusp-wifi", false);
  preferences.putUChar("count", networkCount);

  for (uint8_t i = 0; i < networkCount; ++i) {
    String ssidKey = "s" + String(i);
    String passKey = "p" + String(i);
    preferences.putString(ssidKey.c_str(), networks[i].ssid);
    preferences.putString(passKey.c_str(), networks[i].password);
  }

  for (uint8_t i = networkCount; i < MAX_WIFI_NETWORKS; ++i) {
    String ssidKey = "s" + String(i);
    String passKey = "p" + String(i);
    preferences.remove(ssidKey.c_str());
    preferences.remove(passKey.c_str());
  }

  preferences.putBool("initialized", true);
  preferences.end();
  Serial.printf("[WIFI] Saved %u network(s) to NVS\n", networkCount);
}

void loadNetworks() {
  preferences.begin("cusp-wifi", false);
  bool initialized = preferences.getBool("initialized", false);
  networkCount = preferences.getUChar("count", 0);
  if (networkCount > MAX_WIFI_NETWORKS) networkCount = 0;

  for (uint8_t i = 0; i < networkCount; ++i) {
    String ssidKey = "s" + String(i);
    String passKey = "p" + String(i);
    networks[i].ssid = preferences.getString(ssidKey.c_str(), "");
    networks[i].password = preferences.getString(passKey.c_str(), "");
  }
  preferences.end();

  // Seed first-boot SSID only. Password stays blank until configured.
  if (!initialized) {
    networkCount = 0;
    if (strlen(DEFAULT_WIFI_SSID) > 0) {
      networks[0].ssid = DEFAULT_WIFI_SSID;
      networks[0].password = DEFAULT_WIFI_PASSWORD;
      networkCount = 1;
    }
    saveNetworks();
    Serial.println("[WIFI] First boot initialized. Configure the Wi-Fi password.");
  }
  Serial.printf("[WIFI] Loaded %u saved network(s)\n", networkCount);
}

bool addWiFiNetwork(const String& inputSsid, const String& password) {
  String ssid = inputSsid;
  ssid.trim();
  if (ssid.isEmpty() || ssid.length() > 32 || password.length() > 63) return false;

  for (uint8_t i = 0; i < networkCount; ++i) {
    if (networks[i].ssid == ssid) {
      networks[i].password = password;
      saveNetworks();
      Serial.printf("[WIFI] Updated network: %s\n", ssid.c_str());
      return true;
    }
  }

  if (networkCount >= MAX_WIFI_NETWORKS) return false;
  networks[networkCount].ssid = ssid;
  networks[networkCount].password = password;
  ++networkCount;
  saveNetworks();
  Serial.printf("[WIFI] Added network: %s\n", ssid.c_str());
  return true;
}

bool removeWiFiNetwork(const String& ssid) {
  for (uint8_t i = 0; i < networkCount; ++i) {
    if (networks[i].ssid == ssid) {
      for (uint8_t j = i; j + 1 < networkCount; ++j) networks[j] = networks[j + 1];
      --networkCount;
      saveNetworks();
      Serial.printf("[WIFI] Removed network: %s\n", ssid.c_str());

      if (connectedSSID == ssid) {
        WiFi.disconnect(false, false);
        wifiConnected = false;
        connectedSSID = "";
        setState(NO_WIFI);
      }
      return true;
    }
  }
  return false;
}

void listSavedNetworks() {
  Serial.println("\n--- Saved Wi-Fi networks ---");
  if (networkCount == 0) Serial.println("(none)");
  for (uint8_t i = 0; i < networkCount; ++i) {
    Serial.printf("%u. %s%s\n", i + 1, networks[i].ssid.c_str(),
      (wifiConnected && connectedSSID == networks[i].ssid) ? " [CONNECTED]" : "");
  }
  Serial.println("Passwords are never displayed.");
}

// ---------------- NVS MQTT configuration ----------------

void saveMQTTConfig() {
  preferences.begin("cusp-mqtt", false);
  preferences.putString("host", mqttConfig.host);
  preferences.putUShort("port", mqttConfig.port);
  preferences.putString("protocol", mqttConfig.protocol);
  preferences.putString("username", mqttConfig.username);
  preferences.putString("password", mqttConfig.password);
  preferences.putBool("enabled", mqttConfig.enabled);
  preferences.end();
  disconnectMQTTGracefully();
  lastMQTTConnectAttemptMs = 0;
  Serial.println("[MQTT] Configuration saved to NVS.");
}

void loadMQTTConfig() {
  preferences.begin("cusp-mqtt", true);
  mqttConfig.host = preferences.getString("host", "");
  mqttConfig.port = preferences.getUShort("port", 8883);
  mqttConfig.protocol = preferences.getString("protocol", "mqtts");
  mqttConfig.username = preferences.getString("username", "");
  mqttConfig.password = preferences.getString("password", "");
  mqttConfig.enabled = preferences.getBool("enabled", false);
  preferences.end();
}

void diagnoseMQTT() {
  Serial.println("\n--- MQTT diagnostics ---");
  Serial.printf("Wi-Fi status : %s\n", WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
  Serial.printf("Wi-Fi IP     : %s\n", WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "unavailable");
  Serial.printf("MQTT enabled : %s\n", mqttConfig.enabled ? "YES" : "NO");
  Serial.printf("Host set     : %s\n", mqttConfig.host.isEmpty() ? "NO" : "YES");
  Serial.printf("Port         : %u\n", mqttConfig.port);
  Serial.printf("Protocol     : %s\n", mqttConfig.protocol.c_str());
  Serial.printf("Username set : %s\n", mqttConfig.username.isEmpty() ? "NO" : "YES");
  Serial.printf("Password set : %s\n", mqttConfig.password.isEmpty() ? "NO" : "YES");
  Serial.printf("CA embedded  : %s\n", sizeof(EMQX_ROOT_CA) > 100 ? "YES" : "NO");

  if (!mqttConfig.enabled) {
    Serial.println("[DIAG] BLOCKED: MQTT is disabled. Run 'mqtt enable'.");
  } else if (mqttConfig.host.isEmpty() || mqttConfig.port == 0) {
    Serial.println("[DIAG] BLOCKED: broker host/port is missing.");
  } else if (mqttConfig.protocol != "mqtts") {
    Serial.println("[DIAG] BLOCKED: this diagnostic expects MQTT over TLS (mqtts).");
  } else if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[DIAG] BLOCKED: ESP32 station Wi-Fi is not connected.");
  } else {
    IPAddress resolved;
    Serial.printf("[DIAG] DNS lookup %s ... ", mqttConfig.host.c_str());
    if (WiFi.hostByName(mqttConfig.host.c_str(), resolved) != 1) {
      Serial.println("FAILED");
      Serial.println("[DIAG] Check Wi-Fi internet access and broker hostname.");
    } else {
      Serial.printf("OK (%s)\n", resolved.toString().c_str());
      WiFiClient probe;
      Serial.printf("[DIAG] TCP connect %s:%u ... ", mqttConfig.host.c_str(), mqttConfig.port);
      if (probe.connect(resolved, mqttConfig.port, 5000)) {
        Serial.println("OK");
        probe.stop();
        Serial.println("[DIAG] Network path and TCP port are reachable.");
      } else {
        Serial.println("FAILED");
        Serial.println("[DIAG] Check outbound firewall, broker endpoint, and port.");
      }
    }
  }

  Serial.printf("[DIAG] NTP time : %s\n", ntpTimeSynced ? "SYNCHRONIZED" : "WAITING");
  Serial.printf("[DIAG] MQTT/TLS : %s\n", mqttClient.connected() ? "CONNECTED" : "NOT CONNECTED");
  Serial.printf("[DIAG] MQTT lib error=%d, CONNACK=%d\n",
    static_cast<int>(mqttClient.lastError()),
    static_cast<int>(mqttClient.returnCode()));
  char tlsError[128] = {0};
  const int tlsErrorCode = mqttTlsClient.lastError(tlsError, sizeof(tlsError));
  Serial.printf("[DIAG] TLS error=%d%s%s\n", tlsErrorCode,
    tlsErrorCode != 0 ? " - " : "", tlsErrorCode != 0 ? tlsError : "");
  if (!mqttClient.connected()) {
    Serial.println("[DIAG] The firmware retries the TLS/MQTT connection automatically.");
  }
  Serial.println("------------------------");
}

void printMQTTStatus() {
  Serial.println("\n--- MQTT configuration ---");
  Serial.printf("Firmware : v%s\n", FIRMWARE_VERSION);
  Serial.printf("Built    : %s %s\n", FIRMWARE_BUILD_DATE, FIRMWARE_BUILD_TIME);
  Serial.printf("Enabled  : %s\n", mqttConfig.enabled ? "YES" : "NO");
  Serial.printf("Host     : %s\n", mqttConfig.host.isEmpty() ? "(not set)" : mqttConfig.host.c_str());
  Serial.printf("Port     : %u\n", mqttConfig.port);
  Serial.printf("Protocol : %s\n", mqttConfig.protocol.c_str());
  Serial.printf("Username : %s\n", mqttConfig.username.isEmpty() ? "(not set)" : "configured");
  Serial.printf("Password : %s\n", mqttConfig.password.isEmpty() ? "not set" : "configured");
  Serial.printf("Time sync: %s\n", ntpTimeSynced ? "READY" : "WAITING");
  Serial.printf("MQTT link: %s\n", mqttClient.connected() ? "CONNECTED" : "DISCONNECTED");
  Serial.printf("MQTT error: %d\n", static_cast<int>(mqttClient.lastError()));
  Serial.printf("MQTT CONNACK: %d\n", static_cast<int>(mqttClient.returnCode()));
  char tlsError[128] = {0};
  const int tlsErrorCode = mqttTlsClient.lastError(tlsError, sizeof(tlsError));
  Serial.printf("TLS error: %d%s%s\n", tlsErrorCode,
    tlsErrorCode != 0 ? " - " : "", tlsErrorCode != 0 ? tlsError : "");
}

bool setMQTTServer(const String& host, const String& portText) {
  String cleanHost = host;
  cleanHost.trim();
  long port = portText.toInt();
  if (cleanHost.isEmpty() || cleanHost.length() > 253 || port < 1 || port > 65535) return false;
  mqttConfig.host = cleanHost;
  mqttConfig.port = static_cast<uint16_t>(port);
  saveMQTTConfig();
  return true;
}

bool setMQTTProtocol(const String& protocol) {
  if (protocol != "mqtts") return false;
  mqttConfig.protocol = protocol;
  saveMQTTConfig();
  return true;
}

// ---------------- MQTT over verified TLS ----------------

String makeMQTTTopic(const char* suffix) {
  return String("evs/v1/devices/") + DEVICE_ID + "/" + suffix;
}

bool getUTCISO8601(char* output, size_t outputSize) {
  const time_t now = time(nullptr);
  if (now < VALID_UNIX_TIME) return false;

  struct tm utc;
  if (gmtime_r(&now, &utc) == nullptr) return false;
  return strftime(output, outputSize, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0;
}

void updateSystemClock() {
  if (WiFi.status() != WL_CONNECTED) return;

  const time_t now = time(nullptr);
  if (now >= VALID_UNIX_TIME) {
    if (!ntpTimeSynced) {
      ntpTimeSynced = true;
      Serial.printf("[NTP] Time synchronized: %s", asctime(gmtime(&now)));
    }
    return;
  }

  ntpTimeSynced = false;
  if (!ntpConfigured || millis() - lastNtpConfigMs >= NTP_RETRY_INTERVAL_MS) {
    configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
    ntpConfigured = true;
    lastNtpConfigMs = millis();
    Serial.println("[NTP] Requested UTC time synchronization.");
  }
}

const char* mqttErrorText(int code) {
  switch (code) {
    case 0: return "success";
    case 1: return "unacceptable protocol version";
    case 2: return "client identifier rejected";
    case 3: return "broker unavailable";
    case 4: return "bad username or password";
    case 5: return "not authorized";
    default: return "transport/library error; inspect error codes";
  }
}

bool publishMQTTAvailability(bool online) {
  StaticJsonDocument<160> doc;
  doc["device_id"] = DEVICE_ID;
  doc["status"] = online ? "online" : "offline";
  char payload[192];
  const size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload)) return false;
  return mqttClient.publish(mqttAvailabilityTopic.c_str(), payload, true, 1);
}

void disconnectMQTTGracefully() {
  if (!mqttClient.connected()) return;
  if (!publishMQTTAvailability(false)) {
    Serial.println("[MQTT] Could not publish retained offline availability.");
  }
  mqttClient.disconnect();
}

void dropMQTTTransport() {
  // Do not send MQTT DISCONNECT when the network has failed; let the broker
  // detect the broken connection and publish the configured Last Will.
  mqttTlsClient.stop();
  mqttClient.disconnect();
}

bool publishMQTTState() {
  StaticJsonDocument<512> doc;
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["state"] = stateName(currentState);
  doc["uptime_seconds"] = millis() / 1000UL;

  JsonObject network = doc.createNestedObject("network");
  network["wifi_connected"] = WiFi.status() == WL_CONNECTED;
  network["wifi_ssid"] = connectedSSID;
  network["hotspot_active"] = hotspotActive;

  JsonObject sensor = doc.createNestedObject("sensor");
  sensor["model"] = "MQ-135";
  sensor["valid"] = sensorValid;

  JsonObject mqtt = doc.createNestedObject("mqtt");
  mqtt["connected"] = mqttClient.connected();

  JsonObject firmware = doc.createNestedObject("firmware");
  firmware["version"] = FIRMWARE_VERSION;
  firmware["build_date"] = FIRMWARE_BUILD_DATE;
  firmware["build_time"] = FIRMWARE_BUILD_TIME;

  char payload[768];
  const size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload)) {
    Serial.println("[MQTT] State payload serialization failed.");
    return false;
  }

  const String topic = makeMQTTTopic("state");
  return mqttClient.publish(topic.c_str(), payload, true, 1);
}

bool publishMQTTTelemetry() {
  StaticJsonDocument<512> doc;
  char timestamp[25];

  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["sensor"] = "MQ-135";
  if (getUTCISO8601(timestamp, sizeof(timestamp))) doc["timestamp"] = timestamp;
  else doc["timestamp"] = nullptr;

  doc["uptime_seconds"] = millis() / 1000UL;
  doc["sequence"] = ++mqttTelemetrySequence;

  JsonObject readings = doc.createNestedObject("readings");
  readings["raw_adc"] = sensorADC;
  readings["adc_pin_voltage_v"] = adcVoltage;
  readings["sensor_ao_voltage_v"] = estimatedModuleAOVoltage;
  readings["ppm"] = nullptr;
  doc["valid"] = sensorValid;

  char payload[512];
  const size_t length = serializeJson(doc, payload, sizeof(payload));
  if (length == 0 || length >= sizeof(payload)) {
    Serial.println("[MQTT] Telemetry payload serialization failed.");
    return false;
  }

  const String topic = makeMQTTTopic("telemetry");
  return mqttClient.publish(topic.c_str(), payload, false, 1);
}

void updateMQTT() {
  if (!mqttConfig.enabled || mqttConfig.host.isEmpty() ||
      mqttConfig.port == 0 || mqttConfig.protocol != "mqtts") {
    if (mqttClient.connected()) {
      disconnectMQTTGracefully();
      Serial.println("[MQTT] Disconnected because MQTT is disabled or configuration is invalid.");
    }
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (mqttClient.connected()) {
      dropMQTTTransport();
      Serial.println("[MQTT] Wi-Fi lost; broker Last Will should mark this device offline.");
    }
    return;
  }

  updateSystemClock();
  if (!ntpTimeSynced) return;

  if (mqttClient.connected()) {
    const bool loopOk = mqttClient.loop();

    if (!loopOk || !mqttClient.connected()) {
      Serial.printf("[MQTT] Loop/transport failed (library error=%d); reconnect scheduled.\n",
        static_cast<int>(mqttClient.lastError()));
      dropMQTTTransport();
      return;
    }

    if (mqttStateDirty) {
      if (publishMQTTState()) {
        mqttStateDirty = false;
        Serial.println("[MQTT] Device state published.");
      } else {
        Serial.println("[MQTT] State publish failed.");
      }
    }

    if (millis() - lastMQTTTelemetryMs >= MQTT_TELEMETRY_INTERVAL_MS) {
      lastMQTTTelemetryMs = millis();
      if (publishMQTTTelemetry()) {
        Serial.printf("[MQTT] Telemetry published | seq=%lu | ADC=%d\n",
          static_cast<unsigned long>(mqttTelemetrySequence), sensorADC);
      } else {
        Serial.println("[MQTT] Telemetry publish failed.");
      }
    }
    return;
  }

  if (lastMQTTConnectAttemptMs != 0 &&
      millis() - lastMQTTConnectAttemptMs < MQTT_RECONNECT_INTERVAL_MS) return;

  lastMQTTConnectAttemptMs = millis();
  mqttTlsClient.setCACert(EMQX_ROOT_CA);
  mqttTlsClient.setHandshakeTimeout(15);
  mqttClient.begin(mqttConfig.host.c_str(), mqttConfig.port, mqttTlsClient);
  mqttClient.setOptions(30, true, 5000);

  mqttAvailabilityTopic = makeMQTTTopic("availability");
  mqttClient.setWill(
    mqttAvailabilityTopic.c_str(),
    MQTT_OFFLINE_PAYLOAD,
    true,
    1
  );

  String clientId = String("cuspnode-") + WiFi.macAddress();
  clientId.replace(":", "");

  Serial.printf("[MQTT] Connecting to %s:%u using verified TLS...\n",
    mqttConfig.host.c_str(), mqttConfig.port);

  if (mqttClient.connect(
        clientId.c_str(),
        mqttConfig.username.c_str(),
        mqttConfig.password.c_str())) {
    Serial.printf("[MQTT] CONNECTED as %s\n", clientId.c_str());

    if (publishMQTTAvailability(true)) {
      Serial.println("[MQTT] Online availability published.");
    } else {
      Serial.println("[MQTT] Failed to publish online availability.");
    }

    mqttStateDirty = true;
    lastMQTTTelemetryMs = millis() - MQTT_TELEMETRY_INTERVAL_MS;
  } else {
    char tlsError[128] = {0};
    const int tlsErrorCode = mqttTlsClient.lastError(tlsError, sizeof(tlsError));
    const int mqttErrorCode = static_cast<int>(mqttClient.lastError());
    const int connackCode = static_cast<int>(mqttClient.returnCode());

    if (connackCode > 0) {
      Serial.printf("[MQTT] Connect rejected | library error=%d | CONNACK=%d (%s)\n",
        mqttErrorCode, connackCode, mqttErrorText(connackCode));
    } else {
      Serial.printf("[MQTT] Transport/TLS connection failed | library error=%d | no CONNACK received\n",
        mqttErrorCode);
    }
    if (tlsErrorCode != 0) {
      Serial.printf("[TLS] Error %d: %s\n", tlsErrorCode, tlsError);
    }
  }
}

// ---------------- Wi-Fi manager ----------------

bool startBestWiFiConnection() {
  if (networkCount == 0) {
    Serial.println("[WIFI] No saved networks. Hotspot remains available.");
    setState(NO_WIFI);
    return false;
  }

  setState(WIFI_SCANNING);
  Serial.println("[WIFI] Scanning for saved networks...");
  WiFi.scanDelete();
  int found = WiFi.scanNetworks(false, true);

  int bestEntry = -1;
  int bestRSSI = -1000;
  for (uint8_t i = 0; i < networkCount; ++i) {
    for (int j = 0; j < found; ++j) {
      if (WiFi.SSID(j) == networks[i].ssid && WiFi.RSSI(j) > bestRSSI) {
        bestRSSI = WiFi.RSSI(j);
        bestEntry = i;
      }
    }
  }
  WiFi.scanDelete();

  if (bestEntry < 0) {
    Serial.println("[WIFI] No saved SSID is visible.");
    setState(NO_WIFI);
    wifiAttemptStartedMs = 0;
    return false;
  }

  connectedSSID = networks[bestEntry].ssid;
  Serial.printf("[WIFI] Connecting to %s (RSSI %d dBm)\n",
    connectedSSID.c_str(), bestRSSI);
  setState(WIFI_CONNECTING);
  WiFi.begin(networks[bestEntry].ssid.c_str(), networks[bestEntry].password.c_str());
  wifiAttemptStartedMs = millis();
  return true;
}

void updateWiFiManager() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      connectedSSID = WiFi.SSID();
      Serial.printf("[WIFI] Connected to %s | IP=%s\n",
        connectedSSID.c_str(), WiFi.localIP().toString().c_str());
      setState(WIFI_CONNECTED);
    }
    return;
  }

  if (wifiConnected) {
    wifiConnected = false;
    Serial.println("[WIFI] Station connection lost.");
    setState(NO_WIFI);
  }

  if (currentState == WIFI_CONNECTING && wifiAttemptStartedMs != 0 &&
      millis() - wifiAttemptStartedMs < WIFI_CONNECT_TIMEOUT_MS) return;

  if (millis() - lastWiFiRetryMs >= WIFI_RETRY_INTERVAL_MS) {
    lastWiFiRetryMs = millis();
    startBestWiFiConnection();
  }
}

// ---------------- MQ-135 sensor ----------------

void readSensor() {
  sensorADC = analogRead(MQ135_PIN);
  sensorMilliVolts = analogReadMilliVolts(MQ135_PIN);
  adcVoltage = sensorMilliVolts / 1000.0f;

  // Assumes AO -> 10k -> GPIO34 -> 20k -> GND.
  estimatedModuleAOVoltage = adcVoltage * 1.5f;

  // Rail check only; this is not a sensor calibration/health diagnosis.
  sensorValid = sensorADC > 2 && sensorADC < 4093;

  if (!sensorValid) {
    setState(SENSOR_ERROR);
  } else if (wifiConnected && currentState == SENSOR_ERROR) {
    setState(WIFI_CONNECTED);
  } else if (!wifiConnected && currentState == SENSOR_ERROR) {
    setState(NO_WIFI);
  }
}

// ---------------- Status report and button ----------------

void printStatus() {
  Serial.println("\n========== CUSPNODE STATUS ==========");
  Serial.printf("Firmware        : v%s\n", FIRMWARE_VERSION);
  Serial.printf("Build date      : %s\n", FIRMWARE_BUILD_DATE);
  Serial.printf("Build time      : %s\n", FIRMWARE_BUILD_TIME);
  Serial.printf("Device          : device-001\n");
  Serial.printf("Uptime          : %lu seconds\n", millis() / 1000UL);
  Serial.printf("State           : %s\n", stateName(currentState));
  Serial.printf("Wi-Fi connected : %s\n", wifiConnected ? "YES" : "NO");
  Serial.printf("Wi-Fi SSID      : %s\n", connectedSSID.c_str());
  Serial.printf("STA IP          : %s\n",
    wifiConnected ? WiFi.localIP().toString().c_str() : "Unavailable");
  Serial.printf("Hotspot active  : %s\n", hotspotActive ? "YES" : "NO");
  Serial.printf("Hotspot SSID    : %s\n", HOTSPOT_SSID);
  Serial.printf("Hotspot IP      : %s\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("Hotspot clients : %u\n", WiFi.softAPgetStationNum());
  Serial.printf("Sensor valid    : %s\n", sensorValid ? "YES" : "NO");
  Serial.printf("MQ-135 ADC      : %d\n", sensorADC);
  Serial.printf("ADC voltage     : %.3f V\n", adcVoltage);
  Serial.printf("Estimated AO    : %.3f V\n", estimatedModuleAOVoltage);
  Serial.printf("MQTT connected  : %s\n", mqttClient.connected() ? "YES" : "NO");
  Serial.printf("Saved Wi-Fi     : %u/%u\n", networkCount, MAX_WIFI_NETWORKS);
  Serial.println("=====================================\n");
}

void updateButton() {
  bool reading = digitalRead(BUTTON_PIN);
  if (reading != lastButtonReading) buttonChangedMs = millis();

  if (millis() - buttonChangedMs >= BUTTON_DEBOUNCE_MS &&
      reading != stableButtonState) {
    stableButtonState = reading;
    if (stableButtonState == LOW) {
      Serial.println("[BUTTON] Status requested.");
      printStatus();
    }
  }
  lastButtonReading = reading;
}

// ---------------- HTTP API ----------------

bool requestIsFromHotspotClient() {
  IPAddress ip = server.client().remoteIP();
  return ip[0] == 192 && ip[1] == 168 && ip[2] == 4;
}

void sendJsonError(int code, const char* message) {
  StaticJsonDocument<192> doc;
  doc["status"] = "error";
  doc["message"] = message;
  String output;
  serializeJson(doc, output);
  server.send(code, "application/json", output);
}

void handleRoot() {
  static const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CuspNode MQ-135</title>
<style>
body{font-family:system-ui;background:#101827;color:#eef2ff;margin:0;padding:20px}
main{max-width:760px;margin:auto}.card{background:#1e293b;border:1px solid #334155;
border-radius:12px;padding:16px;margin:12px 0}h1{color:#7dd3fc}
pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#7dd3fc}
input,button{padding:10px;border-radius:8px;margin:4px 0;max-width:100%}
button{background:#0284c7;color:white;border:0}
small{color:#94a3b8}
</style></head><body><main>
<h1>CuspNode MQ-135</h1>
<p><small>Local device status and Wi-Fi configuration</small></p>
<section class="card"><h2>Health</h2><pre id="health">Loading...</pre></section>
<section class="card"><h2>MQ-135</h2><pre id="sensor">Loading...</pre></section>
<section class="card"><h2>Saved Wi-Fi</h2><pre id="wifi">Loading...</pre>
<h3>Add/update network</h3><form id="add">
<input id="ssid" placeholder="SSID" maxlength="32" required>
<input id="password" placeholder="Wi-Fi password" type="password" maxlength="63">
<button>Save network</button></form>
<small>Passwords are never returned by the API.</small></section>
<section class="card"><h2>API</h2>
<p><a href="/api/health">/api/health</a></p>
<p><a href="/api/wifi">/api/wifi</a> · <a href="/api/wifi/scan">/api/wifi/scan</a></p>
<p><a href="/api/mq135">/api/mq135</a></p></section></main>
<script>
async function refresh(){try{
const [h,s,w]=await Promise.all(['/api/health','/api/mq135','/api/wifi'].map(x=>fetch(x).then(r=>r.json())));
document.querySelector('#health').textContent=JSON.stringify(h,null,2);
document.querySelector('#sensor').textContent=JSON.stringify(s,null,2);
document.querySelector('#wifi').textContent=JSON.stringify(w,null,2);
}catch(e){}}
document.querySelector('#add').addEventListener('submit',async e=>{
e.preventDefault();const r=await fetch('/api/wifi/add',{method:'POST',
headers:{'Content-Type':'application/json'},body:JSON.stringify({
ssid:document.querySelector('#ssid').value,password:document.querySelector('#password').value})});
alert(r.ok?'Network saved':'Could not save network');
document.querySelector('#password').value='';refresh();});
refresh();setInterval(refresh,3000);
</script></body></html>
)HTML";
  server.send_P(200, "text/html", PAGE);
}

void handleHealth() {
  StaticJsonDocument<768> doc;
  doc["status"] = "ok";
  JsonObject firmware = doc.createNestedObject("firmware");
  firmware["version"] = FIRMWARE_VERSION;
  firmware["build_date"] = FIRMWARE_BUILD_DATE;
  firmware["build_time"] = FIRMWARE_BUILD_TIME;
  doc["device_id"] = "device-001";
  doc["state"] = stateName(currentState);
  doc["uptime_seconds"] = millis() / 1000UL;

  JsonObject wifi = doc.createNestedObject("wifi");
  wifi["connected"] = wifiConnected;
  wifi["ssid"] = connectedSSID;
  wifi["ip"] = wifiConnected ? WiFi.localIP().toString() : "";

  JsonObject ap = doc.createNestedObject("hotspot");
  ap["active"] = hotspotActive;
  ap["ssid"] = HOTSPOT_SSID;
  ap["ip"] = WiFi.softAPIP().toString();
  ap["clients"] = WiFi.softAPgetStationNum();

  JsonObject sensor = doc.createNestedObject("sensor");
  sensor["valid"] = sensorValid;
  sensor["raw_adc"] = sensorADC;
  sensor["adc_voltage_v"] = adcVoltage;

  doc["mqtt"]["configured"] = mqttConfig.enabled && !mqttConfig.host.isEmpty();
  doc["mqtt"]["connected"] = mqttClient.connected();
  doc["mqtt"]["time_synced"] = ntpTimeSynced;
  doc["mqtt"]["library_error"] = static_cast<int>(mqttClient.lastError());
  doc["mqtt"]["connack_code"] = static_cast<int>(mqttClient.returnCode());
  doc["mqtt"]["host"] = mqttConfig.host;
  doc["mqtt"]["port"] = mqttConfig.port;
  doc["mqtt"]["protocol"] = mqttConfig.protocol;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleMQ135() {
  StaticJsonDocument<384> doc;
  doc["status"] = sensorValid ? "ok" : "invalid";
  doc["device_id"] = "device-001";
  doc["sensor"] = "MQ-135";
  doc["raw_adc"] = sensorADC;
  doc["adc_pin_voltage_v"] = adcVoltage;
  doc["estimated_sensor_ao_voltage_v"] = estimatedModuleAOVoltage;
  doc["ppm"] = nullptr;
  doc["uptime_seconds"] = millis() / 1000UL;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleWiFiList() {
  StaticJsonDocument<1024> doc;
  JsonArray list = doc.createNestedArray("networks");

  for (uint8_t i = 0; i < networkCount; ++i) {
    JsonObject entry = list.createNestedObject();
    entry["ssid"] = networks[i].ssid;
    entry["connected"] = wifiConnected && networks[i].ssid == connectedSSID;
  }

  doc["count"] = networkCount;
  doc["max"] = MAX_WIFI_NETWORKS;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleWiFiScan() {
  int found = WiFi.scanNetworks(false, true);
  DynamicJsonDocument doc(3072);
  JsonArray list = doc.createNestedArray("networks");

  for (int i = 0; i < found; ++i) {
    JsonObject entry = list.createNestedObject();
    String ssid = WiFi.SSID(i);
    entry["ssid"] = ssid;
    entry["rssi"] = WiFi.RSSI(i);
    entry["saved"] = false;
    for (uint8_t j = 0; j < networkCount; ++j) {
      if (networks[j].ssid == ssid) { entry["saved"] = true; break; }
    }
  }
  WiFi.scanDelete();

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleWiFiAdd() {
  if (!requestIsFromHotspotClient()) {
    sendJsonError(403, "Connect to the ESP32 hotspot to manage Wi-Fi.");
    return;
  }

  StaticJsonDocument<256> input;
  if (deserializeJson(input, server.arg("plain"))) {
    sendJsonError(400, "Invalid JSON body.");
    return;
  }

  String ssid = input["ssid"] | "";
  String password = input["password"] | "";
  if (!addWiFiNetwork(ssid, password)) {
    sendJsonError(400, "Invalid network or storage full.");
    return;
  }

  StaticJsonDocument<128> response;
  response["status"] = "saved";
  response["ssid"] = ssid;
  String output;
  serializeJson(response, output);
  server.send(200, "application/json", output);
}

void handleWiFiRemove() {
  if (!requestIsFromHotspotClient()) {
    sendJsonError(403, "Connect to the ESP32 hotspot to manage Wi-Fi.");
    return;
  }

  StaticJsonDocument<128> input;
  if (deserializeJson(input, server.arg("plain"))) {
    sendJsonError(400, "Invalid JSON body.");
    return;
  }

  String ssid = input["ssid"] | "";
  if (!removeWiFiNetwork(ssid)) {
    sendJsonError(404, "Saved network not found.");
    return;
  }
  server.send(200, "application/json", "{\"status\":\"removed\"}");
}

void setupHttpServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/health", HTTP_GET, handleHealth);
  server.on("/api/mq135", HTTP_GET, handleMQ135);
  server.on("/api/wifi", HTTP_GET, handleWiFiList);
  server.on("/api/wifi/scan", HTTP_GET, handleWiFiScan);
  server.on("/api/wifi/add", HTTP_POST, handleWiFiAdd);
  server.on("/api/wifi/remove", HTTP_POST, handleWiFiRemove);
  server.onNotFound([]() { sendJsonError(404, "Route not found."); });
  server.begin();
  Serial.println("[HTTP] Server started on port 80");
}

// ---------------- Serial command interface ----------------

void printHelp() {
  Serial.println(R"HELP(
CuspNode MQ-135 Serial commands
--------------------------------
help
status
device info
wifi list
wifi scan
wifi add <SSID> <PASSWORD>
wifi remove <SSID>
wifi reconnect
sensor
sensor read
ap status
mqtt status
mqtt diagnose
mqtt reconnect
mqtt set-server <HOST> <PORT>
mqtt set-protocol <mqtts>
mqtt set-auth <USERNAME> <PASSWORD>
mqtt clear-auth
mqtt enable
mqtt disable
--------------------------------
115200 baud; Serial Monitor line ending: Newline.
Serial add command expects SSID without spaces.
Passwords are never printed.
)HELP");
}

void handleSerialCommand(String command) {
  command.trim();
  if (command.isEmpty()) return;
  if (command.startsWith("mqtt set-auth ")) Serial.println("[CLI] mqtt set-auth [REDACTED]");
  else Serial.printf("[CLI] %s\n", command.c_str());

  if (command == "help") printHelp();
  else if (command == "status") printStatus();
  else if (command == "wifi list") listSavedNetworks();
  else if (command == "wifi scan") {
    int count = WiFi.scanNetworks(false, true);
    Serial.println("--- Nearby Wi-Fi ---");
    for (int i = 0; i < count; ++i)
      Serial.printf("%d. %s | %d dBm\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
    WiFi.scanDelete();
  }
  else if (command.startsWith("wifi add ")) {
    String args = command.substring(9);
    int separator = args.indexOf(' ');
    if (separator <= 0) {
      Serial.println("Usage: wifi add <SSID> <PASSWORD>");
      return;
    }
    String ssid = args.substring(0, separator);
    String password = args.substring(separator + 1);
    Serial.println(addWiFiNetwork(ssid, password) ?
      "[CLI] Network saved." : "[CLI] Failed to save network.");
  }
  else if (command.startsWith("wifi remove ")) {
    String ssid = command.substring(12);
    Serial.println(removeWiFiNetwork(ssid) ?
      "[CLI] Network removed." : "[CLI] Network not found.");
  }
  else if (command == "wifi reconnect") {
    wifiConnected = false;
    WiFi.disconnect(false, false);
    lastWiFiRetryMs = millis() - WIFI_RETRY_INTERVAL_MS;
    startBestWiFiConnection();
  }
  else if (command == "sensor" || command == "sensor read") {
    readSensor();
    Serial.printf("ADC=%d | ADC voltage=%.3f V | valid=%s\n",
      sensorADC, adcVoltage, sensorValid ? "yes" : "no");
  }
  else if (command == "mqtt status") printMQTTStatus();
  else if (command == "mqtt diagnose") diagnoseMQTT();
  else if (command == "mqtt reconnect") {
    disconnectMQTTGracefully();
    lastMQTTConnectAttemptMs = 0;
    Serial.println("[MQTT] Reconnect requested; the main loop will attempt it.");
  }
  else if (command.startsWith("mqtt set-server ")) {
    String args = command.substring(16);
    int separator = args.indexOf(' ');
    if (separator <= 0 || !setMQTTServer(args.substring(0, separator), args.substring(separator + 1)))
      Serial.println("Usage: mqtt set-server <HOST> <PORT>");
    else Serial.println("[MQTT] Broker endpoint updated.");
  }
  else if (command.startsWith("mqtt set-protocol ")) {
    String protocol = command.substring(18);
    protocol.trim();
    Serial.println(setMQTTProtocol(protocol) ? "[MQTT] Protocol updated." : "Only mqtts (MQTT over TLS) is supported.");
  }
  else if (command.startsWith("mqtt set-auth ")) {
    String args = command.substring(14);
    int separator = args.indexOf(' ');
    if (separator <= 0) Serial.println("Usage: mqtt set-auth <USERNAME> <PASSWORD>");
    else {
      mqttConfig.username = args.substring(0, separator);
      mqttConfig.password = args.substring(separator + 1);
      saveMQTTConfig();
      Serial.println("[MQTT] Authentication updated. Secret values are not displayed.");
    }
  }
  else if (command == "mqtt clear-auth") {
    mqttConfig.username = "";
    mqttConfig.password = "";
    saveMQTTConfig();
    Serial.println("[MQTT] Authentication cleared.");
  }
  else if (command == "mqtt enable" || command == "mqtt disable") {
    if (command == "mqtt enable" && mqttConfig.host.isEmpty()) {
      Serial.println("[MQTT] Set a broker first with mqtt set-server.");
    } else {
      mqttConfig.enabled = command == "mqtt enable";
      saveMQTTConfig();
    }
  }
  else if (command == "ap status") {
    Serial.printf("SSID=%s | IP=%s | clients=%u\n",
      HOTSPOT_SSID, WiFi.softAPIP().toString().c_str(),
      WiFi.softAPgetStationNum());
  }
  else if (command == "device info") {
    Serial.printf("Chip=%s | cores=%u | flash=%u | heap=%u\n",
      ESP.getChipModel(), ESP.getChipCores(),
      ESP.getFlashChipSize(), ESP.getFreeHeap());
  }
  else Serial.println("Unknown command. Type help.");
}

void updateSerialConsole() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (serialLine.length() > 0) {
        handleSerialCommand(serialLine);
        serialLine = "";
      }
    } else if (serialLine.length() < 160) {
      serialLine += c;
    }
  }
}

// ---------------- Setup and loop ----------------

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(MQ135_PIN, INPUT);
  writeLed(false);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ135_PIN, ADC_11db);

  setState(BOOTING);
  Serial.println("\n[CUSPNODE] ESP32 MQ-135 starting");
  Serial.printf("[FW] Version: %s | Built: %s %s\n", FIRMWARE_VERSION, FIRMWARE_BUILD_DATE, FIRMWARE_BUILD_TIME);

  loadNetworks();
  loadMQTTConfig();
  mqttAvailabilityTopic = makeMQTTTopic("availability");
  mqttTlsClient.setCACert(EMQX_ROOT_CA);
  mqttTlsClient.setHandshakeTimeout(15);
  mqttClient.setOptions(30, true, 5000);
  Serial.println("[MQTT] TLS client initialized with the embedded CA.");

  // AP+STA keeps the local management hotspot active while STA connects.
  WiFi.mode(WIFI_AP_STA);
  WiFi.setAutoReconnect(true);

  hotspotActive = WiFi.softAP(HOTSPOT_SSID, HOTSPOT_PASSWORD);
  if (hotspotActive) {
    Serial.printf("[AP] Started SSID=%s | IP=%s\n",
      HOTSPOT_SSID, WiFi.softAPIP().toString().c_str());
  } else {
    Serial.println("[AP] Failed to start hotspot.");
  }

  setupHttpServer();

  lastWiFiRetryMs = millis() - WIFI_RETRY_INTERVAL_MS;
  startBestWiFiConnection();

  Serial.println("[SYSTEM] Ready. Type 'help' in Serial Monitor.");
}

void loop() {
  server.handleClient();
  updateSerialConsole();
  updateButton();
  updateLed();
  updateWiFiManager();

  if (millis() - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    lastSensorReadMs = millis();
    readSensor();
  }

  updateMQTT();
  delay(2);
}

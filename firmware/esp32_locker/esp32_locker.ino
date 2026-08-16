/*
  Smart Locker - ESP32 Firmware
  ------------------------------
  Hardware:
    - ESP32 dev board
    - 2-channel relay module driving two 12V solenoid locks (Locker 1 / Locker 2)
    - 16x2 I2C LCD (PCF8574 backpack, addr 0x27)

  Talks to the Node/Express backend (server.js) over MQTT via HiveMQ Cloud.
  The backend publishes JSON commands to MQTT_TOPIC ("esp32/lock/command"):
    { "cmd": "unlock", "locker": 1 }
    { "cmd": "lock",   "locker": 1 }
    { "cmd": "display","locker": 1, "status": "ASSIGNED"|"AVAILABLE", "user": "..." }

  Libraries required (Arduino IDE > Tools > Manage Libraries):
    - PubSubClient      (Nick O'Leary)
    - ArduinoJson        (Benoit Blanchon)
    - LiquidCrystal_I2C   (Frank de Brabander / Marco Schwartz fork)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ---------- WiFi ----------
const char* WIFI_SSID     = "IotdevLab";
const char* WIFI_PASSWORD = "@50Ghana";

// ---------- MQTT (HiveMQ Cloud, matches backend .env) ----------
const char* MQTT_HOST  = "f1c8e1bf4da9440c983af45fcaf5f040.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USER  = "smart-locker";
const char* MQTT_PASS  = "forwards"; // copy from backend .env (MQTT_PASSWORD)
const char* MQTT_TOPIC = "esp32/lock/command";
const char* MQTT_CLIENT_ID = "esp32-locker-01";

// ---------- Relay / solenoid pins ----------
// Energized (HIGH out of relay board, LOW-triggered boards invert this) = solenoid retracted = UNLOCKED
// De-energized = spring returns pin = LOCKED (fail-secure on power loss)
#define RELAY_LOCKER_1 26
#define RELAY_LOCKER_2 23
#define RELAY_ACTIVE_LOW true   // most cheap 2-channel relay boards trigger on LOW

// ---------- LCD ----------
#define LCD_ADDR 0x27
#define LCD_COLS 16
#define LCD_ROWS 2
LiquidCrystal_I2C lcd(LCD_ADDR, LCD_COLS, LCD_ROWS);

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);

void relayWrite(uint8_t pin, bool energize) {
  bool level = RELAY_ACTIVE_LOW ? !energize : energize;
  digitalWrite(pin, level ? HIGH : LOW);
}

void setLockerState(int locker, bool unlocked) {
  uint8_t pin = (locker == 1) ? RELAY_LOCKER_1 : RELAY_LOCKER_2;
  relayWrite(pin, unlocked);
  Serial.printf("Locker %d -> %s\n", locker, unlocked ? "UNLOCKED" : "LOCKED");
}

void lcdMessage(const String& line1, const String& line2 = "") {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, LCD_COLS));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, LCD_COLS));
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());
}

void handleCommand(JsonDocument& doc) {
  const char* cmd = doc["cmd"] | "";
  int locker = doc["locker"] | 0;

  if (strcmp(cmd, "unlock") == 0) {
    if (locker == 1 || locker == 2) {
      setLockerState(locker, true);
      lcdMessage("Locker " + String(locker), "is open");
    }
  } else if (strcmp(cmd, "lock") == 0) {
    if (locker == 1 || locker == 2) {
      setLockerState(locker, false);
      lcdMessage("Locker " + String(locker), "LOCKED");
    }
  } else if (strcmp(cmd, "display") == 0) {
    const char* status = doc["status"] | "";
    const char* user = doc["user"] | "";
    String line2 = String(status);
    if (strlen(user) > 0) line2 += " " + String(user);
    lcdMessage("Locker " + String(locker), line2);
  } else {
    Serial.print("Unknown cmd: ");
    Serial.println(cmd);
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("MQTT message on ");
  Serial.println(topic);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("JSON parse failed: ");
    Serial.println(err.c_str());
    return;
  }
  handleCommand(doc);
}

void connectMqtt() {
  secureClient.setInsecure(); // skip cert validation for simplicity; pin the HiveMQ CA for production
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT...");
    if (mqttClient.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)) {
      Serial.println("connected");
      mqttClient.subscribe(MQTT_TOPIC);
      lcdMessage("Welcome to", "Smart Locker");
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying in 3s");
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_LOCKER_1, OUTPUT);
  pinMode(RELAY_LOCKER_2, OUTPUT);
  setLockerState(1, false); // start locked (fail-secure)
  setLockerState(2, false);

  Wire.begin(21, 22); // SDA, SCL (default ESP32 I2C pins)
  lcd.init();
  lcd.backlight();
  lcdMessage("Starting the", "system...");

  connectWiFi();
  connectMqtt();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }
  if (!mqttClient.connected()) {
    connectMqtt();
  }
  mqttClient.loop();
}

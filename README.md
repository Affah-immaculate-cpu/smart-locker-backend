# Smart Locker Backend

A biometric-secured smart locker system. Users verify their identity with WebAuthn (Face ID / Touch ID / fingerprint / PIN) in the browser, the Node backend assigns them an available locker, and locker hardware (ESP32 + relay-driven solenoid locks + I2C LCD) is controlled over MQTT.

## How it works

1. A user opens the web page [Smart Locker Login Page](smart-locker-backend-o5ha.onrender.com) and registers a biometric credential (WebAuthn) or verifies with one they already registered.
2. On successful verification, the backend claims the next `AVAILABLE` locker for that user and publishes an MQTT `display` command so the locker's LCD shows who it's assigned to.
3. The user can `unlock`/`lock` their locker from the page; each action is published as an MQTT command that the ESP32 firmware picks up and drives the relay accordingly.
4. When done, the user releases the locker, freeing it for the next person.
5. A background timer auto-releases lockers whose lease has expired (unclaimed lock) or that have been left open too long (occupied timeout), so a locker never gets stuck assigned to nobody.
6. If the page is refreshed while a locker is claimed, the session is restored from `localStorage` and re-validated against the server so the user doesn't lose their spot.

## Architecture

```
Browser (smart-locker-backend-o5ha.onrender.com)
   |  WebAuthn (register/login) + REST (claim/action/release)
   v
Express server (server.js) -- SQLite (lockers.db via database.js)
   |  MQTT (publish cmd: unlock/lock/display)
   v
HiveMQ Cloud (MQTT broker)
   |
   v
ESP32 firmware (firmware/esp32_locker) -- relays -> solenoid locks
                                        -- I2C LCD status display
```

## Requirements

- Node.js 18+
- An MQTT broker (this project is set up for [HiveMQ Cloud](https://www.hivemq.com/mqtt-cloud-broker/))
- An ESP32 dev board + 2-channel relay module + 16x2 I2C LCD, if you're driving real hardware (optional for testing the web/API flow alone — MQTT is skipped gracefully if unconfigured)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the project root:
   ```env
   # Web / WebAuthn
   NODE_ENV=development
   EXPECTED_ORIGIN=http://localhost:3000
   # RP_ID=localhost        # optional, derived from EXPECTED_ORIGIN if omitted

   # MQTT (HiveMQ Cloud or any MQTT broker)
   MQTT_HOST=<broker-host>:8883
   MQTT_USERNAME=<username>
   MQTT_PASSWORD=<password>
   MQTT_TOPIC=esp32/lock/command
   ```
   MQTT is optional — if `MQTT_HOST` isn't set, the server still runs and the REST/WebAuthn flow works; it just won't publish hardware commands.
3. Start the server:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in a browser that supports WebAuthn (a phone or laptop with a fingerprint/Face ID sensor, or a platform authenticator).

The SQLite database (`lockers.db`) is created automatically on first run with 2 lockers (`locker_id` 1 and 2), both `AVAILABLE`.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `NODE_ENV` | `production` enables production mode logging | development |
| `EXPECTED_ORIGIN` | Origin WebAuthn responses must match | `http://localhost:3000` |
| `RP_ID` | WebAuthn Relying Party ID | derived from `EXPECTED_ORIGIN`'s hostname |
| `MQTT_HOST` | MQTT broker host (with optional port) | — (MQTT disabled if unset) |
| `MQTT_USERNAME` / `MQTT_USER` | MQTT broker username | — |
| `MQTT_PASSWORD` / `MQTT_PASS` | MQTT broker password | — |
| `MQTT_TOPIC` | Topic the server publishes commands to and the firmware subscribes to | `esp32/lock/command` |
| `PORT` | HTTP port | `3000` |

## API

| Method & Path | Body / Query | Description |
|---|---|---|
| `POST /register/start` | — | Begin WebAuthn registration; returns options for the browser authenticator |
| `POST /register/finish` | WebAuthn attestation response | Verifies and stores a new credential |
| `POST /login/start` | — | Begin WebAuthn authentication; returns options for a registered authenticator |
| `POST /login/finish` | WebAuthn assertion response | Verifies identity; returns `userID` |
| `POST /claim` | `{ user_id }` | Assigns the next available locker to the user |
| `GET /locker/status` | `?user_id=` | Returns the locker currently assigned/occupied by the user, if any (used to restore session on page refresh) |
| `POST /action` | `{ user_id, locker_id, action }` | `action` is `unlock` or `lock`; publishes the corresponding MQTT command |
| `POST /release` | `{ user_id, locker_id }` | Frees the locker back to `AVAILABLE` |
| `GET /health` | — | Basic health/config check |

## Locker lifecycle

`AVAILABLE` → (`/claim`) → `ASSIGNED` → (`/action unlock`) → `OCCUPIED` → (`/release`) → `AVAILABLE`

- An `ASSIGNED` locker that isn't unlocked within its lease window (5 minutes) auto-reverts to `AVAILABLE`.
- An `OCCUPIED` locker left open for more than 5 minutes is auto-locked and released.

## Firmware

[firmware/esp32_locker/esp32_locker.ino](firmware/esp32_locker/esp32_locker.ino) runs on the ESP32 and:

- Connects to Wi-Fi and the MQTT broker (matching the backend's `.env` MQTT settings)
- Subscribes to the command topic and drives two relay-controlled solenoid locks (`unlock`/`lock`)
- Shows locker status/assignment on a 16x2 I2C LCD (`display` command)

Required Arduino libraries: `PubSubClient`, `ArduinoJson`, `LiquidCrystal_I2C`. Update the `WIFI_SSID`/`WIFI_PASSWORD` and `MQTT_*` constants at the top of the file to match your network and broker before flashing.

## Scripts

- `scripts/inspect_db.js` — read-only inspection of registered users in `lockers.db`
- `scripts/inspect_webauthn_start.js` — debug helper for inspecting `/register/start`/`/login/start` output

## Notes

- `.env` is gitignored — never commit real broker credentials.
- `lockers.db` is a local SQLite file; delete it to reset all lockers/users during development.

## Read Operating Manual: [Open Manual](Smart%20Locker%20-%20Operations%20Manual.pdf)
## Watch operating video: [Smart Locker - Demo Video](https://drive.google.com/file/d/1R2BMD9DogCVqviRVV4EwPOxApFnTIgfG/view?usp=sharing)


const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. FILL IN YOUR HIVEMQ CREDENTIALS HERE ---
const config = {
    mqtt_host: 'mqtts://f1c8e1bf4da9440c983af45fcaf5f040.s1.eu.hivemq.cloud:8883',
    mqtt_user: 'smart-locker',
    mqtt_pass: 'forwards',
    mqtt_topic: 'esp32/lock/command'
};

// Connect to HiveMQ
const mqttClient = mqtt.connect(config.mqtt_host, {
    username: config.mqtt_user,
    password: config.mqtt_pass,
    clientId: 'backend_brain_' + Math.random().toString(16).substr(2, 8)
});

mqttClient.on('connect', () => {
    console.log('Backend connected to HiveMQ Cloud!');
});

// --- 2. API ENDPOINTS FOR THE WEB APP ---

// Claim a locker
app.post('/claim', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'No user ID provided' });

  // Check if user already has a locker
  db.get("SELECT * FROM lockers WHERE user_id = ? AND state != 'AVAILABLE'", [user_id], (err, row) => {
    if (row) return res.status(200).json({ message: 'You already have a locker!', locker_id: row.locker_id });

    // Find first available locker
    db.get("SELECT * FROM lockers WHERE state = 'AVAILABLE' LIMIT 1", (err, row) => {
        if (!row) return res.status(400).json({ error: 'No lockers available' });

        const lockerId = row.locker_id;
        const leaseExpiry = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

        db.run("UPDATE lockers SET state = 'ASSIGNED', user_id = ?, lease_expiry = ? WHERE locker_id = ?",
        [user_id, leaseExpiry, lockerId],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });

          // Tell ESP32 to update the screen
            mqttClient.publish(config.mqtt_topic, JSON.stringify({
            cmd: 'display',
            locker: lockerId,
            status: 'ASSIGNED',
            user: user_id,
            timeout: 300
            }));

            res.json({ message: 'Locker assigned', locker_id: lockerId, timeout: 300 });
        }
        );
    });
    });
});

// Unlock / Lock actions
app.post('/action', (req, res) => {
    const { user_id, locker_id, action } = req.body;
  db.get("SELECT * FROM lockers WHERE locker_id = ? AND user_id = ?", [locker_id, user_id], (err, row) => {
    if (!row) return res.status(403).json({ error: 'Access denied' });

    if (action === 'unlock') {
        const now = Math.floor(Date.now() / 1000);
      // Update state to OCCUPIED and set the occupied_since timestamp for the 24-hour timer
        db.run("UPDATE lockers SET state = 'OCCUPIED', lease_expiry = NULL, occupied_since = ? WHERE locker_id = ?", [now, locker_id]);
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'unlock', locker: locker_id }));
        return res.json({ message: 'Unlocking locker' });
    }
    else if (action === 'lock') {
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'lock', locker: locker_id }));
        return res.json({ message: 'Locking locker' });
    }
    res.status(400).json({ error: 'Invalid action' });
    });
});

// Release locker (Return)
app.post('/release', (req, res) => {
    const { user_id, locker_id } = req.body;
    db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL, occupied_since = NULL WHERE locker_id = ? AND user_id = ?",
    [locker_id, user_id],
    function(err) {
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: locker_id, status: 'AVAILABLE', user: null }));
        res.json({ message: 'Locker released' });
    }
    );
});

// --- 3. THE TIMERS: 5-MINUTE LEASE & 24-HOUR AUTO-RELEASE ---
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);

  // Task A: Handle 5-minute assignment lease expirations
  db.all("SELECT * FROM lockers WHERE state = 'ASSIGNED' AND lease_expiry < ?", [now], (err, rows) => {
    rows.forEach(row => {
        console.log(`Assignment timeout expired for Locker ${row.locker_id}, releasing.`);
        db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL WHERE locker_id = ?", [row.locker_id]);
        mqttClient.publish(config.mqtt_topic, JSON.stringify({
        cmd: 'display',
        locker: row.locker_id,
        status: 'AVAILABLE',
        user: null
        }));
    });
    });

  // Task B: Handle 24-hour auto-release for occupied lockers (forgetful users)
  const twentyFourHoursAgo = now - (60 * 60 * 24); // 86400 seconds
  db.all("SELECT * FROM lockers WHERE state = 'OCCUPIED' AND occupied_since < ?", [twentyFourHoursAgo], (err, rows) => {
    rows.forEach(row => {
        console.log(`Locker ${row.locker_id} has been occupied for 24 hours. Force-releasing and opening.`);
        db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL, occupied_since = NULL WHERE locker_id = ?", [row.locker_id]);

      // Tell ESP32 to open the locker automatically so they can get their stuff out!
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'unlock', locker: row.locker_id }));

      // Then update the screen to Available after 5 seconds
        setTimeout(() => {
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'AVAILABLE', user: null }));
        }, 5000);
    });
    });
}, 15000); // Checks every 15 seconds

// Start the server
app.listen(3000, () => {
    console.log('Backend running on http://localhost:3000');
});
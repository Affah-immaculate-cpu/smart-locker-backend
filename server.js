const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- DYNAMIC DOMAIN SETUP FOR HTTPS ---
// Render injects a URL environment variable automatically
const isProduction = process.env.NODE_ENV === 'production';
const publicUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const rpID = isProduction ? new URL(publicUrl).hostname : 'localhost';
const expectedOrigin = publicUrl;

console.log(`🔥 Running in ${isProduction ? 'Production' : 'Development'} mode`);
console.log(`🔒 RP ID: ${rpID}`);
console.log(`🌐 Expected Origin: ${expectedOrigin}`);

// --- DATABASE (SQLite) ---
// Note: Free Render servers wipe SQLite files on restart. For a permanent database,
// we'd use MongoDB Atlas, but SQLite is fine for a working prototype.
const db = new sqlite3.Database(path.join(__dirname, 'lockers.db'));
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS lockers (id INTEGER PRIMARY KEY, locker_id INTEGER, state TEXT, user_id TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, credential_id TEXT, public_key TEXT, counter INTEGER)");
    db.get("SELECT COUNT(*) as count FROM lockers", (err, row) => {
    if (row.count === 0) {
        db.run("INSERT INTO lockers (locker_id, state) VALUES (1, 'AVAILABLE'), (2, 'AVAILABLE')");
    }
    });
});

// --- MQTT CONNECTION (USE ENVIRONMENT VARIABLES FOR SECURITY) ---
const config = {
    mqtt_host: process.env.MQTT_HOST || 'mqtts://f1c8e1bf4da9440c983af45fcaf5f040.s1.eu.hivemq.cloud:8883',
    mqtt_user: process.env.MQTT_USER || 'smart-locker',
    mqtt_pass: process.env.MQTT_PASS || 'forwards',
    mqtt_topic: 'esp32/lock/command'
};
const mqttClient = mqtt.connect(config.mqtt_host, { username: config.mqtt_user, password: config.mqtt_pass });
mqttClient.on('connect', () => console.log('✅ MQTT Connected to HiveMQ'));

const challengeStore = {};

// --- WEBAUTHN ROUTES ---
app.post('/login/start', (req, res) => {
  db.all("SELECT * FROM users", (err, rows) => {
    if (rows.length === 0) return res.status(404).json({ error: 'No users registered. Please register first.' });
    const options = generateAuthenticationOptions({
        rpID: rpID,
        allowCredentials: rows.map(u => ({ id: Buffer.from(u.credential_id, 'base64url'), type: 'public-key' })),
    });
    challengeStore[options.challenge] = 'login';
    res.json(options);
    });
});

app.post('/login/finish', async (req, res) => {
    const { body } = req;
    if (!challengeStore[body.challenge]) return res.status(400).json({ error: 'Invalid challenge' });
    delete challengeStore[body.challenge];

  db.get("SELECT * FROM users WHERE credential_id = ?", [body.id], async (err, row) => {
    if (!row) return res.status(400).json({ error: 'User not found' });
    try {
        const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: body.challenge,
        expectedRPID: rpID,
        expectedOrigin: expectedOrigin,
        authenticator: {
            credentialID: Buffer.from(row.credential_id, 'base64url'),
            credentialPublicKey: Buffer.from(row.public_key, 'base64url'),
            counter: row.counter
        },
        });
        if (verification.verified) {
        db.run("UPDATE users SET counter = ? WHERE id = ?", [verification.authenticationInfo.newCounter, row.id]);
        return res.json({ verified: true, userID: row.id });
        }
    } catch (error) { return res.status(400).json({ error: error.message }); }
    res.status(400).json({ error: 'Authentication failed' });
    });
});

// --- LOCKER API ---
app.post('/claim', (req, res) => {
    const { user_id } = req.body;
  db.get("SELECT * FROM lockers WHERE state = 'AVAILABLE' LIMIT 1", (err, row) => {
    if (!row) return res.status(400).json({ error: 'No lockers available' });
    db.run("UPDATE lockers SET state = 'ASSIGNED', user_id = ? WHERE locker_id = ?", [user_id, row.locker_id]);
    mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'ASSIGNED', user: user_id }));
    res.json({ message: 'Locker assigned', locker_id: row.locker_id });
    });
});

app.post('/action', (req, res) => {
    const { user_id, locker_id, action } = req.body;
  db.get("SELECT * FROM lockers WHERE locker_id = ? AND user_id = ?", [locker_id, user_id], (err, row) => {
    if (!row) return res.status(403).json({ error: 'Access denied' });
    if (action === 'unlock') {
        db.run("UPDATE lockers SET state = 'OCCUPIED' WHERE locker_id = ?", [locker_id]);
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'unlock', locker: locker_id }));
        return res.json({ message: 'Unlocking locker' });
    } else if (action === 'lock') {
        mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'lock', locker: locker_id }));
        return res.json({ message: 'Locking locker' });
    }
    res.status(400).json({ error: 'Invalid action' });
    });
});

app.post('/release', (req, res) => {
    const { user_id, locker_id } = req.body;
    db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL WHERE locker_id = ? AND user_id = ?", [locker_id, user_id]);
    mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: locker_id, status: 'AVAILABLE', user: null }));
    res.json({ message: 'Locker released' });
});

app.listen(3000, () => console.log(`🚀 Server ready at ${expectedOrigin}`));
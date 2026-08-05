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

const isProduction = process.env.NODE_ENV === 'production';
const publicUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const rpID = isProduction ? new URL(publicUrl).hostname : 'localhost';
const expectedOrigin = publicUrl;

console.log(`🔥 Running in ${isProduction ? 'Production' : 'Development'} mode`);
console.log(`🔒 RP ID: ${rpID}`);
console.log(`🌐 Expected Origin: ${expectedOrigin}`);

// --- DATABASE ---
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

// --- MQTT ---
const config = {
    mqtt_host: process.env.MQTT_HOST || 'mqtts://YOUR_CLUSTER.s1.eu.hivemq.cloud:8883',
    mqtt_user: process.env.MQTT_USER || 'smart-locker',
    mqtt_pass: process.env.MQTT_PASS || 'forwards',
    mqtt_topic: 'esp32/lock/command'
};
const mqttClient = mqtt.connect(config.mqtt_host, { username: config.mqtt_user, password: config.mqtt_pass });
mqttClient.on('connect', () => console.log('✅ MQTT Connected to HiveMQ'));

const challengeStore = {};

// --- 1. WEBAUTHN REGISTRATION ROUTES ---
app.post('/register/start', (req, res) => {
    const userID = crypto.randomBytes(16).toString('hex');
    const options = generateRegistrationOptions({
        rpID: rpID,
        rpName: 'Smart Locker System',
        userID: userID,
        userName: `user_${userID}`,
        attestationType: 'none',
    });
    challengeStore[options.challenge] = userID;
    res.json(options);
});

app.post('/register/finish', async (req, res) => {
    const { body } = req;
    const userID = challengeStore[body.challenge];
    if (!userID) {
        console.error('register/finish: invalid or missing challenge', { challenge: body && body.challenge, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    try {
        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: body.challenge,
            expectedRPID: rpID,
            expectedOrigin: expectedOrigin,
        });

        // Log verification details for debugging
        console.debug('register/finish verification result', {
            verified: verification && verification.verified,
            hasRegistrationInfo: verification && !!verification.registrationInfo,
        });

        if (verification && verification.verified && verification.registrationInfo) {
            const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
            db.run("INSERT INTO users (id, credential_id, public_key, counter) VALUES (?, ?, ?, ?)",
                [userID, credentialID.toString('base64url'), credentialPublicKey.toString('base64url'), counter], (dbErr) => {
                    if (dbErr) console.error('register/finish: DB insert error', dbErr);
                });
            delete challengeStore[body.challenge];
            return res.json({ verified: true, userID });
        } else {
            console.error('register/finish: verification failed or missing registrationInfo', { verification, body, userID });
        }
    } catch (error) {
        console.error('register/finish: exception during verification', { error: error && (error.stack || error), body, userID });
        return res.status(400).json({ error: error.message });
    }
    console.error('register/finish: registration failed (unverified)', { body, userID });
    res.status(400).json({ error: 'Registration failed' });
});

// --- 2. WEBAUTHN LOGIN ROUTES ---
app.post('/login/start', (req, res) => {
    db.all("SELECT * FROM users", (err, rows) => {
        if (rows.length === 0) return res.status(404).json({ error: 'No users registered' });
        const options = generateAuthenticationOptions({
            rpID: rpID,
            allowCredentials: rows.map(u => ({ id: Buffer.from(u.credential_id, 'base64url'), type: 'public-key' })),
        });
        // Ensure allowCredentials.id values are serialized as base64url strings
        if (options.allowCredentials && Array.isArray(options.allowCredentials)) {
            options.allowCredentials = options.allowCredentials.map(c => ({
                id: Buffer.isBuffer(c.id) ? c.id.toString('base64url') : c.id,
                type: c.type,
                transports: c.transports,
            }));
        }
        challengeStore[options.challenge] = 'login';
        res.json(options);
    });
});

app.post('/login/finish', async (req, res) => {
    const { body } = req;
    if (!challengeStore[body.challenge]) {
        console.error('login/finish: invalid or missing challenge', { challenge: body && body.challenge, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    delete challengeStore[body.challenge];
    db.get("SELECT * FROM users WHERE credential_id = ?", [body.id], async (err, row) => {
        if (err) {
            console.error('login/finish: DB error fetching user', err, { body });
            return res.status(500).json({ error: 'Server error' });
        }
        if (!row) {
            console.error('login/finish: user not found for credential', { credential_id: body.id, body });
            return res.status(400).json({ error: 'User not found' });
        }
        try {
            const verification = await verifyAuthenticationResponse({
                response: body,
                expectedChallenge: body.challenge,
                expectedRPID: rpID,
                expectedOrigin: expectedOrigin,
                authenticator: { credentialID: Buffer.from(row.credential_id, 'base64url'), credentialPublicKey: Buffer.from(row.public_key, 'base64url'), counter: row.counter },
            });

            console.debug('login/finish verification', { verified: verification && verification.verified, authenticationInfo: verification && verification.authenticationInfo });

            if (verification && verification.verified) {
                db.run("UPDATE users SET counter = ? WHERE id = ?", [verification.authenticationInfo.newCounter, row.id], (dbErr) => {
                    if (dbErr) console.error('login/finish: DB update counter error', dbErr);
                });
                return res.json({ verified: true, userID: row.id });
            } else {
                console.error('login/finish: verification failed', { verification, body, storedRow: row });
            }
        } catch (error) {
            console.error('login/finish: exception during verification', { error: error && (error.stack || error), body, storedRow: row });
            return res.status(400).json({ error: error.message });
        }
        res.status(400).json({ error: 'Authentication failed' });
    });
});

// --- 3. LOCKER API ROUTES ---
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

// --- 4. TIMERS ---
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    db.all("SELECT * FROM lockers WHERE state = 'ASSIGNED' AND lease_expiry < ?", [now], (err, rows) => {
        rows.forEach(row => {
            db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL WHERE locker_id = ?", [row.locker_id]);
            mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'AVAILABLE', user: null }));
        });
    });
    const twentyFourHoursAgo = now - (60 * 60 * 24);
    db.all("SELECT * FROM lockers WHERE state = 'OCCUPIED' AND occupied_since < ?", [twentyFourHoursAgo], (err, rows) => {
        rows.forEach(row => {
            db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL, occupied_since = NULL WHERE locker_id = ?", [row.locker_id]);
            mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'unlock', locker: row.locker_id }));
            setTimeout(() => {
                mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'AVAILABLE', user: null }));
            }, 5000);
        });
    });
}, 15000);

const PORT = process.env.PORT || 3000;
// Global error handler to ensure JSON responses (prevents HTML error pages)
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err && (err.stack || err));
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error', details: err && err.message });
});

app.listen(PORT, () => console.log(`🚀 Server ready at ${expectedOrigin} (listening on port ${PORT})`));
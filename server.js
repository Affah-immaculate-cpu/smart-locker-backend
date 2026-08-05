const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');

dotenv.config();
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const isProduction = process.env.NODE_ENV === 'production';
const expectedOrigin = process.env.EXPECTED_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
let rpID = process.env.RP_ID || null;
if (!rpID) {
    try {
        // Ensure URL has a scheme so new URL() doesn't throw for values like 'localhost:3000'
        const originForUrl = /^[a-zA-Z]+:\/\//.test(expectedOrigin) ? expectedOrigin : `https://${expectedOrigin}`;
        rpID = new URL(originForUrl).hostname;
    } catch (e) {
        // Fallback: strip protocol/port if parsing fails
        rpID = expectedOrigin.replace(/^https?:\/\//, '').split(':')[0];
    }
}

console.log(`🔥 Running in ${isProduction ? 'Production' : 'Development'} mode`);
console.log(`🔒 RP ID: ${rpID}`);
console.log(`🌐 Expected Origin: ${expectedOrigin}`);

// --- DATABASE ---
// Database initialization is handled in database.js

// --- MQTT ---
const mqttHost = process.env.MQTT_HOST || null;
const config = {
    mqtt_host: mqttHost,
    mqtt_user: process.env.MQTT_USER || process.env.MQTT_USERNAME || null,
    mqtt_pass: process.env.MQTT_PASS || process.env.MQTT_PASSWORD || null,
    mqtt_topic: process.env.MQTT_TOPIC || 'esp32/lock/command'
};
let mqttClient = null;
if (config.mqtt_host) {
    const mqttUrl = /^[a-zA-Z]+:\/\//.test(config.mqtt_host)
        ? config.mqtt_host
        : `mqtts://${config.mqtt_host}`;

    mqttClient = mqtt.connect(mqttUrl, {
        username: config.mqtt_user,
        password: config.mqtt_pass,
        rejectUnauthorized: false,
    });
    mqttClient.on('connect', () => console.log('✅ MQTT Connected to HiveMQ'));
    mqttClient.on('error', (err) => console.error('⚠️ MQTT connection error', err));
} else {
    console.warn('⚠️ MQTT is disabled because MQTT_HOST is not configured.');
}

const challengeStore = {};

// --- 1. WEBAUTHN REGISTRATION ROUTES ---
app.post('/register/start', async (req, res) => {
    const userID = crypto.randomBytes(16).toString('hex');
    // simplewebauthn/server requires a non-string userID (Buffer/Uint8Array).
    // Keep the hex string version for DB storage but pass a Buffer to the library.
    const userIDBuffer = Buffer.from(userID, 'hex');
    const options = await generateRegistrationOptions({
        rpID: rpID,
        rpName: 'Smart Locker System',
        userID: userIDBuffer,
        userName: `user_${userID}`,
        attestationType: 'none',
        authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
        },
        userVerification: 'required',
    });
    // Debug: log raw options (before serialization)
    try { console.debug('register/start: raw options keys', Object.keys(options || {})); } catch (e) { }
    // Serialize binary fields to base64url strings for browser compatibility
    const serialize = (val) => {
        if (!val && val !== 0) return val;
        if (Buffer.isBuffer(val)) return val.toString('base64url');
        if (val instanceof Uint8Array) return Buffer.from(val).toString('base64url');
        return val;
    };
    if (options.user && options.user.id) options.user.id = serialize(options.user.id);
    try { console.debug('register/start: serialized options sample', { challenge: options.challenge, userId: options.user && options.user.id }); } catch (e) { }
    if (options.challenge) options.challenge = String(options.challenge);
    if (Array.isArray(options.excludeCredentials)) {
        options.excludeCredentials = options.excludeCredentials.map(c => ({
            id: serialize(c.id),
            type: c.type,
            transports: c.transports,
        }));
    }
    const jsonOptions = JSON.parse(JSON.stringify(options));
    challengeStore[String(jsonOptions.challenge)] = userID;
    try {
        console.log('register/start: jsonOptions keys', Object.keys(jsonOptions || {}));
        console.log('register/start: jsonOptions sample', JSON.stringify(jsonOptions));
    } catch (e) { }
    res.json(jsonOptions);
});

app.post('/register/finish', async (req, res) => {
    const { body } = req;
    // Defensive logging to help diagnose client payload issues
    try {
        console.debug('register/finish: incoming body keys', Object.keys(body || {}));
    } catch (e) { }
    const userID = challengeStore[body && body.challenge];
    if (!userID) {
        console.error('register/finish: invalid or missing challenge', { challenge: body && body.challenge, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    try {
        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: body.challenge,
            expectedRPID: String(rpID),
            expectedOrigin: String(expectedOrigin),
        });

        // Log verification details for debugging
        console.debug('register/finish verification result', {
            verified: verification && verification.verified,
            hasRegistrationInfo: verification && !!verification.registrationInfo,
        });

        if (verification && verification.verified && verification.registrationInfo) {
            const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
            return db.run("INSERT INTO users (id, credential_id, public_key, counter) VALUES (?, ?, ?, ?)",
                [userID, credentialID.toString('base64url'), credentialPublicKey.toString('base64url'), counter], (dbErr) => {
                    if (dbErr) {
                        console.error('register/finish: DB insert error', dbErr);
                        return res.status(500).json({ error: 'Failed to save registration' });
                    }
                    delete challengeStore[body.challenge];
                    return res.json({ verified: true, userID });
                });
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
        if (err) {
            console.error('login/start DB error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'No users registered' });
        const options = generateAuthenticationOptions({
            rpID,
            allowCredentials: rows.map(u => ({ id: Buffer.from(u.credential_id, 'base64url'), type: 'public-key' })),
            userVerification: 'required',
        });
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
    if (!challengeStore[body && body.challenge]) {
        console.error('login/finish: invalid or missing challenge', { challenge: body && body.challenge, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    delete challengeStore[body && body.challenge];
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
                expectedRPID: String(rpID),
                expectedOrigin: String(expectedOrigin),
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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', expectedOrigin, rpID, mqttConfigured: !!mqttClient });
});

// --- 3. LOCKER API ROUTES ---
function publishMqtt(payload) {
    if (!mqttClient) return;
    mqttClient.publish(config.mqtt_topic, JSON.stringify(payload));
}

app.post('/claim', (req, res) => {
    const { user_id } = req.body;
    db.get("SELECT * FROM lockers WHERE state = 'AVAILABLE' LIMIT 1", (err, row) => {
        if (err) {
            console.error('claim DB error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(400).json({ error: 'No lockers available' });
        const leaseExpiry = Math.floor(Date.now() / 1000) + 300;
        db.run("UPDATE lockers SET state = 'ASSIGNED', user_id = ?, lease_expiry = ? WHERE locker_id = ?", [user_id, leaseExpiry, row.locker_id], (updateErr) => {
            if (updateErr) {
                console.error('claim update error', updateErr);
                return res.status(500).json({ error: 'Failed to assign locker' });
            }
            publishMqtt({ cmd: 'display', locker: row.locker_id, status: 'ASSIGNED', user: user_id });
            res.json({ message: 'Locker assigned', locker_id: row.locker_id });
        });
    });
});

app.post('/action', (req, res) => {
    const { user_id, locker_id, action } = req.body;
    db.get("SELECT * FROM lockers WHERE locker_id = ? AND user_id = ?", [locker_id, user_id], (err, row) => {
        if (err) {
            console.error('action DB error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) return res.status(403).json({ error: 'Access denied' });
        if (action === 'unlock') {
            db.run("UPDATE lockers SET state = 'OCCUPIED', occupied_since = ? WHERE locker_id = ?", [Math.floor(Date.now() / 1000), locker_id], (updateErr) => {
                if (updateErr) {
                    console.error('unlock DB error', updateErr);
                    return res.status(500).json({ error: 'Failed to unlock locker' });
                }
                publishMqtt({ cmd: 'unlock', locker: locker_id });
                return res.json({ message: 'Unlocking locker' });
            });
        } else if (action === 'lock') {
            publishMqtt({ cmd: 'lock', locker: locker_id });
            return res.json({ message: 'Locking locker' });
        }
        res.status(400).json({ error: 'Invalid action' });
    });
});

app.post('/release', (req, res) => {
    const { user_id, locker_id } = req.body;
    db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL, occupied_since = NULL WHERE locker_id = ? AND user_id = ?", [locker_id, user_id], function (err) {
        if (err) {
            console.error('release DB error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        publishMqtt({ cmd: 'display', locker: locker_id, status: 'AVAILABLE', user: null });
        res.json({ message: 'Locker released' });
    });
});

// --- 4. TIMERS ---
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    db.all("SELECT * FROM lockers WHERE state = 'ASSIGNED' AND lease_expiry < ?", [now], (err, rows) => {
        if (err) {
            console.error('timer: error querying assigned lockers', err);
            return;
        }
        if (!rows || rows.length === 0) return;
        rows.forEach(row => {
            db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL WHERE locker_id = ?", [row.locker_id]);
            if (mqttClient) mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'AVAILABLE', user: null }));
        });
    });
    const twentyFourHoursAgo = now - (60 * 60 * 24);
    db.all("SELECT * FROM lockers WHERE state = 'OCCUPIED' AND occupied_since < ?", [twentyFourHoursAgo], (err, rows) => {
        if (err) {
            console.error('timer: error querying occupied lockers', err);
            return;
        }
        if (!rows || rows.length === 0) return;
        rows.forEach(row => {
            db.run("UPDATE lockers SET state = 'AVAILABLE', user_id = NULL, lease_expiry = NULL, occupied_since = NULL WHERE locker_id = ?", [row.locker_id]);
            if (mqttClient) mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'unlock', locker: row.locker_id }));
            setTimeout(() => {
                if (mqttClient) mqttClient.publish(config.mqtt_topic, JSON.stringify({ cmd: 'display', locker: row.locker_id, status: 'AVAILABLE', user: null }));
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
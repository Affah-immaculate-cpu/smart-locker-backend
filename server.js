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

const toBase64Url = (val) => {
    if (val === undefined || val === null) return val;
    if (Buffer.isBuffer(val)) return val.toString('base64url');
    if (val instanceof Uint8Array || ArrayBuffer.isView(val)) return Buffer.from(val).toString('base64url');
    if (val instanceof ArrayBuffer) return Buffer.from(new Uint8Array(val)).toString('base64url');
    if (typeof val === 'string') return val.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return val;
};

const normalizeBase64Url = (value) => {
    if (typeof value !== 'string') return null;
    return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const extractChallengeFromWebAuthnResponse = (body) => {
    if (!body) return null;
    if (typeof body.challenge === 'string' && body.challenge.trim()) return normalizeBase64Url(body.challenge);

    const clientDataJSON = body.response && body.response.clientDataJSON;
    if (!clientDataJSON) return null;

    const decodeString = (str) => {
        for (const encoding of ['base64url', 'base64']) {
            try {
                const decoded = Buffer.from(str, encoding);
                const text = decoded.toString('utf8');
                if (typeof text === 'string' && text.trim().startsWith('{')) return text;
            } catch (e) {
                continue;
            }
        }
        return null;
    };

    let jsonString = null;
    if (typeof clientDataJSON === 'string') {
        jsonString = decodeString(clientDataJSON);
    } else if (Buffer.isBuffer(clientDataJSON)) {
        jsonString = clientDataJSON.toString('utf8');
    } else if (clientDataJSON && typeof clientDataJSON === 'object') {
        if (Array.isArray(clientDataJSON.data)) {
            try {
                jsonString = Buffer.from(clientDataJSON.data).toString('utf8');
            } catch (e) {
                return null;
            }
        } else {
            const arrayKeys = Object.keys(clientDataJSON).filter((key) => /^\d+$/.test(key));
            if (arrayKeys.length > 0) {
                const bytes = arrayKeys.sort((a, b) => Number(a) - Number(b)).map((key) => clientDataJSON[key]);
                try {
                    jsonString = Buffer.from(bytes).toString('utf8');
                } catch (e) {
                    return null;
                }
            }
        }
    }

    if (!jsonString) return null;
    try {
        const parsed = JSON.parse(jsonString);
        return typeof parsed.challenge === 'string' ? normalizeBase64Url(parsed.challenge) : null;
    } catch (e) {
        return null;
    }
};

// --- 1. WEBAUTHN REGISTRATION ROUTES ---
app.post('/register/start', async (req, res) => {
    const userID = crypto.randomBytes(16).toString('hex');
    // simplewebauthn/server requires a non-string userID (Buffer/Uint8Array).
    // Keep the hex string version for DB storage but pass a Buffer to the library.
    const userIDBuffer = Buffer.from(userID, 'hex');
    let options;
    try {
        options = await generateRegistrationOptions({
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
    } catch (error) {
        console.error('register/start: failed to generate registration options', error);
        return res.status(500).json({ error: 'Unable to start registration' });
    }
    // Debug: log raw options (before serialization)
    try { console.debug('register/start: raw options keys', Object.keys(options || {})); } catch (e) { }
    // Serialize binary fields to base64url strings for browser compatibility
    if (options.user && options.user.id) options.user.id = toBase64Url(options.user.id);
    if (options.challenge) options.challenge = toBase64Url(options.challenge);
    try { console.debug('register/start: serialized options sample', { challenge: options.challenge, userId: options.user && options.user.id }); } catch (e) { }
    if (Array.isArray(options.excludeCredentials)) {
        options.excludeCredentials = options.excludeCredentials.map(c => ({
            id: serialize(c.id),
            type: c.type,
            transports: c.transports,
        }));
    }
    const jsonOptions = JSON.parse(JSON.stringify(options));
    challengeStore[normalizeBase64Url(String(jsonOptions.challenge))] = userID;
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
    if (!body || typeof body !== 'object' || !body.response || typeof body.response !== 'object') {
        console.error('register/finish: missing or invalid response payload', { body });
        return res.status(400).json({ error: 'Missing authenticator response payload' });
    }
    if (!body.response.clientDataJSON || !body.response.attestationObject) {
        console.error('register/finish: missing required registration response fields', { body });
        return res.status(400).json({ error: 'Missing clientDataJSON or attestationObject in registration response' });
    }
    const clientDataJSON = body && body.response && body.response.clientDataJSON;
    const clientDataType = clientDataJSON === undefined ? 'undefined' : ArrayBuffer.isView(clientDataJSON) ? 'ArrayBufferView' : (clientDataJSON instanceof ArrayBuffer ? 'ArrayBuffer' : typeof clientDataJSON);
    const clientDataLength = clientDataJSON && (clientDataJSON.byteLength || clientDataJSON.length || (clientDataJSON.data && clientDataJSON.data.length) || 0);
    console.debug('register/finish: clientDataJSON info', { clientDataType, clientDataLength });
    const challenge = extractChallengeFromWebAuthnResponse(body);
    const userID = challenge && challengeStore[challenge];
    const knownChallenges = Object.keys(challengeStore);
    console.debug('register/finish: challenge lookup', { challenge, knownChallenges });
    if (!userID) {
        console.error('register/finish: invalid or missing challenge', { challenge, knownChallenges, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    try {
        // Normalize response binary fields to base64url strings so the library
        // decoders never receive undefined or non-string values that call
        // .toString() internally.
        const normalizeIncomingField = (val) => {
            if (typeof val === 'string') return val;
            if (Buffer.isBuffer(val)) return val.toString('base64url');
            if (val instanceof Uint8Array || ArrayBuffer.isView(val)) return Buffer.from(val).toString('base64url');
            if (val instanceof ArrayBuffer) return Buffer.from(new Uint8Array(val)).toString('base64url');
            // handle JSON-serialized numeric-indexed objects (e.g., {"0": 10, "1": 20})
            if (val && typeof val === 'object') {
                const keys = Object.keys(val).filter(k => /^\d+$/.test(k));
                if (keys.length > 0) {
                    const bytes = keys.sort((a, b) => Number(a) - Number(b)).map(k => val[k]);
                    try { return Buffer.from(bytes).toString('base64url'); } catch (e) { return val; }
                }
            }
            return val;
        };

        // Coerce common response subfields
        if (body && body.response) {
            body.response.clientDataJSON = normalizeIncomingField(body.response.clientDataJSON);
            body.response.attestationObject = normalizeIncomingField(body.response.attestationObject);
            body.response.authenticatorData = normalizeIncomingField(body.response.authenticatorData);
            body.response.signature = normalizeIncomingField(body.response.signature);
            // rawId/id may be sent as binary-like values; make sure they are strings
            body.rawId = normalizeIncomingField(body.rawId || body.id || body.rawId);
            body.id = typeof body.id === 'string' ? body.id : (body.rawId || body.id);
        }

        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: challenge,
            expectedRPID: String(rpID),
            expectedOrigin: String(expectedOrigin),
        });

        // Log verification details for debugging
        console.debug('register/finish verification result', {
            verified: verification && verification.verified,
            hasRegistrationInfo: verification && !!verification.registrationInfo,
        });

        if (verification && verification.verified && verification.registrationInfo) {
            const registrationInfo = verification.registrationInfo;
            const credentialInfo = registrationInfo.credential || {};
            const credentialID = registrationInfo.credentialID || credentialInfo.id;
            const credentialPublicKey = registrationInfo.credentialPublicKey || credentialInfo.publicKey;
            const counter = registrationInfo.counter ?? credentialInfo.counter;

            const normalizeCredentialValue = (value) => {
                if (Buffer.isBuffer(value)) return value.toString('base64url');
                if (value instanceof Uint8Array || ArrayBuffer.isView(value)) return Buffer.from(value).toString('base64url');
                if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value)).toString('base64url');
                return typeof value === 'string' ? value : null;
            };

            const storedCredentialID = normalizeCredentialValue(credentialID);
            const storedPublicKey = normalizeCredentialValue(credentialPublicKey);

            if (!storedCredentialID || !storedPublicKey || counter === undefined || counter === null) {
                console.error('register/finish: missing registration credential values', { credentialID, credentialPublicKey, counter, registrationInfo });
                return res.status(500).json({ error: 'Incomplete registration information' });
            }

            return db.run("INSERT INTO users (id, credential_id, public_key, counter) VALUES (?, ?, ?, ?)",
                [userID, storedCredentialID, storedPublicKey, counter], (dbErr) => {
                    if (dbErr) {
                        console.error('register/finish: DB insert error', dbErr);
                        return res.status(500).json({ error: 'Failed to save registration' });
                    }
                    delete challengeStore[challenge];
                    return res.json({ verified: true, userID });
                });
        } else {
            console.error('register/finish: verification failed or missing registrationInfo', { verification, body, userID });
            return res.status(400).json({ error: 'Registration verification failed' });
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
    db.all("SELECT * FROM users", async (err, rows) => {
        if (err) {
            console.error('login/start DB error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'No users registered' });

        try {
            const options = await generateAuthenticationOptions({
                rpID,
                allowCredentials: rows.map(u => ({
                    id: Buffer.from(u.credential_id, 'base64url'),
                    type: 'public-key',
                })),
                userVerification: 'required',
            });

            // Serialize binary fields to base64url for the browser
            if (options.allowCredentials && Array.isArray(options.allowCredentials)) {
                options.allowCredentials = options.allowCredentials.map(c => ({
                    id: toBase64Url(c.id),
                    type: c.type,
                    transports: c.transports,
                }));
            }
            if (options.challenge) options.challenge = toBase64Url(options.challenge);

            challengeStore[normalizeBase64Url(String(options.challenge))] = 'login';
            res.json(options);
        } catch (error) {
            console.error('login/start: failed to generate options', error);
            res.status(500).json({ error: 'Failed to generate authentication options' });
        }
    });
});

app.post('/login/finish', async (req, res) => {
    const { body } = req;
    const challenge = extractChallengeFromWebAuthnResponse(body);
    if (!challenge || !challengeStore[challenge]) {
        console.error('login/finish: invalid or missing challenge', { challenge, body });
        return res.status(400).json({ error: 'Invalid challenge' });
    }
    delete challengeStore[challenge];
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
                expectedChallenge: challenge,
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
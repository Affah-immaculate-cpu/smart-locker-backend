const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create the database file
const db = new sqlite3.Database(path.join(__dirname, 'lockers.db'));

// Initialize the tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS lockers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    locker_id INTEGER NOT NULL,
    state TEXT DEFAULT 'AVAILABLE',
    user_id TEXT,
    lease_expiry INTEGER,
    occupied_since INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL
    )`);

    // Insert 2 lockers if they don't exist yet
    db.get("SELECT COUNT(*) as count FROM lockers", (err, row) => {
        if (err) {
            console.error('Database initialization error', err);
            return;
        }
        if (row.count === 0) {
            db.run("INSERT INTO lockers (locker_id, state) VALUES (1, 'AVAILABLE'), (2, 'AVAILABLE')");
            console.log("Database initialized with 2 lockers.");
        }
    });
});

module.exports = db;
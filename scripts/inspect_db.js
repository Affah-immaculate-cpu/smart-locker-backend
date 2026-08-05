const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'lockers.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) { console.error('DB OPEN ERROR', err.message); process.exit(1); }
});

db.serialize(() => {
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (err) { console.error('COUNT ERROR', err.message); process.exit(1); }
        console.log('USERS_COUNT', row.count);
        db.all("SELECT id, credential_id FROM users LIMIT 5", (err2, rows) => {
            if (err2) { console.error('SELECT ERROR', err2.message); process.exit(1); }
            console.log('USERS_PREVIEW', JSON.stringify(rows, null, 2));
            db.close();
        });
    });
});

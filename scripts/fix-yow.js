const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const jsonFile = path.join(repoRoot, 'messages.json');
const dbFile = path.join(repoRoot, 'data.db');

function fixJson() {
  if (!fs.existsSync(jsonFile)) {
    console.log('No messages.json file found, skipping JSON fix.');
    return;
  }
  try {
    const raw = fs.readFileSync(jsonFile, 'utf8') || '[]';
    const list = JSON.parse(raw);
    let changed = 0;
    for (const item of list) {
      if (item && typeof item.text === 'string' && item.text.trim().toLowerCase() === 'yow') {
        item.text = '';
        changed++;
      }
    }
    if (changed > 0) {
      fs.writeFileSync(jsonFile, JSON.stringify(list, null, 2), 'utf8');
      console.log('Updated', changed, "JSON message(s) replacing 'yow' with empty string.");
    } else {
      console.log('No JSON messages containing exactly "yow" found.');
    }
  } catch (e) {
    console.error('Error fixing JSON messages:', e && e.message);
  }
}

function fixSqlite() {
  try {
    const sqlite3 = require('sqlite3').verbose();
    if (!fs.existsSync(dbFile)) {
      console.log('No data.db file found, skipping sqlite fix.');
      return;
    }
    const db = new sqlite3.Database(dbFile);
    db.serialize(() => {
      db.get("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='messages'", (err, row) => {
        if (err || !row || row.c === 0) {
          console.log('No messages table found in sqlite DB, skipping.');
          db.close();
          return;
        }
        db.run("UPDATE messages SET text = '' WHERE LOWER(text) = 'yow'", function (uErr) {
          if (uErr) console.error('SQLite update error:', uErr.message);
          else console.log('SQLite: replaced', this.changes, "message(s) containing 'yow'.");
          db.close();
        });
      });
    });
  } catch (e) {
    console.log('sqlite3 not available or error opening DB, skipping sqlite fix.');
  }
}

function main() {
  fixJson();
  fixSqlite();
}

main();

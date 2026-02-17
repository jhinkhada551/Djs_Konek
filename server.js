const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

// Try to load sqlite3; if unavailable fall back to JSON file persistence
let db = null;
let useSqlite = false;
const dbFile = path.join(__dirname, 'data.db');
const jsonFile = path.join(__dirname, 'messages.json');
try {
  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database(dbFile);
  useSqlite = true;
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      name TEXT,
      groupname TEXT,
      avatar TEXT,
      text TEXT,
      file TEXT,
      reactions TEXT,
      ts INTEGER
    )`);
  });
  console.log('Using sqlite3 for message persistence. DB:', dbFile);
} catch (err) {
  console.warn('sqlite3 not available - falling back to JSON file persistence:', err.message);
  // ensure messages.json exists
  if (!fs.existsSync(jsonFile)) fs.writeFileSync(jsonFile, '[]', 'utf8');
}

// in-memory reactions map for quick access: messageId -> Map(emoji -> Set(socketId))
const reactionsMap = new Map();

const app = express();
// Allow configuring allowed origin in production via env var
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Basic security headers (lightweight; consider helmet for full protection)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Permissions-Policy', 'geolocation=()');
  // Content Security Policy: allow self resources, socket.io, and data/images
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https:; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data:;");
  next();
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safe = Date.now() + '-' + Math.random().toString(36).slice(2, 9) + path.extname(file.originalname);
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit (allow larger videos)
  fileFilter: function (req, file, cb) {
    // allow images, audio, video
    if (/^image\//.test(file.mimetype) || /^audio\//.test(file.mimetype) || /^video\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only images, audio and video files are allowed'));
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// health endpoint for container/platform probes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() });
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, originalName: req.file.originalname, mime: req.file.mimetype });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// users: socketId -> { name, group, avatar }
const users = new Map();

// messagesSeen: messageId -> Set(socketId)
const messagesSeen = new Map();

function broadcastUserList() {
  const list = Array.from(users.entries()).map(([id, u]) => ({ id, name: u.name, group: u.group, avatar: u.avatar }));
  io.emit('userlist', { count: list.length, list });
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // basic rate limiting per socket (prevent spamming messages)
  socket.rate = { lastMsgTs: 0, messagesInWindow: 0 };


  socket.on('join', (payload) => {
    users.set(socket.id, { name: payload.name || 'Anonymous', group: payload.group || '', avatar: payload.avatar || null });
    socket.broadcast.emit('user-joined', { id: socket.id, name: payload.name, group: payload.group, avatar: payload.avatar });
    broadcastUserList();
  });


  socket.on('message', (msg, cb) => {
    // msg: { text, file } file optional { url, mime, originalName }
    // validate: do not accept empty messages without files
    const textOnly = (msg && typeof msg.text === 'string') ? msg.text.trim() : '';
    if (!textOnly && !(msg && msg.file)) {
      // inform sender that message was rejected
      socket.emit('message-error', { reason: 'empty' });
      return;
    }

    // enforce message length
    const MAX_TEXT_LENGTH = 5000; // keep reasonably bounded
    if (textOnly.length > MAX_TEXT_LENGTH) {
      socket.emit('message-error', { reason: 'too_long', max: MAX_TEXT_LENGTH });
      return;
    }

    // simple rate limiting: no more than 5 messages per 8 seconds
    try {
      const now = Date.now();
      const windowMs = 8000;
      const maxPerWindow = 5;
      if (!socket.rate) socket.rate = { lastMsgTs: 0, messagesInWindow: 0 };
      if (now - socket.rate.lastMsgTs > windowMs) {
        socket.rate.lastMsgTs = now;
        socket.rate.messagesInWindow = 1;
      } else {
        socket.rate.messagesInWindow++;
      }
      if (socket.rate.messagesInWindow > maxPerWindow) {
        socket.emit('message-error', { reason: 'rate_limit' });
        return;
      }
    } catch (e) {
      // ignore rate errors and proceed
    }
    const user = users.get(socket.id) || { name: 'Anonymous', group: '' };
    const messageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
    const payload = {
      id: messageId,
      from: { id: socket.id, name: user.name, group: user.group, avatar: user.avatar },
      text: msg.text || '',
      file: msg.file || null,
      clientTempId: msg && msg.clientTempId ? msg.clientTempId : null,
      ts: Date.now()
    };

    // persist message
    try {
      if (useSqlite && db) {
        const stmt = db.prepare(`INSERT INTO messages (id,name,groupname,avatar,text,file,reactions,ts) VALUES (?,?,?,?,?,?,?,?)`);
        stmt.run(messageId, user.name, user.group || '', JSON.stringify(user.avatar || {}), payload.text || '', JSON.stringify(payload.file || null), JSON.stringify({}), payload.ts);
        stmt.finalize();
      } else {
        // append to messages.json
        const list = JSON.parse(fs.readFileSync(jsonFile, 'utf8') || '[]');
        list.push({ id: messageId, name: user.name, groupname: user.group || '', avatar: JSON.stringify(user.avatar || {}), text: payload.text || '', file: JSON.stringify(payload.file || null), reactions: JSON.stringify({}), ts: payload.ts });
        // keep file reasonably bounded by trimming older items (keep last 1000)
        const trimmed = list.slice(-1000);
        fs.writeFileSync(jsonFile, JSON.stringify(trimmed, null, 2), 'utf8');
      }
    } catch (err) {
      console.error('DB/JSON insert error', err);
    }

    // mark sender as seen (in-memory)
    messagesSeen.set(messageId, new Set([socket.id]));
    io.emit('message', payload);
    // broadcast initial seen state
    io.emit('seen-update', { messageId, seen: Array.from(messagesSeen.get(messageId)).map(id => ({ id, ...(users.get(id) || {}) })) });
    // acknowledge to sender (if callback provided)
    try {
      if (typeof cb === 'function') cb({ ok: true, id: messageId });
    } catch (e) {}
  });

  // client notifies that they have seen one or more message ids
  socket.on('seen', (payload) => {
    // payload: { messageId }
    const mid = payload && payload.messageId;
    if (!mid) return;
    const set = messagesSeen.get(mid) || new Set();
    set.add(socket.id);
    messagesSeen.set(mid, set);
    const seenList = Array.from(set).map(id => ({ id, ...(users.get(id) || {}) }));
    io.emit('seen-update', { messageId: mid, seen: seenList });
  });

  // react to a message (toggle)
  socket.on('react', (payload) => {
    // payload: { messageId, emoji }
    const mid = payload && payload.messageId;
    const emoji = payload && payload.emoji;
    if (!mid || !emoji) return;

    // ensure map exists
    let mapForMsg = reactionsMap.get(mid);
    if (!mapForMsg) {
      mapForMsg = new Map();
      reactionsMap.set(mid, mapForMsg);
    }
    // Enforce a single reaction per user per message.
    // Remove this user's id from any other emoji sets for this message before toggling the chosen emoji.
    try {
      mapForMsg.forEach((sset, em) => {
        if (em !== emoji && sset && sset.has(socket.id)) {
          sset.delete(socket.id);
        }
      });
    } catch (e) {}

    let setForEmoji = mapForMsg.get(emoji);
    if (!setForEmoji) setForEmoji = new Set();

    // If user already reacted with this emoji, toggle off; otherwise add.
    if (setForEmoji.has(socket.id)) {
      setForEmoji.delete(socket.id);
    } else {
      setForEmoji.add(socket.id);
    }
    mapForMsg.set(emoji, setForEmoji);

    // build reactions obj: emoji -> [ {id,name,group,avatar} ]
    const reactionsObj = {};
    mapForMsg.forEach((sset, em) => {
      reactionsObj[em] = Array.from(sset).map(id => ({ id, ...(users.get(id) || {}) }));
    });

    // persist reactions into storage (sqlite or json)
    try {
      if (useSqlite && db) {
        const stmt = db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`);
        stmt.run(JSON.stringify(reactionsObj), mid);
        stmt.finalize();
      } else {
        const list = JSON.parse(fs.readFileSync(jsonFile, 'utf8') || '[]');
        const idx = list.findIndex(r => r.id === mid);
        if (idx >= 0) {
          list[idx].reactions = JSON.stringify(reactionsObj);
          fs.writeFileSync(jsonFile, JSON.stringify(list.slice(-1000), null, 2), 'utf8');
        }
      }
    } catch (err) {
      console.error('persist reactions error', err);
    }

    // broadcast update
    io.emit('reaction-update', { messageId: mid, reactions: reactionsObj });
  });

  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.broadcast.emit('typing', { id: socket.id, name: user.name, group: user.group, avatar: user.avatar, typing: !!isTyping });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    users.delete(socket.id);
    if (user) socket.broadcast.emit('user-left', { id: socket.id, name: user.name, group: user.group });
    broadcastUserList();
    console.log('socket disconnected', socket.id);
  });

  // when a client joins (after join event), send last N persisted messages
  socket.on('request-history', (opts) => {
    const limit = (opts && opts.limit) || 200;
    if (useSqlite && db) {
      db.all(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) return socket.emit('history', { error: 'db-error' });
        // return in chronological order
        const out = (rows || []).reverse().map(r => ({
          id: r.id,
          from: { id: null, name: r.name, group: r.groupname, avatar: JSON.parse(r.avatar || '{}') },
          text: r.text,
          file: JSON.parse(r.file || 'null'),
          reactions: JSON.parse(r.reactions || '{}'),
          ts: r.ts
        }));
        socket.emit('history', out);
      });
    } else {
      try {
        const list = JSON.parse(fs.readFileSync(jsonFile, 'utf8') || '[]');
        const rows = (list || []).slice(-limit).map(r => ({
          id: r.id,
          from: { id: null, name: r.name, group: r.groupname, avatar: JSON.parse(r.avatar || '{}') },
          text: r.text,
          file: JSON.parse(r.file || 'null'),
          reactions: JSON.parse(r.reactions || '{}'),
          ts: r.ts
        }));
        socket.emit('history', rows);
      } catch (err) {
        socket.emit('history', { error: 'file-read-error' });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  try {
    const addr = server.address();
    console.log('Server address info:', addr);
  } catch (e) {
    // ignore
  }
});

// Cleanup messages older than 3 days (in ms)
const MESSAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function cleanupOldMessages() {
  try {
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    const deletedIds = [];
    if (useSqlite && db) {
      db.all(`SELECT id, file FROM messages WHERE ts < ?`, [cutoff], (err, rows) => {
        if (err) return console.error('cleanup: sqlite select error', err);
        const filesToDelete = [];
        (rows || []).forEach(r => {
          deletedIds.push(r.id);
          try {
            const f = JSON.parse(r.file || 'null');
            if (f && f.url && f.url.startsWith('/uploads/')) filesToDelete.push(path.join(__dirname, f.url));
          } catch (e) {}
        });
        if (deletedIds.length === 0) return;
        db.run(`DELETE FROM messages WHERE ts < ?`, [cutoff], function(delErr) {
          if (delErr) return console.error('cleanup: sqlite delete error', delErr);
          console.log('cleanup: deleted messages (sqlite):', deletedIds.length);
          // remove files
          filesToDelete.forEach(p => {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.warn('cleanup unlink error', p, e.message); }
          });
          // clean in-memory maps
          deletedIds.forEach(id => { messagesSeen.delete(id); reactionsMap.delete(id); });
          io.emit('message-delete', { ids: deletedIds });
        });
      });
    } else {
      // JSON fallback
      try {
        const list = JSON.parse(fs.readFileSync(jsonFile, 'utf8') || '[]');
        const keep = [];
        const filesToDelete = [];
        list.forEach(item => {
          const ts = item.ts || 0;
          if (ts < cutoff) {
            deletedIds.push(item.id);
            try {
              const f = JSON.parse(item.file || 'null');
              if (f && f.url && f.url.startsWith('/uploads/')) filesToDelete.push(path.join(__dirname, f.url));
            } catch (e) {}
          } else {
            keep.push(item);
          }
        });
        if (deletedIds.length > 0) {
          fs.writeFileSync(jsonFile, JSON.stringify(keep.slice(-1000), null, 2), 'utf8');
          filesToDelete.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.warn('cleanup unlink error', p, e.message); } });
          deletedIds.forEach(id => { messagesSeen.delete(id); reactionsMap.delete(id); });
          console.log('cleanup: deleted messages (json):', deletedIds.length);
          io.emit('message-delete', { ids: deletedIds });
        }
      } catch (e) {
        console.error('cleanup: json fallback error', e);
      }
    }
  } catch (e) {
    console.error('cleanupOldMessages error', e);
  }
}

// Run cleanup on startup and every hour
try { cleanupOldMessages(); } catch (e) {}
setInterval(cleanupOldMessages, 60 * 60 * 1000);

// Better logging for unexpected crashes to help platform diagnostics
process.on('uncaughtException', (err) => {
  // If this looks like a Mongo connection refusal, log but do not crash the process
  const msg = err && (err.message || err.toString());
  if (msg && /ECONNREFUSED.*127\.0\.0\.1:27017|MongooseServerSelectionError/i.test(msg)) {
    console.error('Non-fatal Mongo uncaught exception (ignored):', msg);
    return;
  }
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  // exit after logging so the platform/crash detector can restart the process
  process.exit(1);
});

process.on('unhandledRejection', (reason, p) => {
  // Treat Mongo network selection errors as non-fatal when no DB is configured
  const msg = reason && (reason.message || reason.toString());
  if (msg && /ECONNREFUSED.*127\.0\.0\.1:27017|MongooseServerSelectionError/i.test(msg)) {
    console.error('Non-fatal Mongo unhandled rejection (ignored):', msg);
    return;
  }
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
  // exit after logging; platform should restart the process for other errors
  process.exit(1);
});

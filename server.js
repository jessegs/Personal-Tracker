import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const UPLOADS_DIR = join(__dirname, 'uploads');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    filename TEXT NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date);

  CREATE TABLE IF NOT EXISTS weights (
    date TEXT PRIMARY KEY,
    weight REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const hasBodyFat = db
  .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('weights') WHERE name = 'body_fat'")
  .get();
if (hasBodyFat.c === 0) {
  db.exec('ALTER TABLE weights ADD COLUMN body_fat REAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily_calories REAL,
    daily_protein REAL,
    daily_carbs REAL,
    daily_fat REAL,
    goal_weight REAL,
    weight_unit TEXT DEFAULT 'lbs',
    goal_body_fat REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO goals (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS water_logs (
    date TEXT PRIMARY KEY,
    oz REAL NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const hasWaterGoal = db
  .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('goals') WHERE name = 'daily_water_oz'")
  .get();
if (hasWaterGoal.c === 0) {
  db.exec('ALTER TABLE goals ADD COLUMN daily_water_oz REAL');
}

for (const col of ['daily_protein_pct', 'daily_carbs_pct', 'daily_fat_pct']) {
  const has = db
    .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('goals') WHERE name = '${col}'`)
    .get();
  if (has.c === 0) db.exec(`ALTER TABLE goals ADD COLUMN ${col} REAL`);
}

function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===== Multi-user migrations =====
db.exec('PRAGMA foreign_keys = OFF');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

function colExists(table, col) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('${table}') WHERE name = ?`)
    .get(col).c > 0;
}

if (!colExists('entries', 'user_id')) {
  db.exec('ALTER TABLE entries ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, date)');
}
if (!colExists('photos', 'user_id')) {
  db.exec('ALTER TABLE photos ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_user_date ON photos(user_id, date)');
}

// weights: PK was (date) — must become (user_id, date). Recreate.
if (!colExists('weights', 'user_id')) {
  db.exec('DROP TABLE IF EXISTS weights_new');
  db.exec(`
    CREATE TABLE weights_new (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      weight REAL,
      body_fat REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, date)
    )
  `);
  db.exec(
    'INSERT INTO weights_new (user_id, date, weight, body_fat, created_at) ' +
      'SELECT NULL, date, weight, body_fat, created_at FROM weights'
  );
  db.exec('DROP TABLE weights');
  db.exec('ALTER TABLE weights_new RENAME TO weights');
}

// water_logs: PK was (date) — must become (user_id, date). Recreate.
if (!colExists('water_logs', 'user_id')) {
  db.exec('DROP TABLE IF EXISTS water_logs_new');
  db.exec(`
    CREATE TABLE water_logs_new (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      oz REAL NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, date)
    )
  `);
  db.exec(
    'INSERT INTO water_logs_new (user_id, date, oz, updated_at) ' +
      'SELECT NULL, date, oz, updated_at FROM water_logs'
  );
  db.exec('DROP TABLE water_logs');
  db.exec('ALTER TABLE water_logs_new RENAME TO water_logs');
}

// goals: PK was (id=1) — must become user_id. Recreate.
// Note: use a regular `id` PK and UNIQUE user_id so user_id can be NULL on the
// orphan row. (INTEGER PRIMARY KEY is a rowid alias and auto-assigns on NULL.)
if (!colExists('goals', 'user_id')) {
  db.exec('DROP TABLE IF EXISTS goals_new');
  db.exec(`
    CREATE TABLE goals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      daily_calories REAL,
      daily_protein REAL,
      daily_carbs REAL,
      daily_fat REAL,
      daily_water_oz REAL,
      daily_protein_pct REAL,
      daily_carbs_pct REAL,
      daily_fat_pct REAL,
      goal_weight REAL,
      weight_unit TEXT DEFAULT 'lbs',
      goal_body_fat REAL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    INSERT INTO goals_new (
      user_id, daily_calories, daily_protein, daily_carbs, daily_fat,
      daily_water_oz, daily_protein_pct, daily_carbs_pct, daily_fat_pct,
      goal_weight, weight_unit, goal_body_fat, updated_at
    )
    SELECT
      NULL, daily_calories, daily_protein, daily_carbs, daily_fat,
      daily_water_oz, daily_protein_pct, daily_carbs_pct, daily_fat_pct,
      goal_weight, weight_unit, goal_body_fat, updated_at
    FROM goals
  `);
  db.exec('DROP TABLE goals');
  db.exec('ALTER TABLE goals_new RENAME TO goals');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    days TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);

  CREATE TABLE IF NOT EXISTS habit_completions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, habit_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_habit_completions_user_date ON habit_completions(user_id, date);
`);

db.exec('PRAGMA foreign_keys = ON');

// ===== Auth helpers =====
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

const SESSION_DAYS = 30;

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expires
  );
  return { token, expires };
}

function getSession(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?')
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function setSessionCookie(res, token, expiresISO) {
  const expires = new Date(expiresISO).toUTCString();
  const secure = process.env.SECURE_COOKIES === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.SECURE_COOKIES === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `session=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`
  );
}

function getRequestToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req).session;
}

function requireAuth(req, res, next) {
  const session = getSession(getRequestToken(req));
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.userId = session.user_id;
  next();
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  if (!req.path.startsWith('/uploads/')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});
app.use(express.static(join(__dirname, 'public')));

// Owner-gated photo serving — auth required AND photo must belong to the requester
app.get('/uploads/:filename', requireAuth, (req, res) => {
  const filename = basename(req.params.filename);
  const row = db.prepare('SELECT user_id FROM photos WHERE filename = ?').get(filename);
  if (!row || row.user_id !== req.userId) return res.status(404).end();
  const filepath = join(UPLOADS_DIR, filename);
  if (!existsSync(filepath)) return res.status(404).end();
  res.sendFile(filepath);
});

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const photoStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const safeExt = extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const id = randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${id}${safeExt}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed'));
  },
});

// ===== Auth routes =====
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function adoptOrphanData(userId) {
  db.prepare('UPDATE entries SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE photos SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE weights SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE water_logs SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE goals SET user_id = ? WHERE user_id IS NULL').run(userId);
}

app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, numbers, _ . -)' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const isFirstUser = userCount === 0;

  const { salt, hash } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
    .run(username, hash, salt);
  const userId = info.lastInsertRowid;

  if (isFirstUser) adoptOrphanData(userId);

  const { token, expires } = createSession(userId);
  setSessionCookie(res, token, expires);
  res.json({ user: { id: userId, username }, token, expires, adopted_legacy_data: isFirstUser });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = db
    .prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?')
    .get(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const { token, expires } = createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ user: { id: user.id, username: user.username }, token, expires });
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(getRequestToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = getRequestToken(req);
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(session.user_id);
  if (!user) {
    deleteSession(token);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ user });
});

// ===== All /api routes below this require authentication =====

app.post('/api/estimate', requireAuth, async (req, res) => {
  const { description } = req.body || {};
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description required' });
  }
  if (!anthropic) {
    return res.status(503).json({
      error: 'AI estimation not configured. Set ANTHROPIC_API_KEY in .env, or enter manually.',
    });
  }
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system:
        'You are a nutrition estimator. Given a food description, estimate calories, protein (g), carbs (g), and fat (g). Respond ONLY with a JSON object using these exact keys: calories, protein, carbs, fat. All values must be numbers (not strings). Make reasonable estimates for typical portion sizes if not specified.',
      messages: [
        {
          role: 'user',
          content: `Estimate the macros for: ${description}`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              calories: { type: 'number' },
              protein: { type: 'number' },
              carbs: { type: 'number' },
              fat: { type: 'number' },
            },
            required: ['calories', 'protein', 'carbs', 'fat'],
            additionalProperties: false,
          },
        },
      },
    });
    const text = response.content.find((b) => b.type === 'text')?.text || '{}';
    const parsed = JSON.parse(text);
    res.json({
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      carbs: Number(parsed.carbs) || 0,
      fat: Number(parsed.fat) || 0,
    });
  } catch (err) {
    console.error('Estimation error:', err);
    res.status(500).json({ error: err.message || 'Estimation failed' });
  }
});

app.get('/api/entries', requireAuth, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
  }
  const rows = db
    .prepare('SELECT * FROM entries WHERE user_id = ? AND date = ? ORDER BY created_at ASC')
    .all(req.userId, date);
  res.json(rows);
});

app.post('/api/entries', requireAuth, (req, res) => {
  const { date, description, calories, protein, carbs, fat } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description required' });
  }
  const stmt = db.prepare(
    'INSERT INTO entries (user_id, date, description, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const info = stmt.run(
    req.userId,
    date,
    description,
    Number(calories) || 0,
    Number(protein) || 0,
    Number(carbs) || 0,
    Number(fat) || 0
  );
  const row = db
    .prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').run(id, req.userId);
  res.json({ ok: true });
});

app.get('/api/photos', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM photos WHERE user_id = ? ORDER BY date DESC, created_at DESC')
    .all(req.userId);
  res.json(rows);
});

app.post('/api/photos', requireAuth, photoUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo file required' });
  const date = req.body.date;
  const note = (req.body.note || '').slice(0, 500);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    unlinkSync(req.file.path);
    return res.status(400).json({ error: 'valid date required' });
  }
  const stmt = db.prepare(
    'INSERT INTO photos (user_id, date, filename, note) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(req.userId, date, req.file.filename, note);
  const row = db
    .prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

app.delete('/api/photos/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db
    .prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (row) {
    const safeName = basename(row.filename);
    const filepath = join(UPLOADS_DIR, safeName);
    if (existsSync(filepath)) {
      try {
        unlinkSync(filepath);
      } catch (err) {
        console.error('Failed to delete photo file:', err);
      }
    }
    db.prepare('DELETE FROM photos WHERE id = ? AND user_id = ?').run(id, req.userId);
  }
  res.json({ ok: true });
});

app.get('/api/weights', requireAuth, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const rows = db
    .prepare(
      'SELECT date, weight, body_fat FROM weights WHERE user_id = ? AND date >= ? ORDER BY date ASC'
    )
    .all(req.userId, cutoffStr);
  res.json(rows);
});

app.post('/api/weights', requireAuth, (req, res) => {
  const { date, weight, body_fat } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }

  const wProvided = weight !== undefined && weight !== null && weight !== '';
  const bfProvided = body_fat !== undefined && body_fat !== null && body_fat !== '';

  if (!wProvided && !bfProvided) {
    return res.status(400).json({ error: 'provide weight or body fat' });
  }

  let wVal = null, bfVal = null;
  if (wProvided) {
    wVal = Number(weight);
    if (!Number.isFinite(wVal) || wVal <= 0) {
      return res.status(400).json({ error: 'valid weight required' });
    }
  }
  if (bfProvided) {
    bfVal = Number(body_fat);
    if (!Number.isFinite(bfVal) || bfVal < 0 || bfVal > 100) {
      return res.status(400).json({ error: 'body fat must be 0–100' });
    }
  }

  const existing = db
    .prepare('SELECT * FROM weights WHERE user_id = ? AND date = ?')
    .get(req.userId, date);

  if (existing) {
    const newW = wProvided ? wVal : existing.weight;
    const newBF = bfProvided ? bfVal : existing.body_fat;
    db.prepare(
      'UPDATE weights SET weight = ?, body_fat = ? WHERE user_id = ? AND date = ?'
    ).run(newW, newBF, req.userId, date);
  } else {
    if (!wProvided) {
      return res.status(400).json({
        error: 'log a weight first to add body fat for a day with no weight entry',
      });
    }
    db.prepare(
      'INSERT INTO weights (user_id, date, weight, body_fat) VALUES (?, ?, ?, ?)'
    ).run(req.userId, date, wVal, bfVal);
  }

  const row = db
    .prepare('SELECT date, weight, body_fat FROM weights WHERE user_id = ? AND date = ?')
    .get(req.userId, date);
  res.json(row);
});

app.delete('/api/weights/:date', requireAuth, (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid date' });
  db.prepare('DELETE FROM weights WHERE user_id = ? AND date = ?').run(req.userId, date);
  res.json({ ok: true });
});

app.get('/api/water', requireAuth, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
  }
  const row = db
    .prepare('SELECT date, oz FROM water_logs WHERE user_id = ? AND date = ?')
    .get(req.userId, date);
  res.json(row || { date, oz: 0 });
});

app.post('/api/water', requireAuth, (req, res) => {
  const { date, oz } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }
  const v = Number(oz);
  if (!Number.isFinite(v) || v < 0) {
    return res.status(400).json({ error: 'oz must be a non-negative number' });
  }
  if (v === 0) {
    db.prepare('DELETE FROM water_logs WHERE user_id = ? AND date = ?').run(req.userId, date);
  } else {
    db.prepare(
      `INSERT INTO water_logs (user_id, date, oz) VALUES (?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET oz = excluded.oz, updated_at = CURRENT_TIMESTAMP`
    ).run(req.userId, date, v);
  }
  res.json({ date, oz: v });
});

app.get('/api/goals', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM goals WHERE user_id = ?').get(req.userId);
  res.json(row || {});
});

app.post('/api/goals', requireAuth, (req, res) => {
  const b = req.body || {};
  const unit = b.weight_unit === 'kg' ? 'kg' : 'lbs';
  const clampPct = (v) => {
    const n = nullableNum(v);
    if (n === null) return null;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
  };

  db.prepare(
    `INSERT INTO goals (
      user_id, daily_calories, daily_protein_pct, daily_carbs_pct, daily_fat_pct,
      daily_water_oz, goal_weight, weight_unit, goal_body_fat, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      daily_calories = excluded.daily_calories,
      daily_protein_pct = excluded.daily_protein_pct,
      daily_carbs_pct = excluded.daily_carbs_pct,
      daily_fat_pct = excluded.daily_fat_pct,
      daily_water_oz = excluded.daily_water_oz,
      goal_weight = excluded.goal_weight,
      weight_unit = excluded.weight_unit,
      goal_body_fat = excluded.goal_body_fat,
      updated_at = CURRENT_TIMESTAMP`
  ).run(
    req.userId,
    nullableNum(b.daily_calories),
    clampPct(b.daily_protein_pct),
    clampPct(b.daily_carbs_pct),
    clampPct(b.daily_fat_pct),
    nullableNum(b.daily_water_oz),
    nullableNum(b.goal_weight),
    unit,
    nullableNum(b.goal_body_fat)
  );
  const row = db.prepare('SELECT * FROM goals WHERE user_id = ?').get(req.userId);
  res.json(row);
});

// ===== Habits =====
const DAYS_RE = /^[01]{7}$/;

app.get('/api/habits', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, name, days, created_at FROM habits WHERE user_id = ? ORDER BY created_at ASC')
    .all(req.userId);
  res.json(rows);
});

app.post('/api/habits', requireAuth, (req, res) => {
  const { name, days } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  if (typeof days !== 'string' || !DAYS_RE.test(days)) {
    return res.status(400).json({ error: 'days must be a 7-character 0/1 string (Sun-Sat)' });
  }
  if (days === '0000000') {
    return res.status(400).json({ error: 'select at least one day' });
  }
  const info = db
    .prepare('INSERT INTO habits (user_id, name, days) VALUES (?, ?, ?)')
    .run(req.userId, name.trim().slice(0, 200), days);
  const row = db
    .prepare('SELECT id, name, days, created_at FROM habits WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

app.delete('/api/habits/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM habits WHERE id = ? AND user_id = ?').run(id, req.userId);
  res.json({ ok: true });
});

app.get('/api/habit-completions', requireAuth, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
  }
  const rows = db
    .prepare('SELECT habit_id FROM habit_completions WHERE user_id = ? AND date = ?')
    .all(req.userId, date);
  res.json(rows.map((r) => r.habit_id));
});

app.post('/api/habit-completions', requireAuth, (req, res) => {
  const { habit_id, date, completed } = req.body || {};
  if (!Number.isInteger(habit_id)) return res.status(400).json({ error: 'invalid habit_id' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const habit = db
    .prepare('SELECT id FROM habits WHERE id = ? AND user_id = ?')
    .get(habit_id, req.userId);
  if (!habit) return res.status(404).json({ error: 'habit not found' });

  if (completed) {
    db.prepare(
      `INSERT INTO habit_completions (user_id, habit_id, date) VALUES (?, ?, ?)
       ON CONFLICT(user_id, habit_id, date) DO NOTHING`
    ).run(req.userId, habit_id, date);
  } else {
    db.prepare(
      'DELETE FROM habit_completions WHERE user_id = ? AND habit_id = ? AND date = ?'
    ).run(req.userId, habit_id, date);
  }
  res.json({ habit_id, date, completed: !!completed });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tracker running at http://localhost:${PORT}`);
  console.log(`LAN access: http://10.0.0.188:${PORT}`);
  if (!anthropic) {
    console.log('Note: ANTHROPIC_API_KEY not set. AI estimation disabled. Manual entry still works.');
  }
});

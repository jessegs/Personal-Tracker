import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';

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

if (!colExists('users', 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}

// Enforce case-insensitive usernames at the DB level so 'Jesse' and 'jesse'
// can't coexist as separate accounts.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)'
);

if (colExists('workout_logs', 'workout_id') && !colExists('workout_logs', 'skipped')) {
  db.exec('ALTER TABLE workout_logs ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
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
  CREATE TABLE IF NOT EXISTS workout_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    style TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    summary TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_workout_plans_user ON workout_plans(user_id);

  CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES workout_plans(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    focus TEXT,
    exercises_json TEXT NOT NULL DEFAULT '[]',
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_workouts_plan ON workouts(plan_id);

  CREATE TABLE IF NOT EXISTS strava_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    athlete_id INTEGER,
    athlete_firstname TEXT,
    athlete_lastname TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scope TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workout_coach_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_coach_messages_plan ON workout_coach_messages(plan_id, id);

  CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_index INTEGER NOT NULL,
    exercise_name TEXT NOT NULL,
    set_number INTEGER NOT NULL,
    reps INTEGER,
    weight REAL,
    duration_seconds INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_workout_logs_workout ON workout_logs(workout_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meal_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    calories REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_meal_templates_user ON meal_templates(user_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS body_measurements (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    neck REAL,
    shoulders REAL,
    left_bicep REAL,
    right_bicep REAL,
    chest REAL,
    waist REAL,
    left_thigh REAL,
    right_thigh REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_check_ins (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    sleep_minutes INTEGER,
    stress_level INTEGER,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date)
  );
`);

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

function requireAdmin(req, res, next) {
  const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.userId);
  if (!row || !row.is_admin) return res.status(403).json({ error: 'admin only' });
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

// In-memory upload (label scan — image isn't persisted, just sent to Claude)
const labelScanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed'));
  },
});

// ===== Auth routes =====
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const INVITE_CODE = process.env.INVITE_CODE || 'F3Sienna';

function adoptOrphanData(userId) {
  db.prepare('UPDATE entries SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE photos SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE weights SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE water_logs SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE goals SET user_id = ? WHERE user_id IS NULL').run(userId);
}

app.post('/api/auth/signup', (req, res) => {
  const { username, password, invite_code } = req.body || {};
  if (!invite_code || typeof invite_code !== 'string' || invite_code.trim() !== INVITE_CODE) {
    return res.status(403).json({ error: 'Invalid invite code' });
  }
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, numbers, _ . -)' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .get(username);
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
    .prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ? COLLATE NOCASE')
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
  const user = db
    .prepare('SELECT id, username, is_admin FROM users WHERE id = ?')
    .get(session.user_id);
  if (!user) {
    deleteSession(token);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ user: { id: user.id, username: user.username, is_admin: !!user.is_admin } });
});

// ===== Admin =====

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  // For each user, summarize how much data they have
  const rows = db.prepare(`
    SELECT
      u.id, u.username, u.is_admin, u.created_at,
      (SELECT COUNT(*) FROM entries WHERE user_id = u.id)      AS entries_count,
      (SELECT COUNT(*) FROM photos WHERE user_id = u.id)       AS photos_count,
      (SELECT COUNT(*) FROM weights WHERE user_id = u.id)      AS weights_count,
      (SELECT COUNT(*) FROM habits WHERE user_id = u.id)       AS habits_count,
      (SELECT MAX(created_at) FROM entries WHERE user_id = u.id) AS last_entry_at
    FROM users u
    ORDER BY u.created_at ASC
  `).all();
  res.json(
    rows.map((r) => ({
      ...r,
      is_admin: !!r.is_admin,
    }))
  );
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (id === req.userId) {
    return res.status(400).json({ error: "you can't delete your own admin account" });
  }
  // Remove the user's photo files from disk before the DB cascade wipes the rows
  const photos = db
    .prepare('SELECT filename FROM photos WHERE user_id = ?')
    .all(id);
  for (const p of photos) {
    const safe = basename(p.filename);
    const fp = join(UPLOADS_DIR, safe);
    if (existsSync(fp)) {
      try { unlinkSync(fp); } catch (err) { console.error('Failed to delete photo file:', err); }
    }
  }
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true, deleted: result.changes });
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

app.post('/api/scan-label', requireAuth, labelScanUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image required' });
  if (!anthropic) {
    return res.status(503).json({
      error: 'AI not configured. Set ANTHROPIC_API_KEY in .env to use label scanning.',
    });
  }
  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system:
        'You read Nutrition Facts labels. Extract per-serving values. If a value is missing on the label, set it to 0. Return product_name only if it is clearly visible on the package; otherwise return an empty string. The serving_size should be the human-readable text from the label (e.g., "1 cup (240ml)").',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: 'Extract the per-serving nutrition info from this label.',
            },
          ],
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              product_name: { type: 'string' },
              serving_size: { type: 'string' },
              calories: { type: 'number' },
              protein: { type: 'number' },
              carbs: { type: 'number' },
              fat: { type: 'number' },
            },
            required: ['product_name', 'serving_size', 'calories', 'protein', 'carbs', 'fat'],
            additionalProperties: false,
          },
        },
      },
    });
    const text = response.content.find((b) => b.type === 'text')?.text || '{}';
    const parsed = JSON.parse(text);
    res.json({
      product_name: String(parsed.product_name || '').trim(),
      serving_size: String(parsed.serving_size || '').trim(),
      calories: Number(parsed.calories) || 0,
      protein: Number(parsed.protein) || 0,
      carbs: Number(parsed.carbs) || 0,
      fat: Number(parsed.fat) || 0,
    });
  } catch (err) {
    console.error('Label scan error:', err);
    res.status(500).json({ error: err.message || 'Label scan failed' });
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

// ===== Strava integration =====
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || '';
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || '';
const STRAVA_REDIRECT_BASE = process.env.STRAVA_REDIRECT_BASE || '';
const STRAVA_SCOPE = 'activity:write,read';

function stravaEnabled() {
  return Boolean(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET && STRAVA_REDIRECT_BASE);
}

// Short-lived signed state token tied to the user id (15 min)
function makeStravaState(userId) {
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = `${userId}.${exp}`;
  const hmac = createHmac('sha256', STRAVA_CLIENT_SECRET || 'fallback')
    .update(payload)
    .digest('hex')
    .slice(0, 32);
  return `${payload}.${hmac}`;
}

function verifyStravaState(state) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = createHmac('sha256', STRAVA_CLIENT_SECRET || 'fallback')
    .update(`${uid}.${exp}`)
    .digest('hex')
    .slice(0, 32);
  if (sig !== expected) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const userId = Number(uid);
  return Number.isInteger(userId) ? userId : null;
}

async function refreshStravaToken(row) {
  const resp = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Strava token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  db.prepare(
    `UPDATE strava_connections SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
  ).run(data.access_token, data.refresh_token, data.expires_at, row.user_id);
  return { ...row, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at };
}

async function getStravaToken(userId) {
  const row = db.prepare('SELECT * FROM strava_connections WHERE user_id = ?').get(userId);
  if (!row) return null;
  if (row.expires_at && row.expires_at * 1000 < Date.now() + 60 * 1000) {
    return await refreshStravaToken(row);
  }
  return row;
}

app.get('/api/strava/status', requireAuth, (req, res) => {
  const enabled = stravaEnabled();
  const row = db
    .prepare(
      'SELECT athlete_id, athlete_firstname, athlete_lastname, scope, expires_at FROM strava_connections WHERE user_id = ?'
    )
    .get(req.userId);
  res.json({
    enabled,
    connected: !!row,
    athlete: row
      ? {
          id: row.athlete_id,
          name: [row.athlete_firstname, row.athlete_lastname].filter(Boolean).join(' '),
        }
      : null,
  });
});

app.get('/api/strava/auth-url', requireAuth, (req, res) => {
  if (!stravaEnabled()) {
    return res.status(503).json({ error: 'Strava is not configured on this server' });
  }
  const state = makeStravaState(req.userId);
  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    redirect_uri: `${STRAVA_REDIRECT_BASE}/api/strava/callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_SCOPE,
    state,
  });
  res.json({ url: `https://www.strava.com/oauth/authorize?${params}` });
});

// Strava redirects here after user authorizes — NOT behind requireAuth because
// the redirect is browser-driven via state token, not API session
app.get('/api/strava/callback', async (req, res) => {
  if (!stravaEnabled()) {
    return res.status(503).send('Strava is not configured on this server.');
  }
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect('/?strava=error&reason=' + encodeURIComponent(String(error)));
  }
  const userId = verifyStravaState(state);
  if (!userId || !code) {
    return res.redirect('/?strava=error&reason=invalid_state');
  }
  try {
    const resp = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('Strava token exchange failed:', resp.status, text);
      return res.redirect('/?strava=error&reason=token_exchange');
    }
    const data = await resp.json();
    const athlete = data.athlete || {};
    db.prepare(
      `INSERT INTO strava_connections (user_id, athlete_id, athlete_firstname, athlete_lastname, access_token, refresh_token, expires_at, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         athlete_id = excluded.athlete_id,
         athlete_firstname = excluded.athlete_firstname,
         athlete_lastname = excluded.athlete_lastname,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      athlete.id || null,
      athlete.firstname || null,
      athlete.lastname || null,
      data.access_token,
      data.refresh_token,
      data.expires_at,
      data.scope || STRAVA_SCOPE
    );
    res.redirect('/?strava=connected');
  } catch (err) {
    console.error('Strava callback error:', err);
    res.redirect('/?strava=error&reason=server');
  }
});

app.post('/api/strava/disconnect', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT access_token FROM strava_connections WHERE user_id = ?').get(req.userId);
  if (row && row.access_token) {
    // Best-effort revoke at Strava (no need to fail if it doesn't respond)
    try {
      await fetch('https://www.strava.com/oauth/deauthorize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${row.access_token}` },
      });
    } catch (_) {}
  }
  db.prepare('DELETE FROM strava_connections WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

// Push a completed workout as a Strava activity
app.post('/api/workouts/:id/push-to-strava', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!stravaEnabled()) {
    return res.status(503).json({ error: 'Strava is not configured on this server' });
  }
  const tokenRow = await getStravaToken(req.userId).catch((e) => {
    throw e;
  });
  if (!tokenRow) return res.status(400).json({ error: 'Strava not connected' });

  const w = db
    .prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'workout not found' });
  const plan = w.plan_id
    ? db.prepare('SELECT style FROM workout_plans WHERE id = ?').get(w.plan_id)
    : null;
  const style = (plan && plan.style) || 'gym';

  const exercises = JSON.parse(w.exercises_json || '[]');
  const logs = db
    .prepare(
      `SELECT exercise_index, set_number, reps, weight, duration_seconds, skipped
       FROM workout_logs WHERE workout_id = ? AND user_id = ?
       ORDER BY exercise_index ASC, set_number ASC, id ASC`
    )
    .all(id, req.userId);

  // Build description
  const lines = [];
  if (w.focus) lines.push(`Focus: ${w.focus}`);
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    lines.push('');
    lines.push(`${ex.name}  (target: ${ex.target_sets || '?'}×${ex.target_reps || '?'}${ex.target_load ? ' @ ' + ex.target_load : ''})`);
    const exLogs = logs.filter((l) => l.exercise_index === i);
    if (exLogs.length === 0) {
      lines.push('  (no sets logged)');
    } else {
      for (const l of exLogs) {
        if (l.skipped) {
          lines.push(`  Set ${l.set_number}: skipped`);
        } else {
          const parts = [];
          if (l.reps != null) parts.push(`${l.reps} reps`);
          if (l.weight != null) parts.push(`${l.weight} lbs`);
          if (l.duration_seconds != null) parts.push(`${l.duration_seconds}s`);
          lines.push(`  Set ${l.set_number}: ${parts.join(' · ') || '(no values)'}`);
        }
      }
    }
  }
  lines.push('');
  lines.push('— Personal Tracker');
  const description = lines.join('\n').slice(0, 9000);

  // Estimate elapsed_time: 6 min per exercise with logged or target sets, clamp 20-120 min
  const workingExercises = exercises.filter((e) => (Number(e.target_sets) || 0) > 0);
  const estMinutes = Math.max(20, Math.min(120, workingExercises.length * 6));
  const elapsedSeconds = estMinutes * 60;

  // Map style → Strava sport_type
  const sportType =
    style === 'gym' ? 'WeightTraining' : style === 'outdoor' ? 'Workout' : 'Workout';

  // start_date_local at 7am on the workout's date
  const startLocal = `${w.date}T07:00:00`;

  try {
    const resp = await fetch('https://www.strava.com/api/v3/activities', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenRow.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: w.title,
        type: sportType,
        sport_type: sportType,
        start_date_local: startLocal,
        elapsed_time: elapsedSeconds,
        description,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('Strava upload failed:', resp.status, text);
      return res.status(500).json({
        error: `Strava upload failed (${resp.status})`,
        detail: text.slice(0, 500),
      });
    }
    const activity = await resp.json();
    res.json({
      ok: true,
      activity_id: activity.id,
      activity_url: `https://www.strava.com/activities/${activity.id}`,
    });
  } catch (err) {
    console.error('Strava push error:', err);
    res.status(500).json({ error: err.message || 'Strava push failed' });
  }
});

// ===== Workouts =====

const WORKOUT_STYLES = new Set(['gym', 'bodyweight', 'outdoor']);

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Create a plan: AI generates a weekly template, server materializes one workout per date in range
app.post('/api/workouts/plans', requireAuth, async (req, res) => {
  const { goal, style, start_date, end_date, name } = req.body || {};
  if (!goal || typeof goal !== 'string' || goal.trim().length < 3) {
    return res.status(400).json({ error: 'goal required (min 3 chars)' });
  }
  if (!WORKOUT_STYLES.has(style)) {
    return res.status(400).json({ error: 'style must be gym, bodyweight, or outdoor' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({ error: 'valid start_date and end_date required (YYYY-MM-DD)' });
  }
  const startD = parseISODate(start_date);
  const endD = parseISODate(end_date);
  if (endD < startD) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }
  const daysSpan = Math.round((endD - startD) / 86400000) + 1;
  if (daysSpan > 365) {
    return res.status(400).json({ error: 'plan range too long (max 1 year)' });
  }
  if (!anthropic) {
    return res.status(503).json({
      error: 'AI not configured. Set ANTHROPIC_API_KEY to use plan generation.',
    });
  }

  const styleHint = {
    gym: 'free weights, machines, cables, cardio equipment. Specify weight as a percentage of 1RM or a target intensity (e.g., "RPE 7"), since you don\'t know the user\'s exact strength yet.',
    bodyweight: 'pushups, pull-ups, squats, lunges, planks, dips, burpees, etc. No equipment. Use variations to scale difficulty.',
    outdoor: 'rucking, sandbag carries, sandbag squats/cleans, sled drags, hill sprints, sandbag-to-shoulder, farmer carries. Specify ruck weight or sandbag weight in pounds.',
  }[style];

  try {
    const aiRes = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 4096,
      system: `You are an expert strength and conditioning coach. Design a 7-day weekly workout schedule based on the user's goal and chosen style. The schedule will repeat across the user's full date range.

GUIDELINES
- Match weekly volume to the goal: hypertrophy = 3-5 working sessions per muscle group/week; cardio/endurance = 3-5 cardio sessions; general fitness = 4-5 mixed sessions; recovery/active rest = ~1 hard session.
- Include warm-up notes when needed.
- Add at least 1-2 rest days per week (rest days have empty exercises arrays).
- For each exercise, provide target_sets (int), target_reps (string like "8-10" or "30s hold" or "1 mile"), target_load (intensity instruction — see style hint), rest_seconds (int between sets), and optional notes.
- STYLE HINT: ${styleHint}
- day_of_week: 0=Sunday ... 6=Saturday.
- Cover all 7 days, in day_of_week order (0 to 6). Rest days have title "Rest" and exercises: [].
- Keep exercise lists concise (4-7 exercises for working days).`,
      messages: [
        {
          role: 'user',
          content: `Goal: ${goal.trim()}\nStyle: ${style}\nDate range: ${start_date} to ${end_date} (${daysSpan} days)\n\nGenerate the weekly schedule.`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              weekly_schedule: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    day_of_week: { type: 'integer' },
                    title: { type: 'string' },
                    focus: { type: 'string' },
                    exercises: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          target_sets: { type: 'integer' },
                          target_reps: { type: 'string' },
                          target_load: { type: 'string' },
                          rest_seconds: { type: 'integer' },
                          notes: { type: 'string' },
                        },
                        required: [
                          'name',
                          'target_sets',
                          'target_reps',
                          'target_load',
                          'rest_seconds',
                          'notes',
                        ],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['day_of_week', 'title', 'focus', 'exercises'],
                  additionalProperties: false,
                },
              },
            },
            required: ['summary', 'weekly_schedule'],
            additionalProperties: false,
          },
        },
      },
    });

    const text = aiRes.content.find((b) => b.type === 'text')?.text || '{}';
    const parsed = JSON.parse(text);
    const summary = String(parsed.summary || '').trim();
    const template = Array.isArray(parsed.weekly_schedule) ? parsed.weekly_schedule : [];

    // Index template by day_of_week
    const byDow = new Map();
    for (const day of template) {
      if (typeof day.day_of_week === 'number') byDow.set(day.day_of_week, day);
    }

    // Insert plan + workouts in a transaction
    const planInfo = db
      .prepare(
        `INSERT INTO workout_plans (user_id, name, goal, style, start_date, end_date, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.userId,
        (name && String(name).trim()) || `${style} plan`,
        goal.trim().slice(0, 500),
        style,
        start_date,
        end_date,
        summary.slice(0, 2000)
      );
    const planId = planInfo.lastInsertRowid;

    const insertWorkout = db.prepare(
      `INSERT INTO workouts (user_id, plan_id, date, title, focus, exercises_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const cursor = new Date(startD);
    while (cursor <= endD) {
      const dow = cursor.getDay();
      const day = byDow.get(dow) || { title: 'Rest', focus: 'rest', exercises: [] };
      insertWorkout.run(
        req.userId,
        planId,
        isoDate(cursor),
        String(day.title || 'Workout').slice(0, 200),
        String(day.focus || '').slice(0, 100),
        JSON.stringify(Array.isArray(day.exercises) ? day.exercises : [])
      );
      cursor.setDate(cursor.getDate() + 1);
    }

    const plan = db.prepare('SELECT * FROM workout_plans WHERE id = ?').get(planId);
    res.json({ plan });
  } catch (err) {
    console.error('Plan generation error:', err);
    res.status(500).json({ error: err.message || 'Plan generation failed' });
  }
});

app.get('/api/workouts/plans', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, goal, style, start_date, end_date, summary, created_at
       FROM workout_plans WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(req.userId);
  res.json(rows);
});

app.delete('/api/workouts/plans/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM workout_plans WHERE id = ? AND user_id = ?').run(id, req.userId);
  res.json({ ok: true });
});

// List workouts in a date range
app.get('/api/workouts', requireAuth, (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
  }
  const rows = db
    .prepare(
      `SELECT id, plan_id, date, title, focus, completed, exercises_json
       FROM workouts WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`
    )
    .all(req.userId, from, to);
  res.json(
    rows.map((r) => ({
      id: r.id,
      plan_id: r.plan_id,
      date: r.date,
      title: r.title,
      focus: r.focus,
      completed: !!r.completed,
      exercise_count: JSON.parse(r.exercises_json || '[]').length,
    }))
  );
});

// Get a single workout with exercises and existing logs
app.get('/api/workouts/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const w = db
    .prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'not found' });
  const exercises = JSON.parse(w.exercises_json || '[]');
  const logs = db
    .prepare(
      `SELECT id, exercise_index, exercise_name, set_number, reps, weight, duration_seconds, notes, skipped, created_at
       FROM workout_logs WHERE workout_id = ? AND user_id = ? ORDER BY exercise_index ASC, set_number ASC, id ASC`
    )
    .all(id, req.userId);
  res.json({
    id: w.id,
    plan_id: w.plan_id,
    date: w.date,
    title: w.title,
    focus: w.focus,
    notes: w.notes,
    completed: !!w.completed,
    completed_at: w.completed_at,
    exercises,
    logs,
  });
});

// Log a set (or mark a set as skipped)
app.post('/api/workouts/:id/logs', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { exercise_index, set_number, reps, weight, duration_seconds, notes, skipped } =
    req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid workout id' });
  const w = db
    .prepare('SELECT id, exercises_json FROM workouts WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'workout not found' });
  const exercises = JSON.parse(w.exercises_json || '[]');
  const idx = Number(exercise_index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= exercises.length) {
    return res.status(400).json({ error: 'invalid exercise_index' });
  }
  const setNum = Number(set_number);
  if (!Number.isInteger(setNum) || setNum < 1 || setNum > 50) {
    return res.status(400).json({ error: 'set_number must be 1-50' });
  }
  const isSkipped = !!skipped;
  const repsN = isSkipped || reps === '' || reps == null ? null : Number(reps);
  const weightN = isSkipped || weight === '' || weight == null ? null : Number(weight);
  const durationN =
    isSkipped || duration_seconds === '' || duration_seconds == null
      ? null
      : Number(duration_seconds);
  if (!isSkipped && repsN == null && weightN == null && durationN == null) {
    return res.status(400).json({ error: 'provide at least one of reps, weight, duration_seconds' });
  }
  const info = db
    .prepare(
      `INSERT INTO workout_logs (user_id, workout_id, exercise_index, exercise_name, set_number, reps, weight, duration_seconds, notes, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.userId,
      id,
      idx,
      String(exercises[idx].name || '').slice(0, 200),
      setNum,
      repsN,
      weightN,
      durationN,
      (notes && String(notes).slice(0, 500)) || null,
      isSkipped ? 1 : 0
    );
  const row = db
    .prepare('SELECT * FROM workout_logs WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

app.delete('/api/workouts/logs/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM workout_logs WHERE id = ? AND user_id = ?').run(id, req.userId);
  res.json({ ok: true });
});

// Toggle complete / save notes
app.post('/api/workouts/:id/complete', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const w = db.prepare('SELECT completed FROM workouts WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'not found' });
  const newVal = w.completed ? 0 : 1;
  db.prepare(
    `UPDATE workouts SET completed = ?, completed_at = ? WHERE id = ? AND user_id = ?`
  ).run(newVal, newVal ? new Date().toISOString() : null, id, req.userId);
  res.json({ ok: true, completed: !!newVal });
});

// --- Swap one exercise (AI-suggested alternative + apply) ---

app.post('/api/workouts/:id/exercises/:idx/swap', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  const reason = (req.body && req.body.reason ? String(req.body.reason) : '').slice(0, 300).trim();
  if (!Number.isInteger(id) || !Number.isInteger(idx)) {
    return res.status(400).json({ error: 'invalid id or idx' });
  }
  if (!anthropic) {
    return res.status(503).json({ error: 'AI not configured' });
  }
  const w = db
    .prepare('SELECT id, plan_id, title, focus, exercises_json FROM workouts WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'workout not found' });
  const exercises = JSON.parse(w.exercises_json || '[]');
  if (idx < 0 || idx >= exercises.length) {
    return res.status(400).json({ error: 'invalid exercise_index' });
  }
  const current = exercises[idx];
  const plan = w.plan_id
    ? db.prepare('SELECT style, goal FROM workout_plans WHERE id = ?').get(w.plan_id)
    : null;
  const style = (plan && plan.style) || 'gym';

  const styleHint = {
    gym: 'free weights, machines, cables, cardio equipment',
    bodyweight: 'no equipment — pushups, pull-ups, squats, lunges, planks, dips, burpees, variations',
    outdoor: 'rucking, sandbag carries, sandbag squats/cleans, hill sprints, sled drags, farmer carries',
  }[style];

  try {
    const aiRes = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: `You suggest a single substitute exercise that:
- Trains the SAME primary movement pattern / muscle group as the original
- Matches the workout's focus ("${w.focus || ''}") and the user's chosen style (${style}: ${styleHint})
- Has comparable volume/intensity to the original
- Is NOT the same exercise as the original
Return one substitute as JSON.`,
      messages: [
        {
          role: 'user',
          content: `Original exercise:
- name: ${current.name}
- target_sets: ${current.target_sets}
- target_reps: ${current.target_reps}
- target_load: ${current.target_load}
- rest_seconds: ${current.rest_seconds || 60}
- notes: ${current.notes || '(none)'}

Workout title: ${w.title}
Workout focus: ${w.focus || '(unspecified)'}
Plan goal: ${(plan && plan.goal) || '(unspecified)'}
${reason ? `User reason for swap: ${reason}` : ''}

Suggest one substitute exercise.`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              target_sets: { type: 'integer' },
              target_reps: { type: 'string' },
              target_load: { type: 'string' },
              rest_seconds: { type: 'integer' },
              notes: { type: 'string' },
              rationale: { type: 'string' },
            },
            required: [
              'name',
              'target_sets',
              'target_reps',
              'target_load',
              'rest_seconds',
              'notes',
              'rationale',
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const text = aiRes.content.find((b) => b.type === 'text')?.text || '{}';
    const parsed = JSON.parse(text);
    res.json({ original: current, suggestion: parsed });
  } catch (err) {
    console.error('Swap suggestion error:', err);
    res.status(500).json({ error: err.message || 'Swap suggestion failed' });
  }
});

app.post('/api/workouts/:id/exercises/:idx/apply-swap', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  const suggestion = req.body && req.body.suggestion;
  if (!Number.isInteger(id) || !Number.isInteger(idx)) {
    return res.status(400).json({ error: 'invalid id or idx' });
  }
  if (!suggestion || typeof suggestion !== 'object' || !suggestion.name) {
    return res.status(400).json({ error: 'suggestion required' });
  }
  const w = db
    .prepare('SELECT id, exercises_json FROM workouts WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!w) return res.status(404).json({ error: 'workout not found' });
  const exercises = JSON.parse(w.exercises_json || '[]');
  if (idx < 0 || idx >= exercises.length) {
    return res.status(400).json({ error: 'invalid exercise_index' });
  }
  exercises[idx] = {
    name: String(suggestion.name).slice(0, 200),
    target_sets: Number(suggestion.target_sets) || 0,
    target_reps: String(suggestion.target_reps || '').slice(0, 100),
    target_load: String(suggestion.target_load || '').slice(0, 200),
    rest_seconds: Number(suggestion.rest_seconds) || 60,
    notes: suggestion.notes ? String(suggestion.notes).slice(0, 500) : '',
  };
  // Clear logs for this exercise so they don't reference the old movement
  db.prepare(
    'DELETE FROM workout_logs WHERE workout_id = ? AND user_id = ? AND exercise_index = ?'
  ).run(id, req.userId, idx);
  db.prepare('UPDATE workouts SET exercises_json = ? WHERE id = ? AND user_id = ?').run(
    JSON.stringify(exercises),
    id,
    req.userId
  );
  res.json({ ok: true, exercises });
});

// --- AI coach chat ---

function sanitizeExercises(exercises) {
  if (!Array.isArray(exercises)) return [];
  return exercises.map((e) => ({
    name: String(e.name || '').slice(0, 200),
    target_sets: Number(e.target_sets) || 0,
    target_reps: String(e.target_reps || '').slice(0, 100),
    target_load: String(e.target_load || '').slice(0, 200),
    rest_seconds: Number(e.rest_seconds) || 60,
    notes: e.notes ? String(e.notes).slice(0, 500) : '',
  }));
}

const COACH_TOOLS = [
  {
    name: 'update_workout',
    description:
      'Replace the exercises (and optionally title/focus) of one specific workout. Use when the user wants to change a single day, not the recurring weekly pattern.',
    input_schema: {
      type: 'object',
      properties: {
        workout_id: { type: 'integer', description: 'The id of the workout to update.' },
        title: { type: 'string' },
        focus: { type: 'string' },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              target_sets: { type: 'integer' },
              target_reps: { type: 'string' },
              target_load: { type: 'string' },
              rest_seconds: { type: 'integer' },
              notes: { type: 'string' },
            },
            required: ['name', 'target_sets', 'target_reps', 'target_load', 'rest_seconds'],
          },
        },
      },
      required: ['workout_id', 'exercises'],
    },
  },
  {
    name: 'update_recurring_workout',
    description:
      "Update every future workout (on or after a given start date) within the plan that falls on a specific day of the week. Use when the user wants a permanent change to their weekly schedule, e.g. 'always do legs harder on Mondays'.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'integer' },
        day_of_week: { type: 'integer', description: '0=Sun, 1=Mon, ..., 6=Sat' },
        from_date: { type: 'string', description: 'YYYY-MM-DD. Only update workouts on or after this date.' },
        title: { type: 'string' },
        focus: { type: 'string' },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              target_sets: { type: 'integer' },
              target_reps: { type: 'string' },
              target_load: { type: 'string' },
              rest_seconds: { type: 'integer' },
              notes: { type: 'string' },
            },
            required: ['name', 'target_sets', 'target_reps', 'target_load', 'rest_seconds'],
          },
        },
      },
      required: ['plan_id', 'day_of_week', 'from_date', 'exercises'],
    },
  },
];

function executeCoachTool(toolName, input, userId, planId) {
  if (toolName === 'update_workout') {
    const w = db
      .prepare('SELECT id, plan_id FROM workouts WHERE id = ? AND user_id = ?')
      .get(input.workout_id, userId);
    if (!w) throw new Error(`workout ${input.workout_id} not found`);
    if (w.plan_id !== planId) throw new Error('workout does not belong to this plan');
    const exercises = sanitizeExercises(input.exercises);
    const sets = ['exercises_json = ?'];
    const args = [JSON.stringify(exercises)];
    if (input.title) {
      sets.push('title = ?');
      args.push(String(input.title).slice(0, 200));
    }
    if (input.focus) {
      sets.push('focus = ?');
      args.push(String(input.focus).slice(0, 100));
    }
    args.push(input.workout_id, userId);
    db.prepare(`UPDATE workouts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...args);
    return { ok: true, updated_workout_id: input.workout_id, exercise_count: exercises.length };
  }

  if (toolName === 'update_recurring_workout') {
    if (input.plan_id !== planId) throw new Error('plan_id mismatch');
    const dow = Number(input.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new Error('invalid day_of_week');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from_date)) throw new Error('invalid from_date');
    const exercises = sanitizeExercises(input.exercises);
    const candidates = db
      .prepare(
        `SELECT id, date FROM workouts WHERE user_id = ? AND plan_id = ? AND date >= ? ORDER BY date ASC`
      )
      .all(userId, planId, input.from_date);
    let updated = 0;
    for (const w of candidates) {
      const d = parseISODate(w.date);
      if (d.getDay() !== dow) continue;
      const sets = ['exercises_json = ?'];
      const args = [JSON.stringify(exercises)];
      if (input.title) {
        sets.push('title = ?');
        args.push(String(input.title).slice(0, 200));
      }
      if (input.focus) {
        sets.push('focus = ?');
        args.push(String(input.focus).slice(0, 100));
      }
      args.push(w.id, userId);
      db.prepare(`UPDATE workouts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...args);
      updated++;
    }
    return { ok: true, updated_count: updated };
  }

  throw new Error(`unknown tool ${toolName}`);
}

function buildCoachSystemPrompt(plan, recentWorkouts, recentLogs) {
  const today = isoDate(new Date());
  let prompt = `You are an expert fitness coach helping the user iterate on their personalized workout plan.

CURRENT PLAN
- Plan ID: ${plan.id}
- Name: ${plan.name}
- Goal: ${plan.goal}
- Style: ${plan.style}
- Dates: ${plan.start_date} to ${plan.end_date}
- Today: ${today}
- Plan summary: ${plan.summary || '(none)'}

UPCOMING & RECENT WORKOUTS (last/next 14 days)
`;
  for (const w of recentWorkouts) {
    const exercises = JSON.parse(w.exercises_json || '[]');
    const ex = exercises.length
      ? exercises.map((e) => `${e.name} (${e.target_sets}×${e.target_reps} @ ${e.target_load})`).join('; ')
      : '— rest day —';
    prompt += `- workout_id=${w.id} ${w.date} (${dowName(parseISODate(w.date).getDay())}) "${w.title}" [${w.focus || ''}]${w.completed ? ' ✓' : ''}\n    ${ex}\n`;
  }

  if (recentLogs.length > 0) {
    prompt += `\nRECENTLY LOGGED PERFORMANCE (most recent first, max 30 sets)\n`;
    for (const l of recentLogs) {
      const parts = [];
      if (l.reps != null) parts.push(`${l.reps} reps`);
      if (l.weight != null) parts.push(`${l.weight} lbs`);
      if (l.duration_seconds != null) parts.push(`${l.duration_seconds}s`);
      prompt += `- ${l.date} ${l.exercise_name} set ${l.set_number}: ${parts.join(' · ') || '(no values)'}\n`;
    }
  }

  prompt += `\nGUIDANCE
- Be concise. Short answers, no fluff.
- Give actionable advice grounded in the user's actual logged performance, not generic platitudes.
- When the user asks you to change the plan, USE THE TOOLS to actually make the change. Don't just describe what you would change.
  - update_workout: one-time change for a single day. Use when the user references a specific date or workout.
  - update_recurring_workout: change every future occurrence of a weekday (today and later). Use for "always do ... on Mondays" style requests.
- Prefer to keep the user's preferred style (${plan.style}). Don't suggest gym exercises if they picked bodyweight, etc.
- After making a change, briefly tell the user what you changed.`;

  return prompt;
}

function dowName(dow) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
}

app.get('/api/workouts/plans/:id/coach/messages', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const plan = db
    .prepare('SELECT id FROM workout_plans WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const rows = db
    .prepare(
      'SELECT id, role, content_json, created_at FROM workout_coach_messages WHERE plan_id = ? AND user_id = ? ORDER BY id ASC'
    )
    .all(id, req.userId);
  res.json(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: JSON.parse(r.content_json),
      created_at: r.created_at,
    }))
  );
});

app.delete('/api/workouts/plans/:id/coach/messages', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM workout_coach_messages WHERE plan_id = ? AND user_id = ?').run(
    id,
    req.userId
  );
  res.json({ ok: true });
});

app.post('/api/workouts/plans/:id/coach/chat', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!anthropic) {
    return res.status(503).json({ error: 'AI coach requires ANTHROPIC_API_KEY' });
  }
  const userMessage = (req.body && req.body.message ? String(req.body.message) : '').trim();
  if (!userMessage) return res.status(400).json({ error: 'message required' });
  if (userMessage.length > 4000) {
    return res.status(400).json({ error: 'message too long (max 4000 chars)' });
  }

  const plan = db
    .prepare('SELECT * FROM workout_plans WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!plan) return res.status(404).json({ error: 'plan not found' });

  // Build context: workouts within ±14 days, recent logs
  const today = new Date();
  const ctxFrom = new Date(today);
  ctxFrom.setDate(today.getDate() - 7);
  const ctxTo = new Date(today);
  ctxTo.setDate(today.getDate() + 14);
  const recentWorkouts = db
    .prepare(
      `SELECT id, date, title, focus, completed, exercises_json
       FROM workouts WHERE user_id = ? AND plan_id = ? AND date >= ? AND date <= ?
       ORDER BY date ASC`
    )
    .all(req.userId, id, isoDate(ctxFrom), isoDate(ctxTo));
  const recentLogs = db
    .prepare(
      `SELECT l.exercise_name, l.set_number, l.reps, l.weight, l.duration_seconds, w.date
       FROM workout_logs l JOIN workouts w ON l.workout_id = w.id
       WHERE l.user_id = ? AND w.plan_id = ?
       ORDER BY w.date DESC, l.set_number DESC LIMIT 30`
    )
    .all(req.userId, id);

  const systemPrompt = buildCoachSystemPrompt(plan, recentWorkouts, recentLogs);

  // Load history and append the new user message
  const history = db
    .prepare(
      'SELECT role, content_json FROM workout_coach_messages WHERE plan_id = ? AND user_id = ? ORDER BY id ASC'
    )
    .all(id, req.userId)
    .map((r) => ({ role: r.role, content: JSON.parse(r.content_json) }));

  // Sanitize history: drop trailing assistant messages that have a tool_use without a matching tool_result
  // (defensive; shouldn't happen with normal flow)
  const messages = [...history, { role: 'user', content: userMessage }];

  // Save the user message first
  db.prepare(
    'INSERT INTO workout_coach_messages (user_id, plan_id, role, content_json) VALUES (?, ?, ?, ?)'
  ).run(req.userId, id, 'user', JSON.stringify(userMessage));

  const modifications = [];
  let stoppedReason = null;
  const MAX_ITERATIONS = 6;
  let iter = 0;

  try {
    while (iter < MAX_ITERATIONS) {
      iter++;
      const resp = await anthropic.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 4096,
        system: systemPrompt,
        tools: COACH_TOOLS,
        messages,
      });

      // Append assistant turn
      messages.push({ role: 'assistant', content: resp.content });
      db.prepare(
        'INSERT INTO workout_coach_messages (user_id, plan_id, role, content_json) VALUES (?, ?, ?, ?)'
      ).run(req.userId, id, 'assistant', JSON.stringify(resp.content));

      if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
        stoppedReason = resp.stop_reason;
        break;
      }

      if (resp.stop_reason !== 'tool_use') {
        stoppedReason = resp.stop_reason;
        break;
      }

      // Execute tools
      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        let result;
        let isError = false;
        try {
          result = executeCoachTool(tu.name, tu.input, req.userId, id);
          modifications.push({ tool: tu.name, input: tu.input, result });
        } catch (e) {
          result = { error: e.message };
          isError = true;
          modifications.push({ tool: tu.name, error: e.message });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        });
      }
      const userToolMsg = { role: 'user', content: toolResults };
      messages.push(userToolMsg);
      db.prepare(
        'INSERT INTO workout_coach_messages (user_id, plan_id, role, content_json) VALUES (?, ?, ?, ?)'
      ).run(req.userId, id, 'user', JSON.stringify(toolResults));
    }

    if (iter >= MAX_ITERATIONS) stoppedReason = 'max_iterations';

    res.json({
      ok: true,
      stop_reason: stoppedReason,
      modifications,
    });
  } catch (err) {
    console.error('Coach chat error:', err);
    res.status(500).json({ error: err.message || 'Coach chat failed' });
  }
});

app.post('/api/workouts/:id/notes', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { notes } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('UPDATE workouts SET notes = ? WHERE id = ? AND user_id = ?').run(
    notes ? String(notes).slice(0, 2000) : null,
    id,
    req.userId
  );
  res.json({ ok: true });
});

// ===== Meal templates (reusable quick meals) =====

app.get('/api/meal-templates', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, calories, protein, carbs, fat, created_at, last_used_at
       FROM meal_templates
       WHERE user_id = ?
       ORDER BY COALESCE(last_used_at, created_at) DESC`
    )
    .all(req.userId);
  res.json(rows);
});

app.post('/api/meal-templates', requireAuth, (req, res) => {
  const { name, calories, protein, carbs, fat } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const cal = Number(calories) || 0;
  const p = Number(protein) || 0;
  const c = Number(carbs) || 0;
  const f = Number(fat) || 0;
  if (cal === 0 && p === 0 && c === 0 && f === 0) {
    return res.status(400).json({ error: 'at least one macro is required' });
  }
  const info = db
    .prepare(
      'INSERT INTO meal_templates (user_id, name, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(req.userId, name.trim().slice(0, 200), cal, p, c, f);
  const row = db
    .prepare('SELECT * FROM meal_templates WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

app.delete('/api/meal-templates/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  db.prepare('DELETE FROM meal_templates WHERE id = ? AND user_id = ?').run(id, req.userId);
  res.json({ ok: true });
});

// One-click: log a template as an entry on a given date and bump last_used_at
app.post('/api/meal-templates/:id/log', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const date = req.body && req.body.date;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }
  const tpl = db
    .prepare('SELECT * FROM meal_templates WHERE id = ? AND user_id = ?')
    .get(id, req.userId);
  if (!tpl) return res.status(404).json({ error: 'template not found' });

  const info = db
    .prepare(
      'INSERT INTO entries (user_id, date, description, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.userId, date, tpl.name, tpl.calories, tpl.protein, tpl.carbs, tpl.fat);
  db.prepare(
    'UPDATE meal_templates SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  ).run(id, req.userId);

  const row = db
    .prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?')
    .get(info.lastInsertRowid, req.userId);
  res.json(row);
});

// ===== Body measurements =====
const MEASUREMENT_COLS = [
  'neck', 'shoulders', 'left_bicep', 'right_bicep',
  'chest', 'waist', 'left_thigh', 'right_thigh',
];

app.get('/api/measurement', requireAuth, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
  }
  const cols = ['date', ...MEASUREMENT_COLS].join(', ');
  const row = db
    .prepare(`SELECT ${cols} FROM body_measurements WHERE user_id = ? AND date = ?`)
    .get(req.userId, date);
  if (row) return res.json(row);
  const empty = { date };
  for (const c of MEASUREMENT_COLS) empty[c] = null;
  res.json(empty);
});

app.get('/api/measurements', requireAuth, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const cols = ['date', ...MEASUREMENT_COLS].join(', ');
  const rows = db
    .prepare(
      `SELECT ${cols} FROM body_measurements WHERE user_id = ? AND date >= ? ORDER BY date ASC`
    )
    .all(req.userId, cutoffStr);
  res.json(rows);
});

app.post('/api/measurement', requireAuth, (req, res) => {
  const b = req.body || {};
  const date = b.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }

  // Build the input record. undefined/null/'' = "not provided" (preserve existing).
  // A number = update to that value. 0 or negative is rejected.
  const provided = {};
  for (const col of MEASUREMENT_COLS) {
    const v = b[col];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      return res.status(400).json({ error: `invalid value for ${col}` });
    }
    provided[col] = n;
  }
  if (Object.keys(provided).length === 0) {
    return res.status(400).json({ error: 'provide at least one measurement' });
  }

  const existing = db
    .prepare(`SELECT * FROM body_measurements WHERE user_id = ? AND date = ?`)
    .get(req.userId, date);

  const merged = {};
  for (const col of MEASUREMENT_COLS) {
    if (col in provided) merged[col] = provided[col];
    else if (existing) merged[col] = existing[col];
    else merged[col] = null;
  }

  if (existing) {
    const setClause = MEASUREMENT_COLS.map((c) => `${c} = ?`).join(', ');
    db.prepare(
      `UPDATE body_measurements SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND date = ?`
    ).run(...MEASUREMENT_COLS.map((c) => merged[c]), req.userId, date);
  } else {
    const colList = ['user_id', 'date', ...MEASUREMENT_COLS].join(', ');
    const placeholders = ['?', '?', ...MEASUREMENT_COLS.map(() => '?')].join(', ');
    db.prepare(
      `INSERT INTO body_measurements (${colList}) VALUES (${placeholders})`
    ).run(req.userId, date, ...MEASUREMENT_COLS.map((c) => merged[c]));
  }

  const cols = ['date', ...MEASUREMENT_COLS].join(', ');
  const row = db
    .prepare(`SELECT ${cols} FROM body_measurements WHERE user_id = ? AND date = ?`)
    .get(req.userId, date);
  res.json(row);
});

// ===== Daily check-in (sleep + stress) =====

app.get('/api/check-in', requireAuth, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query (YYYY-MM-DD) required' });
  }
  const row = db
    .prepare('SELECT date, sleep_minutes, stress_level FROM daily_check_ins WHERE user_id = ? AND date = ?')
    .get(req.userId, date);
  res.json(row || { date, sleep_minutes: null, stress_level: null });
});

app.get('/api/check-ins', requireAuth, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const rows = db
    .prepare(
      'SELECT date, sleep_minutes, stress_level FROM daily_check_ins WHERE user_id = ? AND date >= ? ORDER BY date ASC'
    )
    .all(req.userId, cutoffStr);
  res.json(rows);
});

app.post('/api/check-in', requireAuth, (req, res) => {
  const { date, sleep_minutes, stress_level } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'valid date required' });
  }

  const sleepProvided = sleep_minutes !== undefined && sleep_minutes !== null && sleep_minutes !== '';
  const stressProvided = stress_level !== undefined && stress_level !== null && stress_level !== '';

  let sleepVal = null, stressVal = null;
  if (sleepProvided) {
    sleepVal = Number(sleep_minutes);
    if (!Number.isInteger(sleepVal) || sleepVal < 0 || sleepVal > 1440) {
      return res.status(400).json({ error: 'sleep minutes must be 0-1440' });
    }
  }
  if (stressProvided) {
    stressVal = Number(stress_level);
    if (!Number.isInteger(stressVal) || stressVal < 1 || stressVal > 10) {
      return res.status(400).json({ error: 'stress level must be 1-10' });
    }
  }

  if (!sleepProvided && !stressProvided) {
    return res.status(400).json({ error: 'provide sleep or stress' });
  }

  const existing = db
    .prepare('SELECT * FROM daily_check_ins WHERE user_id = ? AND date = ?')
    .get(req.userId, date);

  if (existing) {
    const newSleep = sleepProvided ? sleepVal : existing.sleep_minutes;
    const newStress = stressProvided ? stressVal : existing.stress_level;
    if (newSleep === null && newStress === null) {
      db.prepare('DELETE FROM daily_check_ins WHERE user_id = ? AND date = ?').run(req.userId, date);
    } else {
      db.prepare(
        'UPDATE daily_check_ins SET sleep_minutes = ?, stress_level = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND date = ?'
      ).run(newSleep, newStress, req.userId, date);
    }
  } else {
    db.prepare(
      'INSERT INTO daily_check_ins (user_id, date, sleep_minutes, stress_level) VALUES (?, ?, ?, ?)'
    ).run(req.userId, date, sleepVal, stressVal);
  }

  const row = db
    .prepare('SELECT date, sleep_minutes, stress_level FROM daily_check_ins WHERE user_id = ? AND date = ?')
    .get(req.userId, date);
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

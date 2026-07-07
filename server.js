const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PROD = BASE_URL.startsWith('https://');

// ---------- Database (local file in dev, Turso in production) ----------
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:data.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      language TEXT,
      transcript TEXT NOT NULL,
      summary TEXT NOT NULL,
      drive_link TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_participants (
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (meeting_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // One-time migration: import Google tokens from the old tokens.json file
  const legacyPath = path.join(__dirname, 'tokens.json');
  if (fs.existsSync(legacyPath) && !(await getSetting('google_tokens'))) {
    await setSetting('google_tokens', fs.readFileSync(legacyPath, 'utf8'));
    console.log('Migrated Google Drive tokens from tokens.json into the database.');
  }
}

async function one(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return rs.rows[0] || null;
}
async function all(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return rs.rows;
}
async function run(sql, args = []) {
  return db.execute({ sql, args });
}

async function getSetting(key) {
  const row = await one('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
async function deleteSetting(key) {
  await run('DELETE FROM settings WHERE key = ?', [key]);
}

// ---------- Claude client (lazy so the app can start before keys are configured) ----------
let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

// ---------- Google Drive OAuth (school-wide connection, tokens stored in DB) ----------
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback`
  );
}

async function getAuthedDriveClient() {
  const raw = await getSetting('google_tokens');
  if (!raw) return null;
  const tokens = JSON.parse(raw);
  const client = getOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    setSetting('google_tokens', JSON.stringify({ ...tokens, ...newTokens })).catch(console.error);
  });
  return client;
}

// ---------- Middleware ----------
if (IS_PROD) app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));
app.use(
  cookieSession({
    name: 'nes_session',
    secret: process.env.SESSION_SECRET || 'change-me',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: IS_PROD,
    sameSite: 'lax'
  })
);

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'not_logged_in' });
    const user = await one('SELECT id, name, email FROM users WHERE id = ?', [req.session.userId]);
    if (!user) {
      req.session = null;
      return res.status(401).json({ error: 'not_logged_in' });
    }
    req.user = { id: Number(user.id), name: user.name, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim();
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (!name || !email || !password) return res.status(400).json({ error: 'Fill in name, email and password.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const existing = await one('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = bcrypt.hashSync(password, 10);
    const rs = await run('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
      name, email, hash, new Date().toISOString()
    ]);

    req.session.userId = Number(rs.lastInsertRowid);
    res.json({ user: { id: req.session.userId, name, email } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    const user = await one('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    req.session.userId = Number(user.id);
    res.json({ user: { id: Number(user.id), name: user.name, email: user.email } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// All registered users (for the participant picker)
app.get('/api/users', requireAuth, async (req, res, next) => {
  try {
    const users = await all('SELECT id, name, email FROM users ORDER BY name');
    res.json({ users: users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email })) });
  } catch (err) {
    next(err);
  }
});

// ---------- Status ----------
app.get('/api/status', async (req, res) => {
  let driveConnected = false;
  try {
    driveConnected = Boolean(await getSetting('google_tokens'));
  } catch { /* db not ready */ }
  res.json({
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    driveConnected
  });
});

// ---------- Summarize with Claude ----------
app.post('/api/summarize', requireAuth, async (req, res) => {
  const transcript = (req.body?.transcript || '').trim();
  const language = req.body?.language || '';
  if (!transcript) {
    return res.status(400).json({ error: 'The transcript is empty — no speech was captured.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set.' });
  }

  const mixedNote =
    language === 'mix'
      ? 'This meeting mixes Portuguese and English (code-switching). The speech recognizer ran in Portuguese, ' +
        'so English phrases may appear phonetically mangled into Portuguese-looking words — reconstruct the ' +
        'intended English where you can. Write the summary in Portuguese, keeping English terms as spoken. '
      : '';

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system:
        'You summarize meeting transcripts for Nancy\'s English School. The transcript comes from live speech ' +
        'recognition, so it may contain recognition errors — infer the intended meaning. ' +
        mixedNote +
        'Respond in Markdown with these sections: ## Summary (2-4 sentences), ## Key Points (bullets), ' +
        '## Decisions (bullets, or "None"), ## Action Items (bullets with owner if mentioned, or "None"). ' +
        (language === 'mix' ? '' : 'Write in the same language as the transcript.'),
      messages: [{ role: 'user', content: `Meeting transcript:\n\n${transcript}` }]
    });

    const summary = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.json({ summary });
  } catch (err) {
    console.error('Summarization failed:', err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Invalid Anthropic API key.' });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(500).json({ error: 'Rate limited by the Claude API — wait a moment and try again.' });
    }
    res.status(500).json({ error: err.message || 'Summarization failed.' });
  }
});

// ---------- Meetings ----------
async function meetingWithPeople(meeting) {
  const owner = await one('SELECT id, name FROM users WHERE id = ?', [meeting.owner_id]);
  const participants = await all(
    `SELECT u.id, u.name, u.email FROM meeting_participants p
     JOIN users u ON u.id = p.user_id WHERE p.meeting_id = ? ORDER BY u.name`,
    [meeting.id]
  );
  return {
    ...meeting,
    id: Number(meeting.id),
    owner_id: Number(meeting.owner_id),
    owner_name: owner?.name || '?',
    participants: participants.map((p) => ({ id: Number(p.id), name: p.name, email: p.email }))
  };
}

async function canAccessMeeting(meeting, userId) {
  if (Number(meeting.owner_id) === userId) return true;
  const row = await one('SELECT 1 AS ok FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', [
    meeting.id, userId
  ]);
  return Boolean(row);
}

// Save a meeting (after recording + summarizing)
app.post('/api/meetings', requireAuth, async (req, res, next) => {
  try {
    const title = (req.body?.title || '').trim() || `Meeting ${new Date().toLocaleDateString()}`;
    const transcript = (req.body?.transcript || '').trim();
    const summary = (req.body?.summary || '').trim();
    const language = req.body?.language || '';
    const participantIds = Array.isArray(req.body?.participantIds) ? req.body.participantIds : [];

    if (!transcript || !summary) return res.status(400).json({ error: 'Missing transcript or summary.' });

    const rs = await run(
      'INSERT INTO meetings (owner_id, title, language, transcript, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, title, language, transcript, summary, new Date().toISOString()]
    );
    const meetingId = Number(rs.lastInsertRowid);

    for (const pid of participantIds) {
      if (Number.isInteger(pid) && pid !== req.user.id) {
        await run('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)', [meetingId, pid]);
      }
    }

    const meeting = await one('SELECT * FROM meetings WHERE id = ?', [meetingId]);
    res.json({ meeting: await meetingWithPeople(meeting) });
  } catch (err) {
    next(err);
  }
});

// My meetings: ones I recorded or participated in
app.get('/api/meetings', requireAuth, async (req, res, next) => {
  try {
    const meetings = await all(
      `SELECT DISTINCT m.id, m.owner_id, m.title, m.language, m.drive_link, m.created_at
       FROM meetings m
       LEFT JOIN meeting_participants p ON p.meeting_id = m.id
       WHERE m.owner_id = ? OR p.user_id = ?
       ORDER BY m.created_at DESC`,
      [req.user.id, req.user.id]
    );
    res.json({ meetings: await Promise.all(meetings.map(meetingWithPeople)) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/meetings/:id', requireAuth, async (req, res, next) => {
  try {
    const meeting = await one('SELECT * FROM meetings WHERE id = ?', [Number(req.params.id)]);
    if (!meeting || !(await canAccessMeeting(meeting, req.user.id))) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }
    res.json({ meeting: await meetingWithPeople(meeting) });
  } catch (err) {
    next(err);
  }
});

// ---------- Google OAuth (sign-in + Drive connection share one callback, split by state) ----------
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google credentials are not configured (see README).');
  }
  const url = getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: 'drive'
  });
  res.redirect(url);
});

// "Continue with Google" — sign in / create an account with a Google profile
app.get('/auth/google/login', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google credentials are not configured (see README).');
  }
  const url = getOAuthClient().generateAuthUrl({
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'select_account',
    state: 'login'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (req.query.state === 'login') {
      // Google sign-in: fetch the profile, find or create the user, start a session
      const client = getOAuthClient();
      const { tokens } = await client.getToken(req.query.code);
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data: profile } = await oauth2.userinfo.get();

      const email = (profile.email || '').trim().toLowerCase();
      if (!email) return res.status(500).send('Google did not return an email address.');

      let user = await one('SELECT id FROM users WHERE email = ?', [email]);
      if (!user) {
        // Google accounts have no local password — store an unusable random hash
        const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
        const rs = await run('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [
          profile.name || email.split('@')[0], email, randomHash, new Date().toISOString()
        ]);
        req.session.userId = Number(rs.lastInsertRowid);
      } else {
        req.session.userId = Number(user.id);
      }
      return res.redirect('/');
    }

    // Drive connection flow (school-wide)
    const { tokens } = await getOAuthClient().getToken(req.query.code);
    await setSetting('google_tokens', JSON.stringify(tokens));
    res.redirect('/?drive=connected');
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.status(500).send('Google authorization failed. Go back and try again.');
  }
});

// Save a stored meeting to Google Drive
app.post('/api/meetings/:id/drive', requireAuth, async (req, res, next) => {
  try {
    const meeting = await one('SELECT * FROM meetings WHERE id = ?', [Number(req.params.id)]);
    if (!meeting || !(await canAccessMeeting(meeting, req.user.id))) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    const auth = await getAuthedDriveClient();
    if (!auth) return res.status(401).json({ error: 'not_connected' });

    try {
      const drive = google.drive({ version: 'v3', auth });

      const folderName = process.env.DRIVE_FOLDER_NAME || 'Meeting Notes';
      const existing = await drive.files.list({
        q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive'
      });

      let folderId = existing.data.files[0]?.id;
      if (!folderId) {
        const folder = await drive.files.create({
          requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
          fields: 'id'
        });
        folderId = folder.data.id;
      }

      const full = await meetingWithPeople(meeting);
      const people = full.participants.map((p) => p.name).join(', ');
      const content =
        `# ${meeting.title}\n\n` +
        `**Recorded by:** ${full.owner_name}\n` +
        (people ? `**Participants:** ${people}\n` : '') +
        `**Date:** ${new Date(meeting.created_at).toLocaleString()}\n\n` +
        `${meeting.summary}\n\n---\n\n## Full Transcript\n\n${meeting.transcript}\n`;

      const file = await drive.files.create({
        requestBody: {
          name: meeting.title,
          parents: [folderId],
          mimeType: 'application/vnd.google-apps.document'
        },
        media: { mimeType: 'text/markdown', body: content },
        fields: 'id, webViewLink'
      });

      await run('UPDATE meetings SET drive_link = ? WHERE id = ?', [file.data.webViewLink, meeting.id]);
      res.json({ link: file.data.webViewLink });
    } catch (err) {
      console.error('Drive save failed:', err);
      if (err.code === 401 || err.code === 403) {
        await deleteSetting('google_tokens');
        return res.status(401).json({ error: 'not_connected' });
      }
      res.status(500).json({ error: err.message || 'Failed to save to Google Drive.' });
    }
  } catch (err) {
    next(err);
  }
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------- Start ----------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Nancy's English School — Meeting Recorder running at ${BASE_URL}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

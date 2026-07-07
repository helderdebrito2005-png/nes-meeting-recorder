# 🎙️ Nancy's English School — Meeting Recorder

A web app for the school team: record meetings with live speech recognition in the browser (Portuguese + English), summarize them with the Claude API, share them with the participants, and save notes as Google Docs in Google Drive.

## Features

- **User accounts** — each team member signs up with email + password
- **Live transcription** in the browser (Chrome/Edge) — Portuguese, English, or mixed PT+EN mode
- **AI summaries** (Claude) — key points, decisions and action items
- **Shared meeting history** — every participant of a meeting sees it in their own history
- **Google Drive** — one click saves the notes as a Google Doc in a "Meeting Notes" folder

## Run locally

```
npm install
copy .env.example .env    # then fill in the keys (see below)
npm start
```

Open http://localhost:3000 in **Chrome or Edge**. Data is stored in a local `data.db` file.

## Deploy online (Render + Turso — free)

The app is ready to deploy. You need three free accounts: **GitHub** (code), **Turso** (database), **Render** (hosting).

### 1. Push the code to GitHub

Create a repository (e.g. `nes-meeting-recorder`, private is fine) and push this folder. Secrets are safe — `.env`, `data.db` and `tokens.json` are git-ignored.

### 2. Create the cloud database (Turso)

1. Sign up at https://turso.tech (free plan)
2. Create a database (e.g. `nes-meetings`)
3. Copy the **Database URL** (`libsql://...`) and create an **auth token**

### 3. Deploy on Render

1. Sign up at https://render.com and click **New → Web Service**, connect the GitHub repo
2. Plan: **Free** · Build: `npm install` · Start: `npm start`
3. Add the environment variables:
   - `ANTHROPIC_API_KEY` — your Claude key
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — from step 2
   - `BASE_URL` — the app URL Render gives you, e.g. `https://nes-meeting-recorder.onrender.com`
   - `SESSION_SECRET` — any long random string
4. Deploy 🚀

### 4. Update Google OAuth

In Google Cloud → **Google Auth Platform → Clients** → your client → add a second redirect URI:

```
https://YOUR-APP.onrender.com/auth/google/callback
```

Then open the deployed app, save a meeting to Drive once, and authorize — the connection is stored in the database for everyone.

> 💡 On the free plan the server sleeps after 15 min without visits; the first visit afterwards takes ~1 min to wake up.

## Configuration reference

See [.env.example](.env.example). Locally the database is a `data.db` file; in production set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`.

## Notes

- Speech recognition uses the browser's Web Speech API (Chrome/Edge only). The **PT+EN mixed mode** listens in Portuguese and Claude reconstructs English fragments — for heavy 50/50 bilingual meetings a dedicated transcription service (e.g. AssemblyAI) gives better accuracy.
- The Google Drive connection is school-wide: whoever authorizes it first connects the Drive account where all notes are stored (scope `drive.file` — the app only sees files it created).
- Passwords are stored hashed (bcrypt). Sessions last 30 days.

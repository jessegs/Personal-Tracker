# Personal Tracker

A self-hosted personal tracker for calories, macros, weight, body fat, water, progress photos, and habits. Single Node.js server, vanilla JS frontend, SQLite storage, optional AI macro estimation via the Anthropic API.

## Features

- **Daily food log** — log entries with calories / protein / carbs / fat. Optional AI estimation: type "2 eggs and toast" and Claude fills in the macros.
- **Goals** — daily calorie target plus protein/carbs/fat as percentages of total calories. Goal weight, body fat %, and water target.
- **Macro rings** — five color-coded SVG progress rings (calories, protein, carbs, fat, water) on the daily log.
- **Weight & body fat** — log per-day weight + body fat. 30-day dual-axis chart with goal lines for both.
- **Water** — quick-log buttons (+8 / +16 / +24 oz) and custom amount.
- **Progress photos** — date-stamped photo gallery, click-to-zoom lightbox, ownership-gated URLs.
- **Share image** — gradient share button generates a 1080×1620 PNG combining your photo, macros, and weight, ready for the iOS share sheet.
- **Habits** — define recurring habits with which days of the week they apply. Today view with completion checkboxes.
- **Multi-user** — username/password accounts, scrypt-hashed passwords, session-token auth (cookie + Authorization Bearer header), per-user data isolation.

## Stack

- Node.js 22+ (uses `node:sqlite`, the built-in driver — no native build step)
- Express 4
- SQLite (file at `data/tracker.db`)
- Anthropic SDK (optional, for AI macro estimation)
- Vanilla JS, no frontend build step

## Setup

```bash
git clone <this-repo-url>
cd <repo>
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (optional — AI estimation is disabled if absent)
npm start
```

Open <http://localhost:3000>. Create an account on first run — the first signup also adopts any pre-existing data on the server.

## Environment variables

| Var | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none) | Enables AI macro estimation. Without it, manual entry still works. |
| `PORT` | `3000` | Server port. |
| `SECURE_COOKIES` | `false` | Set to `true` when serving over HTTPS so the session cookie gets the `Secure` flag. |

## Storage layout

- `data/tracker.db` — SQLite database. Schema is migrated automatically on startup.
- `uploads/` — progress photos (served only to their owner via `/uploads/<filename>`).

Both directories are created automatically and are excluded from git via `.gitignore`.

## Notes

- This app has no email verification, no password reset, and no rate limiting on the auth endpoints. It's a personal tracker — bring your own friends or run it on a private network / behind a VPN.
- Designed to feel like a real app on iPhone — `Add to Home Screen` from Safari for a standalone PWA experience with safe-area support.

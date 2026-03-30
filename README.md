# Dobble Generator

A production-oriented web app for managing user-owned custom SpotMatch decks with:

- secure username/password authentication
- salted password hashing with `bcryptjs`
- SQLite persistence for users, decks, and sessions using Node's built-in runtime support
- CSRF protection on all state-changing forms
- rate limiting on login, registration, and password changes
- account page with password change and per-user deck summary
- printable PDF export with fronts and matching backs

## Requirements

- Node.js 22.5+
- npm

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Copy the environment file and set a strong session secret:

```bash
cp .env.example .env
```

3. Start the app:

```bash
npm run dev
```

4. Open `http://localhost:3000`

## Production notes

- Set `NODE_ENV=production`
- Set a long random `SESSION_SECRET`
- Put the app behind HTTPS on your Linux host or reverse proxy
- Persist the `data/` directory
- Run with a process manager such as `systemd`, `pm2`, or Docker

Example systemd service:

```ini
[Unit]
Description=Dobble Generator
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/dobble-generator
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=SESSION_SECRET=replace-with-a-strong-random-secret
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

## Security choices

- Passwords are never stored in plain text
- Password changes re-hash the new password before saving
- Sessions are server-side and use secure cookies in production
- CSRF tokens are required for all POST routes
- Ownership checks prevent users from accessing or mutating other users' decks

## Install note

The app avoids native SQLite npm packages, so `npm install` should not require `node-gyp` compilation.

## PDF export

- Export from any deck page with the `Export PDF` button
- Front pages are followed by matching back pages
- PNG symbol artwork is rendered with transparency preserved
- Missing artwork falls back to a generated placeholder symbol graphic

## SpotMatch constraints

Deck generation supports `symbols per card` values where `symbolsPerCard - 1` is prime.
For a deck with `n` symbols per card:

- order = `n - 1`
- required unique symbols = `order^2 + order + 1`
- total cards generated = `order^2 + order + 1`

Examples:

- `3` symbols per card -> `7` symbols required
- `4` symbols per card -> `13` symbols required
- `6` symbols per card -> `31` symbols required
- `8` symbols per card -> `57` symbols required

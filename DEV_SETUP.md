# Vulcan — Dev Setup

The mobile app talks to a local Express backend (`server/`). To reach that backend from a phone running Expo Go without depending on your LAN IP, the backend is exposed over an **ngrok tunnel**.

```
Expo Go on phone  ─┐
                   │  HTTPS
                   ▼
       https://<your>.ngrok-free.app
                   │
                   ▼   (forwards)
       http://localhost:3000  ──► server/index.js  ──► Anthropic API
```

This is a development convenience. The backend itself is plain Express + `PORT` env var — it will deploy unchanged to Railway, Render, Fly, or any other Node host when you migrate off ngrok.

---

## Prerequisites (one-time)

1. **Node 18+** and **npm** installed.
2. **ngrok installed.** Already done via `winget install Ngrok.Ngrok`. Verify with `ngrok --version`.
3. **Free ngrok account.** Sign up at https://dashboard.ngrok.com/signup. Copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken.
4. **Anthropic API key.** Get one at https://console.anthropic.com/.

### One-time configuration

```powershell
# Authenticate ngrok on this machine (writes to %USERPROFILE%\AppData\Local\ngrok\ngrok.yml)
ngrok config add-authtoken <YOUR_AUTHTOKEN>

# Install backend dependencies
cd C:\Users\Giano\vulcan-mobile\server
npm install
Copy-Item .env.example .env
notepad .env                       # paste ANTHROPIC_API_KEY, save, close
```

### Strongly recommended: claim a free static domain

ngrok's free tier includes **one reserved domain per account**. Without it, the tunnel URL changes every time you restart ngrok, and you have to edit `.env` + restart Expo each time. With it, you set `.env` *once* and forget.

1. Go to https://dashboard.ngrok.com/domains, click **+ New Domain**, claim the free one (looks like `mellow-cat-1234.ngrok-free.app`).
2. Paste that URL into `vulcan-mobile\.env`:
   ```
   EXPO_PUBLIC_API_BASE_URL=https://mellow-cat-1234.ngrok-free.app
   ```
3. Use `--domain=<your-domain>` when starting ngrok (see below).

If your ngrok is older than 3.13 and `--domain` errors, run `ngrok update` once to pull the latest binary.

---

## Daily startup — three terminals, in this order

### Terminal 1: Backend

```powershell
cd C:\Users\Giano\vulcan-mobile\server
npm start
```

Wait for `Vulcan backend listening on http://0.0.0.0:3000`. Sanity-check:

```powershell
curl http://localhost:3000/health      # → {"ok":true}
```

### Terminal 2: ngrok tunnel

**With a static domain (recommended):**

```powershell
ngrok http --domain=mellow-cat-1234.ngrok-free.app 3000
```

**Without a static domain (URL changes every run):**

```powershell
ngrok http 3000
```

You'll see a panel like:

```
Forwarding   https://abcd-1234-56-78.ngrok-free.app -> http://localhost:3000
```

That `Forwarding` HTTPS URL is what the mobile app needs.

### Terminal 3: `.env` and Expo

- **Static domain path:** `.env` is already correct — skip straight to starting Expo.
- **Dynamic URL path:** open `vulcan-mobile\.env`, set `EXPO_PUBLIC_API_BASE_URL` to the URL ngrok just printed (no trailing slash needed but harmless), save.

Then start Expo:

```powershell
cd C:\Users\Giano\vulcan-mobile
npx expo start --port 8082
```

> If you edited `.env` in this session, Expo must be **fully restarted** (Ctrl+C, then re-run). `EXPO_PUBLIC_*` vars are read once at dev-server start; hot reload does not pick them up.

Scan the QR code in Expo Go, submit a diagnosis, and the request flows: phone → ngrok HTTPS → localhost:3000 → Anthropic.

---

## Verifying the tunnel end-to-end

```powershell
# From any machine, anywhere:
curl https://<your-ngrok-url>/health
# → {"ok":true}
```

ngrok also serves an inspector at http://127.0.0.1:4040 showing every request hitting your tunnel — invaluable for debugging "is the request even reaching the backend?".

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App stuck on "Thinking…" forever | `.env` URL doesn't match the live tunnel, or Expo wasn't restarted after `.env` change | Compare `.env` to ngrok's Forwarding line; restart Expo |
| `ERR_NGROK_3200` "endpoint offline" | Backend isn't running, or ngrok is pointed at the wrong port | Check terminal 1, confirm `ngrok http 3000` |
| HTML page instead of JSON | ngrok browser interstitial — the `ngrok-skip-browser-warning` header in `lib/api.ts` already handles this; if you see it from `curl`, add `-H "ngrok-skip-browser-warning: true"` |
| `Missing ANTHROPIC_API_KEY` on backend start | `server/.env` not created or not filled in | `Copy-Item server/.env.example server/.env`, edit, restart |
| `Port 8081 is being used` | Stale Metro instance | Use `--port 8082`, or `Get-Process node \| Stop-Process` to clear |

---

## Cloud migration (when you're ready for TestFlight / Play internal)

The backend is already host-agnostic. To move to Railway / Render / Fly:

1. Push `server/` to a Git repo (or deploy from the existing one, set the build root to `server/`).
2. Set env vars on the host: `ANTHROPIC_API_KEY`, `PORT` (most hosts inject this automatically — the server already honors it).
3. Use the host's start command: `npm start`.
4. Update `vulcan-mobile\.env` → `EXPO_PUBLIC_API_BASE_URL=https://api.your-domain.com`, restart Expo.

No code changes. ngrok stops being part of the picture.

You can leave the `ngrok-skip-browser-warning` header in the client — non-ngrok backends ignore unknown headers.

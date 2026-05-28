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

---

## Persistent cache on Railway (one-time setup)

The backend keeps several caches that should survive redeploys:

| File | Contents | Lifetime |
|---|---|---|
| `cache.json` | Ask Vulcan factual-answer cache | 30-day TTL per entry |
| `dtcCache.json` | Claude DTC-fallback answers (codes not in the static DB) | Forever — DTC definitions don't change |
| `vehicleSpecCache.json` | Verified vehicle specs from external providers | Forever — specs don't change for a given vehicle |

Railway's container filesystem is **ephemeral** — every redeploy wipes these files unless they live on a mounted **Volume**. Without a Volume, every redeploy means re-paying Claude for previously-answered DTCs and re-paying provider quota for previously-fetched specs.

### Configure the Volume (Railway dashboard, ~2 min)

1. Open your Vulcan service in the Railway dashboard.
2. **Variables & Volumes** tab → **+ New Volume**.
3. Mount path: `/data`. Size: 1 GB is more than enough (current caches total <10 MB).
4. Click **Add**. Railway provisions the Volume and restarts the service.
5. Back in the **Variables** tab, add `CACHE_DIR=/data`.
6. Trigger a redeploy (or wait for the next push).

### Verify it worked

After the deploy completes, hit `/metrics` and make a couple of cacheable requests (a Claude-fallback DTC like `C0700`, an oil-spec question). Trigger a redeploy from the dashboard. Hit `/metrics` again — the `entries` counts under `dtcFallback` and `vehicleSpecs` should be the same as before the redeploy. The deploy logs show a `[startup] cache rollup:` line that makes this easy to spot.

### Local dev

`CACHE_DIR` is optional locally — leave it blank in `server/.env` and the cache files land in `server/` (gitignored) like they always have.

---

## EAS Build — standalone iOS app

Expo Go is great for quick UI / logic iteration on modules it pre-bundles. Use **EAS Build** when you need a real native binary: testing the actual app icon, splash, OBD2 Bluetooth (when that lands), TestFlight distribution, or App Store release.

The `eas.json` at the repo root defines three profiles:

| Profile | Use for | Dev tools | Distribution |
|---|---|---|---|
| `development` | Day-to-day native testing with hot reload | Yes | Ad Hoc (direct install) |
| `preview` | TestFlight-style internal testing | No | Internal / Ad Hoc |
| `production` | App Store release | No | Store |

### First-time setup (one-time, ~10 min plus Apple 2FA)

```powershell
cd C:\Users\Giano\vulcan-mobile
eas login                          # uses your Expo account
eas init                           # creates the EAS project, writes projectId into app.json
eas device:create                  # walks you through registering your iPhone UDID
eas build --profile development --platform ios
```

On the first iOS build EAS will prompt for your Apple ID, ask for 2FA, and offer to manage certificates and provisioning profiles automatically — say yes. The build queues on EAS infrastructure; free-tier builds usually finish in 15–25 min.

When it completes, EAS prints an install URL. Open it on the iPhone in Safari → **Install**. Then under **Settings → General → VPN & Device Management**, tap your developer profile and **Trust** it.

### Daily dev (after the first build is installed)

```powershell
cd C:\Users\Giano\vulcan-mobile
npx expo start --dev-client        # NOT plain `expo start`
```

The dev-client app on your phone replaces Expo Go and loads your custom native binary. Hot reload, console, and dev menu all behave the same. You only rebuild the development binary when you change native config — adding a permission, a new plugin, or a new native module.

### TestFlight build

```powershell
eas build --profile preview --platform ios
eas submit --profile production --platform ios     # uploads the binary to App Store Connect
```

In App Store Connect, add testers under **TestFlight → Internal Testing**. They install via the TestFlight app.

### App Store release build

```powershell
eas build --profile production --platform ios
eas submit --profile production --platform ios
```

Complete the App Store listing in App Store Connect (screenshots, description, privacy questionnaire).

### Bundle identifier

`app.json` sets `ios.bundleIdentifier` to `com.vulcan.app`. If your Apple Developer account is registered under a specific reverse-DNS (most are, e.g., `com.yourname.vulcan`), change both `ios.bundleIdentifier` and `android.package` before the first `eas init` — keep them identical. After the first build, the identifier is locked into the credentials EAS provisions; renaming later requires regenerating certificates.

### When to use Expo Go vs dev build

| Change | Expo Go | EAS dev build |
|---|---|---|
| TSX / JS / styles | ✓ | ✓ |
| New screen / route | ✓ | ✓ |
| New JS-only npm package | ✓ | ✓ |
| New Expo SDK module that's bundled in Expo Go (camera, image picker, print, sharing, AsyncStorage) | ✓ | ✓ |
| New native module not in Expo Go (e.g., `@react-native-async-storage/async-storage` was already covered, but `react-native-ble-plx` would not be) | ✗ | ✓ |
| Custom Info.plist permission strings | ✗ | ✓ |
| Testing real icon / splash | ✗ | ✓ |
| TestFlight / App Store distribution | n/a | ✓ |

### Sanity check the config before building

EAS builds take ~20 min on the free tier. Catch config mistakes locally first:

```powershell
npx expo-doctor
```

(Not `npx expo doctor` — `doctor` was removed from the local Expo CLI; `expo-doctor` is a separate package that Expo invokes via `npx`.) It checks bundle ID format, plugin compatibility, SDK version alignment, and Info.plist completeness — anything red here means EAS would fail at the same point.


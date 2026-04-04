# Deploying (e.g. `challenge.evasnyder.com`)

One Node process serves the **API** and the **built Vite app** from the same origin. SQLite lives on disk — use a **persistent volume** for `DB_PATH`.

**Replicas:** Run **exactly one** instance per SQLite database. OAuth state and sessions are stored in SQLite; if the load balancer sends `/auth/login` to instance A and `/auth/callback` to instance B, Last.fm login will fail or you will look “logged out” until you scale down to one replica (or move to a shared database).

## 1. Build locally (sanity check)

```bash
npm run build
NODE_ENV=production FRONTEND_ORIGIN=https://challenge.evasnyder.com node backend/src/server.js
```

Open `http://127.0.0.1:8787` — you should see the app and `/health` should return JSON.

## 2. Environment variables (production)

| Variable | Notes |
|----------|--------|
| `NODE_ENV` | `production` (enables HTTPS cookies, `trust proxy`) |
| `FRONTEND_ORIGIN` | `https://challenge.evasnyder.com` (exact origin, no trailing slash) |
| `LASTFM_API_KEY` / `LASTFM_API_SECRET` | From [Last.fm API account](https://www.last.fm/api/account/create) |
| `SESSION_SECRET` | Long random string |
| `ARTIST_LASTFM_USERNAME` | Your Last.fm username (for artist-only admin tools) |
| `CAMPAIGN_ARTIST` / `CAMPAIGN_TRACK_NAME` | Match scrobbles (default: Eva Snyder / turkeys) |
| `DB_PATH` | e.g. `/data/data.sqlite` on a mounted volume |
| `TRUST_PROXY` | Set to `1` if your host doesn’t set `NODE_ENV` but sits behind HTTPS (optional; often not needed if `NODE_ENV=production`) |

In Last.fm, set the app **callback URL** to `https://your-host/auth/callback` (same path your server uses).

## 3. DNS (Squarespace)

Create a **subdomain** `challenge` → **CNAME** to the hostname your host provides (e.g. `xxx.railway.app`, `xxx.onrender.com`). Enable HTTPS on the host.

## 4. Docker (any provider that runs containers)

From the **repository root**:

```bash
docker build -t top-listeners .
docker run -p 8787:8787 --env-file .env -v top-listeners-data:/data \
  -e DB_PATH=/data/data.sqlite \
  top-listeners
```

Mount `/data` so SQLite survives restarts.

## 5. Railway (important)

- **Root directory** for the service must be the **repository root** (where `Dockerfile` and `railway.json` live), **not** `backend`. If the root is `backend`, Railway won’t see the repo `Dockerfile` or build `web/dist`, and you’ll get the “API only” page at `/`.
- This repo includes **`railway.json`** with `"builder": "DOCKERFILE"` so the image builds the **web** app and copies `web/dist` into the container.
- After deploy, open **`GET /health`**: `hasWebDist` should be **`true`** and `webDist` should point at the folder containing the built app.

## 6. Providers (pick one)

- **Railway / Render / Fly.io**: Connect the repo, set env vars, add a **volume** for `/data`, use the **Dockerfile** from repo root **or** match the layout in this repo’s `Dockerfile`.
- **Without Docker**: Run `npm run build` in CI, copy `web/dist` and `backend/`, run `NODE_ENV=production node backend/src/server.js`, persist `data.sqlite`.

## 7. Squarespace marketing site

Link a button to `https://challenge.evasnyder.com`.

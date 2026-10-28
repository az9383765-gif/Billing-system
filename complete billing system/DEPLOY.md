# Deploying MartBill on a real domain

MartBill is a single Node.js server: it serves the API **and** the built app,
and keeps everything in one SQLite file. No external database, no redis —
one process, one disk.

- `PORT` — read from the environment (falls back to 3000 locally)
- `DATA_DIR` — where `shopbill.db` is written (falls back to `./data`)
- HTTPS — always terminate it (Render does this for you; nginx + certbot on a VPS).
  Service workers and Google sign-in **require HTTPS** (localhost is exempt).

---

## Option A — Render (no server to manage)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick the repo. Render reads `render.yaml`
   (build `npm ci && npm run build`, start `npm start`, disk at `/var/data`).
3. Plan: **Starter ($7/mo)** — the free plan has no persistent disk, so the
   database would be wiped on every deploy. Fine for a trial, not for a shop.
4. Wait for the first deploy, open the URL → you land in **setup mode** →
   create the owner (Head) account → sign in.
5. **Settings → Appearance / Shop Information** — set your shop name, address, GSTIN.

### Your domain

1. Buy the domain (Namecheap / Cloudflare / Porkbun — ~$10/yr).
2. Render → your service → **Custom Domains** → add it. Render issues the
   HTTPS certificate automatically.
3. At your registrar, add the DNS it shows (usually a `CNAME` to
   `*.onrender.com`, or an `A` to Render's IP).

### Swap the placeholder in `index.html` (link previews)

`index.html` ships with `https://martbill.app` as a placeholder so shared links
show the right card. Search the file for `martbill.app` and replace **all six
URLs** (`og:url`, `og:image` ×2, `twitter:image`, `canonical`) with your domain,
then redeploy.

---

## Option B — VPS (full control)

Ubuntu 22.04/24.04, a domain pointed at the server's IP (`A` record).

```bash
# 1. basics
sudo apt update && sudo apt -y install nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pm2

# 2. app
git clone <your-repo-url> martbill && cd martbill
npm ci
npm run build
mkdir -p /var/martbill-data

# 3. run under pm2 (survives reboots) with the database outside the repo
DATA_DIR=/var/martbill-data pm2 start server/index.js --name martbill
pm2 save && pm2 startup   # follow the printed command

# 4. nginx in front
sudo tee /etc/nginx/sites-available/martbill >/dev/null <<'NGINX'
server {
  listen 80;
  server_name yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX
sudo ln -s /etc/nginx/sites-available/martbill /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. HTTPS (free certificates, auto-renewed)
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# 6. firewall
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

---

## Google sign-in (optional)

1. [Google Cloud Console](https://console.cloud.google.com) → **APIs &
   Credentials → Create credentials → OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: `https://yourdomain.com`
   (add `http://localhost:3000` while developing).
3. Copy the Client ID → **Settings → Google Sign-in** in MartBill → paste →
   Save. The login page now shows **Sign in with Google**.
4. Until it is configured, the login page simply stays password-only — nothing
   breaks. A Google address seen for the first time becomes a *pending* account
   you approve in **Settings → Users** (same as any sign-up).

## Backups

- **In-app**: Settings → Backup & Restore downloads / restores a full JSON
  snapshot (do this weekly; keep the file somewhere safe).
- **The database itself**: copy `${DATA_DIR}/shopbill.db` while the server runs
  (SQLite in WAL mode tolerates a file copy; safest with a restart or
  `sqlite3 shopbill.db ".backup backup.db"`). Cron example:

  ```bash
  0 3 * * * cp /var/martbill-data/shopbill.db /backups/shopbill-$(date +\%F).db
  ```

## Multi-shop / cloud sync

Settings → **Online Sync** accepts any MartBill server address — a second
terminal, a second shop, or a small VPS. Sync is always optional: the shop
keeps billing offline and pushes changes when the internet returns.

## Before you ship

```bash
npm test            # 76 API tests
npm run test:ui     # page render suite   (server must run on :3000)
npm run test:features  # full browser E2E  (server must run on :3000)
```

Start the server first (`npm start` after `npm run build`), then the two
browser suites. All three must be green.

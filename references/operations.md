# On-site operations

The local server runs on a small Linux box at the site. Assume nobody
technical is physically there: everything must auto-start, auto-recover, and
be diagnosable over SSH.

Reference footprint: Ubuntu LTS, Node 22 LTS, 1 GB RAM, static LAN IP.
Port layout: the Node process listens on `127.0.0.1:3300`; nginx terminates
TLS on `:443` for the LAN. Only 443 (and mDNS 5353/udp) are open.

## Environment

```bash
# .env — local server
LOCATION_ID=<site document ID in Firestore>
PORT=3300
HOST=127.0.0.1                     # nginx fronts it; never expose Node directly
GOOGLE_APPLICATION_CREDENTIALS=/etc/island/service-account.json
FIREBASE_API_KEY=<web API key>
CLOUD_API_URL=https://<your-cloud-app>
HEARTBEAT_INTERVAL_MS=5000
HEARTBEAT_FAILURE_THRESHOLD=3
SYNC_SECRET=<same value as cloud env>      # ingestion endpoints (sync-flush.md)
TERMINAL_SECRET=<hardware HMAC secret>
LOCK_ACCESS_TOKEN=<same as cloud env>
KIOSK_API_KEY=<same as cloud env, or empty for open kiosk>
```

The service-account JSON is a full-privilege cloud credential sitting on a box
in the field: `chmod 600`, owned by the service user, and **never in the git
checkout** (a stray key committed next to the code is a real incident pattern
— add `*.json` service keys to `.gitignore` before the first deploy).

## systemd

```ini
# /etc/systemd/system/island-local.service
[Unit]
Description=Island Mode Local Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=island
Group=island
WorkingDirectory=/opt/island/local-server
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/island/local-server/.env
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now island-local
sudo journalctl -u island-local -f          # live logs
```

`Restart=always` interacts with the storage decision
([replication.md](replication.md)): with memory storage, a crash **during an
outage** restarts into an empty replica and the offline work is gone. If you
kept memory storage, at minimum alert on restarts (`systemd-notify`, or a
journald watch) so the loss is known, not silent.

## TLS + mDNS

Terminals are browser PWAs served over HTTPS from the cloud; browsers refuse
mixed-content calls to a plain-HTTP LAN box, so the local server must speak
HTTPS — with a self-signed CA installed on every terminal device.

```bash
# Self-signed cert, 10 years, with SANs for both the mDNS name and the static IP
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/island/key.pem -out /etc/ssl/island/cert.pem \
  -subj "/CN=island.local" \
  -addext "subjectAltName=DNS:island.local,IP:192.168.1.100"
```

```nginx
# /etc/nginx/sites-available/island-local
server {
    listen 443 ssl;
    server_name island.local;
    ssl_certificate     /etc/ssl/island/cert.pem;
    ssl_certificate_key /etc/ssl/island/key.pem;
    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

mDNS so terminals can find `island.local` without local DNS:

```bash
sudo apt-get install -y avahi-daemon && sudo systemctl enable --now avahi-daemon
sudo hostnamectl set-hostname island
sudo ufw allow 443/tcp && sudo ufw allow 5353/udp && sudo ufw reload
```

Install `cert.pem` as a trusted CA on every terminal (this is the #1 field
failure — a terminal without the cert fails over to *nothing*, silently):

- **Linux/ChromeOS kiosk**: `sudo cp cert.pem /usr/local/share/ca-certificates/island.crt && sudo update-ca-certificates`, restart the browser.
- **Android tablet**: Settings → Security → Install certificate → CA certificate.
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain cert.pem`.
- **Windows**: double-click → install to "Trusted Root Certification Authorities".

Keep an mDNS-less fallback: give the box a static IP, include that IP in the
cert SANs and in the client's fallback list
([network-failover.md](network-failover.md)) — Android's mDNS support in
particular is unreliable.

## Monitoring

`GET /health` → `{ ok, locationId, mode, timestamp }` — liveness + which mode
the server believes it is in.

`GET /status` → network state, per-replication `active`/`error`, and the
local-vs-cloud document counts. Reading it:

| Signal | Meaning |
|---|---|
| `collections.X` ≈ `firestoreCounts.X` | replica healthy |
| local 0, cloud > 0 | initial replication never completed — check rules/credentials |
| `firestoreCounts.X === -1` | cloud unreachable right now (expected when offline) |
| `replications[].error` set with recent `errorAt` | live replication failure — usually rules or a missing `serverTimestamp` on cloud writes |
| unsynced counts growing while `mode: online` | flush failing — check `SYNC_SECRET` and cloud logs |

Cloud-side, the site document is the operator surface: `lastHeartbeatAt`
should move every ~30 s and `status` should be `online`. An admin "sites"
screen showing both, with staleness coloring, is the cheapest fleet dashboard
you can build.

Local watchdog (belt-and-braces on top of systemd):

```bash
#!/bin/bash
# /opt/island/check-health.sh — cron: */5 * * * *
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3300/health)
if [ "$STATUS" != "200" ]; then
  echo "$(date) - local server DOWN (HTTP $STATUS)" >> /var/log/island-health.log
  systemctl restart island-local
fi
```

## Update and rollback

```bash
cd /opt/island && git rev-parse HEAD > /tmp/island-prev-commit   # rollback point
sudo systemctl stop island-local
git pull && cd local-server && npm install && npm run build
sudo systemctl start island-local
curl -s http://localhost:3300/status | jq '.replications'        # all active: true
```

During the restart, online terminals use the cloud unaffected; only a
simultaneous cloud outage would be noticed. Rollback = `git checkout $(cat
/tmp/island-prev-commit)`, rebuild, restart.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED` :443 | nginx down | `systemctl status nginx` |
| `ECONNREFUSED` :3300 on localhost | Node process down | `systemctl status island-local`, read journal |
| Replica counts stay 0 | rules deny the `local-server` uid, or bad credentials | test rules; verify service account + API key |
| One collection never updates | cloud writes missing `serverTimestamp` | audit that collection's cloud write paths |
| Deleted items still served locally | hard delete on the cloud | soft-delete (`_deleted: true` + stamp) |
| Terminals never fail over | CA cert not installed, or 443 firewalled | install cert; `ufw allow 443/tcp` |
| `island.local` unresolvable | avahi not running / client lacks mDNS | start avahi; rely on the static-IP fallback |
| Offline work not syncing after reconnect | flush failing | journal grep "flush"; check `SYNC_SECRET` both sides |
| Cloud bookings blocked though site is up | stale `lastHeartbeatAt` | check Firestore heartbeat errors in journal |
| Stock looks wrong after reconnect | duplicate apply or wholesale delta reset | verify ingestion idempotency ([sync-flush.md](sync-flush.md)) |
| High memory | large replica in memory storage | expected; add swap below 1 GB RAM |

## Checklist

- [ ] systemd unit enabled; survives reboot
- [ ] Service-account key 600, outside the repo
- [ ] TLS cert has SANs for name AND static IP; CA installed on every terminal
- [ ] mDNS + static-IP fallback both tested from a terminal
- [ ] `/status` counts verified ≈ cloud after first sync
- [ ] Outage drill performed: pull WAN, watch terminals fail over, restore, verify flush

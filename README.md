# Dockside Training

A staff training calendar for the marina, hosted on your own PC with Docker.

- **Managers** add training sessions and drills, edit them, and change their dates by dragging them
  to another day or time. They can also plan something for a month and set the day later, mark
  attendance, download attendance as a spreadsheet, and invite or remove people.
- **Staff** sign in to see the calendar, book places, and see their own training history.
- Everyone's screen updates as soon as something changes.

The server checks every change, so only managers can change the calendar, even if someone tampers
with the page.

## Run it

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) running on the PC that will host the calendar.

```sh
docker compose up -d --build
```

Then open http://localhost:8080 on that PC.

1. **First visit:** create the first manager account. This option only appears while the calendar has no accounts.
2. **Invite people:** go to **People** and enter someone's email. You get a sign-up link to send them by text, Teams or email.
   The link works once, for 14 days. They open it, enter their name and choose a password.
3. **Forgotten passwords:** go to **People**, click **Password reset link** next to the person, and send them the link.

### Let other devices reach it

Staff open `http://<this PC's address>:8080`, for example `http://192.168.1.20:8080`. To find the address,
run `ipconfig` and look for the IPv4 Address. If phones or other PCs can't connect, allow port 8080
through Windows Firewall.

Set `PUBLIC_URL` in `docker-compose.yml` to that address so invite and reset links always point to it, then run
`docker compose up -d` again.

### Update after changing the code

```sh
docker compose up -d --build
```

The data stays in the `training-data` Docker volume across updates and restarts.

### Back up the data

```sh
docker compose exec training node -e "new (require('node:sqlite').DatabaseSync)('/data/training.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp training:/data/backup.db ./training-backup.db
```

To restore a backup, stop the app, copy the file back to `/data/training.db`, and start it again.

## Today's weather

The weather panel beside the calendar comes from [Open-Meteo](https://open-meteo.com/), which is free and needs no account
or key. The server fetches the forecast at most every 15 minutes and shares it with everyone, so the PC running the calendar
needs internet access. The panel shows Westhaven by default. To show another place, set `WEATHER_LAT`, `WEATHER_LON` and
`WEATHER_NAME` in `docker-compose.yml`.

If the panel says the forecast isn't available, the server can't reach Open-Meteo. On networks that inspect secure traffic,
Node.js needs that network's certificate. Copy the certificate file (ask IT for it) next to `docker-compose.yml`, then add:

```yaml
    volumes:
      - ./company-ca.crt:/certs/company-ca.crt:ro
    environment:
      NODE_EXTRA_CA_CERTS: /certs/company-ca.crt
```

When running without Docker on Windows, `npm start` already trusts the certificates Windows trusts.

## Phone notifications

Anyone with an account can turn notifications on in **Settings → Notifications**, once on each phone or computer.
They can choose which of these they get:

- **A session they booked is moved or cancelled.** Several changes saved at once arrive as one notification.
- **A reminder the evening before**, from 5 pm marina time, for sessions they booked and for required sessions.
  Set `REMINDER_HOUR` to change the hour (0–23).
- **New training or drills.** A repeating series arrives as one notification. Example sessions never notify.

The person who makes a change is not notified about it. Tapping a notification opens the calendar on that day. Signing
out turns notifications off on that device, and removing someone from the team stops all of theirs.

### What phones need

- **HTTPS.** Phones only allow notifications from a secure `https://` address (and from `http://localhost`, for
  testing on the PC itself). A plain `http://192.168.x.x:8080` address will not work. Two common ways to add HTTPS:
  - a tunnel such as Cloudflare Tunnel, which gives an address like `https://training.example.co.nz` that also works off site;
  - a name and certificate from IT, served through a reverse proxy such as Caddy.
- **iPhone and iPad** (iOS 16.4 or newer): open the calendar in Safari, tap Share, then **Add to Home Screen**. Open it
  from the new icon, sign in, and turn notifications on in Settings. Safari itself cannot receive them.
- **Android:** Chrome can turn them on straight from the browser. Adding it to the home screen is optional.

Once it's on HTTPS, set `COOKIE_SECURE: "1"` and `PUBLIC_URL` to the https address in `docker-compose.yml`.

### How it works

The server sends notifications through each browser's own push service (Google for Chrome and Android, Apple for
iPhone, Mozilla for Firefox, Microsoft for Edge), using the standard Web Push protocol. The message is encrypted so only
the person's device can read it. The server makes its signing key once and keeps it in the database, so backups keep
existing subscriptions working. The server only ever sends to those push services, never to other addresses.

The server needs to reach those push services over the internet. If your network inspects secure traffic, see the
certificate note under *Today's weather*. Set `PUSH_CONTACT` to a `mailto:` or `https://` address the push services
can contact about your server (default: `https://www.westhaven.co.nz`).

## Run without Docker

You need Node.js 22.15 or newer. There are no packages to install.

```sh
npm start
```

The data is stored in `./data/training.db`. Set `PORT`, `DATA_DIR` or `PUBLIC_URL` to change the defaults.

## Files

| Path | What it is |
| --- | --- |
| `server.js` | Web server and API: sign-in, invites, roles, calendar data (SQLite), live updates, weather and push notifications |
| `web/` | The app people use in the browser |
| `Dockerfile`, `docker-compose.yml` | Container setup |

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

## Phone notifications (next step)

The app is already set up to be installed on a phone. Phones only allow push notifications from sites served over
HTTPS, so before adding them, put the calendar behind HTTPS. Two common ways:

- a reverse proxy such as Caddy, with a certificate your phones trust;
- a tunnel such as Cloudflare Tunnel.

Once it's on HTTPS, set `COOKIE_SECURE: "1"` in `docker-compose.yml`.

## Run without Docker

You need Node.js 22.13 or newer. There are no packages to install.

```sh
npm start
```

The data is stored in `./data/training.db`. Set `PORT`, `DATA_DIR` or `PUBLIC_URL` to change the defaults.

## Files

| Path | What it is |
| --- | --- |
| `server.js` | Web server and API: sign-in, invites, roles, calendar data (SQLite) and live updates |
| `web/` | The app people use in the browser |
| `Dockerfile`, `docker-compose.yml` | Container setup |

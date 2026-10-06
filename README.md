# Scrum Poker

Real-time planning poker for agile estimation. Create rooms, vote, and reveal results with a countdown timer.

## Technologies

- **Backend:** Node.js, Express, Socket.io
- **Database:** SQLite (via better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JS (served statically)
- **Containerization:** Docker, Docker Compose

## How to Run

```bash
npm install
npm start
```

The app runs on port 3000 by default (override with `PORT` env).

### Environment

Copy `.env.example` to `.env` and set your admin password:

```
ADMIN_PASSWORD=your-secure-password
```

## Docker Compose

```yaml
services:
  scrum-poker:
    build: .
    container_name: scrum-poker
    ports:
      - "8090:3000"
    environment:
      - ADMIN_PASSWORD=changeme
      - TZ=Europe/Warsaw
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker compose up -d
```

The admin panel is available at `/admin`.

`ADMIN_PASSWORD` is required at startup. Set `TRUST_PROXY` to the number of trusted
proxy hops when the application is deployed behind a reverse proxy.

## Experience Enhancements

The room experience is intentionally playful without using audio:

- Live presence indicators and a small join/leave activity feed.
- Smooth participant enter/exit transitions.
- Staggered card-flip reveals and animated average values.
- Clear round status messages such as choosing, almost ready, revealing, and results.
- Gentle vote confirmation feedback and timeout urgency.
- Room sharing improvements, including invite QR codes and room accent colors.
- Accessibility support including keyboard controls, visible focus states, and reduced motion.
- Optional calm mode for disabling shakes, celebration effects, and other intense motion.

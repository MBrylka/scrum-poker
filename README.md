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

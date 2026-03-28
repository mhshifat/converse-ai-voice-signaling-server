# Voice signaling server (WebRTC)

Handles WebRTC signaling for **live human voice** during handoff: human agent speaks into their mic → customer hears it in real time.

- **Deploy**: Run on any Node host (Railway, Render, Fly.io free tiers). Not deployable to Vercel (needs a long-lived WebSocket server).
- **Env**: `PORT` (default 3001).
- **Frontend**: Set `NEXT_PUBLIC_VOICE_SIGNALING_WS_URL` to `ws://localhost:3001` (dev) or `wss://your-signaling-host` (prod).
- **HTTP**: `GET /health` returns `200` + `ok` (use for Render health checks). `GET /` returns a short label.

## Render free tier (“spins down after inactivity”)

You *can* point an external uptime service (e.g. UptimeRobot, cron-job.org) at `https://your-service.onrender.com/health` every few minutes. That sometimes **reduces cold starts** so the process is already running when someone opens the widget.

**Limits:**

- When the instance **does** spin down, the Node process stops: **all WebSocket connections drop** and in-memory rooms are cleared. Polling does **not** preserve an active voice call through a sleep cycle.
- Relying on constant pings to avoid sleep is **fragile** and may conflict with the spirit of free tier; for **reliable** live voice in production, use a **paid** Render instance (or another always-on host).

```bash
npm install
npm start
```

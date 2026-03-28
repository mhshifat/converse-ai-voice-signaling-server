# Voice signaling server (WebRTC)

Handles WebRTC signaling for **live human voice** during handoff: human agent speaks into their mic → customer hears it in real time.

- **Deploy**: Run on any Node host (Railway, Render, Fly.io free tiers). Not deployable to Vercel (needs a long-lived WebSocket server).
- **Env**: `PORT` (default 3001). **`VOICE_SIGNALING_JWT_SECRET`**: must match the Next.js app; clients send a short-lived JWT on `join`. Optional dev-only: `ALLOW_INSECURE_VOICE_SIGNALING=true` to allow joins without a token (do not use in production).
- **Frontend**: Set `NEXT_PUBLIC_VOICE_SIGNALING_WS_URL` to `ws://localhost:3001` (dev) or `wss://your-signaling-host` (prod).
- **HTTP**: `GET /health` returns `200` + `ok` (use for Render health checks). `GET /` returns a short label.
- **Optional**: `MAX_WS_PAYLOAD` (bytes, default `131072`, max `1048576`) — max WebSocket frame size.

## Security

- **`VOICE_SIGNALING_JWT_SECRET` set (production):** Each `join` must include a valid short-lived JWT from the main app; claims must match `conversationId` and `role` (`customer` | `human`). Issuance is gated on the API (active handoff, correct channel, assignment).
- **`wss://` in production:** Encrypts signaling in transit.
- **UUID-shaped** `conversationId` and **`maxPayload`** on the WebSocket reduce junk and oversized frames.
- **One socket per role per room:** If someone occupies `human` first, the real agent gets “role already taken” (DoS on that role for that room).

**Residual risks:** JWT can be replayed until it expires; rate limiting is not built in (use a reverse proxy if needed). Media stays **peer-to-peer (WebRTC)**; signaling only carries SDP/ICE.

**Manual QA:** See **“Manual test checklist (full voice handoff)”** in `web/README.md`.

## Render free tier (“spins down after inactivity”)

**Recommended:** Use [cron-job.org](https://cron-job.org) (or UptimeRobot, etc.) with **GET** `https://your-service.onrender.com/health` every **10–15 minutes**. That **reduces cold starts** compared to a daily ping and avoids Vercel cron limits if you are not using Vercel Pro.

**Limits:**

- When the instance **does** spin down, the Node process stops: **all WebSocket connections drop** and in-memory rooms are cleared. Polling does **not** preserve an active voice call through a sleep cycle.
- Relying on constant pings to avoid sleep is **fragile** and may conflict with the spirit of free tier; for **reliable** live voice in production, use a **paid** Render instance (or another always-on host).

```bash
npm install
npm start
```

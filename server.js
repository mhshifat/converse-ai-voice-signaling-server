/**
 * WebRTC signaling server for live human voice handoff.
 * Run separately (e.g. Railway, Render, Fly.io). Clients connect with
 * conversationId + role ('human' | 'customer'); we relay offer/answer/ice.
 *
 * HTTP + WebSocket share one port (required by hosts like Render). GET /health
 * for platform health checks or external uptime pings (see README re: free tier).
 */
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3001;

/** Must match web app `VOICE_SIGNALING_JWT_SECRET` (HS256 JWT for join). */
const JWT_SECRET = process.env.VOICE_SIGNALING_JWT_SECRET?.trim();
/** Local dev only — never enable in production. */
const ALLOW_INSECURE_NO_JWT = process.env.ALLOW_INSECURE_VOICE_SIGNALING === 'true';

/** Only accept standard UUID-shaped IDs (matches Prisma @default(uuid())) to limit abuse of room keys. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cap signaling message size (SDP + ICE are small; blocks huge JSON / DoS). */
const MAX_WS_PAYLOAD = Math.min(Math.max(Number(process.env.MAX_WS_PAYLOAD) || 131072, 4096), 1048576);

const /** @type {Map<string, { human?: import('ws').WebSocket, customer?: import('ws').WebSocket }>} */ rooms = new Map();

function getRoom(conversationId) {
  let room = rooms.get(conversationId);
  if (!room) {
    room = {};
    rooms.set(conversationId, room);
  }
  return room;
}

function broadcast(room, exclude, payload) {
  const msg = JSON.stringify(payload);
  if (room.human && room.human !== exclude) {
    if (room.human.readyState === 1) room.human.send(msg);
  }
  if (room.customer && room.customer !== exclude) {
    if (room.customer.readyState === 1) room.customer.send(msg);
  }
}

function leave(conversationId, ws) {
  const room = getRoom(conversationId);
  if (room.human === ws) room.human = undefined;
  if (room.customer === ws) room.customer = undefined;
  if (!room.human && !room.customer) rooms.delete(conversationId);
}

function base64UrlToBuffer(s) {
  let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Buffer.from(b, 'base64');
}

/**
 * @returns {{ conversationId: string, role: string } | null}
 */
function verifyVoiceJoinToken(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const data = `${h}.${p}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest();
  let sigBuf;
  try {
    sigBuf = base64UrlToBuffer(sig);
  } catch {
    return null;
  }
  if (sigBuf.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlToBuffer(p).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  if (payload.role !== 'human' && payload.role !== 'customer') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return { conversationId: payload.sub, role: payload.role };
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0] || '/';
  if (path === '/health' || path === '/health/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  if (path === '/' || path === '') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('converse-voice-signaling');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });

wss.on('connection', (ws) => {
  let conversationId = null;
  let role = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'join') {
        conversationId = data.conversationId;
        role = data.role;
        if (
          !conversationId ||
          typeof conversationId !== 'string' ||
          !UUID_RE.test(conversationId.trim())
        ) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid conversation' }));
          return;
        }
        conversationId = conversationId.trim();
        if (!role || !['human', 'customer'].includes(role)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid join' }));
          return;
        }
        if (JWT_SECRET) {
          const tok = data.token;
          if (!tok || typeof tok !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing join token' }));
            return;
          }
          const claims = verifyVoiceJoinToken(tok, JWT_SECRET);
          if (!claims || claims.conversationId !== conversationId || claims.role !== role) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
            return;
          }
        } else if (!ALLOW_INSECURE_NO_JWT) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message:
                'Signaling requires VOICE_SIGNALING_JWT_SECRET (set ALLOW_INSECURE_VOICE_SIGNALING=true for local dev only)',
            })
          );
          return;
        }
        const room = getRoom(conversationId);
        if (room[role]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Role already taken' }));
          return;
        }
        room[role] = ws;
        ws.conversationId = conversationId;
        ws.role = role;
        ws.send(JSON.stringify({ type: 'joined', conversationId, role }));
        if (room.human && room.customer) {
          room.human.send(JSON.stringify({ type: 'create-offer' }));
        }
        return;
      }

      if (!conversationId || !role) return;

      const room = getRoom(conversationId);
      const targetRole = role === 'human' ? 'customer' : 'human';
      const target = room[targetRole];
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({ ...data, from: role }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message || 'Invalid message' }));
    }
  });

  ws.on('close', () => {
    if (conversationId) leave(conversationId, ws);
  });

  ws.on('error', () => {
    if (conversationId) leave(conversationId, ws);
  });
});

server.listen(PORT, () => {
  console.log(`Voice signaling (HTTP + WebSocket) listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  if (JWT_SECRET) {
    console.log('Join auth: JWT enabled (VOICE_SIGNALING_JWT_SECRET)');
  } else if (ALLOW_INSECURE_NO_JWT) {
    console.warn('Join auth: INSECURE mode (ALLOW_INSECURE_VOICE_SIGNALING) — not for production');
  } else {
    console.warn('Join auth: disabled until VOICE_SIGNALING_JWT_SECRET is set');
  }
  console.log(`Set NEXT_PUBLIC_VOICE_SIGNALING_WS_URL to ws://localhost:${PORT} for dev, wss://your-host for prod`);
});

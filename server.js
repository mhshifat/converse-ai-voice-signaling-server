/**
 * WebRTC signaling server for live human voice handoff.
 * Run separately (e.g. Railway, Render, Fly.io). Clients connect with
 * conversationId + role ('human' | 'customer'); we relay offer/answer/ice.
 *
 * HTTP + WebSocket share one port (required by hosts like Render). GET /health
 * for platform health checks or external uptime pings (see README re: free tier).
 */
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3001;

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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let conversationId = null;
  let role = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'join') {
        conversationId = data.conversationId;
        role = data.role;
        if (!conversationId || !role || !['human', 'customer'].includes(role)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid join' }));
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
  console.log(`Set NEXT_PUBLIC_VOICE_SIGNALING_WS_URL to ws://localhost:${PORT} for dev, wss://your-host for prod`);
});

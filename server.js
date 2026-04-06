import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { runAgent } from './agent/index.js';
import { inventoryCache, CACHE_TTL_MS } from './agent/tools.js';

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TURNS = 20;
const PURGE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// { sessionId -> { lastResponseId, turnCount, lastActivity, createdAt, history[] } }
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, PURGE_INTERVAL_MS).unref();

app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function authenticate(req, res, next) {
  const authHeader = req.headers['x-api-token'];
  if (!authHeader || authHeader !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  const now = Date.now();
  const cacheEntries = [];

  for (const [key, { fetchedAt }] of inventoryCache) {
    const [caldate, todate] = key.split('|');
    const ageMs = now - fetchedAt;
    cacheEntries.push({
      caldate,
      todate,
      fetchedAt:        new Date(fetchedAt).toISOString(),
      ageSeconds:       Math.floor(ageMs / 1000),
      expiresInSeconds: Math.max(0, Math.floor((CACHE_TTL_MS - ageMs) / 1000)),
      expired:          ageMs >= CACHE_TTL_MS,
    });
  }

  res.json({
    ok:             true,
    activeSessions: sessions.size,
    inventoryCache: { ttlMinutes: CACHE_TTL_MS / 60_000, entries: cacheEntries },
  });
});

app.delete('/v1/cache/inventory', authenticate, (req, res) => {
  const cleared = inventoryCache.size;
  inventoryCache.clear();
  res.json({ ok: true, clearedEntries: cleared });
});

app.get('/v1/session/:sessionId', authenticate, (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }
  res.json({
    sessionId:    req.params.sessionId,
    createdAt:    new Date(session.createdAt).toISOString(),
    lastActivity: new Date(session.lastActivity).toISOString(),
    turnCount:    session.turnCount,
    history:      session.history,
  });
});

app.post('/v1/chat', authenticate, async (req, res) => {
  const { message, sessionId, checkIn, checkOut, guestName, microsite } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required and must be a string' });
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required and must be a string' });
  }

  const now = Date.now();
  let session = sessions.get(sessionId);

  if (session && now - session.lastActivity > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    session = null;
  }

  if (!session) {
    // Store guest context on session creation so it persists across turns
    const guestContext = {};
    if (guestName  && typeof guestName  === 'string') guestContext.guestName  = guestName;
    if (checkIn    && typeof checkIn    === 'string') guestContext.checkIn    = checkIn;
    if (checkOut   && typeof checkOut   === 'string') guestContext.checkOut   = checkOut;
    if (microsite  && typeof microsite  === 'string') guestContext.microsite  = microsite;

    session = {
      lastResponseId: undefined,
      turnCount:      0,
      lastActivity:   now,
      createdAt:      now,
      history:        [],
      guestContext,
    };
    sessions.set(sessionId, session);
  }

  if (session.turnCount >= MAX_TURNS) {
    return res.status(429).json({ error: 'Session turn limit reached. Start a new session.' });
  }

  try {
    const { output, responseId } = await runAgent(message, session.lastResponseId, session.guestContext);

    const timestamp = new Date().toISOString();
    session.history.push(
      { role: 'user',      content: message, timestamp },
      { role: 'assistant', content: output,  timestamp }
    );
    session.lastResponseId = responseId;
    session.turnCount += 1;
    session.lastActivity = Date.now();

    res.json({ reply: output, sessionId });
  } catch (err) {
    console.error('Agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

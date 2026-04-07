import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { runAgent } from './agent/index.js';
import { inventoryCache, CACHE_TTL_MS, findOfferingsByIds } from './agent/tools.js';

const app = express();
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

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

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowAnyOrigin = ALLOWED_ORIGINS.includes('*');
  const isAllowedOrigin = allowAnyOrigin || (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin));

  if (allowAnyOrigin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

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
    const [venueCode, caldate, todate] = key.split('|');
    const ageMs = now - fetchedAt;
    cacheEntries.push({
      venueCode,
      caldate,
      todate,
      fetchedAt:        new Date(fetchedAt).toISOString(),
      ageSeconds:       Math.floor(ageMs / 1000),
      expiresInSeconds: Math.max(0, Math.floor((CACHE_TTL_MS - ageMs) / 1000)),
      expired:          ageMs >= CACHE_TTL_MS,
    });
  }

  const activeSessions = [...sessions.entries()].map(([id, s]) => ({
    sessionId:        id,
    createdAt:        new Date(s.createdAt).toISOString(),
    lastActivity:     new Date(s.lastActivity).toISOString(),
    turnCount:        s.turnCount,
    fellowshipContext: !!s.guestContext?.fellowshipCode,
  }));

  res.json({
    ok:             true,
    activeSessions: sessions.size,
    features: {
      fellowshipContext: !!process.env.UV_SYSTEM_ID,
    },
    sessions:       activeSessions,
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
  const { message, sessionId, checkIn, checkOut, guestName, microsite, fellowshipCode } = req.body;

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
    if (guestName      && typeof guestName      === 'string') guestContext.guestName      = guestName;
    if (checkIn        && typeof checkIn        === 'string') guestContext.checkIn        = checkIn;
    if (checkOut       && typeof checkOut       === 'string') guestContext.checkOut       = checkOut;
    if (microsite      && typeof microsite      === 'string') guestContext.microsite      = microsite;
    if (fellowshipCode && typeof fellowshipCode === 'string') guestContext.fellowshipCode = fellowshipCode;

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

    // Resolve {{mastercode}} placeholders → <a> tags + collect full offering data
    const placeholderIds = [...output.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]);
    const referencedOfferings = findOfferingsByIds(placeholderIds);
    const offeringsMap = new Map(referencedOfferings.map((o) => [o.mastercode, o]));

    const reply = output.replace(/\{\{([^}]+)\}\}/g, (_, mastercode) => {
      const o = offeringsMap.get(mastercode);
      if (!o) return `{{${mastercode}}}`;
      const nodename = (o.name ?? '').replace(/"/g, '&quot;');
      return `<a class="uwsjs-inv-item-select uvjs-scenesliderclick" data-nodecode="${o.venueId ?? ""}" data-mastercode="${o.mastercode}" data-nodename="${nodename}" data-date="${o.date ?? ""}">View Event</a>`;
    });

    const timestamp = new Date().toISOString();
    session.history.push(
      { role: 'user',      content: message, timestamp },
      { role: 'assistant', content: reply,   timestamp }
    );
    session.lastResponseId = responseId;
    session.turnCount += 1;
    session.lastActivity = Date.now();

    res.json({ reply, items: referencedOfferings, sessionId });
  } catch (err) {
    console.error('Agent error:', err);

    const message = err?.message ?? '';

    if (err.name === 'AbortError' || message.includes('timed out') || message.includes('timeout')) {
      return res.status(504).json({ error: 'The request timed out. Please try again.' });
    }
    if (message.includes('rate limit') || message.includes('429')) {
      return res.status(429).json({ error: 'Too many requests to the AI provider. Please wait a moment and try again.' });
    }
    if (message.includes('401') || message.includes('invalid_api_key') || message.includes('Unauthorized')) {
      return res.status(502).json({ error: 'AI provider authentication failed. Check server configuration.' });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

import { tool } from '@openai/agents';
import { z } from 'zod/v3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  mapInventory,
  filterByDate,
  filterByTag,
  searchOfferings,
} from '../mappers/inventory.js';
import { mapUser } from '../mappers/user.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Inventory cache ──────────────────────────────────────────────────────────

export const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const inventoryCache = new Map(); // key: "caldate|todate" → { data, fetchedAt }

// ─── Inventory fetcher ────────────────────────────────────────────────────────
// Uses the real UrVenue API when env vars are set, otherwise falls back to the
// local example JSON so development works without credentials.

async function fetchInventory(caldate, todate) {
  const venueCode = process.env.UV_VENUE_CODE ?? 'local';
  const cacheKey = `${venueCode}|${caldate}|${todate}`;
  const cached = inventoryCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[UV-Bot] Cache HIT for ${cacheKey}`);
    return cached.data;
  }

  const apiKey   = process.env.UV_INVENTORY_API_KEY;
  const sourceLoc = process.env.UV_SOURCE_LOC;

  if (!apiKey || !sourceLoc || !venueCode) {
    console.warn('[UV-Bot] Inventory env vars not set — using local example JSON');
    const raw = JSON.parse(
      readFileSync(join(__dirname, '../data/example-inventory.json'), 'utf8')
    );
    const data = mapInventory(raw);
    inventoryCache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  }

  const url = new URL('https://api.urvenue.me/v1/gxn/inventory/json/');
  url.searchParams.set('apikey',        apiKey);
  url.searchParams.set('sourcecode',    process.env.UV_SOURCE_CODE ?? 'crossbook');
  url.searchParams.set('sourceloc',     sourceLoc);
  url.searchParams.set('appecozoneid',  '0');
  url.searchParams.set('venuecode',     venueCode);
  url.searchParams.set('caldate',       caldate);
  url.searchParams.set('todate',        todate);
  url.searchParams.set('filters',       'tree:tag');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`Inventory API responded with ${res.status} ${res.statusText}`);
  }

  const raw = await res.json();
  const data = mapInventory(raw);
  inventoryCache.set(cacheKey, { data, fetchedAt: Date.now() });
  console.log(`[UV-Bot] Cache SET for ${cacheKey}`);
  return data;
}

// ─── Fellowship fetcher ───────────────────────────────────────────────────────

async function fetchFellowship(fellowshipCode) {
  const apiKey   = process.env.UV_INVENTORY_API_KEY;
  const sourceLoc = process.env.UV_SOURCE_LOC;
  const systemId  = process.env.UV_SYSTEM_ID;

  if (!apiKey || !sourceLoc || !systemId) {
    console.warn('[UV-Bot] Fellowship env vars not set — using local example JSON');
    const raw = JSON.parse(
      readFileSync(join(__dirname, '../data/example-user.json'), 'utf8')
    );
    return mapUser(raw);
  }

  const url = new URL('https://api.urvenue.me/v1/fellowship/fellowship/json/');
  url.searchParams.set('apikey',        apiKey);
  url.searchParams.set('sourcecode',    process.env.UV_FELLOWSHIP_SOURCE_CODE ?? 'public');
  url.searchParams.set('sourceloc',     sourceLoc);
  url.searchParams.set('systemid',      systemId);
  url.searchParams.set('fellowshipcode', fellowshipCode);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`Fellowship API responded with ${res.status} ${res.statusText}`);
  }

  const raw = await res.json();
  return mapUser(raw);
}

// ─── Helper: trim offerings to a token-safe shape for the agent ──────────────

function toAgentOffering(o) {
  return {
    mastercode:    o.mastercode,
    venueName:     o.venueName,
    propertyName:  o.propertyName,
    category:      o.category,
    name:          o.name,
    highlight:     (o.highlight ?? o.description ?? '').slice(0, 180) || null,
    timeLabel:     o.timeLabel,
    pricingDisplay: o.pricingDisplay,
    tags:          o.tags,
  };
}

// ─── Tool 1: get_guest_context ────────────────────────────────────────────────
// Built dynamically per-session when a fellowshipCode is present.

function buildGetGuestContextTool(fellowshipCode) {
  return tool({
    name: 'get_guest_context',
    description:
      "Retrieves the current guest's profile and stay details: name, arrival/departure dates, room number, party members, property contact info, and experiences already booked. Call this at the start of the conversation to personalize suggestions.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const guest = await fetchFellowship(fellowshipCode);
        if (!guest) return { error: 'Guest data unavailable.' };
        return guest;
      } catch (err) {
        return { error: `Could not fetch guest context: ${err.message}` };
      }
    },
  });
}

// ─── Tool 2: search_experiences ───────────────────────────────────────────────
// caldate and todate are REQUIRED — the agent must collect these from the guest
// before calling this tool. The instructions enforce that conversation step.

export const searchExperiencesTool = tool({
  name: 'search_experiences',
  description:
    'Fetches available experiences and activities from the venue inventory for a specific date range, then filters by keyword and/or tag. ' +
    'IMPORTANT: you must have confirmed caldate and todate from the guest before calling this tool. ' +
    'Returns up to 8 bookable offerings, each with a unique mastercode to embed as {{mastercode}} in your response.',
  parameters: z.object({
    caldate: z
      .string()
      .describe('Start date in ISO format "YYYY-MM-DD". Must be confirmed with the guest first.'),
    todate: z
      .string()
      .describe('End date in ISO format "YYYY-MM-DD". Can equal caldate for a single day.'),
    keyword: z
      .string()
      .nullable()
      .describe('Interest keyword, e.g. "massage", "dinner", "ski", "spa". Pass null to browse all.'),
    tag: z
      .string()
      .nullable()
      .describe('Tag category to filter by, e.g. "Dining", "Most Popular". Pass null to skip.'),
  }),
  execute: async ({ caldate, todate, keyword, tag }) => {
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_RE.test(caldate) || !ISO_RE.test(todate)) {
      return { error: 'Invalid date format. Both caldate and todate must be in YYYY-MM-DD format.' };
    }
    if (caldate > todate) {
      return { error: `Invalid date range: caldate (${caldate}) must be on or before todate (${todate}).` };
    }

    let offerings;

    try {
      offerings = await fetchInventory(caldate, todate);
    } catch (err) {
      return { error: `Could not fetch inventory: ${err.message}` };
    }

    if (!offerings.length) {
      return { error: `No experiences found for ${caldate} – ${todate}.` };
    }

    // When the API returns data for a range, filter down to the requested dates
    const inRange = offerings.filter(
      (o) => o.date >= caldate && o.date <= todate
    );
    let results = inRange.length ? inRange : offerings;

    if (tag)     results = filterByTag(results, tag);
    if (keyword) results = searchOfferings(results, keyword);

    if (!results.length) {
      return {
        message: `No experiences matched "${keyword ?? tag}" for ${caldate} – ${todate}.`,
        tip: 'Try a broader keyword or remove filters.',
      };
    }

    return {
      dateRange:  { from: caldate, to: todate },
      totalFound: results.length,
      showing:    Math.min(results.length, 8),
      results:    results.slice(0, 8).map(toAgentOffering),
    };
  },
});

/**
 * Finds full offerings from the inventory cache by their mastercodes.
 * Used after agent responds to resolve {{mastercode}} placeholders.
 * @param {string[]} mastercodes
 * @returns {import('../mappers/inventory.js').Offering[]}
 */
export function findOfferingsByIds(mastercodes) {
  if (!mastercodes.length) return [];
  const idSet = new Set(mastercodes);
  const found = new Map();
  for (const { data } of inventoryCache.values()) {
    for (const offering of data) {
      if (idSet.has(offering.mastercode) && !found.has(offering.mastercode)) {
        found.set(offering.mastercode, offering);
      }
    }
  }
  return mastercodes.map((id) => found.get(id)).filter(Boolean);
}

/**
 * Builds the tool list for a session.
 * get_guest_context is only included when a fellowshipCode is available.
 * @param {{ fellowshipCode?: string }} guestContext
 */
export function buildTools(guestContext = {}) {
  const tools = [searchExperiencesTool];
  if (guestContext.fellowshipCode) {
    tools.push(buildGetGuestContextTool(guestContext.fellowshipCode));
  }
  return tools;
}

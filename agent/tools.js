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
export const inventoryCache = new Map(); // key: "MIC{microcode}|caldate|todate" → { data, fetchedAt }

// ─── Inventory fetcher ────────────────────────────────────────────────────────
// When a microcode is provided the URL is built dynamically:
//   host       → https://${UV_ENVICODE}.urvenue.me
//   venuecode  → MIC${microcode}
// Falls back to static env vars (UV_VENUE_CODE) when no microcode is given,
// or to the local example JSON when API credentials are not configured.

async function fetchInventory(caldate, todate, microcode) {
  const venueCode = `MIC${microcode}`;
  const cacheKey  = `${venueCode}|${caldate}|${todate}`;
  const cached    = inventoryCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[UV-Bot] Cache HIT for ${cacheKey}`);
    return cached.data;
  }

  const apiKey = process.env.UV_INVENTORY_API_KEY;

  if (!apiKey) {
    console.warn('[UV-Bot] UV_INVENTORY_API_KEY not set — using local example JSON');
    const raw  = JSON.parse(
      readFileSync(join(__dirname, '../data/example-inventory.json'), 'utf8')
    );
    const data = mapInventory(raw);
    inventoryCache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  }

  const url = new URL('https://api.urvenue.me/v1/gxn/inventory/json/');
  url.searchParams.set('apikey',       apiKey);
  url.searchParams.set('sourcecode',   process.env.UV_SOURCE_CODE ?? 'crossbook');
  url.searchParams.set('sourceloc',    microcode);
  url.searchParams.set('appecozoneid', '0');
  url.searchParams.set('venuecode',    venueCode);
  url.searchParams.set('caldate',      caldate);
  url.searchParams.set('todate',       todate);
  url.searchParams.set('filters',      'tree:tag');

  // Log the full URL (apikey redacted) so we can verify params in Vercel logs
  const loggableUrl = url.toString().replace(apiKey, '***');
  console.log(`[UV-Bot] Inventory request: GET ${loggableUrl}`);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12_000),
  });

  console.log(`[UV-Bot] Inventory response: HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    console.error(`[UV-Bot] Inventory API error body: ${body.slice(0, 500)}`);
    throw new Error(`Inventory API responded with ${res.status} ${res.statusText}`);
  }

  const raw  = await res.json();

  // Log top-level keys to diagnose unexpected response shapes
  const topKeys = Object.keys(raw?.uv?.data ?? raw ?? {});
  console.log(`[UV-Bot] Inventory raw top-level keys: ${topKeys.join(', ') || '(none)'}`);

  const data = mapInventory(raw);
  console.log(`[UV-Bot] Inventory mapped offerings: ${data.length}`);

  inventoryCache.set(cacheKey, { data, fetchedAt: Date.now() });
  console.log(`[UV-Bot] Cache SET for ${cacheKey}`);
  return data;
}

// ─── Fellowship fetcher ───────────────────────────────────────────────────────

async function fetchFellowship(fellowshipCode, microcode) {
  const apiKey   = process.env.UV_INVENTORY_API_KEY;
  const systemId = process.env.UV_SYSTEM_ID;

  if (!apiKey || !systemId) {
    console.warn('[UV-Bot] Fellowship env vars not set — using local example JSON');
    const raw = JSON.parse(
      readFileSync(join(__dirname, '../data/example-user.json'), 'utf8')
    );
    return mapUser(raw);
  }

  const url = new URL('https://api.urvenue.me/v1/fellowship/fellowship/json/');
  url.searchParams.set('apikey',         apiKey);
  url.searchParams.set('sourcecode',     process.env.UV_FELLOWSHIP_SOURCE_CODE ?? 'public');
  url.searchParams.set('sourceloc',      microcode);
  url.searchParams.set('systemid',       systemId);
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
    mastercode:     o.mastercode,
    venueName:      o.venueName,
    propertyName:   o.propertyName,
    category:       o.category,
    name:           o.name,
    highlight:      (o.highlight ?? o.description ?? '').slice(0, 180) || null,
    timeLabel:      o.timeLabel,
    pricingDisplay: o.pricingDisplay,
    tags:           o.tags,
  };
}

// ─── Tool 1: get_guest_context ────────────────────────────────────────────────
// Built dynamically per-session when a fellowshipCode is present.

function buildGetGuestContextTool(fellowshipCode, microcode) {
  return tool({
    name: 'get_guest_context',
    description:
      "Retrieves the current guest's profile and stay details: name, arrival/departure dates, room number, party members, property contact info, and experiences already booked. Call this at the start of the conversation to personalize suggestions. Once called, use the returned arrivalDate and departureDate directly as the date range for search_experiences — do NOT ask the guest for dates again.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const guest = await fetchFellowship(fellowshipCode, microcode);
        if (!guest) return { error: 'Guest data unavailable.' };
        return guest;
      } catch (err) {
        return { error: `Could not fetch guest context: ${err.message}` };
      }
    },
  });
}

// ─── Tool 2: validate_date ────────────────────────────────────────────────────
// Checks whether a date is today or in the future. The agent should call this
// whenever the guest manually provides a date before using it in search_experiences.

const validateDateTool = tool({
  name: 'validate_date',
  description:
    'Checks whether a date is today or in the future (not already in the past). ' +
    'Call this when the guest manually provides a date to confirm it is valid before calling search_experiences. ' +
    'If the date is in the past, ask the guest for an upcoming date instead.',
  parameters: z.object({
    date: z.string().describe('Date to validate in YYYY-MM-DD format.'),
  }),
  execute: async ({ date }) => {
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_RE.test(date)) {
      return { valid: false, reason: 'Invalid format. Expected YYYY-MM-DD.' };
    }
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return {
        valid:  false,
        isPast: true,
        today,
        reason: `${date} has already passed (today is ${today}). Ask the guest for an upcoming date.`,
      };
    }
    return { valid: true, isPast: false, isToday: date === today, today };
  },
});

// ─── Tool 3: search_experiences ───────────────────────────────────────────────
// microcode is captured in the closure at session-creation time and used to
// build the correct MIC-prefixed venuecode for the inventory API call.
// When a fellowshipCode is present the agent should use arrivalDate/departureDate
// from get_guest_context directly instead of asking the guest for dates.

function buildSearchExperiencesTool(microcode) {
  return tool({
    name: 'search_experiences',
    description:
      'Fetches available experiences and activities from the venue inventory for a specific date range, then filters by keyword and/or tag. ' +
      'If get_guest_context was already called, use its arrivalDate/departureDate as caldate/todate without asking the guest. ' +
      'Otherwise, validate manually-provided dates with validate_date first. ' +
      'Returns up to 8 bookable offerings, each with a unique mastercode to embed as {{mastercode}} in your response.',
    parameters: z.object({
      caldate: z
        .string()
        .describe('Start date in ISO format "YYYY-MM-DD".'),
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
      console.log(`[UV-Bot] search_experiences called — microcode:${microcode} caldate:${caldate} todate:${todate} keyword:${keyword} tag:${tag}`);

      const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (!ISO_RE.test(caldate) || !ISO_RE.test(todate)) {
        return { error: 'Invalid date format. Both caldate and todate must be in YYYY-MM-DD format.' };
      }
      if (caldate > todate) {
        return { error: `Invalid date range: caldate (${caldate}) must be on or before todate (${todate}).` };
      }

      // Reject searches entirely in the past
      const today = new Date().toISOString().split('T')[0];
      if (todate < today) {
        console.warn(`[UV-Bot] search_experiences rejected — date range in the past (todate:${todate} today:${today})`);
        return {
          error: `The requested date range (${caldate} – ${todate}) is in the past. Ask the guest for upcoming dates.`,
        };
      }

      let offerings;

      try {
        offerings = await fetchInventory(caldate, todate, microcode);
      } catch (err) {
        console.error(`[UV-Bot] search_experiences fetchInventory threw: ${err.message}`);
        return { error: `Could not fetch inventory: ${err.message}` };
      }

      if (!offerings.length) {
        console.warn(`[UV-Bot] search_experiences — mapInventory returned 0 offerings for ${caldate}–${todate}`);
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
}

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
 * - search_experiences captures microcode in a closure to build MIC-prefixed
 *   venuecodes when calling the inventory API.
 * - get_guest_context is only included when a fellowshipCode is available.
 * - validate_date is always included.
 * @param {{ fellowshipCode?: string, microsite?: string }} guestContext
 */
export function buildTools(guestContext = {}) {
  const microcode = guestContext.microsite ?? null;

  const tools = [buildSearchExperiencesTool(microcode), validateDateTool];
  if (guestContext.fellowshipCode) {
    tools.push(buildGetGuestContextTool(guestContext.fellowshipCode, microcode));
  }
  return tools;
}

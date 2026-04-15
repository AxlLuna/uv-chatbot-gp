import { tool } from '@openai/agents';
import { z } from 'zod/v3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  mapInventory,
  filterByTag,
  searchOfferings,
} from '../mappers/inventory.js';
import { mapUser } from '../mappers/user.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Inventory cache ──────────────────────────────────────────────────────────

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const inventoryCache = new Map(); // key: "{microcode}|YYYY-MM-DD" → { data, fetchedAt }

// ─── Date range helper ────────────────────────────────────────────────────────

/**
 * Returns every ISO date string between from and to, inclusive.
 * @param {string} from  "YYYY-MM-DD"
 * @param {string} to    "YYYY-MM-DD"
 * @returns {string[]}
 */
function datesInRange(from, to) {
  const dates = [];
  const end   = new Date(to   + 'T00:00:00Z');
  for (
    let d = new Date(from + 'T00:00:00Z');
    d <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ─── Inventory fetcher (per-day) ──────────────────────────────────────────────
// One call per date. Cache key: "{microcode}|YYYY-MM-DD", TTL 1 hour.
// venuecode → MIC${microcode}, sourceloc → microcode.

async function fetchInventory(date, microcode) {
  const cacheKey = `${microcode}|${date}`;
  const cached   = inventoryCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[UV-Bot] Cache HIT for ${cacheKey}`);
    return cached.data;
  }

  const apiKey    = process.env.UV_INVENTORY_API_KEY;
  const venueCode = `MIC${microcode}`;

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
  url.searchParams.set('caldate',      date);
  url.searchParams.set('todate',       date);
  url.searchParams.set('filters',      'tree:tag');

  // Log full URL (apikey redacted) so Vercel logs show exactly what was called
  const loggableUrl = url.toString().replace(apiKey, '***');
  console.log(`[UV-Bot] Inventory request: GET ${loggableUrl}`);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(12_000),
  });

  console.log(`[UV-Bot] Inventory response ${date}: HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    console.error(`[UV-Bot] Inventory API error body (${date}): ${body.slice(0, 500)}`);
    throw new Error(`Inventory API responded with ${res.status} ${res.statusText}`);
  }

  const raw      = await res.json();
  const topKeys  = Object.keys(raw?.uv?.data ?? raw ?? {});
  console.log(`[UV-Bot] Inventory raw top-level keys (${date}): ${topKeys.join(', ') || '(none)'}`);

  const data = mapInventory(raw);
  console.log(`[UV-Bot] Inventory mapped offerings (${date}): ${data.length}`);

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
    date:           o.date,
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
// Fetches one API call per day in the requested range (in parallel), then
// aggregates. Each offering carries its own `date` field so the agent can
// present events in the correct day without mixing them up.

function buildSearchExperiencesTool(microcode) {
  return tool({
    name: 'search_experiences',
    description:
      'Fetches available experiences for each day in the requested date range (one API call per day, run in parallel) and returns the aggregated results filtered by keyword and/or tag. ' +
      'Each result includes a `date` field — always attribute events to their correct day and never mix events from different days. ' +
      'If get_guest_context was already called, use its arrivalDate/departureDate as caldate/todate without asking the guest. ' +
      'Otherwise validate manually-provided dates with validate_date first. ' +
      'Returns up to 8 bookable offerings per call, each with a mastercode to embed as {{mastercode}} in your response.',
    parameters: z.object({
      caldate: z
        .string()
        .describe('Start date in ISO format "YYYY-MM-DD".'),
      todate: z
        .string()
        .describe('End date in ISO format "YYYY-MM-DD". Set equal to caldate to search a single day.'),
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

      const today = new Date().toISOString().split('T')[0];
      if (todate < today) {
        console.warn(`[UV-Bot] search_experiences rejected — date range in the past (todate:${todate} today:${today})`);
        return {
          error: `The requested date range (${caldate} – ${todate}) is in the past. Ask the guest for upcoming dates.`,
        };
      }

      // Fetch each day in parallel — one cached API call per day
      const days = datesInRange(caldate, todate);
      console.log(`[UV-Bot] Fetching ${days.length} day(s): ${days.join(', ')}`);

      let perDay;
      try {
        perDay = await Promise.all(days.map((d) => fetchInventory(d, microcode)));
      } catch (err) {
        console.error(`[UV-Bot] search_experiences fetchInventory threw: ${err.message}`);
        return { error: `Could not fetch inventory: ${err.message}` };
      }

      let results = perDay.flat();

      if (!results.length) {
        console.warn(`[UV-Bot] search_experiences — 0 offerings total for ${caldate}–${todate}`);
        return { error: `No experiences found for ${caldate} – ${todate}.` };
      }

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
 * Used after the agent responds to resolve {{mastercode}} placeholders.
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

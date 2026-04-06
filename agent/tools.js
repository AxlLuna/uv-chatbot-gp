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
  const cacheKey = `${caldate}|${todate}`;
  const cached = inventoryCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`[UV-Bot] Cache HIT for ${cacheKey}`);
    return cached.data;
  }
  const apiKey   = process.env.UV_INVENTORY_API_KEY;
  const sourceLoc = process.env.UV_SOURCE_LOC;
  const venueCode = process.env.UV_VENUE_CODE;

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

// ─── Guest loader (local JSON for now) ───────────────────────────────────────

function loadGuest() {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '../data/example-user.json'), 'utf8')
  );
  return mapUser(raw);
}

// ─── Helper: trim offerings to a token-safe shape for the agent ──────────────

function toAgentOffering(o) {
  return {
    itemId:        o.itemId,
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

export const getGuestContextTool = tool({
  name: 'get_guest_context',
  description:
    "Retrieves the current guest's profile and stay details: name, arrival/departure dates, room number, party members, property contact info, and experiences already booked. Call this at the start of the conversation to personalize suggestions.",
  parameters: z.object({}),
  execute: async () => {
    const guest = loadGuest();
    if (!guest) return { error: 'Guest data unavailable.' };
    return guest;
  },
});

// ─── Tool 2: search_experiences ───────────────────────────────────────────────
// caldate and todate are REQUIRED — the agent must collect these from the guest
// before calling this tool. The instructions enforce that conversation step.

export const searchExperiencesTool = tool({
  name: 'search_experiences',
  description:
    'Fetches available experiences and activities from the venue inventory for a specific date range, then filters by keyword and/or tag. ' +
    'IMPORTANT: you must have confirmed caldate and todate from the guest before calling this tool. ' +
    'Returns up to 8 bookable offerings, each with a unique itemId to embed as {{itemId}} in your response.',
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
    console.log(`[search_experiences] caldate=${caldate} todate=${todate} keyword=${keyword} tag=${tag}`);
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

// getGuestContextTool is disabled for now — focusing on inventory only
export const allTools = [searchExperiencesTool];

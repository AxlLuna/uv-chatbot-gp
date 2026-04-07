/**
 * inventory-mapper.js
 *
 * Transforms the raw UrVenue inventory API response into a flat, token-efficient
 * array of offerings that UV-Bot can reason about and reference via {{mastercode}}.
 *
 * ─── RAW API — TWO KNOWN SHAPES ─────────────────────────────────────────────
 *
 * Shape A (example-api-response.json) — no `items` or `tags` sections:
 *   uv.data.inventory.[dateKey].venues.[venueId].ecolist  ← primary source
 *   uv.data.inventory.[dateKey].venues.[venueId].masterlist
 *
 * Shape B (example2-api-response.json) — richer, preferred:
 *   uv.data.inventory.[dateKey].items.[mastercode]        ← primary source
 *   uv.data.inventory.[dateKey].tags.nodes[]              ← venue names
 *   uv.data.header.tags.[tagId].label                     ← tag labels
 *
 * ─── MAPPED OFFERING SHAPE ───────────────────────────────────────────────────
 * {
 *   mastercode      string   UrVenue mastercode  →  used as {{mastercode}} and data-mastercode
 *   venueId         string   VEN code
 *   venueName       string|null  human name  e.g. "Lakeview Lounge"
 *   propertyName    string|null  parent property  e.g. "Fairmont Chateau Lake Louise"
 *   date            string   ISO "YYYY-MM-DD"
 *   category        string|null  broad type e.g. "Dining Reservations"
 *   name            string|null  specific offering  e.g. "Lakeview - Lunch & Dinner"
 *   description     string|null  full marketing description
 *   highlight       string|null  one-liner teaser
 *   timeLabel       string|null  "Available from 11:00am to 3:45pm"
 *   startTime       string|null  24h "HH:MM"
 *   endTime         string|null  24h "HH:MM"
 *   pricingDisplay  string|null  "Reservation" | "$25" | etc.
 *   payType         string|null  "reserve" | "pay"
 *   tags            string[]     e.g. ["Dining", "Most Popular"]
 * }
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * "D260403" → "2026-04-03"
 */
function dateKeyToISO(dateKey) {
  const raw = dateKey.slice(1); // strip leading "D" → "260403"
  return `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
}

/**
 * Raw time like "11730" → "17:30"  |  "10700" → "07:00"  |  "0" → null
 * The API prefixes all HHMM values with a leading "1".
 */
function parseRawTime(raw) {
  if (!raw || raw === '0' || raw === 0) return null;
  const hhmm = String(raw).slice(1).padStart(4, '0'); // strip leading "1"
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

// ─── Venue name lookup from tags.nodes ───────────────────────────────────────

/**
 * Builds a Map<venueId, { venueName, propertyName }> from the tags.nodes tree.
 */
function buildVenueNameMap(tagsNodes = []) {
  const map = new Map();

  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.nodetype === 'Venue' && node.nodecode) {
        map.set(node.nodecode, {
          venueName: node.label ?? null,
          propertyName: node.highlight ?? null,
        });
      }
      if (Array.isArray(node.nodes)) walk(node.nodes);
    }
  }

  walk(tagsNodes);
  return map;
}

/**
 * Builds a Map<tagId (numeric string), label> from header.tags.
 */
function buildTagLabelMap(headerTags = {}) {
  const map = new Map();
  for (const [tagCode, tagData] of Object.entries(headerTags)) {
    // tagCode is like "TAG3025494877", tagIds in items are "3025494877"
    const numericId = tagCode.replace(/^TAG/, '');
    map.set(numericId, tagData.label ?? tagCode);
  }
  return map;
}

// ─── Shape B — use `items` section (richer) ──────────────────────────────────

function mapFromItems(dateKey, dateData, venueNameMap, tagLabelMap) {
  const date = dateKeyToISO(dateKey);
  const items = dateData?.items ?? {};
  const offerings = [];

  for (const [rawKey, item] of Object.entries(items)) {
    if (item.inactive === '1' || item.state === 'off') continue;

    const venueId = item.venuecode ?? null;
    const venueInfo = venueId ? (venueNameMap.get(venueId) ?? {}) : {};

    const rawTagIds = item.tagids ?? [];
    const tags = rawTagIds
      .map((id) => tagLabelMap.get(String(id)))
      .filter(Boolean);

    offerings.push({
      mastercode: item.mastercode ?? rawKey,
      venueId,
      venueName: venueInfo.venueName ?? null,
      propertyName: venueInfo.propertyName ?? null,
      date,
      category: item.booktypename ?? null,
      name: item.itemname ?? item.mastername ?? null,
      description: item.descr ?? null,
      highlight: item.highlight || item.masterhighlight || null,
      timeLabel: item.timelabel ?? null,
      startTime: parseRawTime(item.starttime),
      endTime: parseRawTime(item.endtime),
      pricingDisplay: item.pricingdisplay ?? null,
      payType: item.paytype ?? null,
      tags,
    });
  }

  return offerings;
}

// ─── Shape A — fallback via ecolist/masterlist ────────────────────────────────

function mapFromEcolist(dateKey, dateData, venueNameMap) {
  const date = dateKeyToISO(dateKey);
  const venues = dateData?.venues ?? {};
  const offerings = [];

  for (const [venueId, venueData] of Object.entries(venues)) {
    const ecolist = venueData?.ecolist ?? [];
    const masterlist = venueData?.masterlist ?? {};
    const venueInfo = venueNameMap.get(venueId) ?? {};

    for (const ecoBlock of ecolist) {
      const booktype = ecoBlock?.booktype ?? {};
      const ecomasters = ecoBlock?.ecomasters ?? {};

      for (const [masId, masRef] of Object.entries(ecomasters)) {
        const master = masterlist[masId] ?? {};
        const ecoitems = masRef?.ecoitems ?? {};

        for (const [, mastercode] of Object.entries(ecoitems)) {
          offerings.push({
            mastercode,
            venueId,
            venueName: venueInfo.venueName ?? null,
            propertyName: venueInfo.propertyName ?? null,
            date,
            category: booktype.label ?? null,
            name: master.mastername ?? null,
            description: booktype.descr || null,
            highlight: master.masterhighlight || null,
            timeLabel: null,
            startTime: null,
            endTime: null,
            pricingDisplay: null,
            payType: null,
            tags: [],
          });
        }
      }
    }
  }

  return offerings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Transforms a raw UrVenue inventory API response into a flat array of offerings.
 * Handles both Shape A (ecolist only) and Shape B (items + tags).
 *
 * @param {object} rawResponse
 * @returns {Offering[]}
 */
export function mapInventory(rawResponse) {
  const data = rawResponse?.uv?.data;
  if (!data) return [];

  const headerTags = data.header?.tags ?? {};
  const tagLabelMap = buildTagLabelMap(headerTags);
  const inventory = data.inventory ?? {};
  const offerings = [];

  for (const [dateKey, dateData] of Object.entries(inventory)) {
    // Build venue name map from this date's tags.nodes tree (Shape B)
    const tagsNodes = dateData?.tags?.nodes ?? [];
    const venueNameMap = buildVenueNameMap(tagsNodes);

    const hasItems = dateData?.items && Object.keys(dateData.items).length > 0;

    if (hasItems) {
      offerings.push(...mapFromItems(dateKey, dateData, venueNameMap, tagLabelMap));
    } else {
      offerings.push(...mapFromEcolist(dateKey, dateData, venueNameMap));
    }
  }

  return offerings;
}

/**
 * Filter by ISO date.
 * @param {Offering[]} offerings
 * @param {string} date  "YYYY-MM-DD"
 */
export function filterByDate(offerings, date) {
  return offerings.filter((o) => o.date === date);
}

/**
 * Filter by venue ID.
 * @param {Offering[]} offerings
 * @param {string} venueId
 */
export function filterByVenue(offerings, venueId) {
  return offerings.filter((o) => o.venueId === venueId);
}

/**
 * Filter by tag label (case-insensitive).
 * @param {Offering[]} offerings
 * @param {string} tag  e.g. "Dining"
 */
export function filterByTag(offerings, tag) {
  const t = tag.toLowerCase();
  return offerings.filter((o) => o.tags.some((tg) => tg.toLowerCase().includes(t)));
}

/**
 * Keyword search across name, description, highlight, category, venueName.
 * @param {Offering[]} offerings
 * @param {string} keyword
 */
export function searchOfferings(offerings, keyword) {
  const kw = keyword.toLowerCase();
  return offerings.filter((o) =>
    [o.name, o.description, o.highlight, o.category, o.venueName]
      .filter(Boolean)
      .some((f) => f.toLowerCase().includes(kw))
  );
}

/**
 * inventory-mapper.js
 *
 * Transforms the raw UrVenue inventory API response into a flat array of offerings.
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
 *   pic             string|null  image URL for the offering
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

/**
 * Fix pic URLs that are missing the host (e.g. "https:///imateq/..." → "https://api.urvenue.me/imateq/...").
 */
function normalisePic(pic) {
  if (!pic) return null;
  return pic.replace(/^https?:\/\/\//, 'https://api.urvenue.me/');
}

/**
 * Normalise tagids to a string array regardless of API shape.
 * The live API returns tagids as string[] but some items send "" or an object.
 */
function normaliseTagIds(tagids) {
  if (Array.isArray(tagids)) return tagids;
  if (tagids && typeof tagids === 'object') return Object.keys(tagids);
  return [];
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

    const tags = normaliseTagIds(item.tagids)
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
      pic: normalisePic(item.itempic),
      tags,
    });
  }

  return offerings;
}

// ─── Shape A / Hybrid — ecolist + top-level items ────────────────────────────
// itemsById: Map<mastercode, item> built from data.items (top-level)

function mapFromEcolist(dateKey, dateData, venueNameMap, tagLabelMap, itemsById) {
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
          // Enrich with rich item data from data.items if available
          const item = itemsById?.get(mastercode) ?? {};

          const tags = normaliseTagIds(item.tagids)
            .map((id) => tagLabelMap.get(String(id)))
            .filter(Boolean);

          const resolvedVenueId = item.venuecode ?? venueId;
          const resolvedVenueInfo = venueNameMap.get(resolvedVenueId) ?? venueInfo;

          offerings.push({
            mastercode,
            venueId:        resolvedVenueId,
            venueName:      resolvedVenueInfo.venueName ?? venueInfo.venueName ?? null,
            propertyName:   resolvedVenueInfo.propertyName ?? venueInfo.propertyName ?? null,
            date,
            category:       item.booktypename ?? booktype.label ?? null,
            name:           item.itemname ?? item.mastername ?? master.mastername ?? null,
            description:    item.descr ?? booktype.descr ?? null,
            highlight:      item.highlight ?? item.masterhighlight ?? master.masterhighlight ?? null,
            timeLabel:      item.timelabel ?? null,
            startTime:      parseRawTime(item.starttime),
            endTime:        parseRawTime(item.endtime),
            pricingDisplay: item.pricingdisplay ?? null,
            payType:        item.paytype ?? null,
            pic:            item.itempic ?? null,
            tags,
          });
        }
      }
    }
  }

  return offerings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {object} rawResponse
 * @returns {object[]}
 */
export function mapInventory(rawResponse) {
  const data = rawResponse?.uv?.data;
  if (!data) return [];

  const headerTags = data.header?.tags ?? {};
  const tagLabelMap = buildTagLabelMap(headerTags);

  // Build a top-level mastercode → item lookup from data.items (hybrid API shape)
  const itemsById = new Map(Object.entries(data.items ?? {}));

  const inventory = data.inventory ?? {};
  const offerings = [];

  for (const [dateKey, dateData] of Object.entries(inventory)) {
    // Build venue name map from this date's tags.nodes tree (Shape B / Hybrid)
    const tagsNodes = dateData?.tags?.nodes ?? [];
    const venueNameMap = buildVenueNameMap(tagsNodes);

    // Shape B: rich items nested inside the date key
    const hasDateItems = dateData?.items && Object.keys(dateData.items).length > 0;

    if (hasDateItems) {
      offerings.push(...mapFromItems(dateKey, dateData, venueNameMap, tagLabelMap));
    } else {
      // Shape A / Hybrid: ecolist for date structure, itemsById for rich details
      offerings.push(...mapFromEcolist(dateKey, dateData, venueNameMap, tagLabelMap, itemsById));
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

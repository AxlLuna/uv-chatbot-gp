/**
 * user-mapper.js
 *
 * Transforms the raw UrVenue fellowship/user API response into a lean object
 * with only the fields UV-Bot needs to personalize suggestions and understand
 * the guest's stay context.
 *
 * ─── WHAT WE KEEP ────────────────────────────────────────────────────────────
 *
 * Guest identity   firstName, lastName, email, phone
 * Stay window      arrivalDate, departureDate
 * Room             roomNumber (from fellowcodes leader)
 * Party            partySize, partyMembers[{ firstName, lastName }]
 * Property info    address, contactPhone, contactEmail  (from resources.extra)
 * Existing plans   existingItinerary[{ date, venueName, itemName, time,
 *                                       durationMinutes, partyNames, payType }]
 * Reference        confCode (confirmation code shown to guest)
 *
 * ─── WHAT WE DROP ────────────────────────────────────────────────────────────
 * - All internal codes (fellowcode, bookcode, partycode, cartcode, ordercode…)
 * - Financial totals and payment statuses
 * - Scan/checkin fields (scanmax, scantstamp, applewalleturl…)
 * - Legal terms text (too long, not useful for suggestions)
 * - itinerary_by_party (duplicate of itinerary)
 * - itinerary_date_totals (financial)
 * - Logo / background / icon / PDF resources
 * - Color codes, isleader, emailnotify, phonenotify flags
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * "20260130" → "2026-01-30"
 */
function itineraryDateToISO(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * "10915" → "09:15"  |  "0" / falsy → null
 * Same leading-"1" convention as the inventory API.
 */
function parseShiftTime(raw) {
  if (!raw || raw === '0' || raw === 0) return null;
  const hhmm = String(raw).slice(1).padStart(4, '0');
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Transforms the raw fellowship API response into a lean guest context object.
 *
 * @param {object} rawResponse   Full parsed JSON from the fellowship endpoint.
 * @returns {GuestContext | null}
 */
export function mapUser(rawResponse) {
  const data = rawResponse?.uv?.data;
  if (!data) return null;

  // ── Identity ──────────────────────────────────────────────────────────────
  const firstName = data.firstname ?? null;
  const lastName = data.lastname ?? null;
  const email = data.email ?? null;
  const phone = data.phone?.replace(/^\[US\]/, '') ?? null; // strip "[US]" prefix

  // ── Stay ──────────────────────────────────────────────────────────────────
  const arrivalDate = data.arrivaldate ?? null;
  const departureDate = data.departuredate ?? null;

  // ── Party ─────────────────────────────────────────────────────────────────
  const fellowcodes = data.fellowcodes ?? {};
  const partySize = data.fellows ?? Object.keys(fellowcodes).length;

  const partyMembers = Object.values(fellowcodes).map((f) => ({
    firstName: f.firstname ?? null,
    lastName: f.lastname ?? null,
  }));

  // Room number from the leader fellow (isleader === "1"), fallback to first
  const leaderFellow =
    Object.values(fellowcodes).find((f) => f.isleader === '1') ??
    Object.values(fellowcodes)[0];
  const roomNumber = leaderFellow?.roomnumber ?? null;

  // ── Property info ─────────────────────────────────────────────────────────
  const extra = data.resources?.extra ?? {};
  const propertyAddress = extra.address ?? null;
  const propertyContactPhone = extra.contactinfo ?? null;
  const propertyContactEmail = extra.contactemailaddress ?? null;

  // ── Existing itinerary ────────────────────────────────────────────────────
  const rawItinerary = data.itinerary ?? {};
  const existingItinerary = [];

  for (const [dateKey, bookings] of Object.entries(rawItinerary)) {
    const date = itineraryDateToISO(dateKey);

    for (const booking of bookings) {
      existingItinerary.push({
        date,
        venueName: booking.venuename ?? null,
        itemName: booking.itemname ?? null,
        time: parseShiftTime(booking.starttime ?? booking.time),
        durationMinutes: booking.duration ? Number(booking.duration) : null,
        partyNames: booking.fellownames ?? [],
        payType: booking.paytype ?? null,
      });
    }
  }

  // Sort chronologically
  existingItinerary.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : (a.time ?? '').localeCompare(b.time ?? '');
  });

  // ── Confirmation code ─────────────────────────────────────────────────────
  const confCode = data.confcode ?? null;

  return {
    firstName,
    lastName,
    email,
    phone,
    roomNumber,
    arrivalDate,
    departureDate,
    partySize,
    partyMembers,
    propertyAddress,
    propertyContactPhone,
    propertyContactEmail,
    confCode,
    existingItinerary,
  };
}

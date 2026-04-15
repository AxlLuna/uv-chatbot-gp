# UV-Bot — UrVenue AI Concierge Chatbot

A conversational AI concierge backend built for **UrVenue**, a hospitality technology platform. UV-Bot helps venue guests discover and plan experiences (dining, pools, nightlife, spas, etc.) by searching the venue's live inventory and returning rich event card references.

## Overview

UV-Bot is a REST API service that wraps an OpenAI agent (`gpt-4.1`) with custom tools and instructions tuned for the hospitality domain. Guests interact with it via a simple chat endpoint; the bot collects the desired dates, queries the UrVenue inventory API, and responds with inline `<a>` tags ready for the UrVenue JS plugin, plus an `items` array containing the full offering data so the frontend can render cards without additional API calls.

The bot is **multi-venue**: the `microsite` field sent on every request determines which venue's inventory is queried. No server restart or config change is needed to serve a different property.

## Architecture

```
server.js          ← Express HTTP server, session management, auth, rate limiting
agent/
  index.js         ← Creates the OpenAI Agent and runs it per request
  instructions.js  ← System prompt: UV-Bot persona, scope, and behavior rules
  tools.js         ← Tool definitions (search_experiences, validate_date, get_guest_context)
mappers/
  inventory.js     ← Transforms raw UrVenue inventory API response into flat offerings
  user.js          ← Transforms raw UrVenue fellowship API response into guest context
data/
  example-inventory.json   ← Local fallback inventory (used when UV_INVENTORY_API_KEY is not set)
  example-user.json        ← Local fallback guest profile
```

## API Endpoints

### `GET /health`
Returns server status, active sessions, and inventory cache state. No authentication required.

```json
{
  "ok": true,
  "activeSessions": 2,
  "features": {
    "fellowshipContext": true
  },
  "sessions": [
    {
      "sessionId": "abc-123",
      "createdAt": "2026-04-06T18:00:00.000Z",
      "lastActivity": "2026-04-06T18:05:30.000Z",
      "turnCount": 4,
      "fellowshipContext": true
    }
  ],
  "inventoryCache": {
    "ttlMinutes": 15,
    "entries": [
      {
        "microcode": "fairmontlakelouise",
        "date": "2026-04-10",
        "fetchedAt": "2026-04-06T18:00:00.000Z",
        "ageSeconds": 142,
        "expiresInSeconds": 3458,
        "expired": false
      },
      {
        "microcode": "fairmontlakelouise",
        "date": "2026-04-11",
        "fetchedAt": "2026-04-06T18:00:00.000Z",
        "ageSeconds": 142,
        "expiresInSeconds": 3458,
        "expired": false
      }
    ]
  }
}
```

### `POST /v1/chat`
Send a message to the bot.

**Headers:** `x-api-token: <API_TOKEN>`

**Body:**
```json
{
  "sessionId": "unique-session-id",
  "message": "What dining options do you have this weekend?",
  "microsite": "fairmontlakelouise",
  "guestName": "John Doe",
  "checkIn": "2026-04-10",
  "checkOut": "2026-04-12",
  "fellowshipCode": "MVGVQFCFOBHJXJEB"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | The guest's message. |
| `sessionId` | Yes | Unique identifier for the conversation session. |
| `microsite` | Yes | Venue identifier. Used as `sourceloc` and to build `venuecode=MIC{microsite}` for the inventory API. Determines which venue's experiences are returned. |
| `guestName` | No | Used to personalize the agent's greeting. |
| `checkIn` | No | Guest's check-in date (`YYYY-MM-DD`). Discarded if the stay has already ended. |
| `checkOut` | No | Guest's check-out date (`YYYY-MM-DD`). Discarded if already in the past. |
| `fellowshipCode` | No | Guest's UrVenue reservation code. Enables the `get_guest_context` tool when present. |

> All fields except `message`, `sessionId`, and `microsite` are optional. When provided, context fields are stored on the session at creation time and reused across all turns — subsequent messages do not need to resend them.

**Response:**
```json
{
  "reply": "Here is a great dinner option for Saturday: <a class=\"uwsjs-inv-item-select uvjs-scenesliderclick\" data-nodecode=\"VEN123\" data-mastercode=\"MBLTHPXBWE0IODXOGH\" data-nodename=\"Afternoon Tea\" data-date=\"2026-04-10\">Book</a>",
  "items": [
    {
      "mastercode": "MBLTHPXBWE0IODXOGH",
      "venueId": "VEN123",
      "venueName": "Fairview",
      "propertyName": "Fairmont Chateau Lake Louise",
      "date": "2026-04-10",
      "category": "Afternoon Tea",
      "name": "Afternoon Tea",
      "description": null,
      "highlight": "A classic afternoon tea experience with stunning lake views.",
      "timeLabel": "Available from 1:00pm to 4:00pm",
      "startTime": "13:00",
      "endTime": "16:00",
      "pricingDisplay": "$75",
      "payType": "pay",
      "tags": ["Dining", "Most Popular"]
    }
  ],
  "sessionId": "unique-session-id"
}
```

> `{{mastercode}}` placeholders in the agent's text are replaced server-side with `<a>` tags compatible with the UrVenue JS plugin (`uvjs`). The `items` array contains the full offering data for each referenced event, so the frontend can render cards without making additional API calls.

**Error responses:**

| Status | Cause |
|--------|-------|
| `400` | Missing or invalid `message`, `sessionId`, or `microsite` |
| `429` | Session turn limit reached, or AI provider rate limit |
| `500` | Unexpected internal error |
| `502` | AI provider authentication failed (check `OPENAI_API_KEY`) |
| `504` | Request timed out — agent or upstream API took too long |

### `GET /v1/session/:sessionId`
Retrieve session details including full conversation history.

**Headers:** `x-api-token: <API_TOKEN>`

### `DELETE /v1/cache/inventory`
Clears all cached inventory responses immediately, forcing fresh API calls on the next `search_experiences` invocation. Useful during debugging or after a venue updates its inventory without waiting for the TTL to expire.

**Headers:** `x-api-token: <API_TOKEN>`

**Response:**
```json
{ "ok": true, "clearedEntries": 2 }
```

## Sessions

- Sessions expire after **30 minutes** of inactivity.
- Each session is limited to **20 turns**.
- A background interval purges expired sessions every 5 minutes.
- Session context (`microsite`, `guestName`, `checkIn`, `checkOut`, `fellowshipCode`) is set at creation and persists for the session's lifetime — it does not need to be resent on every message.

## Date Handling

- `checkIn` and `checkOut` are validated at session creation. If `checkOut` is already in the past (the stay has completely ended), both dates are discarded and the agent will ask the guest for their upcoming dates.
- The agent uses the `validate_date` tool to verify any date the guest provides before searching inventory. Dates in the past are rejected and the guest is prompted for a future date.
- `search_experiences` also rejects date ranges where `todate` is in the past, as a final safety net.

## Inventory Cache

Inventory is fetched **one day at a time**. Each day is a separate API call cached independently.

- **Cache key:** `{microsite}|YYYY-MM-DD` — one entry per venue per day.
- **TTL: 1 hour** — after expiry the next request fetches fresh data from the API.
- The cache is **shared across all sessions** — if two guests at the same venue request the same day, only one API call is made.
- When a guest requests a multi-day range, all days are fetched in parallel (`Promise.all`). Days already in cache are returned instantly; only missing days hit the API.
- Errors from the API are never cached, so a failed request always retries on the next call.
- Use `DELETE /v1/cache/inventory` to clear the cache manually without restarting the server.

## Agent Tools

| Tool | Description |
|---|---|
| `search_experiences` | Fetches venue inventory for a date range, filters by keyword and/or tag. Uses `microsite` from the session to build `sourceloc={microsite}` and `venuecode=MIC{microsite}` for the API call. Returns up to 8 offerings. Rejects date ranges entirely in the past. Always available. |
| `validate_date` | Checks whether a date is today or in the future. Called by the agent whenever the guest manually provides a date before searching inventory. Always available. |
| `get_guest_context` | Fetches the guest's profile, stay dates, room number, party, and existing bookings from the fellowship API using the session's `microsite` as `sourceloc`. Only available when `fellowshipCode` is provided in the session. |

## Setup

### Prerequisites
- Node.js 18+
- An OpenAI API key
- *(Optional)* UrVenue API credentials for live inventory

### Install

```bash
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Required
OPENAI_API_KEY=sk-...
API_TOKEN=your-secret-token

# UrVenue Inventory API
# If not set, the local example JSON files are used instead (development mode)
UV_INVENTORY_API_KEY=...
UV_SOURCE_CODE=crossbook          # defaults to "crossbook"

# Fellowship API (optional — enables get_guest_context when fellowshipCode is passed)
UV_SYSTEM_ID=...
UV_FELLOWSHIP_SOURCE_CODE=public  # defaults to "public"

PORT=3000
ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

> `UV_SOURCE_LOC` and `UV_VENUE_CODE` are **not needed**. Both are derived at runtime from the `microsite` value sent in each request: `sourceloc={microsite}` and `venuecode=MIC{microsite}`.

### Run

```bash
npm start
```

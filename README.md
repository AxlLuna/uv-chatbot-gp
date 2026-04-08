# UV-Bot — UrVenue AI Concierge Chatbot

A conversational AI concierge backend built for **UrVenue**, a hospitality technology platform. UV-Bot helps venue guests discover and plan experiences (dining, pools, nightlife, spas, etc.) by searching the venue's live inventory and returning rich event card references.

## Overview

UV-Bot is a REST API service that wraps an OpenAI agent (`gpt-4.1`) with custom tools and instructions tuned for the hospitality domain. Guests interact with it via a simple chat endpoint; the bot collects the desired dates, queries the UrVenue inventory API, and responds with inline `<a>` tags ready for the UrVenue JS plugin, plus a `items` array containing the full offering data so the frontend can render cards without additional API calls.

## Architecture

```
server.js          ← Express HTTP server, session management, auth, rate limiting
agent/
  index.js         ← Creates the OpenAI Agent and runs it per request
  instructions.js  ← System prompt: UV-Bot persona, scope, and behavior rules
  tools.js         ← Tool definitions (search_experiences, get_guest_context)
mappers/
  inventory.js     ← Transforms raw UrVenue inventory API response into flat offerings
  user.js          ← Transforms raw UrVenue fellowship API response into guest context
data/
  example-inventory.json   ← Local fallback inventory (used when env vars are not set)
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
        "venueCode": "MICfairmontlakelouise",
        "caldate": "2026-04-10",
        "todate": "2026-04-12",
        "fetchedAt": "2026-04-06T18:00:00.000Z",
        "ageSeconds": 142,
        "expiresInSeconds": 758,
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
  "guestName": "John Doe",
  "checkIn": "2026-04-10",
  "checkOut": "2026-04-12",
  "microsite": "fairmontlakelouise",
  "fellowshipCode": "MVGVQFCFOBHJXJEB"
}
```

> All fields except `message` and `sessionId` are optional. When provided, they are stored on the session at creation time and used to personalize the agent's responses. Subsequent turns in the same session do not need to resend them.
>
> `fellowshipCode` is the guest's unique identifier in the UrVenue guest portal. When present, the `get_guest_context` tool is enabled and the agent can fetch the guest's full profile, stay details, party, and existing itinerary from the fellowship API.

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
| `400` | Missing or invalid `message` / `sessionId` |
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

## Inventory Cache

Inventory API responses are cached in-memory keyed by `venueCode|caldate|todate`.

- TTL: **15 minutes** — after expiry the next request fetches fresh data from the API.
- The cache is **shared across all sessions** — if two guests request the same date range and venue, only one API call is made.
- The venue code is included in the key to prevent collisions when multiple venues are served.
- Errors from the API are never cached, so a failed request always retries on the next call.
- Use `DELETE /v1/cache/inventory` to clear the cache manually without restarting the server.

## Agent Tools

| Tool | Description |
|---|---|
| `search_experiences` | Fetches venue inventory for a date range, then filters by keyword and/or tag. Returns up to 8 offerings. Validates that dates are in `YYYY-MM-DD` format and that `caldate` ≤ `todate` before calling the API. Always available. |
| `get_guest_context` | Fetches the guest's profile, stay dates, room number, party, and existing bookings from the fellowship API. Only available when `fellowshipCode` is provided in the session. |

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

# Optional — if not set, the local example JSON files are used instead
UV_INVENTORY_API_KEY=...
UV_SOURCE_LOC=...
UV_VENUE_CODE=...
UV_SOURCE_CODE=crossbook        # defaults to "crossbook"

# Fellowship API (optional — enables get_guest_context when fellowshipCode is passed)
UV_SYSTEM_ID=...
UV_FELLOWSHIP_SOURCE_CODE=public  # defaults to "public"

PORT=3000
ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

### Run

```bash
npm start
```

# UV-Bot — UrVenue AI Concierge Chatbot

A conversational AI concierge backend built for **UrVenue**, a hospitality technology platform. UV-Bot helps venue guests discover and plan experiences (dining, pools, nightlife, spas, etc.) by searching the venue's live inventory and returning rich event card references.

## Overview

UV-Bot is a REST API service that wraps an OpenAI agent (`gpt-4.1`) with custom tools and instructions tuned for the hospitality domain. Guests interact with it via a simple chat endpoint; the bot collects the desired dates, queries the UrVenue inventory API, and responds with inline event placeholders (`{{itemId}}`) that the frontend replaces with visual booking cards.

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
Returns server status and number of active sessions. No authentication required.

```json
{ "ok": true, "activeSessions": 3 }
```

### `POST /v1/chat`
Send a message to the bot.

**Headers:** `x-api-token: <API_TOKEN>`

**Body:**
```json
{
  "sessionId": "unique-session-id",
  "message": "What dining options do you have this weekend?"
}
```

**Response:**
```json
{
  "reply": "Here is a great dinner option for Saturday: {{abc123}}",
  "sessionId": "unique-session-id"
}
```

### `GET /v1/session/:sessionId`
Retrieve session details including full conversation history.

**Headers:** `x-api-token: <API_TOKEN>`

## Sessions

- Sessions expire after **30 minutes** of inactivity.
- Each session is limited to **20 turns**.
- A background interval purges expired sessions every 5 minutes.

## Agent Tools

| Tool | Description |
|---|---|
| `search_experiences` | Fetches venue inventory for a date range, then filters by keyword and/or tag. Returns up to 8 offerings. |
| `get_guest_context` | *(Defined but currently disabled)* Loads the guest's profile, stay dates, room number, party, and existing bookings. |

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
UV_SOURCE_CODE=crossbook   # defaults to "crossbook"

PORT=3000
```

### Run

```bash
npm start
```

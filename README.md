<p align="center">
  <img src="public/icon.png" alt="Sakura Call icon" width="112" height="112" />
</p>

<h1 align="center">Sakura Call</h1>

<p align="center">
  A private, on-demand, owner-operated WebRTC calling app with multilingual captions.
</p>

<p align="center">
  Audio, video, one-at-a-time screen sharing, and optional live translated captions for invited participants.
</p>

## Overview

Sakura Call is a self-hosted communication tool for one owner and invited participants. It is built for short private calls: start the app when needed, use the room, then stop the app and tunnel immediately afterward.

The product surface is intentionally small:

- Fixed room capacity of up to 6 people.
- Owner-controlled room creation.
- 4-digit room code join flow.
- Audio calls, video calls, and one-at-a-time screen sharing.
- Conversation and captions panel visible throughout the meeting UI.
- Optional live captions with transcription and translation.
- Peer-to-peer WebRTC media first, with managed TURN fallback when needed.
- No invite links, public room directory, user accounts, queues, public meeting features, or always-on service assumptions.

## Current Runtime Model

The intended runtime is on-demand:

1. Start `./run.sh`.
2. The script builds the app.
3. The app runs locally on port `3010`.
4. Cloudflare Tunnel exposes the HTTP app at `CLOUDFLARE_HOSTNAME`.
5. Participants join with the 4-digit room code.
6. On `Ctrl+C`, terminal hangup, or process exit, the app and Cloudflare Tunnel stop.

Cloudflare Tunnel exposes the web app only. Browser media is negotiated separately through WebRTC ICE. Calls try direct peer-to-peer paths first. If direct ICE cannot work, configured Cloudflare Realtime TURN credentials are available as the managed relay fallback.

There is no OCI layer, no self-hosted coturn service, no TURN Docker Compose stack, and no host-side "start relay" step.

## Media And Relay Model

Sakura Call creates a peer-to-peer WebRTC mesh between joined participants. Each browser starts with STUN from `NEXT_PUBLIC_STUN_URLS`. After a participant has joined a room, the browser requests authenticated ICE configuration from `/api/ice-servers`; the server adds short-lived Cloudflare Realtime TURN credentials when TURN is configured.

Normal behavior:

- `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all`.
- Direct P2P is preferred.
- TURN is used only if the browser's ICE negotiation selects a relay candidate.
- Long-lived Cloudflare TURN key material stays server-side.

Testing behavior:

- `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=relay` forces relay-only ICE and is useful for validating TURN fallback.
- Set it back to `all` for real calls.

The meeting settings modal includes a live connection path panel. It polls WebRTC stats and shows whether each active peer connection is `Direct P2P`, `TURN fallback`, `Mixed`, or `Waiting`, with RTT when the browser reports it.

## Privacy Model

Audio, video, and screen sharing use encrypted WebRTC media transport between participating browsers. In group calls, media is not mixed by the server. When TURN is used, Cloudflare forwards encrypted WebRTC packets, but the relay can still see connection metadata such as IP addresses, ports, timing, and traffic volume.

Captions and translations are optional and use a different path. When a browser enables captions, that browser sends short local microphone chunks to the Sakura Call server. The server sends those chunks to OpenAI for transcription and translation, then sends translated text to connected recipients and a preview back to the speaker.

Important boundaries:

- Remote audio is not transcribed from another participant's browser.
- Each browser must accept the captions privacy notice before sending microphone audio for captions.
- Caption audio is processed by this server and OpenAI, so captions are not end-to-end encrypted.
- Room state is stored in memory only and disappears when the server stops.
- Room codes are not placed in URLs or localStorage.
- The OpenAI API key and Cloudflare TURN API token stay server-side.
- Populated `.env` files, build output, dependency folders, logs, and caches are ignored by Git.

## Tech Stack

- Next.js 15 with a custom Node HTTP server
- React 19
- TypeScript
- Tailwind CSS 4
- Socket.IO for room signaling, captions, and call events
- WebRTC for audio, video, and screen media
- Web Audio API for browser-side speech segmentation
- OpenAI API for transcription and translation
- Cloudflare Tunnel for temporary HTTPS access to the HTTP app
- Cloudflare Realtime TURN for managed WebRTC relay fallback

## Requirements

Required for local development:

- Node.js 20 or newer
- npm

Required for captions:

- An OpenAI API key

Required for public real-device calls:

- `cloudflared`
- A Cloudflare account
- A Cloudflare-managed domain and hostname for the tunnel

Required for managed TURN fallback:

- A Cloudflare Realtime TURN key ID
- A Cloudflare Realtime TURN API token that can generate TURN credentials for that key

## Quick Start

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

For a normal local setup, fill in:

```bash
OPENAI_API_KEY=<openai-api-key>
TRANSCRIPTION_MODEL=gpt-4o-transcribe
TRANSLATION_MODEL=gpt-4o-mini
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all
ROOM_OWNER_TOKEN=<private-owner-passcode>
ROOM_OWNER_SESSION_SECRET=<long-random-cookie-secret>
```

For real calls with managed TURN fallback, also add:

```bash
CLOUDFLARE_TURN_TOKEN_ID=<cloudflare-turn-token-id>
CLOUDFLARE_TURN_API_TOKEN=<cloudflare-turn-api-token>
CLOUDFLARE_TURN_TTL_SECONDS=86400
```

For the Cloudflare Tunnel flow, also add:

```bash
CLOUDFLARE_API_TOKEN=<cloudflare-api-token-for-tunnel-and-dns>
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
CLOUDFLARE_ZONE_ID=<cloudflare-zone-id>
CLOUDFLARE_HOSTNAME=call.example.com
CLOUDFLARE_TUNNEL_NAME=sakura-call
CLOUDFLARE_SERVICE_URL=http://localhost:3010
```

Start the local development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Localhost is enough for basic browser microphone and UI testing. iPhone Safari and remote participants need HTTPS, so use the Cloudflare Tunnel flow for actual calls.

## On-Demand Public Run

Set up the Cloudflare Tunnel once after configuring the tunnel environment variables:

```bash
npm run tunnel:setup
```

Then start the full on-demand stack:

```bash
./run.sh
```

`run.sh` owns the runtime lifecycle:

1. Clears the local app ports.
2. Builds the production app.
3. Starts the production app on `http://localhost:3010`.
4. Starts Cloudflare Tunnel for the configured hostname.
5. Stops the app and tunnel on exit.

Run `npm run tunnel:setup` again if you change the Cloudflare hostname, tunnel name, zone, account, or tunnel API token.

## Join Flow

The normal call flow is:

1. Choose a language.
2. Enter a display name.
3. Host unlocks host mode with `ROOM_OWNER_TOKEN`.
4. Host creates a room.
5. Host shares the 4-digit room code.
6. Guest chooses a language.
7. Guest enters a display name.
8. Guest enters the 4-digit room code.
9. Participants allow the needed media permissions.
10. The room admits up to 6 participants.
11. The host starts captions if needed.
12. Each browser accepts the captions privacy notice before its own microphone audio is sent for transcription.

Group calls use a peer-to-peer mesh, so each additional participant increases browser CPU and bandwidth usage.

## Environment Variables

Use `.env.local` for local secrets. `.env` also works locally, but populated environment files must not be committed.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key for transcription and translation. Required only when captions are used. |
| `TRANSCRIPTION_MODEL` | Transcription model. Defaults to `gpt-4o-transcribe`. |
| `TRANSLATION_MODEL` | Translation model. Defaults to `gpt-4o-mini`. |
| `NEXT_PUBLIC_STUN_URLS` | Comma-separated STUN URLs. Defaults to Google STUN when unset. |
| `NEXT_PUBLIC_ICE_TRANSPORT_POLICY` | `all` for normal P2P-first behavior, `relay` for TURN-only testing. |
| `CLOUDFLARE_TURN_TOKEN_ID` | Cloudflare Realtime TURN token/key ID used by the server to generate short-lived ICE credentials. |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare Realtime TURN API token. Keep server-side only. |
| `CLOUDFLARE_TURN_TTL_SECONDS` | Lifetime for generated TURN credentials. Defaults to `86400`. |
| `ROOM_OWNER_TOKEN` | Private passcode used to unlock host mode and create rooms. |
| `ROOM_OWNER_SESSION_SECRET` | Secret used to sign the host session cookie. Falls back to `ROOM_OWNER_TOKEN` when unset. |
| `APP_ALLOWED_ORIGINS` | Optional comma-separated allowed origins for production hardening. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token used by `scripts/cloudflare-tunnel.mjs` for tunnel setup, tunnel lookup, tunnel token retrieval, and DNS setup. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for the tunnel. |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID for the public hostname. |
| `CLOUDFLARE_HOSTNAME` | Public hostname, for example `call.example.com`. |
| `CLOUDFLARE_TUNNEL_NAME` | Named Cloudflare Tunnel. Defaults to `sakura-call`. |
| `CLOUDFLARE_SERVICE_URL` | Local service URL for tunnel ingress, usually `http://localhost:3010`. |
| `SHUTDOWN_NOTICE_GRACE_MS` | Optional delay before shutdown notification redirect. Defaults to `750`. |

Do not use these old or unrelated values:

- `CLOUDFLARE_CALL_API_TOKEN`
- `TURN_USERNAME`
- `TURN_PASSWORD`
- `NEXT_PUBLIC_TURN_URLS`
- `NEXT_PUBLIC_TURN_USERNAME`
- `NEXT_PUBLIC_TURN_CREDENTIAL`
- OCI or Oracle TURN VM variables

The server still accepts a few old TURN aliases during transition, such as `TURN_TOKEN_ID` and `TURN_API_TOKEN`, but the documented names above are the canonical names.

## Cloudflare Tunnel Setup

Use this when you want a real HTTPS URL for Safari, mobile devices, or a participant outside your local network.

1. Add your domain to Cloudflare.
2. Point your registrar nameservers to the Cloudflare nameservers.
3. Create a Cloudflare API token for the target account and zone.
4. Give that token enough access to manage Cloudflare Tunnel and the target DNS record.
5. Add the Cloudflare tunnel values to `.env.local`.
6. Install `cloudflared`.

On macOS:

```bash
brew install cloudflare/cloudflare/cloudflared
```

Create or update the tunnel and DNS record:

```bash
npm run tunnel:setup
```

Run the app and tunnel:

```bash
./run.sh
```

The public URL only works while this machine, the app server, and Cloudflare Tunnel are running.

## Cloudflare Realtime TURN Setup

Use this when you want a managed relay fallback for restrictive NATs, corporate networks, hotel Wi-Fi, or mobile networks.

1. In Cloudflare, create a Realtime TURN key for this app.
2. Store the TURN token/key ID in `CLOUDFLARE_TURN_TOKEN_ID`.
3. Store the TURN API token in `CLOUDFLARE_TURN_API_TOKEN`.
4. Keep `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all` for normal peer-to-peer-first calls.

Browsers never receive the long-lived Cloudflare TURN key ID or API token. Joined participants receive only short-lived generated `iceServers` from the Sakura Call server.

Cloudflare's generated ICE server list can include alternate port `53` URLs. Sakura Call filters those out because common browsers and networks often block that port. The normal Cloudflare TURN UDP, TCP, and TLS ports remain available.

## Commands

```bash
npm run dev           # Start the custom Next.js + Socket.IO dev server on port 3000
npm run build         # Build the Next.js app
npm run start         # Start the production app on the default port
npm run start:public  # Start the production app on port 3010
npm run tunnel:setup  # Create or update Cloudflare Tunnel and DNS
npm run tunnel:run    # Run the Cloudflare Tunnel helper
npm run lint          # Run ESLint
npm run typecheck     # Run TypeScript without emitting files
npm test              # Run server tests
./run.sh              # Start app and Cloudflare Tunnel, then clean up on exit
```

## Project Structure

```text
app/                          Next.js pages, layout, robots route, and global CSS
app/room/[roomId]/            Room page
components/                   Client UI and call experience
components/CallRoom.tsx       Meeting room, WebRTC state, controls, settings modals
components/VideoGrid.tsx      Meeting media layout
lib/audioCapture.ts           Browser speech segmentation and WAV encoding
lib/audioEnhancement.ts       Browser microphone filtering and soft noise gate
lib/i18n.ts                   Supported language metadata and UI strings
lib/roomCode.ts               Browser session storage helper for room codes
lib/socket.ts                 Socket.IO client
lib/transcription.ts          Server-side OpenAI transcription
lib/translation.ts            Server-side OpenAI translation
lib/webrtc.ts                 WebRTC peer connection helpers
server/index.ts               Custom HTTP server, Next handler, and API routes
server/rooms.ts               In-memory room, code, participant, and host state
server/signaling.ts           Socket.IO signaling, subtitles, and room events
server/turn.ts                Cloudflare Realtime TURN credential generation
scripts/cloudflare-tunnel.mjs Cloudflare Tunnel setup and run helper
run.sh                        On-demand public runtime script
```

## Security Notes

- Keep populated `.env` files out of Git.
- Keep OpenAI and Cloudflare credentials outside committed files.
- Use a private random `ROOM_OWNER_TOKEN`.
- Use a long random `ROOM_OWNER_SESSION_SECRET`.
- Keep `robots.txt` disallowing crawling because the app is private and on-demand.
- Leave `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all` except when testing TURN specifically.
- If the Cloudflare hostname is reachable for longer than a short call, add Cloudflare WAF or rate-limit rules for `/api/owner`, `/api/rooms`, `/api/rooms/join`, `/api/ice-servers`, `/api/turn/status`, and `/socket.io/*`.
- Captions and translations are not end-to-end encrypted because microphone chunks are processed by this server and OpenAI.

## Limitations

- This is not a scalable public calling service.
- It supports rooms with up to 6 participants.
- Room and participant state are in memory.
- There is no database, account system, public room listing, queue, monitoring stack, CI/CD pipeline, or production deployment target.
- TURN fallback requires configured Cloudflare Realtime TURN credentials.
- Captions require an OpenAI API key and can take a few seconds depending on speech length and translation load.
- Group calls use a browser mesh, so CPU and bandwidth cost grow with participant count.

## Verification Checklist

Before a real call, confirm:

- `npm run lint` passes.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm run tunnel:setup` succeeds after Cloudflare tunnel changes.
- `./run.sh` starts the app and Cloudflare Tunnel.
- The host can unlock host mode.
- The host can create a room and copy the 4-digit code.
- The guest can join with the language, name, and room code flow.
- Participants beyond the 6-person room capacity are blocked.
- Audio, video, and screen sharing controls work for the selected browsers.
- The settings modal shows the connection path panel during calls.
- The conversation and captions section remains visible during audio, video, and screen-sharing states.
- Each viewer receives subtitles translated into their selected spoken language when captions are enabled.
- The app and tunnel stop when `run.sh` exits.

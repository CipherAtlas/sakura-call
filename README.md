<p align="center">
  <img src="public/icon.png" alt="Sakura Call icon" width="112" height="112" />
</p>

<h1 align="center">Sakura Call</h1>

<p align="center">
  A private, owner-operated WebRTC calling app for short on-demand calls.
</p>

<p align="center">
  Audio, video, screen sharing, and host-controlled multilingual live captions for invited participants.
</p>

## Overview

Sakura Call is a self-hosted communication tool for one owner and invited participants. It is designed for temporary private calls: start the app when needed, share the 4-digit room code, use the call, then stop the app and Cloudflare Tunnel immediately afterward.

This is intentionally not a public meeting platform. There are no user accounts, public room listings, queues, invite-link discovery flows, or always-on service assumptions.

Current product scope:

- One active room at a time.
- Up to 6 participants per room.
- Owner-only room creation behind a private host passcode.
- Guest join flow through language, display name, and a 4-digit room code.
- Audio calls, video calls, and one-at-a-time screen sharing.
- Conversation and captions UI available during audio, video, and screen-sharing states.
- Host-controlled live captions with transcription and per-recipient translation.
- Peer-to-peer-first WebRTC media with managed Cloudflare Realtime TURN fallback when configured.
- In-memory room state with no database or persistent call history.

## Runtime Model

The intended public runtime is `./run.sh`:

1. Install dependencies if `node_modules/` is missing.
2. Clear local app ports `3010`, `3011`, `3012`, and `3013`.
3. Build the production Next.js app.
4. Start the custom Next.js and Socket.IO server on `http://localhost:3010`.
5. Start Cloudflare Tunnel for `CLOUDFLARE_HOSTNAME`.
6. Stop both the app server and tunnel on `Ctrl+C`, terminal hangup, or process exit.

Cloudflare Tunnel exposes the HTTP app only. Browser media is negotiated separately through WebRTC ICE. Calls try direct peer-to-peer paths first, then request managed TURN credentials from the Sakura Call server if direct ICE fails or if relay-only testing is enabled.

There is no self-hosted TURN VM, coturn service, Docker Compose relay stack, OCI deployment layer, or long-running production host in the current codebase.

## Current Call Flow

The normal guest flow is:

1. Choose the language you will speak.
2. Enter a display name.
3. Enter the 4-digit room code.
4. Allow camera and microphone permissions.
5. Join the room.

The owner flow is:

1. Choose language and display name.
2. Unlock host mode with `ROOM_OWNER_TOKEN`.
3. Create a room.
4. Share the 4-digit room code with invited participants.
5. Start captions when needed.

The room URL contains an internal room id, not the join code. Guests should join through the 4-digit room code flow.

## Room And Session Behavior

Room state lives in server memory:

- A room expires after 4 hours.
- Only one active room can exist at a time.
- The host can create the active room and receives an HTTP-only creator cookie.
- If the host leaves, the room ends for everyone.
- Disconnected participants have a short reconnect window before their slot expires.
- Reconnecting an existing participant requires the server-issued participant session token.
- Failed room-code attempts are rate-limited and temporarily blocked after repeated failures.

Browser storage is limited to client convenience and reconnect state:

- `localStorage` stores preferences such as language, display name, theme, voice settings, selected device ids, volume levels, and layout choices.
- `sessionStorage` stores the room code and participant session token for the current room session.
- HTTP-only cookies store owner and room-creator privileges.
- Room codes are not placed in URLs.

## Meeting Features

The meeting UI supports:

- Mute and unmute.
- Deafen and undeafen.
- Camera on and off.
- Screen sharing with one active sharer at a time.
- Fullscreen viewing for participant video or shared screen surfaces.
- Gallery, focus, speaker, collage, and compact media layouts.
- Surface pickers for choosing what appears in the dominant view.
- A volume mixer for master output, screen-share audio, and remote participant volumes.
- Conversation panel, draggable overlay, fullscreen conversation panel, and browser Picture-in-Picture captions where supported.
- Settings panels for room code, theme, voice, connection path, managed relay status, and screen-share quality.

Screen-sharing controls include presets for text clarity, balanced sharing, motion, 4K/ultra, and custom settings. Manual controls can set resolution cap, frame rate, bitrate, detail-vs-motion optimization, and whether screen sharing should be prioritized over camera video. The UI also reports actual screen-share stats when the browser exposes them.

Screen-share audio is browser-limited. The most reliable case is sharing a Chrome tab with tab audio enabled. Safari, Firefox, window sharing, and entire-screen sharing may provide video only.

## Captions And Translation

Captions are host-controlled. When the host starts the subtitle service:

- Each participant browser sends short chunks of its own local microphone audio to the Sakura Call server.
- The server sends those chunks to OpenAI for transcription.
- Transcribed text is translated into each recipient's selected spoken language when needed.
- The speaker receives a local preview of what others see.
- Other participants receive translated caption events through Socket.IO.
- Caption and conversation logs are held in browser state during the call.

Remote audio is not transcribed from another participant's browser. Each browser submits only its own microphone while the caption service is running.

Captions and translations are not end-to-end encrypted because microphone chunks are processed by this server and OpenAI. Audio, video, and screen-share media use the separate encrypted WebRTC media path.

## Media And Relay Model

Sakura Call uses a WebRTC mesh between joined participants. Each browser starts with STUN servers from `NEXT_PUBLIC_STUN_URLS`, defaulting to Google STUN when unset.

Normal behavior:

- `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all`.
- Direct peer-to-peer ICE is attempted first.
- TURN credentials are requested from `/api/ice-servers` only for authenticated room participants.
- Cloudflare Realtime TURN credentials are generated server-side and returned as short-lived browser ICE credentials.
- The long-lived Cloudflare TURN key id and API token never go to the browser.

Testing behavior:

- `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=relay` forces relay-only ICE.
- Use relay-only mode to validate TURN fallback.
- Set it back to `all` for normal calls.

The settings modal includes a connection path panel. It polls WebRTC stats and reports each active peer path as direct P2P, TURN fallback, mixed, or waiting, with RTT when the browser exposes it.

## Microphone Processing

The app processes microphone audio locally in the browser before sending it over WebRTC. Browser-provided noise suppression is intentionally disabled so the app can apply a consistent local Web Audio chain.

The microphone chain is:

1. Capture the selected browser microphone.
2. Convert the selected input channel mode into a mono voice path.
3. Apply local input gain.
4. Analyze input level for meters and gate state.
5. Apply RNNoise suppression when available.
6. Blend in a delayed dry voice bed so high suppression stays natural.
7. Apply a soft noise gate.
8. Apply automatic voice leveling.
9. Apply compression and limiting.
10. Send the processed mono track to WebRTC.

Voice settings include:

- Microphone device selection.
- Output device selection when the browser supports it.
- Mic channel mode: auto, input 1/left, input 2/right, or mix all channels.
- Noise suppression level.
- Noise gate level with live input, noise floor, threshold, peak, and gate state.
- Local processed microphone test.
- Input volume and clipping protection.

For most USB audio interfaces, use the interface directly as the Sakura Call microphone. The channel selector handles common one-sided stereo and multi-channel interface captures without requiring OBS, BlackHole, or another virtual mixer.

## Privacy Boundaries

Sakura Call is private and self-hosted, but not every feature has the same privacy boundary.

Audio, video, and screen sharing:

- Use encrypted WebRTC media transport between participating browsers.
- Are not mixed by the Sakura Call server.
- May travel through Cloudflare TURN when relay fallback is needed.
- Remain encrypted at the WebRTC media layer even when relayed, though relays can see metadata such as IP addresses, ports, timing, and traffic volume.

Captions and translations:

- Are explicitly host-controlled.
- Send local microphone chunks to this server and OpenAI while enabled.
- Send translated text back through the Sakura Call server.
- Are not end-to-end encrypted.

Server and storage:

- Room state, participants, room codes, failed attempts, and caption-service state are in memory.
- No account database, searchable room list, message database, or persistent call history exists.
- Environment files, build output, dependency folders, logs, caches, agent metadata, and local skill files are ignored by Git.

## Tech Stack

- Next.js 15 with a custom Node HTTP server.
- React 19.
- TypeScript.
- Tailwind CSS 4.
- Socket.IO for room signaling, captions, and call events.
- WebRTC for audio, video, and screen media.
- Web Audio API and RNNoise WASM for browser-side microphone processing.
- OpenAI API for transcription and translation.
- Cloudflare Tunnel for temporary HTTPS access to the HTTP app.
- Cloudflare Realtime TURN for managed WebRTC relay fallback.

## Requirements

Required for local development:

- Node.js 20 or newer.
- npm.

Required for captions:

- An OpenAI API key.

Required for public real-device calls:

- `cloudflared`.
- A Cloudflare account.
- A Cloudflare-managed domain and hostname for the tunnel.

Required for managed TURN fallback:

- A Cloudflare Realtime TURN key id.
- A Cloudflare Realtime TURN API token that can generate TURN credentials for that key.

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

For real calls with managed TURN fallback, add:

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

Set up or update the named tunnel and DNS record:

```bash
npm run tunnel:setup
```

Then start the on-demand public stack:

```bash
./run.sh
```

The public URL works only while this machine, the app server, and Cloudflare Tunnel are running.

## Environment Variables

Use `.env.local` for local secrets. `.env` also works locally, but populated environment files must not be committed.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key for transcription and translation. Required only when captions are used. |
| `TRANSCRIPTION_MODEL` | Transcription model. Defaults to `gpt-4o-transcribe`. |
| `TRANSLATION_MODEL` | Translation model. Defaults to `gpt-4o-mini`. |
| `NEXT_PUBLIC_STUN_URLS` | Comma-separated STUN URLs. Defaults to `stun:stun.l.google.com:19302`. |
| `NEXT_PUBLIC_ICE_TRANSPORT_POLICY` | `all` for normal peer-to-peer-first calls, `relay` for TURN-only testing. |
| `CLOUDFLARE_TURN_TOKEN_ID` | Cloudflare Realtime TURN token/key id used by the server to generate short-lived ICE credentials. |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare Realtime TURN API token. Keep server-side only. |
| `CLOUDFLARE_TURN_TTL_SECONDS` | Lifetime for generated TURN credentials. Defaults to `86400`. |
| `ROOM_OWNER_TOKEN` | Private passcode used to unlock host mode and create rooms. |
| `ROOM_OWNER_SESSION_SECRET` | Secret used to sign the host session cookie. Falls back to `ROOM_OWNER_TOKEN` when unset. |
| `APP_ALLOWED_ORIGINS` | Optional comma-separated allowed origins for production hardening. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token used by `scripts/cloudflare-tunnel.mjs` for tunnel setup, tunnel lookup, tunnel token retrieval, and DNS setup. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id for the tunnel. |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone id for the public hostname. |
| `CLOUDFLARE_HOSTNAME` | Public hostname, for example `call.example.com`. |
| `CLOUDFLARE_TUNNEL_NAME` | Named Cloudflare Tunnel. Defaults to `sakura-call`. |
| `CLOUDFLARE_SERVICE_URL` | Local service URL for tunnel ingress, usually `http://localhost:3010`. |
| `SHUTDOWN_NOTICE_GRACE_MS` | Optional delay before shutdown notification redirect. Defaults to `750`. |

In production, state-changing HTTP routes and Socket.IO handshakes are origin-checked. Allowed origins come from localhost defaults, `CLOUDFLARE_HOSTNAME`, and `APP_ALLOWED_ORIGINS`.

## Cloudflare Tunnel Setup

Use this when you want a real HTTPS URL for Safari, mobile devices, or a participant outside your local network.

1. Add your domain to Cloudflare.
2. Point your registrar nameservers to Cloudflare.
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

Run `npm run tunnel:setup` again if you change the Cloudflare hostname, tunnel name, zone, account, or tunnel API token.

## Cloudflare Realtime TURN Setup

Use this for restrictive NATs, corporate networks, hotel Wi-Fi, or mobile networks where direct peer-to-peer ICE may fail.

1. In Cloudflare, create a Realtime TURN key for this app.
2. Store the TURN token/key id in `CLOUDFLARE_TURN_TOKEN_ID`.
3. Store the TURN API token in `CLOUDFLARE_TURN_API_TOKEN`.
4. Keep `NEXT_PUBLIC_ICE_TRANSPORT_POLICY=all` for normal calls.

Browsers never receive the long-lived Cloudflare TURN key id or API token. Joined participants receive only short-lived generated `iceServers` from the Sakura Call server.

Cloudflare's generated ICE server list can include alternate port `53` URLs. Sakura Call filters those out because common browsers and networks often block that port. The normal Cloudflare TURN UDP, TCP, and TLS ports remain available.

## Commands

```bash
npm run dev           # Start the custom Next.js + Socket.IO dev server on port 3000
npm run dev:public    # Start the dev server on port 3010
npm run build         # Build the Next.js app
npm run start         # Start the production app on the default port
npm run start:public  # Start the production app on port 3010
npm run lint          # Run ESLint
npm run typecheck     # Run TypeScript without emitting files
npm test              # Run server tests
npm run tunnel:setup  # Create or update Cloudflare Tunnel and DNS
npm run tunnel:run    # Run the Cloudflare Tunnel helper
./run.sh              # Build, start app, start tunnel, and clean up on exit
```

## Project Structure

```text
app/                          Next.js pages, layout, robots route, RNNoise worklet route, and global CSS
app/room/[roomId]/            Room page wrapper for the call experience
components/                   Client UI and call experience
components/CallRoom.tsx       Meeting room, WebRTC state, controls, captions, fullscreen, and PiP behavior
components/CallRoomModals.tsx Settings, voice, layout, leave, and screen-share quality modals
components/SubtitlesPanel.tsx Conversation and translated caption panels
components/VideoGrid.tsx      Participant and screen-share media layouts
lib/audioCapture.ts           Browser speech segmentation and WAV encoding for captions
lib/audioEnhancement.ts       Browser mic mono mix, RNNoise, gate, leveling, compression, and limiting
lib/i18n.ts                   Supported languages and UI strings
lib/roomCode.ts               Session storage helpers for room codes and participant session tokens
lib/socket.ts                 Socket.IO client singleton
lib/theme.ts                  Theme storage and system theme handling
lib/transcription.ts          Server-side OpenAI transcription
lib/translation.ts            Server-side OpenAI translation
lib/webrtc.ts                 WebRTC peer connection helpers
server/cookies.ts             Cookie parsing helpers
server/index.ts               Custom HTTP server, Next handler, API routes, HTTPS redirect, and shutdown notices
server/origin.ts              Allowed origin handling for HTTP mutations and Socket.IO
server/rooms.ts               In-memory room, room code, participant, session, host, and screen-share state
server/signaling.ts           Socket.IO signaling, captions, participant events, and room lifecycle events
server/turn.ts                Cloudflare Realtime TURN credential generation and status
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
- Captions and translations are not end-to-end encrypted because microphone chunks are processed by this server and OpenAI.
- If the Cloudflare hostname stays reachable beyond a short call, add Cloudflare WAF or rate-limit rules for `/api/owner`, `/api/rooms`, `/api/rooms/join`, `/api/ice-servers`, `/api/turn/status`, and `/socket.io/*`.

## Limitations

- This is not a scalable public calling service.
- It supports one active room with up to 6 participants.
- Room and participant state are in memory.
- There is no database, account system, public room listing, queue, monitoring stack, CI/CD pipeline, or production deployment target.
- TURN fallback requires configured Cloudflare Realtime TURN credentials.
- Captions require an OpenAI API key and can take a few seconds depending on speech length and translation load.
- Picture-in-Picture captions depend on browser support.
- Screen-share audio depends heavily on browser and capture-source support.
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
- A guest can join with the language, name, and room code flow.
- Participants beyond the 6-person room capacity are blocked.
- Audio, video, and screen sharing controls work for the selected browsers.
- Screen-share audio is tested from a Chrome tab with tab audio enabled.
- Direct USB interface microphones produce centered mono voice audio with the right mic channel mode selected.
- Voice settings show live input level, noise floor, gate threshold, peak level, and gate open/closed state.
- The settings modal shows managed relay and connection path status during calls.
- The conversation and captions section remains visible during audio, video, and screen-sharing states.
- Each viewer receives subtitles translated into their selected spoken language when captions are enabled.
- The app and tunnel stop when `run.sh` exits.

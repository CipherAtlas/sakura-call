<p align="center">
  <img src="public/icon.png" alt="Sakura Call icon" width="112" height="112" />
</p>

<h1 align="center">Sakura Call</h1>

<p align="center">
  A private, on-demand, host-sized WebRTC calling app with multilingual captions.
</p>

<p align="center">
  Audio, video, one-at-a-time screen sharing, and optional live translated captions in one owner-operated room.
</p>

## Overview

Sakura Call is a self-hosted communication tool for one owner and invited participants. It is built for short, private calls: start the app when needed, use the call, and stop everything immediately afterward.

The app intentionally keeps the product surface small:

- Fixed room capacity of up to 6 people.
- Owner-controlled room creation.
- 4-digit room code join flow.
- Multilingual caption transcription and translation support.
- Audio calls, video calls, and one-at-a-time screen sharing.
- Live translated captions with a per-browser privacy acknowledgement.
- Peer-to-peer WebRTC media first, with TURN fallback for restrictive networks.
- No invite links, public room directory, user accounts, queues, public meeting features, or long-running service assumptions.

## Privacy Model

Audio, video, and screen sharing use encrypted WebRTC media transport between participating browsers. Group calls use a peer-to-peer mesh rather than server mixing. When a TURN relay is used, the relay forwards encrypted WebRTC packets, but it can still see connection metadata such as IP addresses, ports, timing, and traffic volume.

Live captions and translations are optional and use a different path. When a browser enables captions, that browser sends short local microphone chunks to the Sakura Call server. The server sends those chunks to OpenAI for transcription and translation, then relays translated subtitle text to the other participants and a preview back to the speaker. In group calls, each caption segment is translated only for the selected languages of connected recipients, and one translation is reused for participants who share the same target language.

Important boundaries:

- Remote audio is not transcribed from another participant's browser.
- Each browser must accept the captions privacy notice before sending microphone audio for captions.
- Room state is stored in memory only and disappears when the server stops.
- Room codes are not placed in URLs or localStorage.
- The OpenAI API key stays server-side.
- `.env`, `.env.local`, build output, dependency folders, logs, and caches are ignored by Git.

## Tech Stack

- Next.js 15
- React 19
- TypeScript
- Tailwind CSS 4
- Socket.IO
- WebRTC
- Web Audio API
- OpenAI API
- Cloudflare Tunnel for temporary HTTPS access
- coturn for fallback TURN relay

## Requirements

- Node.js 20 or newer
- npm
- An OpenAI API key for captions and translation
- `cloudflared` for public HTTPS access
- Docker for the default local TURN relay, or an OCI TURN VM configured for `TURN_MODE=oci`
- A Cloudflare account and Cloudflare-managed domain for the public tunnel flow

## Quick Start

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Fill in at least these values:

```bash
OPENAI_API_KEY=<openai-api-key>
TRANSCRIPTION_MODEL=gpt-4o-transcribe
TRANSLATION_MODEL=gpt-4o-mini
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
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

Localhost is enough for basic browser microphone and UI testing. iPhone Safari and remote participants need HTTPS, so use the Cloudflare Tunnel flow below for real-device calls.

## On-Demand Public Run

For an actual private call, use:

```bash
./run.sh
```

The script owns the runtime lifecycle:

1. Clears the local app ports.
2. Leaves TURN relay startup off by default.
3. Builds the app.
4. Starts the production app on port `3010`.
5. Starts the Cloudflare Tunnel for the HTTPS app URL.
6. Lets the host start the OCI TURN relay from Settings only when fallback is needed.
7. On `Ctrl+C`, process exit, or terminal hangup, stops the app, tunnel, and any TURN relay started by the app or script.

By default, `TURN_ENABLED=0`, so `./run.sh` does not start Docker TURN or OCI TURN during launch. Calls try peer-to-peer first. If OCI TURN variables are configured, the host fallback relay button starts the OCI VM on demand from the room UI.

To deliberately start a relay during launch, opt in for that run:

```bash
TURN_ENABLED=1 TURN_MODE=local TURN_HOST=localhost ./run.sh
```

Cloudflare Tunnel exposes the HTTP app only. It does not carry TURN relay traffic. TURN must be reachable directly from both browsers on:

- `3478/tcp`
- `3478/udp`
- `49160-49200/udp`

If the local Docker relay is behind a home router or restrictive NAT, use a directly reachable host or the OCI TURN VM path instead.

## Join Flow

The normal call flow is:

1. Choose a language.
2. Enter a display name.
3. Host unlocks host mode in Settings with `ROOM_OWNER_TOKEN`.
4. Host creates a room.
5. Host shares the 4-digit room code.
6. Guest chooses a language, enters a display name, and enters the room code.
7. Participants allow the needed media permissions.
8. The room admits up to 6 participants.
9. The host starts captions if needed.
10. Each browser accepts the captions privacy notice before its own microphone audio is sent for transcription.

The meeting UI supports audio calls, video calls, and one-at-a-time screen sharing. Group calls use a peer-to-peer mesh, so each additional participant increases browser CPU and bandwidth usage. The conversation and captions section remains visible in every meeting mode.

## Environment Variables

Use `.env.local` for local secrets. Do not commit populated environment files.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI API key for transcription and translation. |
| `TRANSCRIPTION_MODEL` | Transcription model. Defaults to `gpt-4o-transcribe`. |
| `TRANSLATION_MODEL` | Translation model. Defaults to `gpt-4o-mini`. |
| `NEXT_PUBLIC_STUN_URLS` | Comma-separated STUN URLs. |
| `NEXT_PUBLIC_ICE_TRANSPORT_POLICY` | `all` for normal behavior, `relay` for TURN-only testing. |
| `TURN_URLS` | Comma-separated TURN URLs returned only to authenticated room participants. |
| `TURN_USERNAME` | TURN username. Defaults to `sakura` where supported. |
| `TURN_PASSWORD` | TURN password. Leave empty to let scripts generate a per-run secret where supported. |
| `TURN_MODE` | `auto`, `local`, or `oci` for `run.sh`. |
| `TURN_HOST` | Public IP or hostname for local Docker TURN. Defaults to auto-detected public IP. |
| `TURN_EXTERNAL_IP` | coturn external IP override for Docker mode. |
| `TURN_ENABLED` | `0` by default so `run.sh` does not start TURN at launch. Set to `1` only when you deliberately want launch-time TURN startup. |
| `OCI_TURN_INSTANCE_ID` | OCI instance OCID for the TURN VM. |
| `OCI_TURN_SSH_USER` | SSH user for the TURN VM, usually `ubuntu`. |
| `OCI_TURN_SSH_KEY_FILE` | Local private SSH key path for the TURN VM. Keep it outside the repo. |
| `OCI_TURN_STOP_INSTANCE_ON_EXIT` | `1` stops the OCI TURN VM on exit. |
| `OCI_USER_OCID` | OCI API user OCID. Lowercase Oracle-generated names also work. |
| `OCI_FINGERPRINT` | OCI API key fingerprint. |
| `OCI_TENANCY_OCID` | OCI tenancy OCID. |
| `OCI_REGION` | OCI region, for example `ap-mumbai-1`. |
| `OCI_PRIVATE_KEY_FILE` | Local OCI API private key path. Keep it outside the repo. |
| `ROOM_OWNER_TOKEN` | Private passcode used to unlock host mode. |
| `ROOM_OWNER_SESSION_SECRET` | Secret used to sign the host session cookie. |
| `APP_ALLOWED_ORIGINS` | Optional comma-separated allowed origins for production hardening. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token for tunnel setup and run commands. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID. |
| `CLOUDFLARE_HOSTNAME` | Public hostname, for example `call.example.com`. |
| `CLOUDFLARE_TUNNEL_NAME` | Named Cloudflare Tunnel. Defaults to `sakura-call`. |
| `CLOUDFLARE_SERVICE_URL` | Local service URL for tunnel ingress, usually `http://localhost:3010`. |

## Cloudflare Tunnel Setup

Use this when you want a real HTTPS URL for Safari, mobile devices, or a participant outside your network.

1. Add your domain to Cloudflare.
2. Point your registrar nameservers to the Cloudflare nameservers.
3. Create a Cloudflare API token that can manage the target zone DNS record and Cloudflare Tunnel configuration.
4. Add the Cloudflare values to `.env.local`.
5. Install `cloudflared`.

On macOS:

```bash
brew install cloudflare/cloudflare/cloudflared
```

Create or update the tunnel and DNS record:

```bash
npm run tunnel:setup
```

Then run the full on-demand stack:

```bash
./run.sh
```

The public URL only works while the app, tunnel, and this machine are running.

## TURN Options

### Local Docker TURN

`run.sh` starts the Docker TURN service automatically in default `auto` mode when OCI TURN is not configured.

Manual local TURN start:

```bash
TURN_USERNAME=sakura TURN_PASSWORD=<turn-password> docker compose -f docker-compose.turn.yml up -d
```

Manual local TURN environment:

```bash
TURN_URLS=turn:<public-turn-host>:3478?transport=udp,turn:<public-turn-host>:3478?transport=tcp
TURN_USERNAME=sakura
TURN_PASSWORD=<turn-password>
TURN_EXTERNAL_IP=<public-turn-ip>
```

For remote callers, `localhost` is not enough. The TURN server must be reachable by both browsers on a public IP or hostname with the TURN ports open.

### OCI TURN VM

The OCI fallback path expects a small Always Free eligible VM dedicated to coturn:

- Shape: `VM.Standard.E2.1.Micro`
- CPU: `1 OCPU`
- RAM: `1 GB`
- Region: `ap-mumbai-1`
- OS user: `ubuntu`
- Service: `coturn`

Keep Sakura Call TURN resources inside the `sakura-call-free-only` compartment so budget alerts and quota guardrails apply. Do not add paid or scalable OCI services unless you intentionally change the operating model.

The VM is expected to have:

```text
/opt/sakura-turn/start-turn.sh
/opt/sakura-turn/stop-turn.sh
```

The start script receives the current public IP and `TURN_USERNAME`/`TURN_PASSWORD`, then starts coturn for that run. The stop script stops coturn before the VM shuts down.

Keep OCI private keys and SSH keys outside the repository and owner-readable only:

```bash
chmod 600 /path/to/oci_api_key.pem
chmod 600 /path/to/sakura_call_oci_turn
```

Install the OCI CLI before using OCI mode:

```bash
pipx install oci-cli
```

## Commands

```bash
npm run dev           # Start the custom Next.js + Socket.IO dev server
npm run start:public  # Start the production app on port 3010
npm run tunnel:setup  # Create or update Cloudflare Tunnel and DNS
npm run tunnel:run    # Run the Cloudflare Tunnel
npm run lint          # Run ESLint
npm run typecheck     # Run TypeScript without emitting files
npm run build         # Build the Next.js app
./run.sh              # Start app and Cloudflare Tunnel, then clean up on exit
```

## Project Structure

```text
app/                         Next.js pages, layout, robots route, global CSS
app/room/[roomId]/           Room page
components/                  Client UI and call experience
lib/audioCapture.ts          Browser speech segmentation and WAV encoding
lib/audioEnhancement.ts      Browser microphone filtering and soft noise gate
lib/i18n.ts                  Supported language metadata and UI strings
lib/roomCode.ts              Browser session storage helper for room codes
lib/socket.ts                Socket.IO client
lib/transcription.ts         Server-side OpenAI transcription
lib/translation.ts           Server-side OpenAI translation
lib/webrtc.ts                WebRTC peer connection helpers
server/index.ts              Custom HTTP server, Next handler, and API routes
server/rooms.ts              In-memory room, code, participant, and host state
server/signaling.ts          Socket.IO signaling, subtitles, and room events
server/turn.ts               On-demand OCI TURN relay control
scripts/cloudflare-tunnel.mjs Cloudflare Tunnel setup and run helper
docker-compose.turn.yml      Local coturn fallback relay
run.sh                       On-demand public runtime script
```

## Security Notes

- Keep populated `.env` files out of Git.
- Keep OpenAI, Cloudflare, OCI, TURN, and SSH credentials outside committed files.
- Use `ROOM_OWNER_TOKEN` as a private owner passcode.
- Use a long random `ROOM_OWNER_SESSION_SECRET`.
- Keep `robots.txt` disallowing crawling because the app is private and on-demand.
- If the Cloudflare hostname is reachable for longer than a short call, add Cloudflare WAF or rate-limit rules for `/api/ice-servers`, `/api/turn/status`, `/api/owner`, and `/socket.io/*`.
- Captions and translations are not end-to-end encrypted because microphone chunks are processed by this server and OpenAI.

## Limitations

- This is not a scalable public calling service.
- It supports rooms with up to 6 participants.
- It supports the configured OpenAI speech-to-text language set for captions.
- Room and participant state are in memory.
- There is no database, account system, public room listing, queue, monitoring stack, CI/CD pipeline, or production deployment target.
- TURN fallback requires a directly reachable TURN server and valid credentials.
- Subtitle latency favors natural translation quality over immediacy and can take a few seconds.

## Verification Checklist

Before a real call, confirm:

- `npm run lint` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- The host can unlock host mode.
- The host can create a room and copy the 4-digit code.
- The guest can join with the language, name, and room code flow.
- Participants beyond the 6-person room capacity are blocked.
- Audio, video, and screen sharing controls work for the selected browser.
- The conversation and captions section remains visible during audio, video, and screen-sharing states.
- Each viewer receives subtitles translated into their selected spoken language.
- The app, tunnel, and TURN relay stop when `run.sh` exits.

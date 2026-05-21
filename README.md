# Sakura Call

Sakura Call is a local-development MVP for a private two-person WebRTC audio call with live translated subtitles between English and Japanese.

The app is built for quick testing with another person over HTTPS using Cloudflare Tunnel. It is not production infrastructure yet.

## What It Does

- Creates private two-person rooms.
- Supports English and Japanese only.
- Gives the room creator a 4-digit room code.
- Blocks a third participant from joining.
- Runs peer-to-peer WebRTC audio between the two browsers.
- Uses Socket.IO for room state, signaling, reconnects, and subtitle events.
- Captures the local microphone stream, segments speech in the browser, sends short WAV chunks to the server, transcribes them, translates them, and sends translated subtitles to the other participant.
- Shows the speaker a local preview of what the other participant receives.
- Keeps video calling dormant for now; the UI is audio-only.
- Keeps the OpenAI API key server-side only.

## Tech Stack

- Next.js 15
- React 19
- TypeScript
- Tailwind CSS 4
- Socket.IO
- WebRTC audio transport
- Web Audio API
- OpenAI API
- Cloudflare Tunnel for public HTTPS testing

## Project Structure

```text
app/                       Next.js pages, layout, global CSS, robots route
app/room/[roomId]/         Room page
components/                Client UI and call experience
lib/audioCapture.ts        Browser speech segmentation and WAV encoding
lib/audioEnhancement.ts    Browser microphone filtering and soft noise gate
lib/i18n.ts                English/Japanese UI strings and language helpers
lib/roomCode.ts            Browser session storage helper for room codes
lib/socket.ts              Socket.IO client
lib/transcription.ts       Server-side OpenAI transcription
lib/translation.ts         Server-side OpenAI translation
lib/webrtc.ts              WebRTC peer connection helpers
server/index.ts            Custom HTTP server, Next handler, room API routes
server/rooms.ts            In-memory room, code, participant, and host state
server/signaling.ts        Socket.IO signaling, subtitles, and room events
scripts/cloudflare-tunnel.mjs  Cloudflare Tunnel setup/run helper
run.sh                     Convenience script for public local testing
```

## Requirements

- Node.js 20 or newer is recommended.
- npm
- An OpenAI API key
- `cloudflared`, only if you want to expose the local app through Cloudflare Tunnel
- A Cloudflare account and a domain on Cloudflare, only for public HTTPS testing

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Fill in at least:

```bash
OPENAI_API_KEY=sk-...
TRANSLATION_MODEL=gpt-4o-mini
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
```

Start the local app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Localhost works for browser microphone testing. iPhone Safari and remote devices need HTTPS, so use the Cloudflare Tunnel flow below for real-device testing.

## Environment Variables

```bash
OPENAI_API_KEY=
TRANSLATION_MODEL=gpt-4o-mini
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_HOSTNAME=call.example.com
CLOUDFLARE_TUNNEL_NAME=sakura-call
CLOUDFLARE_SERVICE_URL=http://localhost:3010
```

Notes:

- `OPENAI_API_KEY` is required for transcription and translation.
- `TRANSLATION_MODEL` defaults to `gpt-4o-mini` when unset.
- Transcription is fixed in code to `gpt-4o-mini-transcribe`.
- `NEXT_PUBLIC_STUN_URLS` can be a comma-separated list of STUN URLs.
- Cloudflare variables are only required for `npm run tunnel:setup`, `npm run tunnel:run`, and `./run.sh`.
- Do not commit `.env` or `.env.local`.

## Commands

```bash
npm run dev           # Start the custom Next.js + Socket.IO dev server
npm run start:public  # Start the production app on port 3010 for Cloudflare Tunnel
npm run tunnel:setup  # Create/configure the Cloudflare Tunnel and DNS record
npm run tunnel:run    # Run the Cloudflare Tunnel
npm run lint          # Run ESLint
npm run typecheck     # Run TypeScript without emitting files
npm run build         # Build the Next.js app
./run.sh              # Start the public local test flow in one terminal
```

## How The Call Flow Works

1. A user chooses English or Japanese and enters a display name.
2. The creator calls `POST /api/rooms`.
3. The server creates a 6-character room ID, 4-digit room code, and host-only creator cookie.
4. The creator shares the 4-digit room code.
5. The guest opens the site, chooses a language, enters a name, and enters the 4-digit room code.
6. Both users grant microphone permission and are added to the call.
7. Socket.IO joins both participants into the room and exchanges WebRTC offer/answer/ICE signaling.
8. WebRTC sends audio peer-to-peer where the network allows it.
9. The host starts the subtitle service.
10. Each browser captures its own microphone audio, segments speech, and emits audio chunks to the server.
11. The server transcribes the speaker's audio, renders captions in each viewer's selected language, and sends a preview caption back to the speaker.

Remote audio is not transcribed. Each browser only submits its own local microphone audio.

If the host leaves, the room ends and the remaining participant is removed from the call.

## Video Calling Dormant Mode

The app is intentionally scoped to audio-only UI right now. Video/WebRTC camera logic still exists in the codebase, but it is marked dormant behind `videoCallingEnabled` in `components/CallRoom.tsx`.

If the user says **"enable video calling"**, that means:

- Flip the dormant video path back on.
- Restore camera permission copy and camera controls.
- Re-enable camera track acquisition in the media setup flow.
- Show local/remote video when tracks are present.
- Keep the audio/subtitle behavior unchanged.

Do not rebuild the feature from scratch; reuse the existing dormant video logic.

## Security And Privacy Notes

- The OpenAI API key is only used by server-side modules.
- Room state is in memory only.
- Room codes are never placed in URLs or localStorage.
- The room creator is identified by an HTTP-only cookie.
- Rooms expire after 4 hours.
- Invalid room-code attempts are rate-limited.
- Audio segment payloads are size-limited.
- Socket join, subtitle start, and audio events are rate-limited.
- `.env`, `.env.local`, build output, dependency folders, logs, and caches are ignored by Git.

## Cloudflare Domain And Tunnel Setup

Use this when you want a real HTTPS URL such as `https://call.example.com` for testing on iPhone Safari or with another person outside your network.

### 1. Add Your Domain To Cloudflare

1. Create or sign in to a Cloudflare account.
2. In Cloudflare, choose **Add a domain**.
3. Enter your domain, for example `example.com`.
4. Choose a plan.
5. Cloudflare will scan existing DNS records. Review and continue.
6. Cloudflare will show two assigned nameservers.

### 2. Change Nameservers At Your Domain Provider

1. Sign in to the company where you bought the domain, such as Namecheap, GoDaddy, Squarespace, Porkbun, or Google Domains/Squarespace Domains.
2. Open the domain's DNS or nameserver settings.
3. Choose custom nameservers.
4. Replace the existing nameservers with the two Cloudflare nameservers shown for your domain.
5. Save the change.
6. Return to Cloudflare and wait for the domain to become active.

Nameserver propagation can take minutes or hours depending on the registrar.

### 3. Create A Cloudflare API Token

Create a Cloudflare API token with permissions that can manage the zone DNS record and Cloudflare Tunnel configuration for your account.

The script needs:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_HOSTNAME`

You can find the account ID and zone ID in the Cloudflare dashboard. The hostname should be the full subdomain you want to use, for example:

```bash
CLOUDFLARE_HOSTNAME=call.example.com
```

### 4. Configure `.env.local`

```bash
OPENAI_API_KEY=sk-...
TRANSLATION_MODEL=gpt-4o-mini
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_HOSTNAME=call.example.com
CLOUDFLARE_TUNNEL_NAME=sakura-call
CLOUDFLARE_SERVICE_URL=http://localhost:3010
```

### 5. Install `cloudflared`

On macOS with Homebrew:

```bash
brew install cloudflare/cloudflare/cloudflared
```

Other installation methods are available from Cloudflare's `cloudflared` documentation.

### 6. Create Or Update The Tunnel And DNS Record

Run this once, and rerun it whenever you change the hostname, account, zone, tunnel name, or service URL:

```bash
npm run tunnel:setup
```

The script:

- Verifies the Cloudflare token.
- Finds or creates the named tunnel.
- Configures tunnel ingress for `CLOUDFLARE_HOSTNAME`.
- Replaces any existing DNS record for that hostname with a proxied CNAME to the tunnel.
- Prints the zone status, nameservers, hostname, service URL, tunnel name, tunnel ID, and DNS record.

### 7. Run The Public Local Site

Terminal 1:

```bash
npm run build
npm run start:public
```

Terminal 2:

```bash
npm run tunnel:run
```

Then open your configured hostname, for example:

```text
https://call.example.com
```

The public URL only works while the local app, the tunnel, and your computer are running.

You can also use the convenience script:

```bash
./run.sh
```

`run.sh` builds the app, starts the production server on port `3010`, starts the tunnel, and stops both processes when you press `Ctrl+C`.

## Testing With Another Person

1. Start the app and tunnel.
2. Open your Cloudflare hostname.
3. Choose `English` or `日本語`.
4. Enter your name.
5. Create a room.
6. Send the other person the 4-digit room code.
7. The other person opens the site, chooses their language, enters their name, and enters the code.
8. Both people allow microphone access and join.
9. The host starts the subtitle service.
10. Speak naturally. The main subtitle area shows the other person's translated speech, and the preview subtitle area shows what your speech looks like after translation.

If the host leaves, the other participant sees a `Call host has left` notice before returning to the home screen.

If the WebRTC media connection fails on a restrictive network, test again on a different network. This MVP uses STUN only; production reliability usually requires TURN.

## Limitations

- This is an MVP and not production deployment infrastructure.
- Room and participant state is in memory, so all rooms disappear when the server restarts.
- It supports only two participants.
- It supports only English and Japanese.
- It uses STUN only, not TURN.
- Restrictive NATs and firewalls may prevent peer-to-peer media.
- There is no database, user account system, monitoring, CI/CD pipeline, or production deployment target.
- Subtitle latency favors natural translation quality over immediacy and is expected to be a few seconds.

## Cost Notes

Costs depend on current model pricing, speech volume, silence, retry behavior, and call length.

This MVP uses:

- `gpt-4o-mini-transcribe` for transcription
- `gpt-4o-mini` by default for translation

Plan for API usage before hosting this for real users.

## Verification Checklist

- Select English or Japanese.
- Enter a display name.
- Create a room.
- Copy the 4-digit code.
- Join from a second browser or device.
- Confirm a third participant is blocked.
- Confirm the UI asks only for microphone access.
- Confirm microphone denial shows a localized error.
- Confirm English viewers receive English subtitles.
- Confirm Japanese viewers receive Japanese subtitles.
- Confirm `npm run lint`, `npm run typecheck`, and `npm run build` pass.

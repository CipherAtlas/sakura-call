# Privacy and Security Notes

Sakura Call is designed as a private, self-hosted, host-sized, peer-to-peer-first communication tool for developers. It is not designed as a general-public calling platform, account system, public room directory, or scalable meeting product.

## Current Privacy Model

- Audio, video, and screen sharing use WebRTC media transport between participating browsers.
- Calls try direct peer-to-peer connectivity first through STUN.
- TURN is a fallback relay. A TURN relay can see connection metadata such as IPs, ports, timing, and traffic volume, but WebRTC media remains encrypted at the media layer.
- Room state is in server memory and expires with the process or room cleanup. There is no account database, searchable room list, message database, or persistent call history.
- Room creation requires the owner session. Guests join through the 4-digit room code flow.
- The live captions feature is different from the WebRTC media path: when the host starts captions, each joined browser sends local microphone chunks to this server, then to the configured OpenAI API for transcription and translation. Caption text is then relayed to other participants and previewed locally.
- Captions are host-controlled for this private on-demand room. Each browser sends only its own microphone chunks while the caption service is running. Remote audio is not transcribed from another participant's browser.

## What Is Good Today

- The product scope is intentionally narrow: one owner-created room with an implicit 6-participant limit.
- Media is peer-to-peer first instead of server-mixed.
- Rooms, participants, failed join attempts, subtitle state, and room codes are in memory, not persisted to disk.
- Room codes are not placed in URLs or local storage.
- Owner and room creator privileges use HTTP-only cookies.
- The OpenAI API key stays server-side.
- The meeting UI separates the media-encryption boundary from the host-controlled captions/OpenAI processing boundary while captions are running.
- Cloudflare Realtime TURN credentials are generated server-side only for authenticated room participants. Calls remain peer-to-peer first and use TURN only when ICE needs relay fallback.
- On September 8, 2026, the refreshed dependency tree reported zero known vulnerabilities in `npm audit` and `npm audit --omit=dev`. This is a dated check, not a permanent security guarantee.

## Implemented Protections

- Socket.IO events after join are bound to the server-side socket participant session. WebRTC signaling, media state, language changes, subtitle controls, audio segments, and leave events no longer trust client-supplied `participantId`, `from`, or `roomId` as the authority.
- Successful joins now receive a server-issued participant session token. Rejoining an existing participant requires that token, so a client cannot reclaim a participant slot just by guessing or copying a `participantId`.
- Transient socket disconnects mark the participant offline instead of immediately freeing the identity. The participant can reclaim the same slot with the session token during the reconnect grace window.
- Socket.IO now rejects disallowed origins during the handshake.
- State-changing HTTP routes reject requests from disallowed `Origin` headers, and production also rejects missing-origin mutation requests.
- Allowed origins come from localhost defaults, `CLOUDFLARE_HOSTNAME`, and optional comma-separated `APP_ALLOWED_ORIGINS`.
- Dependencies were refreshed within Next.js 15; the PostCSS override follows the patched root version. Node.js 24 LTS is the documented and pinned runtime.
- HTTP and Socket.IO joins share an IP-based attempt budget that survives socket/participant-id replacement. Cloudflare client identity is accepted only through the local tunnel boundary.
- JSON bodies have size/time limits; unexpected HTTP errors receive a controlled response. Caption input must match the browser's PCM WAV format before reaching a provider.
- Caption requests have cancellation/deadlines and bounded concurrency. Stop/end/disconnect invalidates in-flight work; duplicate and superseded results are suppressed. A failed translation does not prevent other languages from receiving captions.
- HTTP responses set `nosniff`, `no-referrer`, `DENY` framing, and camera/microphone/display-capture/speaker-selection policies. The baseline CSP restricts base URLs, objects, and frame ancestors; it does not yet restrict scripts with nonces.
- API JSON responses use `Cache-Control: no-store`. TURN upstream failures return 503, and credential generation has a deadline.

## Remaining Risks And Priorities

### P0: Must Stay True For Safe Private Use

- Keep the deployment private and owner-operated. Do not add public room discovery, user accounts, queues, public meeting features, or long-lived service operation without a broader security review.
- Keep captions host-controlled and explicit in the meeting UI. When the host starts captions, each participant browser's local speech audio and transcript content leave that browser and are processed by the server and OpenAI.
- Keep Cloudflare TURN keys server-side. Browsers should receive only short-lived generated ICE credentials through the authenticated `/api/ice-servers` route.
- Keep `.env`, `.env.local`, Cloudflare tokens, OpenAI keys, and TURN key tokens out of git.

### P1: Should Do Before Presenting As A Serious Developer Tool

- Evaluate a nonce-based script CSP with browser verification of Next.js hydration, RNNoise WASM, media, and PiP. The current CSP deliberately covers base/object/framing restrictions only.
- Automated tests cover room/session/capacity rules, Socket.IO origin and host-only subtitle checks, reconnect throttling, malformed HTTP/audio input, caption cancellation/order, TURN route authority/failures/deadlines, and synthetic AudioWorklet output. Real-device media, relay-only calls, and live provider quality still need integration/manual verification.
- Add structured server logs that avoid transcript, audio, room code, token, and TURN credential content.
- Document OpenAI retention settings for the operator, including whether Zero Data Retention or modified abuse monitoring is enabled for the API organization.

### P2: Could Do For Stricter Privacy Deployments

- Add an optional deployment-controlled extra room secret while preserving the default 4-digit room code flow.
- Add TURN credential revocation for ended rooms if stricter relay cleanup is needed.
- Add an admin health page that exposes only operational status, never room codes, participant names, captions, tokens, or ICE credentials.
- Add automated dependency update checks in CI so audit drift is caught early.
- Add an explicit data-retention statement in the UI and README for captions, server memory, browser storage, TURN metadata, Cloudflare Tunnel, Cloudflare Realtime TURN, and OpenAI processing.

## Honest Positioning

The accurate positioning is: self-hosted, ephemeral, host-sized, peer-to-peer-first WebRTC calling with host-controlled AI captions.

Avoid claiming that the whole product is fully private or end-to-end encrypted in the same sense as a dedicated E2EE messenger. A precise claim is: audio, video, and screen sharing use encrypted WebRTC media transport between participating browsers, including when relayed through TURN; host-controlled captions/translations are not end-to-end encrypted because local microphone segments are processed by this server and OpenAI.

## Shared Chat And Requested File Downloads

Typed messages and attachment metadata pass through the authenticated room Socket.IO connection and are not end-to-end encrypted. With captions enabled, message text is sent to OpenAI for translation into recipient languages. Originals remain readable when translation fails. Server-side membership, text/file limits, send rate limits, and bounded translation concurrency apply.

File contents are retained in the sender's browser and transferred only after a recipient requests a download over encrypted WebRTC data channels. The server and OpenAI do not receive file contents; existing managed TURN can relay the encrypted transfer when a direct path fails. Each file is limited to 25 MiB; sender retention and simultaneous transfers are bounded. The UI renders filenames as text and saves received content as a download rather than executing or previewing it. Transfers stop when peer connections close; downloaded files remain under the recipient's control.

Chat and shared-file references are temporary. There is no disk-backed chat/file storage, account history, or history replay. Automated file-transfer checks use simulated data channels; actual cross-device downloads and translation-provider performance require a live manual check.

# Privacy and Security Notes

Sakura Call is designed as a private, self-hosted, host-sized, peer-to-peer-first communication tool for developers. It is not designed as a general-public calling platform, account system, public room directory, or scalable meeting product.

## Current Privacy Model

- Audio, video, and screen sharing use WebRTC media transport between participating browsers.
- Calls try direct peer-to-peer connectivity first through STUN.
- TURN is a fallback relay. A TURN relay can see connection metadata such as IPs, ports, timing, and traffic volume, but WebRTC media remains encrypted at the media layer.
- Room state is in server memory and expires with the process or room cleanup. There is no account database, searchable room list, message database, or persistent call history.
- Room creation requires the owner session. Guests join through the 4-digit room code flow.
- The live captions feature is different from the WebRTC media path: local microphone chunks are sent to this server, then to the configured OpenAI API for transcription and translation. Caption text is then relayed to other participants and previewed locally.
- Each browser must acknowledge the captions privacy notice before that browser starts sending microphone chunks for captions. Remote audio is not transcribed from another participant's browser.

## What Is Good Today

- The product scope is intentionally narrow: one owner-created room with an implicit 6-participant limit.
- Media is peer-to-peer first instead of server-mixed.
- Rooms, participants, failed join attempts, subtitle state, and room codes are in memory, not persisted to disk.
- Room codes are not placed in URLs or local storage.
- Owner and room creator privileges use HTTP-only cookies.
- The OpenAI API key stays server-side.
- The meeting UI separates the media-encryption boundary from the optional captions/OpenAI processing boundary before captions are enabled.
- Cloudflare Realtime TURN credentials are generated server-side only for authenticated room participants. Calls remain peer-to-peer first and use TURN only when ICE needs relay fallback.
- The production dependency audit currently reports no vulnerabilities after updating the PostCSS dependency used by Next through npm overrides.

## Changes In The Current Hardening Pass

- Socket.IO events after join are bound to the server-side socket participant session. WebRTC signaling, media state, language changes, subtitle controls, audio segments, and leave events no longer trust client-supplied `participantId`, `from`, or `roomId` as the authority.
- Successful joins now receive a server-issued participant session token. Rejoining an existing participant requires that token, so a client cannot reclaim a participant slot just by guessing or copying a `participantId`.
- Transient socket disconnects mark the participant offline instead of immediately freeing the identity. The participant can reclaim the same slot with the session token during the reconnect grace window.
- Socket.IO now rejects disallowed origins during the handshake.
- State-changing HTTP routes reject requests from disallowed `Origin` headers, and production also rejects missing-origin mutation requests.
- Allowed origins come from localhost defaults, `CLOUDFLARE_HOSTNAME`, and optional comma-separated `APP_ALLOWED_ORIGINS`.
- Dependencies were refreshed within the current framework line, and `postcss` is forced to the patched root version through `overrides`.

## Remaining Risks And Priorities

### P0: Must Stay True For Safe Private Use

- Keep the deployment private and owner-operated. Do not add public room discovery, user accounts, queues, public meeting features, or long-lived service operation without a broader security review.
- Keep captions opt-in per browser. When captions are enabled, that browser's speech audio and transcript content leave the browser and are processed by the server and OpenAI.
- Keep Cloudflare TURN keys server-side. Browsers should receive only short-lived generated ICE credentials through the authenticated `/api/ice-servers` route.
- Keep `.env`, `.env.local`, Cloudflare tokens, OpenAI keys, and TURN key tokens out of git.

### P1: Should Do Before Presenting As A Serious Developer Tool

- Add a `Content-Security-Policy`, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, and a camera/microphone/screen-share `Permissions-Policy`.
- Add focused tests for room join, invalid session token rejection, reconnect reclaim, room-capacity enforcement, origin rejection, and host-only subtitle/TURN controls.
- Add structured server logs that avoid transcript, audio, room code, token, and TURN credential content.
- Document OpenAI retention settings for the operator, including whether Zero Data Retention or modified abuse monitoring is enabled for the API organization.

### P2: Could Do For Stricter Privacy Deployments

- Add an optional deployment-controlled extra room secret while preserving the default 4-digit room code flow.
- Add TURN credential revocation for ended rooms if stricter relay cleanup is needed.
- Add an admin health page that exposes only operational status, never room codes, participant names, captions, tokens, or ICE credentials.
- Add automated dependency update checks in CI so audit drift is caught early.
- Add an explicit data-retention statement in the UI and README for captions, server memory, browser storage, TURN metadata, Cloudflare Tunnel, Cloudflare Realtime TURN, and OpenAI processing.

## Honest Positioning

The accurate positioning is: self-hosted, ephemeral, host-sized, peer-to-peer-first WebRTC calling with optional AI captions.

Avoid claiming that the whole product is fully private or end-to-end encrypted in the same sense as a dedicated E2EE messenger. A precise claim is: audio, video, and screen sharing use encrypted WebRTC media transport between participating browsers, including when relayed through TURN; optional captions/translations are not end-to-end encrypted because local microphone segments are processed by this server and OpenAI.

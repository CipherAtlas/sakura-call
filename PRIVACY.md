# Privacy and Security Notes

Sakura Call is designed as a private, self-hosted, two-person, peer-to-peer-first communication tool for developers. It is not designed as a general-public calling platform, account system, public room directory, or scalable meeting product.

## Current Privacy Model

- Audio, video, and screen sharing use WebRTC media transport between the two browsers.
- Calls try direct peer-to-peer connectivity first through STUN.
- TURN is a fallback relay. A TURN relay can see connection metadata such as IPs, ports, timing, and traffic volume, but WebRTC media remains encrypted at the media layer.
- Room state is in server memory and expires with the process or room cleanup. There is no account database, searchable room list, message database, or persistent call history.
- Room creation requires the owner session. Guests join through the 4-digit room code flow.
- The live captions feature is different from the WebRTC media path: local microphone chunks are sent to this server, then to the configured OpenAI API for transcription and translation. Caption text is then relayed to the other participant and previewed locally.

## What Is Good Today

- The product scope is intentionally narrow: one owner-created room and a hard two-person participant limit.
- Media is peer-to-peer first instead of server-mixed.
- Rooms, participants, failed join attempts, subtitle state, and room codes are in memory, not persisted to disk.
- Room codes are not placed in URLs or local storage.
- Owner and room creator privileges use HTTP-only cookies.
- The OpenAI API key stays server-side.
- The fallback TURN relay is intended to be started only when needed and stopped on exit.
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

- Keep the deployment private and owner-operated. Do not add public room discovery, user accounts, queues, group calls, or long-lived service operation without a broader security review.
- Keep captions opt-in. When captions are enabled, speech audio and transcript content leave the browser and are processed by the server and OpenAI.
- Keep the TURN relay ephemeral and guarded. TURN should start only when needed, use non-default credentials, and stop when the call ends.
- Keep `.env`, `.env.local`, OCI keys, Cloudflare tokens, OpenAI keys, TURN passwords, and SSH keys out of git.

### P1: Should Do Before Presenting As A Serious Developer Tool

- Add a visible in-app captions privacy notice before starting the subtitle service.
- Add a `Content-Security-Policy`, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, and a camera/microphone/screen-share `Permissions-Policy`.
- Add focused tests for room join, invalid session token rejection, reconnect reclaim, two-person enforcement, origin rejection, and host-only subtitle/TURN controls.
- Add structured server logs that avoid transcript, audio, room code, token, and TURN credential content.
- Document OpenAI retention settings for the operator, including whether Zero Data Retention or modified abuse monitoring is enabled for the API organization.

### P2: Could Do For Stricter Privacy Deployments

- Add an optional deployment-controlled extra room secret while preserving the default 4-digit room code flow.
- Add short-lived TURN credentials generated per room/session instead of any static browser-visible TURN credential.
- Add an admin health page that exposes only operational status, never room codes, participant names, captions, tokens, or ICE credentials.
- Add automated dependency update checks in CI so audit drift is caught early.
- Add an explicit data-retention statement in the UI and README for captions, server memory, browser storage, TURN metadata, Cloudflare Tunnel, OCI, and OpenAI processing.

## Honest Positioning

The accurate positioning is: self-hosted, ephemeral, two-person, peer-to-peer-first WebRTC calling with optional AI captions.

Avoid claiming that the whole product is fully private or end-to-end encrypted in the same sense as a dedicated E2EE messenger. The WebRTC media path is encrypted and peer-to-peer first, but signaling, TURN metadata, room state, and AI captions each have their own privacy boundaries.

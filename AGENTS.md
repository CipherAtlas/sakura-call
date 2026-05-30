# Agent Instructions

- Unless the user explicitly asks for a visual pass, do not start or run the dev server just to inspect the app visually.
- For normal implementation work, verify with non-visual checks such as lint, typecheck, build, and relevant tests.
- Only run the server for browser-based or visual verification when the user asks for a visual pass or specifically requests live/manual inspection.
- Before making code edits, ask for the user's approval and wait for confirmation. Only edit code after the user approves the change.
- This is a private, on-demand communication tool for the owner and invited participants, not a scalable or widely available calling product.
- Preserve the implicit 6-person room limit. Do not add queues, public room discovery, user accounts, or scalability work unless explicitly requested.
- The intended runtime model is: start everything when needed, use the call, then stop everything immediately. `run.sh` should bring up the app and Cloudflare Tunnel, then tear them down on exit.
- Cloudflare Tunnel exposes the HTTP app only. Browser media remains peer-to-peer first through WebRTC ICE, with Cloudflare Realtime TURN credentials generated server-side as the managed fallback when configured.
- Do not reintroduce self-hosted TURN infrastructure, cloud TURN VMs, public room discovery, user accounts, queues, or scalability work unless explicitly requested.
- The intended product supports audio calls, video calls, and screen sharing in the UI. Do not describe video as dormant or audio-only.
- Preserve the current soft sakura/garden aesthetic unless the user explicitly asks to replace it; improve UX within that visual direction.
- The conversation/captions section must always remain visible in the meeting UI, including during audio calls, video calls, and screen sharing.
- The normal join flow is: choose language, choose name, enter the 4-digit room code, allow the needed media permissions, then join the room. Do not reintroduce invite links unless explicitly requested.

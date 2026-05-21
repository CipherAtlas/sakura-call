# Agent Instructions

- Unless the user explicitly asks for a visual pass, do not start or run the dev server just to inspect the app visually.
- For normal implementation work, verify with non-visual checks such as lint, typecheck, build, and relevant tests.
- Only run the server for browser-based or visual verification when the user asks for a visual pass or specifically requests live/manual inspection.
- Before making code edits, ask for the user's approval and wait for confirmation. Only edit code after the user approves the change.
- The product is currently audio-only in the UI. Video calling logic is intentionally dormant, not deleted.
- If the user says "enable video calling", reuse the dormant video path in `components/CallRoom.tsx`: restore camera permission copy and controls, re-enable camera track acquisition, and show local/remote video tracks without rebuilding the feature from scratch.
- The normal join flow is: choose language, choose name, enter the 4-digit room code, allow microphone permission, then join the room. Do not reintroduce invite links unless explicitly requested.

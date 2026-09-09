# Sakura UI rework

Approved: September 9, 2026. Implement the reviewed Sakura Paper visuals with Petal Studio mobile controls and selective Garden Window artwork, including the entry and pre-call lobby.

Visual sources: `/Users/sabar/.codex/visualizations/2026/09/08/01a0823d-77ef-7ca0-ac84-924772468651/` (Sakura Paper desktop/mobile, Petal Studio mobile menu, Garden Window audio).

Constraints: existing production app and calling behavior; six-person private rooms; language → name → code → permissions → join; visible conversation at all times; no dependency, backend, deployment, or credential changes. Existing uncommitted work predates this task and must be preserved.

Asset inventory: one generated watercolor garden, reused in lobby and audio backgrounds. Real participant media remains live; do not generate fake people or bake UI text into assets. Existing Lucide icons match the selected thin rounded icon language. DM Sans is self-hosted with its OFL license.

Acceptance: responsive lobby and setup; fixed six-button mobile dock; all secondary tools available; presets-first sharing; persistent conversation; accurate host exit; keyboard focus; dark/reduced-motion support. Verify lint, typecheck, relevant tests, build, browser interactions and visual comparisons, plus actual iPhone Simulator Safari. Document evidence and remaining limitations in `design-qa.md`.

Status: initial redesign and desktop/light-default iterations are built locally. The latest speaking animation, caption badge, More anchor, and laptop receive-audio fixes are implemented and verified in isolation, but await a safe production-preview rebuild/restart. Do not interrupt an active call to apply them. See `design-qa.md` for evidence and limits.

Final interaction decisions: More opens above its own button, aligned to its right edge on desktop and clamped inside the mobile viewport, without changing media/conversation bounds. The lobby Audio & devices button stays in place and opens a scrollable panel upward. Speaking animates the center avatar, respecting reduced motion. Final captions remain visible without a Final/確定 status badge. Nonblocking camera, screen-share, and floating-caption notices dismiss after five seconds; joining failures remain visible. Light is the default; explicit saved theme preferences are respected. No deployment or dependency changes were made.

## Audio receive reliability and Japanese

Boosted remote playback keeps a muted native receiver element alive so Chromium decodes the remote WebRTC stream before Web Audio gain processing. The receiver is released with the boost controller. Playback resynchronizes when tracks arrive/unmute and retries on user interaction. Adjacent audio/video arrivals share participant streams before React commits.

Japanese has all 262 active UI translations after removal of unused keys. Isolated browser QA verified Japanese name submission, final caption content without the status badge, desktop/mobile More placement and readable labels, and upward device-menu opening/Escape dismissal. Actual Japanese speech recognition/translation and the user's phone-to-laptop listening retest remain unverified in this iteration.

## Desktop page integration

At widths above 900px, language, name, and room entry use a full-width site header and an open split page with the garden illustration. The pre-call lobby shares the header and uses the page canvas without a surrounding card. Mobile styles remain unchanged. Implementation is scoped to `app/paper.css`.

Permission action: use a primary pink button, never toggle/off styling. Keep white text and full background opacity while requesting media access, including hover, dark theme, and Japanese labels.

Conversation reading order: show the translation matching the viewer's chosen language first and the original below in smaller muted text. If the original already matches, the translation is empty, or the available translation targets a different language, show the original once. Local messages use right-aligned soft-pink bubbles; remote messages use left-aligned bordered bubbles. Keep speaker names and times, including group calls. These conversation changes await the next safe rebuild/reload.

Caption service control: the host sees one rounded icon button combining status and toggle action (Captions off/on; 字幕オフ/オン). It turns sage when active and disables while starting. Guests retain a read-only status; host-only caption authority is unchanged. Both conversation placements share the same control.

Deafen is now a primary bottom-bar control beside Mic on desktop and mobile, using the existing handler, pressed state, and localized labels. It is removed from More. The mobile dock has six columns, with tighter spacing on narrow phones. Do not restart the server for this change, per the user's instruction.

Button polish: shared action icons use rounded 1.5px strokes. Icon-only close buttons use a 44px circular target, 19px icon, 12px inner padding, and 4px outer spacing, with a soft rose hover surface. Text-labeled exit controls retain their layout. More rows have rounded hover surfaces and gentler spacing. Existing keyboard outlines and reduced-motion behavior remain.

## Verified unused-code cleanup

Removed the unreferenced standalone SubtitlesPanel component (ConversationPanel remains), its obsolete final-caption props and redundant local/remote caption state, hidden entry artwork, and its unused icon import. Removed 386 CSS selector branches for retired UI classes, one unused keyframe, and 61 unused translation keys (275 localized entries across dictionaries). English and Japanese retain matching coverage for all 262 active keys. Dynamic layout/status classes and Next.js convention-based exports were preserved.

Validation: lint, TypeScript with noUnusedLocals/noUnusedParameters, 36 tests, and a production build in an isolated temporary copy passed. Sampled entry/call/menu geometry and visual styles matched before and after CSS cleanup at desktop/mobile widths. This is a conservative static audit; retained legacy CSS may still contain cascade overrides that need separate visual analysis before consolidation. No dependencies, server restart, or deployment changed.

## Current mobile screen-sharing milestone

Implemented and production-built the iPhone 14 screen-sharing redesign: external screen header, zoom/pan/reset, compact participant chips, persistent conversation in both orientations, reachable fullscreen exit/mixer, and Safari keyboard-aware layout. Native Simulator and browser evidence, including the remaining final native-retest boundary caused by the Mac locking, is recorded in `design-qa.md`. The temporary test server is stopped; the current checkout is ready for the next normal `run.sh` startup. Earlier notes about avoiding a restart were superseded by the user's explicit authorization for this test session.

# Sakura redesign QA

Date: 2026-09-09

## Result

final result: passed

No remaining actionable P0/P1/P2 visual findings in the exercised scope. This is a redesign of the existing calling application, not a pixel clone or a static prototype.

## Visual truth and comparisons

Evidence directory: `/Users/sabar/.codex/visualizations/2026/09/08/01a0823d-77ef-7ca0-ac84-924772468651/`.

Selected direction: `sakura-paper-desktop.png` and `sakura-paper-mobile.png`, with the secondary controls from `petal-studio-mobile.png` and botanical imagery from `garden-window-desktop.png`. Each source is 1672 × 941 pixels. The user's later instructions supersede the mock's menu positioning: More must float without reflow, and the lobby device menu must open upward above its stationary button.

Rendered implementation: `http://localhost:3010`, production build, existing home and room routes.

- `final-audio-desktop.png`: 1672 × 941 CSS/pixels, density 1, two connected audio-only test participants, light theme, captions off.
- `final-call-mobile.png` and `final-more-mobile.png`: 390 × 844 CSS/pixels, density 1, same audio-only state.
- `final-precall-desktop.png`, `final-precall-mobile.png`: 1440 × 900 and 390 × 844, ready-to-join lobby.
- `final-devices-up-desktop.png`, `final-devices-up-mobile.png`: upward device selector overlay.
- `final-iphone-precall.png`, `final-iphone-devices-up.png`: actual iPhone 17 Pro Simulator, iOS 26.2 Safari; native simulator screen capture including Safari chrome.

Combined comparison inputs were generated and opened, not judged from separate screenshots:

- `comparison-paper-desktop.png`: primary reference and actual desktop, each downsampled to 836 × 471, side by side.
- `comparison-audio-desktop.png`: secondary garden reference and actual desktop at the same normalization. Only the garden art direction is adopted from this alternative; its serif typography and bottom conversation layout are not the selected Paper design.
- `comparison-mobile.png`: source mobile artboard cropped at x573/y0, 528 × 941, fitted without stretching into 390 × 844; actual mobile at 390 × 844 alongside it. Source artboard proportions differ from an actual iPhone browser viewport; padding from normalization is not scored as drift.
- `comparison-controls.png`: focused, enlarged source and actual mobile dock, normalized to 503 × 150 per side for icon/label inspection.

State differences are intentional: references contain three illustrative people and sample captions; live captures use two test participants with cameras off and an honest empty conversation. Real participant streams replace generated portraits. The unused decorative fourth reference tile was not implemented. Existing five layout choices remain available rather than hard-coding the mock's participant arrangement.

## Comparison history and resolved findings

1. Initial responsive review: inherited theme rules obscured the new garden artwork and made dark primary text low contrast. The common paper tokens, primary foreground color, background resets, and unclipped image treatment corrected this. Entry and dark captures document the result.
2. [P2] Pre-call controls overlapped and the microphone-test button squeezed its label. Old fixed heights, grid rows, and button widths were removed from the redesigned setup layout. `final-precall-mobile.png` and `final-iphone-precall.png` show separated controls and a reachable Join Call action.
3. [P2] Initial mobile More implementation resized the conversation/media areas. Replaced with an absolute foreground panel above the dock; captions remain mounted. Measured workspace bounds before/after opening were identical: x8/y74/w374/h683 at 390 × 844. `final-more-mobile.png` shows the revised overlay.
4. [P2] Device disclosure expanded downward. Replaced with `DeviceMenu`, positioned above the original button with bounded scrolling, outside-click dismissal, and Escape dismissal. Measured mobile button bounds stayed x24.109/y607.547/w341.781/h56 before and after opening; the panel's bottom was above the button. Desktop panel remained inside the viewport. `final-iphone-devices-up.png` verifies the same behavior in Safari.
5. [P2] Persistent camera-unavailable notices consumed space after fallback succeeded. Nonblocking media notices now clear after 5000 ms with timer cleanup. Browser polling observed removal at 5311 ms; Join Call remained enabled. The warning appeared and disappeared in the actual simulator. Join-blocking errors remain visible.
6. [P2] First combined comparison showed legacy square avatar backgrounds. `comparison-mobile-before-avatar-fix.png` records this finding. Corrected the high-specificity legacy tile rule; final computed radii are 50%, and the reopened `comparison-mobile.png` and `comparison-controls.png` confirm the correction and final dock.

## Required fidelity surfaces

- **Typography:** self-hosted DM Sans supplies the rounded, readable sans-serif direction of Sakura Paper. Existing Lucide icons retained. Display headings use restrained weights; forms remain at least 16 px to avoid iPhone focus zoom. Small dock labels are accompanied by full accessible button names and 56 px mobile controls. No heading-preface/kicker labels were introduced.
- **Spacing/layout:** shared paper frame, 12–22 px control/card radii, consistent rose borders, compact header, persistent conversation, and a five-action mobile dock. Mobile gallery uses two columns when multiple participants are present. Desktop retains side-by-side media and conversation. Menus overlay rather than reflow the primary regions.
- **Colors/tokens:** ivory, white, plum, blush, and sage map to the chosen references. Dark mode uses corresponding plum surfaces and a dark foreground on pale primary actions. Semantic red is reserved for leaving; focus rings are deliberately stronger than the reference for keyboard visibility.
- **Image quality:** one generated watercolor garden, encoded as WebP, is reused in entry/setup and audio-only tiles. Crop and resolution were checked in desktop/mobile captures. Existing live video and library icons remain real app content; no generated portraits or rasterized interface text were added.
- **Copy/content:** language/name/code flow preserved, actual participant identity and state labels retained, honest empty conversation, host exit explicitly says it ends the room for everyone. No fake captions or chat composer. Voice/device controls remain functional.

## Verification

- `npm run typecheck`: passed.
- `npm run lint`: passed without warnings.
- `npm test`: all 36 existing tests passed, covering media capture, caption ingress, room capacity, session/signaling safety, host closure, and TURN routes.
- `npm run build`: passed for the final source, including TypeScript and lint validation.
- Browser: language/name/code entry; authenticated host creation; media preparation; two- and three-participant sessions; mute/camera/deafen controls; mixer; voice/device settings; all five layouts; settings/theme changes; conversation overlay; fullscreen/exit; share presets/manual disclosure; host and guest leave confirmations.
- Screen-share UI used a local synthetic canvas stream. This verifies layout/control behavior, not actual OS capture or screen-audio quality.
- More and device menus were measured for zero layout movement. Device menu closes with Escape. Modal Tab wraps inside the dialog. Reduced-motion mode computed a 0.001-second animation duration. No production page errors were captured in the final browser run.
- Actual iPhone Simulator Safari: entry forms, software keyboard, room-code submission, permission flow, pre-call camera-off fallback, Join Call, connected participant count, mobile dock, foreground More, upward device panel, transient notice removal, and guest return to room entry after host ended the call.
- Viewports exercised: 390 × 844, 844 × 390 landscape, 1440 × 900, and 1672 × 941, plus the native iPhone Simulator viewport. No horizontal overflow in the five desktop layout checks.

## Limits

Simulator camera capture was unavailable. Microphone acquisition after a fresh permission grant occasionally needed a retry; retry succeeded. Physical iPhone camera/microphone quality and inter-network TURN fallback were not revalidated by this UI pass. Live paid caption processing was left off; existing caption tests passed. The reference's populated transcript styling therefore has code/test coverage but no new live-provider visual proof.

No dependency, backend/infrastructure, deployment, credential, or Git-history changes were made for the redesign. Pre-existing uncommitted changes were preserved; UI review used copies saved before implementation as the diff baseline.

## Implementation checklist

- [x] Cohesive Sakura entry and pre-call lobby
- [x] Responsive meeting UI with persistent conversation
- [x] Fixed mobile controls and foreground More
- [x] Upward lobby device menu
- [x] Five-second nonblocking notices
- [x] Keyboard, reduced-motion, light/dark checks
- [x] Browser and actual Simulator verification
- [x] Production build and existing tests

## Desktop page iteration — September 9

User requested an integrated desktop website instead of a centered dialog frame. Updated the existing design at widths above 900px: full-width header, open entry canvas, and unframed lobby content. The user's new layout direction supersedes the original desktop card reference.

Verified production build (including lint/type checks), whitespace diff, entry progression, private room creation, media-ready lobby, joining and ending the temporary room. Inspected desktop 1440x900, laptop 1024x768, and mobile 390x844; no horizontal overflow. The laptop device menu remained above its button and within the viewport (top 16px). Mobile retains its existing card layout; this iteration used browser mobile emulation, with native iPhone Simulator evidence from the preceding redesign still recorded above.

Artifacts in the existing visualization directory: `site-entry-desktop.png`, `site-laptop.png`, `site-lobby-desktop.png`, and `site-mobile-regression.png`. Both temporary test rooms were ended. No deployment or dependencies changed.

## Speaking, menu, and laptop receive fixes — September 9

Restored a pulsing center avatar while the existing speaking state is active; reduced-motion preferences still apply. Removed the Final status badge from subtitle/conversation headers. Positioned More above its own trigger, right-aligned on desktop and clamped within the mobile viewport.

Reproduced silent laptop receive with an isolated Chromium WebRTC tone sender and the real CallAudioSink: incoming packets increased but decoded samples/output RMS were zero when the remote stream was routed straight into the boost graph. Starting a muted native receiver element enabled decoding. Added that element to the boost controller with release cleanup. Retest with the corrected component and no manual workaround produced output RMS 0.6776 and playing/unmuted sink state. Also verified gesture recovery after paused playback. Sink now responds to track signature changes, track unmute, and stream track events. Track arrival stores participant streams immediately so successive audio/video events share them before React commits.

Typecheck, lint, all 36 existing tests, and diff whitespace checks passed. Isolated browser checks verified speaking animation, desktop More alignment, and mobile viewport containment. These are synthetic browser audio measurements, not a completed phone-to-laptop listening test. The running production server was intentionally not rebuilt/restarted while the user's room remained active; source changes await a safe restart.

## Japanese verification and documentation — September 9

Compared English/Japanese dictionaries: 323 keys each, no missing Japanese values. Ran current components with current CSS in an isolated Chromium harness at 1440x900 and 390x844, leaving the active production room untouched. Submitted the Japanese name `さくら 太郎` with Enter and confirmed it was preserved. Rendered Japanese final caption text and verified that no Final/確定 badge remained. Inspected Japanese More labels and measured that the panel opens above the button and stays within the mobile viewport with no horizontal page overflow. Verified Japanese device-menu text, upward positioning after its opening animation, and Escape dismissal. Screenshots: `japanese-controls-desktop.png`, `japanese-controls-mobile.png`, `japanese-devices-mobile.png` in the existing visualization directory.

Updated README and UI_REWORK with interaction decisions, light default, receive-audio behavior, and the pending restart boundary. Diff whitespace check passed. This is UI/component verification with caption fixtures, not live Japanese transcription/translation, native Japanese IME composition, or a physical phone-to-laptop listening test. No server restart or deployment was performed.

## Permission button contrast — September 9

Removed toggle/off-state classes from the media-permission action and made it a primary button. Scoped its pink background, white text, and full opacity across idle, hover, and disabled/loading states in both themes; Japanese loading labels can wrap. Isolated Chromium computed-style checks verified RGB(154,54,91) background, white text, and opacity 1 for enabled/disabled hover in light and dark. Typecheck passed. This change joins the pending safe rebuild/restart; the active server was not interrupted.

## Translation-first conversation — September 9

Changed the shared conversation renderer so a translation into the current viewer language is the primary text, with the source beneath. Same-language and duplicate text render once; missing/current-language-unavailable translations fall back to the original. Added semantic language attributes. Removed language-preface labels. Local and remote turns now use right/left aligned Sakura bubbles with speaker/time metadata.

Isolated Chromium at 390x844 verified the user's English/Hindi example: English translation above Hindi source, with no duplicate local text or horizontal overflow. Japanese viewer test verified Japanese primary text and English source. Typecheck and lint passed. Artifacts: `conversation-translation-first-mobile.png` and `conversation-japanese-first-mobile.png` in the existing visualization directory. No live server restart was performed; real caption provider behavior was not exercised.

## Unified caption control — September 9

Replaced the separate caption status and Start/Stop button with one icon/status toggle shared by the main and overlay conversation panels. Uses existing English/Japanese labels, pressed and busy semantics, a pink off state, and sage on state. Guests still see status only. Typecheck passed; no live caption-provider start was triggered and no server restart was performed.

## Deafen in bottom bar — September 9

Moved Deafen out of More and next to Mic in the primary dock. Reused existing deafen/undeafen behavior and English/Japanese labels. Isolated component QA verified toggled pressed state, six visible mobile controls, no Deafen duplicate in More, and no horizontal overflow at 390px, 320px, and 1024px. Narrow-phone spacing provides a 44.7px button width in a 288px dock. Typecheck, lint, and diff whitespace checks passed. Server not restarted, as requested.

## Shared icon/button polish — September 9

Refined shared button icon strokes and transitions; icon-only X buttons have a quiet circular treatment, 44px targets, 12px padding, and 4px margins. Text-bearing fullscreen exit buttons are excluded from the square sizing. More menu rows use rounded hover surfaces instead of stacked dividers. Isolated Japanese mobile menu inspection verified dimensions, 1.5px strokes, padding/margins, and successful close action. Screenshot: `sleek-controls-mobile.png`. Lint and diff whitespace checks passed. Server not restarted.

## Unused-code cleanup — September 9

Audited references across app/components/lib/server/scripts/public, distinguishing literal classes from dynamic layout/status classes and Next convention-based exports. Removed the unused standalone subtitle renderer, unused final-caption props/state and hidden entry art, 386 unreachable CSS selector branches, one unreferenced keyframe, and 61 unused translation keys (275 dictionary entries). Public types/helpers with internal uses were retained. Active transcript logs and conversation rendering remain.

Validation passed: ESLint; TypeScript with noUnusedLocals and noUnusedParameters; all 36 existing tests; production build in a separate temporary copy with no environment file and a shared node_modules symlink. The running server and its .next directory were not rebuilt or restarted. Isolated browser comparisons using freshly compiled before/after styles found identical settled geometry and computed colors/fonts/borders for mobile/desktop name entry, desktop call controls, and desktop/mobile More menus. Initial mobile comparison ran during initial layout settling; repeating after settling matched. English/Japanese dictionaries both have 262 keys, with no Japanese omissions. Diff whitespace check passed.

Remaining scope boundary: this removes verified unreachable code, not every overridden legacy declaration. No real provider or physical-device audio retest was performed for this cleanup.

## iPhone 14 screen-sharing UX — September 9

Replaced the overlaid screen label with a separate compact header and added 2× zoom, bounded dragging, double-tap reset, and keyboard controls. Mobile participant previews become a 44px horizontal chip row. Fullscreen keeps conversation below the screen in portrait and beside it in landscape, with a persistent exit and reachable mixer. Visual viewport handling keeps the composer above Safari's keyboard; participant chips and the main header collapse while typing. Fixed implicit landscape grid columns, stretched chip avatars, clipped chip corners, and conflicting mixer top/bottom positioning found during testing.

Verification:
- Actual iPhone 14 Simulator (iOS 26.2, 390×844 device) received a synthetic 1920×1080 canvas screen over real WebRTC from Chromium. Inspected regular and fullscreen portrait/landscape, native zoom, software-keyboard opening/dismissal, and a sent message received by the other browser. Simulator microphone was a silent AudioContext stream in a temporary QA-only route; production source has no QA route or synthetic media.
- Chromium mobile checks at 390×664, 390×844, and 844×390; desktop at 1440×900. Checked conversation/composer containment, no horizontal page overflow, participant switching and return to screen, double-tap zoom/reset, bounded pan, dark theme/reduced motion, and mixer scrolling.
- Actual 25 MiB P2P download returned 26,214,400 correct bytes. Observed the circular progressbar before completion. A small text-file download also matched its source.
- Share settings at 390×664: advanced content scrolled to its full 581px range, footer actions remained reachable, Motion selected 1080p / 60 fps / 8.5 Mbps, and the removed 4K disclaimer was absent.
- The final keyboard blur regression was checked with simulated Safari viewport values: keyboard layout remained active after textarea blur, Send stayed at exactly the same bounds, and the message arrived. The Mac locked before repeating this final adjustment natively. The mixer correction and final chip clipping polish were verified in Chromium after the native pass.
- Lint, typecheck, all 44 tests, whitespace checks, and the production build in the actual checkout passed. The temporary test server was stopped after verification. No dependencies, credentials, tunnel configuration, or deployment changed.

Evidence directory: `/Users/sabar/.codex/visualizations/2026/09/09/01a084c9-ae7e-7160-8a88-be6919178267/iphone14-screen-share/`. Native screenshots: `native-keyboard.png`, `native-fullscreen.png`, `native-landscape-fullscreen.png`. Browser evidence includes portrait, landscape, dark fullscreen, desktop, and advanced settings images. These checks do not establish physical-device audio quality, live caption-provider output, or remote-network throughput.

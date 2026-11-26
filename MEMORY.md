# MEMORY — Meridian Air (fitbit-bio-dashboard)

Handoff for any LLM working here. The owner switches models often: **run `git pull` first**, then update this file when done.

## Facts
- Repo: https://github.com/Zurplox/fitbit-bio-dashboard (public). Live: https://zurplox.github.io/fitbit-bio-dashboard/ — encrypted vault; only the lock screen is visible without the passphrase.
- Stack: Python pipeline (Google Health API v4; old Fitbit API gone since 2 Nov 2026) → deterministic rule engine → AES-256-GCM `data/biometrics.enc.json` → static `index.html` + `assets/app.js` + `assets/theme.css`. `assets/charts.js` was deleted; charts are inline SVG/HTML.
- Docs: `README.md`, `ARCHITECTURE.md` (ownership and payload contract), `DESIGN_SYSTEM.md` (current visual direction).
- Daily sync: `.github/workflows/daily_sync.yml`, 08:00/08:30 SGT. Refresh token expires after 7 days while the OAuth app is unpublished; reauthorise with `scripts/authorize.py`. Optional `ATHLETE_AGE` secret; profile currently supplies age 29.
- Tests: `python -m unittest discover -s tests -t . -v`; `node --check assets/app.js`. Bump the cache-buster in `index.html` after CSS/JS changes.
- Demo: `python demo_data.py` then `DASHBOARD_PASS=meridian-demo python encrypt_data.py`. Restore with `git checkout -- data/` before committing.
- Vault passphrase is saved in OpenChamber project secrets; use `secret.run`, never print it.

## Source views
- Vault is an envelope with `views.fitbit` (default) and `views.all`; each is a complete payload built by `sync.build_payload()`. `filter_fetched()` keeps points whose `dataSource` is Fitbit; rollups (steps, calories, active minutes, intraday HR) are withheld from the Fitbit view because they merge devices.
- Toolbar selector `sourceSelect` persists to `ma-source`. Legacy vaults without `views` still render, with the selector hidden.

## Design direction
Consumer fitness app: quiet top bar, hero with three rings (Recovery, Sleep, Training load), self-hosted Manrope (OFL licence in `assets/fonts/`), one chart moment (workout zone ribbon), no runtime font request, no gradients/glow/emoji. Details are flat rows in a few rounded cards. Phone gets a floating glass tab bar. Theme switch is a View Transitions circle sweep.

## Metric rules
- Missing metrics are omitted, never shown as zero or `--`.
- No insulin/glucose prediction: WEAR-ME (Nature 2026) needed blood tests. No walking steadiness, gait, Body Battery or stress score — not available from the API.
- VO₂ max is estimated with Uth 2004 because this account returns no `daily-vo2-max` points. Skin temperature deviation comes from `daily-sleep-temperature-derivations`.
- Training effect is relative 0–5 from heart-rate-zone minutes; light-zone minutes count zero.
- Every metric needs a `HELP` entry for its `i` button.

## Real account notes
- Fitbit Air plus Garmin Connect and Google Fit relayed by Health Connect. HRV only since ~13 Nov, so HRV status appears around 7 Dec. No height in profile, so no BMI.
- The API once sent NaN skin temperatures; `_num` drops non-finite values and sync writes `allow_nan=False`.

- Final craft audit: defined `--chart` alias so the load ring is blue when optimal; fixed sync dot classes; base desktop styling for baseline rows; AA contrast for faint text; guard against NaN thirds with <3 samples; skip empty readouts; guard empty hero title; help popover is a live region with `aria-describedby`; gauge fill uses solid spans instead of a gradient; focus shows a coaching card title, not a raw key. Docs token table refreshed.

- HR ribbon is scrubbable: pointer hover/drag with capture, touch drag via pointer events, and arrow/Home/End/Escape keys. Tooltip shows minute, bpm and zone; crosshair is SVG line + dot. `bindHrScrub()` is called after Activity renders.

- Recovery factors are now an untidy stacked deck under the rings. `bindFactorDeck()` manages order, click-to-front and drag-to-back; CSS `--stack-scale` shrinks offsets on phones so the deck never overflows.

- One metric per card: Vitals split into five metric cards. Good/fulfilled cards (factor score ≥70% of weight, or band tone good) get a restrained `.foil` sheen using `--foil-a/b/c`; no glow. Fixed factor score maths (contribution ÷ weight, not ÷100).

- Foil cards respond to pointer: `bindFoilTilt()` sets `--tilt-x/y`, `--shine-x/y`, `--hue`; hover is ±5°, drag ±9°. Reduced motion resets tilt. Recent nights and workout stats became cards; `fetch_exercise` now keeps manual `notes` when present.

- Cards mode is one Pokemon-style deck of **every measured card**, not 13 sections. `collectResultCards()` lifts all `[data-result-key]` cards out of their slots into temporary `.section.stack-proxy` wrappers in `#stackViewport`; `restoreResultCards()` puts them back in reverse order (a saved `next` sibling may still be inside a proxy). `stackTo/cycleStack/goToSection` manage the pile. Navigation is buttons/arrows/nav only — no wheel, flick, swipe or tap-to-flip. `bindDeckDrag()` maps pointer drag to `--tilt-x/y`, `--shine-*` and `--hue` on the proxy and its foil children; `btnGyro` opts into `deviceorientation` (with iOS permission) for the same tilt. `ma-mode` persists. Inactive proxies show only their coloured edges. On phones proxies are content-sized (200–528px tall) with compact metric cards and controls.

- Deck controls show a next-card preview, a position rail and a `?` shortcuts panel (`toggleShortcutHelp`, also opened by the `?` key and closed by Escape or an outside click). Forward and back navigation use different tick pitches (540/420 Hz), and a bad card gives one low thud plus a haptic pattern per load (`state.badSeen`).
- Tiers: `tierOf()` maps score ≥92 gold, ≥80 silver; everything else is plain, bad cards get a stained/scuffed finish. Nights use efficiency ≥95 gold / ≥90 silver. Foil sheen uses stronger 200%-size gradients, a sweep animation and tier colours; the proxy border picks up the tier and `charged` adds a moving rainbow wash. `#celebration` is now a fixed full-viewport layer (z-index 120) outside `#app`, cleared on lock. Celebrations repeat whenever a good card comes forward: 46 confetti, or 110 + seven firework rings + flash + rays + 11 balloons + NEAR PERFECT badge for gold, with corner cannons. Gold sound: sweep + low boom + five-note arpeggio via Web Audio (`ma-sound`, synthesised, no asset request); haptics on coarse pointers. Deck cards are centred 1.59:1 credit-card rectangles with compact inner content. Review cycle 2 issues (tablet control overlap, stale banner height) fixed earlier.

- Source picker is now an icon-led menu: Fitbit Air (Fitbit dots), Garmin Fenix (watch), Google/other (app tile), All sources (group). Vault holds four complete views; `filter_fetched(fetched, group)` and `source.source_group()` map records. Alternate views skip the publish gate so a source with no core metrics can still render honestly. Demo now seeds mixed sources.

- Static review fixes: `lock()` restores lifted cards before clearing slots; `sectionHidden` Map restores the original section visibility (no empty markers section); arrow keys work after button focus while inputs still swallow them; celebrations dedupe by `${navSeq}:${resultKey}` so theme/source switches do not replay them but revisits do; nav links to non-deck sections switch to Page mode; print lets the shell scroll.

- Metric cards now carry a compact SVG comparison line (`miniTrend()`) built only from reported daily history (last 10 points), with the user's baseline dashed when measured and a named accessible label. `.metric-card` is a flex column so the chart fills spare space; status keeps the bottom margin when no chart exists. Lock purges source-menu and chrome labels too. Proxies carry `dataset.sectionId` so nav links and `aria-current` still point at their original section.

- Mobile drag now follows the finger: `setDrag()` writes `--drag-x/y/r` and a `following` class (transitions off), `clearDrag()` either springs back or flies the card offscreen before `cycleStack()` 170ms later. Passing 72px on a coarse pointer arms a `swipe-cue` badge and haptic; release commits, short drags reset. `stack-proxy` transform composes stack vars with drag vars.

- Gesture review fixes: viewport no longer steals capture from `.foil` children (avoids stuck 9° hover tilt); fly-out timer is cancelled on restore/new press and guarded against detached cards; `pointercancel` never commits a swipe; cue text tracks direction and is `aria-hidden`, with a CSS specificity fix so it stays absolute; tilt vars are reset on card change/restore and skipped under reduced motion, which also strips drag transforms from proxies.

- Recent nights are one `nights-card` in the deck (`data-result-key="recent-nights"`), with all nights as compact rows inside; the old per-night result cards are gone. Tier is taken from the best efficiency. Mobile rows are compacted so all seven fit without scrolling. Deck is now 16 cards instead of 22.

- Research source: `ryanbr/noop` (StrandAnalytics). We implement its published, transparent method independently: robust z-scores (mean + 1.253×MAD spread) weighted HRV .55 / RHR .20 / sleep .15 / resp .05 / skin .05, logistic `100/(1+exp(-1.6(z+0.2)))`; and workout Effort = Edwards-style %HRR zone weights × minutes, log-mapped by ln(7201). No proprietary score or NOOP code is copied. `bio_analytics.recovery()` keeps the legacy linear path when personal spreads are absent; cold-start is honest.

- Sleep numbers reconciled: the hero ring and Today card now use the pipeline's `sleep.score`, not minutes ÷ need. The need ratio is only a supporting readout and cold-start fallback; band label comes from `sleep.band`. Help text and design doc updated.

## Next steps
- After a real sync, check the Data sources panel for anything still "not measured".
- Keep `MEMORY.md` short; condense this again if it grows.

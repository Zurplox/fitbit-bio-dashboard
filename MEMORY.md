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

## Next steps
- After a real sync, check the Data sources panel for anything still "not measured".
- Keep `MEMORY.md` short; condense this again if it grows.

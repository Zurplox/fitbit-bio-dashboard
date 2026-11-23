# MEMORY — Meridian Air (fitbit-bio-dashboard)

Handoff for any LLM working here. The owner switches models often: **run `git pull` first**,
then update this file at the end of the session.

## Facts
- Repo: https://github.com/Zurplox/fitbit-bio-dashboard (public). Live: https://zurplox.github.io/fitbit-bio-dashboard/ (encrypted vault; you only see the lock screen without the passphrase).
- Stack: Python pipeline (Google Health API v4; legacy Fitbit API died on 2 Nov 2026) → rule engine → AES-256-GCM `data/biometrics.enc.json` → static `index.html` + `assets/{app.js,charts.js,theme.css}`.
- Docs to read before changes: `README.md`, `ARCHITECTURE.md` (ownership + payload contract), `DESIGN_SYSTEM.md` (graphite glass, no glow, colour = data meaning only).
- Daily sync: `.github/workflows/daily_sync.yml`, 08:00/08:30 SGT, produces the "data: sync" commits. The Google refresh token expires every 7 days while the OAuth app is unpublished; fix `invalid_grant` with `scripts/authorize.py`.
- Tests: `python -m unittest discover -s tests -t . -v`, `node --check assets/app.js`.
- When you change `theme.css`/`app.js`, bump the cache-buster in `index.html`.
- `backups/` holds a committed snapshot zip that gets refreshed by hand.

## State (2026-11-23)
- Local is synced to `875103a` (data sync 2026-11-23T05:25Z).
- Latest UI work: WHOOP-style palette + recovery breakdown, frosted glass cards on a neutral graphite canvas (`b1c2c60`).

## 2026-11-23 revamp (uncommitted until the owner approves)
- Front end rewritten: light-first, flat, Linear/Stripe restraint + WHOOP/Apple/Garmin metric set. All rendering is into `[data-slot]` containers in `index.html`; lock empties them. Missing metrics are omitted, never shown as "--".
- Strain 0–21 rescale and the strain-target card removed (fake scale); load shown as the ACWR ratio.
- New metric: skin temperature deviation (`fetch_daily_skin_temp`, payload `today.skin_temp`, `history.skin_temp`), plus a test.
- Not in the Google Health API: walking steadiness and gait metrics. Don't add them.
- The demo build overwrites `data/biometrics.enc.json`; run `git checkout -- data/` before committing.

- Round 2 (same day): new `markers` block in the payload (`sync.build_markers`), covering HRV status, intensity mix, social jetlag, VO₂/METs, RHR trend, steps vs plateau and BMI, plus readiness on the hero. Exercise sessions now keep `zones`, `elevation_m` and `run_vo2max`; the profile adds `age` via GET /users/me/profile. Thresholds and citations are in `bio_policy.py`. 74 tests.
- Deliberately absent (see DESIGN_SYSTEM.md): insulin/glucose, Body Battery, fitness age, walking steadiness.

- Round 3: an "i" button on each metric opens a plain-English callout (`HELP` map + `info(key)` in app.js). Add a `HELP` entry whenever you add a metric.

- Round 4: app-style score tiles (value inside ring), vitals as tiles; charts for every marker (HRV status band chart, sleep timing `Viz.timing`, skin temp, sparklines, steps/BMI scales); theme switch is a View Transitions circle sweep from the button. History sleep rows now carry `bed_minutes`/`wake_minutes`.

- Round 5: Garmin-style training effect (relative 0–5, `analytics.training_effect`) replaces the workout list; VO₂ max estimated (Uth 2004) because the real account returns 0 `daily-vo2-max` points (confirmed in the sync log). Optional `ATHLETE_AGE` secret added to daily_sync.yml.
- Gotcha: don't write files with PowerShell `Set-Content` when the text contains non-ASCII characters (≈ came out as "?"). Use the edit tool.

- Round 6 (real-data QA): the API sent NaN skin temps, which made the vault unparseable in browsers. `_num` now drops non-finite values and sync writes with `allow_nan=False`. Training effect gives light-zone minutes zero weight (walks had scored "Hard"). Real account: Fitbit Air plus Garmin Connect and Google Fit relayed via Health Connect; HRV only since ~13 Nov (HRV status appears around 7 Dec); no height in profile, so no BMI.

- Round 7: unslop + glisse pass. App shell (sidebar, sticky glass toolbar, glass tab bar on phones), one Today panel with four ring cells, vitals as an instrument strip, mono figures. Glass is native CSS (glisse is React from a CDN, which can't run beside decrypted data).

- Round 8: removed every trend chart (canvas, sparklines, heatmap, day bars, scales) and deleted assets/charts.js. All history is now a short table or numeric readouts. Still visual: the four rings, one sleep-stage bar, goal progress bars and the training-effect gauge.

## Next steps
- After the next real sync, check that zone data, age and skin temperature arrive (look for "not measured" in the Data sources panel).

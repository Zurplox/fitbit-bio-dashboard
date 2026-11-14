# Meridian Air

A private, end-to-end encrypted physiological dashboard for **Fitbit** data, built for the
**Fitbit Air**. Python pulls the measurements, a deterministic rule engine decides what they
mean, and a single static page reads an AES-256-GCM vault in your browser.

This is the sibling of [garmin-bio-dashboard](https://github.com/Zurplox/garmin-bio-dashboard),
rebuilt against a different API and with a new interface — not a reskin.

---

## Why the Google Health API, not the Fitbit API

The legacy Fitbit Web API was **switched off on 2 November 2026**. Its endpoints and its OAuth
server now return `410 Gone`. Every Fitbit account, including the Fitbit Air, is reached through
the [Google Health API](https://developers.google.com/health) at `health.googleapis.com/v4` with
Google OAuth 2.0.

That changes the shape of the integration, not just the hostname:

| Concern | Fitbit Web API (gone) | Google Health API (used here) |
|:---|:---|:---|
| Auth | Fitbit OAuth 2.0 | Google OAuth 2.0, `googlehealth.*.readonly` scopes |
| Sleep | `/1.2/user/-/sleep/date/...` | `sleep` sessions with stages and a summary |
| HRV | `/1/user/-/hrv/date/...` | `daily-heart-rate-variability` |
| Daily totals | `activities/date` | `steps`, `total-calories`, `active-minutes` via `dailyRollUp` |
| Page size | 100+ | **25 points per page** |
| Aggregation window | free-form | **14 days** for heart rate / calories / active minutes, **90 days** otherwise |

---

## Quick start (demo, no account needed)

```bash
pip install -r requirements.txt
python demo_data.py                                   # synthetic payload, labelled demo:true
DASHBOARD_PASS=meridian-demo python encrypt_data.py
python -m http.server 8971 --bind 127.0.0.1
# open http://127.0.0.1:8971  ·  passphrase: meridian-demo
```

The demo is generated through the **same** `build_payload` the live run uses, so it exercises the
real arithmetic. It carries `demo: true` into the vault and the page shows a permanent
**DEMO DATA** chip. Synthetic physiology is never presented as a measurement.

---

## Real data

### 1. Google Cloud project

1. Enable the **Google Health API** on a project in the Google Cloud console.
2. Create an **OAuth client ID** of type *Web application*.
3. Add `http://127.0.0.1:8765/` under **Authorized redirect URIs**.
4. Add your own Google account under **Test users** while the app is unpublished.
5. Make sure your Fitbit account is linked in the **Google Health** mobile app (sign in with the
   same Google account and complete the Fitbit migration).

### 2. Refresh token

```bash
export GOOGLE_HEALTH_CLIENT_ID=...
export GOOGLE_HEALTH_CLIENT_SECRET=...
python scripts/authorize.py            # opens consent, prints the refresh token
```

`scripts/authorize.py --manual` exists for a machine without a usable loopback redirect.

### 3. Run it

```bash
export GOOGLE_HEALTH_REFRESH_TOKEN=...
export ATHLETE_NAME="Your name"
export DASHBOARD_TZ=Asia/Singapore
export STEP_GOAL=10000

python sync.py                 # writes data/biometrics.json (gitignored)
DASHBOARD_PASS=... python encrypt_data.py
```

### 4. Automate it

`.github/workflows/daily_sync.yml` runs at 08:00 and 08:30 SGT, serialised by a concurrency group.
Repository secrets it needs:

| Secret | Purpose |
|:---|:---|
| `GOOGLE_HEALTH_CLIENT_ID` | OAuth client |
| `GOOGLE_HEALTH_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_HEALTH_REFRESH_TOKEN` | long-lived access |
| `DASHBOARD_PASS` | vault passphrase — **there is no default** |
| `ATHLETE_NAME` | name on the page |

Publish the site with GitHub Pages (Settings → Pages → deploy from branch, root). The page is
static; the only thing it fetches is `data/biometrics.enc.json`.

---

## Privacy model — stated precisely

The vault is encrypted with **AES-256-GCM**, keyed by **PBKDF2-HMAC-SHA256 at 600,000
iterations**. The browser derives the key with the Web Crypto API and decrypts in memory. The
envelope records the work factor it was written with, so raising the cost later does not
invalidate existing ciphertext.

| Property | Status |
|:---|:---|
| No plaintext health data committed | ✅ `data/biometrics.json` is gitignored; only ciphertext ships |
| Tamper-evident | ✅ AES-GCM authentication rejects modified ciphertext |
| Stops casual scraping of a public URL | ✅ the JSON is not human-readable |
| Confidential against someone who reads this repo | ✅ **only if `DASHBOARD_PASS` is a real secret** — there is deliberately no fallback, and `encrypt_data.py` exits non-zero without it |
| Protected from the repository host | ❌ GitHub Actions holds the passphrase as a secret while encrypting |

The passphrase is held **in memory only** for the session, never in localStorage, a cookie or a
URL. Lock destroys the in-memory data and every chart instance. `data/status.json` is public and
carries only a timestamp, the device name and metric counts.

---

## What the pipeline refuses to do

* **No placeholder physiology.** Every metric group records whether it was measured. A run whose
  core groups (sleep, resting heart rate, HRV) are missing **exits non-zero** and leaves the
  previous vault in place, instead of publishing a dataset the page cannot distinguish from
  measurement.
* **No scores from a model.** The rule engine is the only author of recovery, readiness, load
  bands and risk. `score_source` in the payload says so.
* **No invented numbers in prose.** Every paragraph is generated from the values in that run; a
  missing reading reads `--`, and the narrative says it was not measured.
* **No silent defaults.** A step goal is labelled `configured`, not "your device's goal", because
  the API does not expose the device's own target through these scopes.

---

## Tracked metrics

| Metric | Source | Notes |
|:---|:---|:---|
| Sleep duration, efficiency, stages | `sleep` sessions | main sleep per night; naps excluded |
| Sleep need & debt | derived | 7h30m floor + 25% of 14-night debt, capped at +90 min |
| Overnight HRV (RMSSD) | `daily-heart-rate-variability` | judged against your 30-night median |
| Resting heart rate | `daily-resting-heart-rate` | against your 30-day median |
| Blood oxygen | `daily-oxygen-saturation` | nightly average; sparse by nature |
| Breathing rate | `daily-respiratory-rate` | against your own baseline |
| Steps, calories, active minutes | `dailyRollUp` | chunked to the API's range caps |
| Workouts | `exercise` sessions | duration, calories, average HR, distance |
| Intraday heart rate | `heartRate` rollup | hourly averages, last 24 h |
| Cardio fitness | `daily-vo2-max` | device estimate |
| Circadian timing | derived | median onset, spread, alignment |
| Recovery / readiness / load ratio | derived | thresholds in `bio_policy.py` |
| Correlations | derived | curated pairs, n ≥ 14 and \|r\| ≥ 0.35 |
| Coaching | derived | one card per domain, each citing its study and its limits |

---

## Layout

```
googlehealth_source.py   the only module that talks to Google
bio_analytics.py         pure arithmetic, no I/O, no meaning
bio_policy.py            every threshold, band, tone and label
clinical_engine.py       deterministic verdicts + narrative
bio_correlate.py         relationships between your own channels
bio_coach.py             prescriptions per training domain
provenance.py            live-vs-missing bookkeeping and the publish gate
sync.py                  the run: fetch → analyse → gate → publish
encrypt_data.py          AES-256-GCM envelope + status file
index.html               markup
assets/theme.css         design system
assets/charts.js         canvas charts, no dependencies
assets/app.js            decrypt + render
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the ownership rules and the payload contract.

---

## Tests

```bash
python -m unittest discover -s tests -t . -v     # 66 tests, offline
node --check assets/app.js && node --check assets/charts.js
```

`tests/test_pipeline.py` covers the arithmetic: band ordering and tone vocabulary, the 12-hour
clock, timestamp offsets, sleep-score monotonicity and bounds, the sleep-need cap, recovery weight
renormalisation, ACWR arithmetic, day-load bounds, onset handling across midnight, correlation
floors, the provenance gate, the encryption envelope (round-trip, wrong key, tampering, absence of
a default passphrase), and full payload assembly from synthetic data.

`tests/test_source.py` pins the API contract against documented response shapes: rollup request
bodies carry full RFC3339 timestamps, rollup values are found through nested and list-shaped
payloads, sleep sessions are de-duplicated to one main sleep per night with offset-correct local
clocks, paging filters are built correctly, a single failing data type cannot abort the run, and an
unset secret (which arrives as an empty string) falls back instead of blanking the page.

---

## Known limits

* **Testing-mode tokens.** While the OAuth consent screen is unpublished, Google expires refresh
  tokens after **7 days**. Either publish the app or re-run `scripts/authorize.py` weekly; the
  sync fails with an `invalid_grant` message that says exactly this.
* **Page size 25.** Long daily series are paged to a 1,500-point ceiling and then windowed
  by date, so the newest readings survive whichever order the pages arrive in.
* **Rollup caps.** Calories and active minutes are fetched in 14-day chunks, steps in 90-day
  chunks, and stitched.
* **Intraday heart rate** is a 24-hour window of hourly averages, not historical minute data.
* **No device step goal** through these scopes; `STEP_GOAL` configures the target and the page
  labels it as configured.
* The dashboard is static. **Refresh** re-reads the published vault; it cannot run the pipeline.

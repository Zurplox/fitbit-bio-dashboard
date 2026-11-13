# Architecture

Python for ingestion and meaning, one static page for rendering. Each concern has exactly one
owner; if you are about to write a threshold somewhere else, you are in the wrong file.

```
          googlehealth_source.py ──┐
          (the only Google I/O)    │
                                   ▼
                            bio_analytics.py ──────► clinical_engine.py
                            (pure arithmetic)        (verdicts + prose)
                                   │      │
                                   │      └─ bio_correlate.py
                                   │         (channel relationships)
                                   │
                                   └─ bio_coach.py  (prescriptions)
                                             │
                                             ▼
                                 sync.py (the run)
                                             │
                       provenance.py ────────┤ publish gate
                       bio_policy.py ────────┘ bands, tones, labels
                                             ▼
                                  data/biometrics.json
                                             │ encrypt_data.py
                                             ▼
                                  data/biometrics.enc.json
                                             │ Web Crypto (in-browser)
                                             ▼
                                        index.html
```

## Ownership

| Concern | Owner | Rule |
|:---|:---|:---|
| Google Health access, pagination, rollup chunking, parsing | `googlehealth_source.py` | The only module that performs network I/O against Google. Records live-vs-missing provenance as it fetches. |
| Thresholds, bands, tones, labels, coaching evidence | `bio_policy.py` | Neither Python nor the browser may compare a metric against a number of its own. `TONE_NAMES` is the whole colour vocabulary; a tone names a *meaning*, and the page owns the palette. |
| Arithmetic | `bio_analytics.py` | Pure functions. No I/O, no environment, no provenance, no colours. Also decides positional windows ("last 30 days") and which record is latest. |
| Verdicts and prose | `clinical_engine.py` | Sole author of recovery, readiness, illness-watch level and the headline. Every paragraph ships twice: clinical, then the same finding in everyday words. |
| Relationships | `bio_correlate.py` | Curated pairs only, with floors on paired days and coefficient size. The direction published is the one measured. |
| Prescriptions | `bio_coach.py` | Pure rules over measured sessions, steps, nights and readings. A domain with no measured history publishes **no** prescription. |
| Publish decision | `provenance.py` | `DataQuality.publishable()` is the gate; nothing else decides. |
| The run | `sync.py` | Wires modules, assembles the envelope, writes the payload, reports. |
| Encryption and status | `encrypt_data.py` | Standalone. Reads the pipeline's JSON, never imports the pipeline. |
| Rendering | `index.html` + `assets/` | Consumes resolved bands. Its only decisions are layout. |

## Payload contract

`sync.build_payload()` emits:

* `schema`, `generated_at` (timezone-aware), `demo`, `timezone`, `device`, `athlete`;
* `today` — per-metric readings, each with its own `band` (`key`, `label`, `plain`, `tone`) and the
  comparison that produced it (`delta_pct`, `delta`, `baseline`, `need_minutes`);
* `history` — `sleep`, `hrv`, `rhr`, `steps`, `active_minutes`, `calories`, `spo2`, `resp`,
  `vo2max`, `hr_intraday`, `exercise`, all chronological;
* `baselines` — the medians the readings are judged against, with the sample size each used;
* `load` — acute and chronic minutes, the ratio, its band, and a 28-day daily series;
* `circadian`, `correlations`, `coaching`, `clinical`, `data_quality`, `policy`.

Two invariants:

1. **Bands arrive resolved.** If a new derived metric is needed, add it in `bio_analytics` (with its
   band in `bio_policy`) and ship it resolved. Do not add a threshold ladder to the frontend.
2. **Absence is explicit.** A missing measurement is `null` in the payload and `--` on the page. It
   is never a zero, a midpoint or a plausible default.

## The page

Three layers, in order:

* **Markup** — sections and cards. Copy is written for someone who is not a clinician: the
  scientific name stays (HRV, RHR, ACWR) with the everyday meaning beside it.
* **Render** — `render(data)` walks the payload once. Each `render*` helper owns one card. It reads
  bands and tones; it computes no scores.
* **Decrypt boundary** — `decryptVault()` is the only place ciphertext becomes data. `lock()`
  discards the passphrase, the payload and every chart registered with `Viz`.

`assets/charts.js` draws straight onto canvas: no CDN, no chart library, no build step. Each chart
is a draw function over a payload slice, registered for resize, and re-run on theme change because
colours are read from CSS custom properties at draw time.

## Why these limits are visible in the UI

The API's shape leaks into the product, so the page states it rather than hiding it:

* a provenance panel naming every metric group and whether it was live;
* a **14/14 live** chip that opens the list of anything missing;
* a stale-data banner past 30 hours;
* a **DEMO DATA** chip that cannot be dismissed;
* sparse metrics (blood oxygen) publishing `nights_recorded` beside the reading;
* a step goal labelled *configured*, because it is not the device's own.

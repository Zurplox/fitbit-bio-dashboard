# Meridian Air design direction

- **Product:** A private physiology dashboard that helps one athlete read last night's sleep, recovery, heart and training signals.
- **Character:** Calm, exact, honest. Quality comes from trustworthy numbers and restraint, not effects.
- **References:** Linear / Notion / Stripe for restraint; WHOOP, Apple Health and Garmin for which metrics matter and how plainly they are said.
- **Moment:** The three score rings at the top (recovery, sleep performance, training load). They carry most of the colour on the page.
- **Rule of honesty:** A metric the API did not return is left off the page. No placeholders, no estimates, no borrowed proprietary scales.

## Palette

Light theme by default; dark is a toggle.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#0b0b0c` | canvas |
| `--surface` | `#f9fafb` | `#141416` | cards |
| `--line` | `#e5e7eb` | `#27272a` | 1px borders, dividers |
| `--text` / `--muted` / `--faint` | `#111827` / `#6b7280` / `#9ca3af` | `#f3f4f6` / `#9ca3af` / `#71717a` | three text roles |
| `--accent` | ink `#111827` | `#f3f4f6` | primary button only |
| `--good` / `--warn` / `--bad` | `#16a34a` / `#d97706` / `#dc2626` | brighter steps | status dots, recovery ring |
| `--chart` / `--strain` | `#2563eb` | `#60a5fa` | every trend line, training load |
| `--sleep*` | indigo steps | indigo steps | sleep ring and stages only |

## Shell

An instrument console, not a landing page: a 232px sidebar (sections, device, sync dot), a toolbar naming the current section and date, dense solid panels, and monospaced readings for every figure. Below 1024px the sidebar becomes a floating tab bar.

**Glass** (after glisse's rules, in native CSS because no third-party script may run on a page holding decrypted health data) sits only on the control layer that floats over scrolling content: the toolbar, the phone tab bar, popovers and chart tooltips. Frosted fill, a lit top rim, a soft neutral float; solid fallback when `backdrop-filter` or transparency is unavailable. Content panels stay solid.

## Rules

- Solid panels with 1px borders; no shadows on content, no glow, no gradients on surfaces, no gradient text.
- One series colour per chart; baselines are dashed grey.
- Type: system UI stack (no web font request, so the vault stays the only network fetch). Page title 40/700 tight, section 22/600, card title 16/600, labels 12/500, tabular figures everywhere.
- Spacing on a 4px grid: 24px card padding, 64px between sections. Radii: 6px controls, 10px cards, pills only for status tags.
- Sentence case, no emoji, line icons at 18px / 1.5 stroke.
- Explanations live behind `<details>`; provenance is one collapsed panel at the bottom rather than a badge on every card.
- Motion: ring fill and progress width only; `prefers-reduced-motion` disables both.
- No trend charts, sparklines, heatmaps or canvas. History is shown as a short data table or labelled readouts (lowest, highest, mean, median, range). A single stage bar for last night's sleep and the five-segment training-effect gauge stay: they describe one reading, not a trend.

## Metric vocabulary

- **Recovery** (WHOOP-style %): weighted HRV, resting HR, sleep, breathing against your own baselines.
- **Sleep performance** (WHOOP-style %): hours asleep ÷ tonight's need.
- **Training load** (Garmin-style): acute:chronic minutes ratio, shown as the ratio itself. The old 0–21 "strain" rescale was dropped because it implied a WHOOP strain score the data cannot produce.
- **Overnight vitals** (Apple Vitals-style table): HRV, resting HR, breathing, SpO₂, skin temperature deviation. Skin temperature has no published threshold here, so it is "Not scored".
- **Training readiness** (Garmin-style /100): recovery tempered by the load trend.
- **HRV status** (Garmin-style): 7-night mean ln(RMSSD) vs your 60-night mean ± 0.5 SD (Plews 2013).
- **Aerobic vs high intensity**: workout heart-rate-zone time, light+moderate vs vigorous+peak, read against ~80/20 (Seiler 2010).
- **Social jetlag**: weekend vs weekday mid-sleep (Wittmann 2006, Roenneberg 2012).
- **Heart and metabolic markers**: VO₂ max in METs (Kodama 2009), 30-day RHR trend (Zhang 2016), 28-day steps vs the age-group plateau (Paluch 2022), BMI. Context, never a personal risk number.
- **Training effect** (Garmin-style aerobic/anaerobic 0–5): zone-weighted load per workout (Edwards 1993 TRIMP idea) divided by your own 95th-percentile session of 90 days. Relative, and labelled as not Firstbeat.
- **VO₂ max estimate**: when the device sends none (true for this Fitbit Air account), Uth 2004 (15.3 × max HR ÷ resting HR, max HR per Tanaka 2001), weekly from a 7-day RHR mean, shown with "≈" and "Estimated". Needs age: from the profile, else the `ATHLETE_AGE` secret.
- Not derivable, therefore absent: walking steadiness and gait (not in the API), Body Battery and stress (need continuous HRV), fitness age and VO₂ percentiles (need sex, which the API doesn't expose), insulin and glucose (WEAR-ME, Nature 2026: wearables alone reached AUROC 0.70; useful accuracy needed blood tests).

Design process informed by [heydamir/unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0).

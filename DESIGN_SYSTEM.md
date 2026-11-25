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
| `--bg` | `#f6f6f8` | `#0d0d10` | canvas |
| `--surface` | `#ffffff` | `#17171b` | cards |
| `--line` | `#e8e8ed` | `#28282f` | 1px borders, dividers |
| `--text` / `--muted` / `--faint` | `#17171b` / `#6e6e78` / `#6f6f79` | `#f4f4f6` / `#a5a5af` / `#85858f` | three text roles |
| `--accent` | `#2f62d8` | `#7ba2ff` | focus ring, demo tag |
| `--good` / `--warn` / `--bad` | `#1f9d55` / `#cf7a12` / `#d63d4a` | brighter steps | status dots, recovery ring |
| `--chart` | `#2f62d8` | `#7ba2ff` | training-load ring when optimal |
| `--zone-*` | grey, blue, amber, red | lighter steps | workout HR ribbon and zone strip |
| `--sleep*` | indigo steps | indigo steps | sleep ring only |

## Shell

A consumer fitness app, not a console or a landing page. Default view is a Pokemon-style deck: every measured result (recovery, vitals, factors, nights) is one full-size card in a single overlapping pile. Navigate with the arrows, nav links or the Cards/Page toggle; a hard swipe on a phone also moves to the next card. There is no wheel, flick or tap-to-flip. Drag the front card (or switch on the device-tilt button) to reveal its hologram. Page mode restores the scrolling sections. Cards behind the front one show only their coloured edges, never overlapping text. The deck card is a centred credit-card rectangle (1.59:1, 480px wide on desktop, 360px on phones) that hugs its inner result card with only a hairline edge; inner content stays compact and scrolls if a reading needs more room. On phones the metric cards and controls stay compact. Within the cards: a quiet top bar with an icon-led source picker (Fitbit Air by default; Garmin Fenix, Google/other and All sources also available), a hero with three rings (Recovery, Sleep, Training load), generous white space, and one chart moment (the workout zone ribbon). Each source is a complete recalculated payload view, not just a label change. Type is self-hosted Manrope (OFL licence in `assets/fonts/`); no runtime font request. The hero takes a 5% wash from the recovery tone, the recovery ring has fine instrument ticks, and the workout ribbon adds a zone-minute strip and first/middle/last-third readouts. Details are flat rows inside rounded cards; no sidebar, no walls of equal tiles, no mono labels. Phone gets a floating glass tab bar.

**Glass** (after glisse's rules, in native CSS because no third-party script may run on a page holding decrypted health data) sits only on the control layer that floats over scrolling content: the toolbar, the phone tab bar, popovers and chart tooltips. Frosted fill, a lit top rim, a soft neutral float; solid fallback when `backdrop-filter` or transparency is unavailable. Content panels stay solid.

## Rules

- Solid panels with 1px borders; no shadows on content, no glow, no gradients on surfaces, no gradient text.
- One series colour per chart; baselines are dashed grey.
- Type: system UI stack (no web font request, so the vault stays the only network fetch). Page title 40/700 tight, section 22/600, card title 16/600, labels 12/500, tabular figures everywhere.
- Spacing on a 4px grid: 24px card padding, 64px between sections. Radii: 6px controls, 10px cards, pills only for status tags.
- Sentence case, no emoji, line icons at 18px / 1.5 stroke.
- Explanations live behind `<details>`; provenance is one collapsed panel at the bottom rather than a badge on every card.
- Motion: ring fill and progress width only; `prefers-reduced-motion` disables both.
- Each section adds something new. Heart no longer repeats the big HRV/resting-HR/VO₂ figures from Vitals and Markers; it shows only baseline context, skin temperature and the 24-hour readouts.
- Activity opens with one full-width "Latest workout" card: every measurement the API sent, a heart-rate-zone table, training-effect scores and a comparison with the last eight similar sessions. Missing fields are omitted, never shown as zero.
- The workout card carries the one exception to the no-charts rule: a tall inline-SVG heart-rate trace with a flat area fill, zone bands, average line, peak marker and a clean zone-minute strip underneath. Hover, drag or use arrow keys to scrub any minute; the crosshair and tooltip are plain SVG/HTML, with no chart library. All chart text is HTML so it never stretches with the SVG. No canvas, no gradient. If samples or zone limits are missing, it says so instead of drawing an estimate.
- The recovery factors live directly under the hero as an untidy four-card deck, one factor per card. Each score is the contribution as a percentage of its weight; a score of 70% or more gets a restrained foil treatment. Foil cards tilt slightly toward the pointer and their sheen shifts position and hue; holding and dragging tilts further. Dragging or tilting the card charges its foil; arrows move through the deck. The same cards sit under the hero in Page mode.
- Vitals, recent nights and workout measurements are one item per card. Cards whose band tone is good (nights with ≥90% efficiency) get the same foil and pointer response. A score ≥92 (or efficiency ≥95) turns the foil gold and 80–91 silver; both show a moving hologram that fills the card edge to edge with no inset margin. Ordinary readings stay plain white; below-average readings are heavily stained, scratched, torn at the corner and desaturated, so damage reads at a glance — both answer a drag with shadow only, never colour. Deck text cannot be selected, so dragging anywhere on a card tilts it. Session notes are shown only when the API reported them.
- Celebrations fire every time a good card comes forward: 46 confetti pieces, or 110 pieces plus seven firework rings, a flash, starburst rays, eleven rising balloons and a NEAR PERFECT badge for gold. They cover the full viewport, not just the card, and are cleared on lock. Gold gets a rising sweep, low boom and five-note chime; other results get a two-note chime, all with tiered haptic patterns on touch devices. Navigation gives a soft directional tick and a 12ms tap. Sound can be muted from the deck controls; there are no audio files. No emoji and no looping motion, and reduced motion suppresses all particles.
- No decorative charts, heatmaps or canvas. The one exception is the compact comparison line at the foot of a metric card: it plots only reported daily values, with the user's baseline dashed and the newest point marked, and it fills the card's spare space. Longer history stays as short data tables or labelled readouts (lowest, highest, mean, median, range). A single stage bar for last night's sleep and the five-segment training-effect gauge stay: they describe one reading, not a trend.

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

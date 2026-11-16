# Meridian Air design direction

Design notes for the Fitbit Air physiology dashboard.

- **Product:** A private physiology dashboard that helps one athlete understand recent sleep, recovery, heart and training signals.
- **Character:** Calm, exact, quietly personal.
- **World:** A night-shift monitoring instrument: graphite surfaces, legible readings, and no decorative ambient effects.
- **Moments:** The recovery/sleep summary and the sleep-stage trend chart; color is reserved for data meaning there.
- **Signature:** Every measurement group carries its source attribution; calculations are explicitly marked **Derived**, and unknown origins stay **Source unreported**.

## Visual rules

- Neutral graphite ramp for surfaces, one restrained pale-green accent, semantic hues only where they encode a reading or series.
- Sentence-case labels, a single sans-serif UI family, tabular numerals, and compact monospace only where it improves data scanning.
- 4px spacing cadence, flat raised surfaces, quiet hairline borders, responsive charts and cards. The workout calendar labels weekdays vertically and weeks left-to-right, with a duration legend.
- No decorative glows, hue gradients, glass surfaces, generic greeting headline, or gratuitous entrance animation.

Metric attribution is sampled from source metadata supplied by Google Health. A badge names only a source the API reported; it does not infer that the originating device is Fitbit Air or Garmin when metadata is absent.

Design process informed by [heydamir/unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0).

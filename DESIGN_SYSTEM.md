# Meridian Air design direction

Design notes for the Fitbit Air physiology dashboard.

- **Product:** A private physiology dashboard that helps one athlete understand recent sleep, recovery, heart and training signals.
- **Character:** Calm, exact, quietly personal. Premium because the numbers are trustworthy, not because the frame is loud.
- **World:** A night-shift monitoring instrument behind smoked glass: dark panes, legible readings, one convincing material rather than five decorative effects.
- **Moments:** The recovery/strain/sleep ring band and the recovery breakdown; colour is reserved for data meaning there.
- **Signature:** Every measurement group carries its source attribution; calculations are explicitly marked **Derived**, and unknown origins stay **Source unreported**.

## Palette

Near-black canvas (`#07080a`) under a faint wash of the three data hues, with saturated colour carrying meaning and nothing else:

| Token | Dark | Meaning |
| --- | --- | --- |
| `--good` / `--accent` | `#2ff08f` | recovery, HRV |
| `--strain` | `#17a9ff` | effort |
| `--sleep` | `#a78bfa` | sleep |
| `--steps` | `#d4ff4f` | steps |
| `--spo2` | `#5ad2ff` | blood oxygen |
| `--rhr` | `#ff7ba8` | resting rate |
| `--warn` / `--bad` | `#ffc247` / `#ff5d73` | caution, alert |

Light theme keeps the same meanings at darker, AA-clearing values (green `#00754a`, strain `#006fc4`, sleep `#5936d0`).

## Visual rules

- **Surfaces are frosted, not glossy.** Cards are a 56%-surface tint with `blur(20px) saturate(150%)`, a hairline border and a lit top edge (inset white at 5.5%). Glass only reads because the page carries a subtle hue wash and grain behind it.
- **No glow.** No coloured shadows, no halo rings around status dots, no bloom behind a card, no gradient text, no spotlight at the top of the page.
- **One hue per card, at its edge.** The ring cards carry a 3px top bar in `--hue` and a ring track tinted `--hue` at 18%; the card body stays neutral.
- Neutral graphite ramp for text and rules; semantic hues only where they encode a reading or series.
- Sentence-case labels, a single sans-serif UI family, tabular numerals, and compact monospace only where it improves data scanning.
- 4px spacing cadence, hairline borders, responsive charts and cards. The workout calendar labels weekdays vertically and weeks left-to-right, with a duration legend.
- Motion is limited to ring draw-in and bar width; no entrance animation, no hover lift.
- Print drops every pane back to white with grey rules, so a PDF stays readable.

## Entitlement

The **Member** chip is a mark, not a paywall: the encrypted vault is the entitlement. It is hidden on phones, where the header is a fixed four-column grid.

Metric attribution is sampled from source metadata supplied by Google Health. A badge names only a source the API reported; it does not infer that the originating device is Fitbit Air or Garmin when metadata is absent.

Design process informed by [heydamir/unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0).

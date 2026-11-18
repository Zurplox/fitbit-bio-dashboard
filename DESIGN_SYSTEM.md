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

- **Surfaces are frosted, not glossy.** Cards, the ring cards, the readout strip and the sticky bar are one glass family (recipe below). Nothing inside a card glows or blooms.
- **The backdrop is part of the material.** A fixed `html::before` layer carries five wide radial fields (recovery green `.26`, strain `.22`/`.12`, sleep `.20`, steps `.12`, green again at the foot `.13`) plus grain; the panes blur that field, so the hue shows through the glass. Blurring a near-black page would return near-black, which is why the wash has to be this strong.
- **No glow.** No coloured shadows, no halo rings around status dots, no bloom behind a card, no gradient text, no spotlight at the top of the page.
- **One hue per card, at its edge.** The ring cards carry a 3px top bar in `--hue` and a ring track tinted `--hue` at 18%; the card body stays neutral.
- Neutral graphite ramp for text and rules; semantic hues only where they encode a reading or series.
- Sentence-case labels, a single sans-serif UI family, tabular numerals, and compact monospace only where it improves data scanning.
- 4px spacing cadence, hairline borders, responsive charts and cards. The workout calendar labels weekdays vertically and weeks left-to-right, with a duration legend.
- Motion is limited to ring draw-in and bar width; no entrance animation, no hover lift.
- Print drops every pane back to white with grey rules, so a PDF stays readable.

## Glass recipe

One recipe, four ingredients; leaving any of them out is what makes a card read as a plain translucent box.

| Ingredient | Value |
| --- | --- |
| Fill | `rgba(255,255,255,.095)` — lighter than the backdrop, never a darker tint |
| Sheen | 118° white gradient `.09` → 0 at 44%, plus a top-left radial `.125` |
| Frost | `backdrop-filter: blur(30px) saturate(190%)` (with the `-webkit-` prefix) |
| Rim | 1px `rgba(255,255,255,.18)`; top `.35`, left `.23`, bottom `.07` — lit from the top-left |
| Depth | inset top highlight `.24`, inset bottom shade `rgba(0,0,0,.32)`, `0 30px 60px -28px rgba(0,0,0,.95)` float |
| Grain | `body::after` noise tile at `opacity .03`, over everything, to dither blur banding |

The sticky bar keeps `var(--bg)` at 64% opacity so 11px nav labels still clear AA while content visibly blurs underneath. The readout strip is one pane cut into cells: the cells have no fill of their own and the hairline dividers are the only structure.

Glass is decoration, so it is defeatable: `prefers-reduced-transparency: reduce` drops the wash and grain and returns solid surfaces, `@supports not (backdrop-filter)` does the same for browsers without a compositor filter, and print strips every pane back to white.

Light theme inverts the source of the tint: white at 60% with white top rim and a `rgba(15,23,32,.1)` border, over a dimmed version of the same hue wash (`rgba(0,117,74,.17)` and friends).

## Entitlement

The **Member** chip is a mark, not a paywall: the encrypted vault is the entitlement. It is hidden on phones, where the header is a fixed four-column grid.

Metric attribution is sampled from source metadata supplied by Google Health. A badge names only a source the API reported; it does not infer that the originating device is Fitbit Air or Garmin when metadata is absent.

Design process informed by [heydamir/unslop](https://github.com/heydamir/unslop) (Damir Sokolovsky, CC BY 4.0).

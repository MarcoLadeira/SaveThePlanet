# 7-minute pitch (issue #70)

| File | What it is |
| --- | --- |
| `SaveThePlanet-pitch.pptx` | The 12-slide, 16:9 deck. Speaker notes on every slide: timing, what's on screen, the words, a caption. |
| `script.md` | The same script as one document (796 words, 0:00–7:00), with captions for muted viewing. |
| `evidence-ledger.md` | Every number on a slide: value, status (measured / deterministic / illustrative / hypothetical / estimate) and source. |
| `qa.md` | Short answers to the questions judges are likely to ask. |
| `build-deck.js`, `script.json` | Source. Edit `script.json`, then run `node docs/demo/build-deck.js` (needs `pptxgenjs react react-dom react-icons sharp`). |

## What's left: record the four clips

The deck has four dark 16:9 frames labelled **CLIP 1–4**. They need genuine recordings of the app against the
hosted GridToEv model (API key in `.env`). The build machine had no model access, so none are faked.

**Before recording:**
1. Run the app from `main` with the key, at 1920×1080, browser in full screen (F11), notifications off.
2. On the Dashboard, press **New target** until the target falls in 24–31 Jan 2026, the week the Impact page
   and the Rewards card replay. Write the date and half-hour in `evidence-ledger.md`: that is the frozen scenario.
   Use it on every page.
3. Let every page finish loading once before you hit record, so the clips have no spinners.

| Clip | Slide | Length | Record |
| --- | --- | --- | --- |
| 1 | 3 | 30 s | Dashboard: the historical target chip, the forecast, the battery routing, the EV plan. |
| 2 | 4 | 45 s | Forecast page, the frozen day: the +30 min forecast beside EirGrid's observed curtailment; hover one hit and one miss. |
| 3 | 5 | 55 s | Battery page, then EV page for the same day: KPIs, "When charging can run on renewables", "Best half-hours to charge". |
| 4 | 7 | 20 s | EV page, SaveThePlanet Rewards card: Join free (demo) → an evening with an offer → 20 kWh → Reserve → the split line. Optionally a morning's "No discounted window". Then "leave demo". |

Optional 5 s cut for slide 8: Impact page, *Who earns*, click **400 sessions**.

**Insert each clip:** click the frame, note its size, Insert › Video › This Device, match the size and
position, delete the frame, set Playback › Start: Automatically. Trim loading with Playback › Trim Video.
Keep the MP4s next to the deck (H.264/AAC), not linked online.

## Rehearse and export

- Read the notes aloud against a timer; aim to finish at **6:50**. Each slide's time range is in its notes.
- Slideshow › Record → record narration over the slides with the clips playing; then File › Export › Create a Video
  (1080p) for the standalone MP4. Check it is under 7:00 and plays offline on a second machine.
- One hostile run-through with `qa.md`: someone attacks the baseline, the hypothetical battery, the 50/25/25
  settlement and the CO₂ estimate.

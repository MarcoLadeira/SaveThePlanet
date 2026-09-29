# 7-minute pitch (issue #70)

| File | What it is |
| --- | --- |
| `SaveThePlanet-pitch.pptx` | The deck: 14 plain slides, one idea each. Speaker notes on every slide: timing, what's on screen, the words, a caption. |
| `script.md` | The same script as one document (722 words, 0:00–6:35 with the recordings, a 25-second buffer under 7:00), with captions for muted viewing. |
| `evidence-ledger.md` | Every number on a slide: value, status (recorded / predicted / deterministic / illustrative / hypothetical / estimate) and source. |
| `qa.md` | Short answers to the questions judges are likely to ask. |
| `hydrogen.md` | The hydrogen and scalability story (slides 4 and 12) for a live app demo, and what it assumes (issue #76). |
| `hydrogen_stages.py` | Writes `data/hydrogen-stages-2026-01-24.json`, the slide 12 chart, from `backend/hydrogen.py`. |
| `data/` | The real data behind the two charts: EirGrid's recorded curtailment for 10 May 2026, and the GridToEv model's +30-minute predictions for January 2026. |
| `build-deck.js`, `script.json` | Source. Edit `script.json`, then run `node docs/demo/build-deck.js` (needs `pptxgenjs`). |

## What's left: record the four clips

Slides 4, 6, 7 and 9 have a flat grey 16:9 area labelled "Screen recording 1–4". They need genuine recordings
of the app running against the hosted GridToEv model (API key in `.env`). The build machine had no model
access, so nothing there is faked.

**Before recording:**
1. Run the app from `main` with the key, at 1920×1080, browser in full screen (F11), notifications off.
2. On the Dashboard, press **New target** until the target falls in 24–31 Jan 2026, the week the Impact page
   and the Rewards card replay. Write the date and half-hour in `evidence-ledger.md` and use it on every page.
3. Let every page finish loading once before recording, so the clips have no spinners.

| Recording | Slide | Length | Show |
| --- | --- | --- | --- |
| 1 | 4 | 20 s | Dashboard: the historical target, the forecast, the EV plan and the battery level. Pick a half-hour where the battery shows FULL, so the "surplus to ESB hydrogen plants" line is on screen. |
| 2 | 6 | 35 s | Forecast page, the chosen day: the +30 min forecast beside EirGrid's recorded curtailment; hover one hit and one miss. |
| 3 | 7 | 35 s | Battery page, then EV page for the same day, default fleet: "Cars that can charge through the day" and the best half-hour. |
| 4 | 9 | 20 s | EV page, SaveThePlanet Rewards: Join free (demo), an evening with an offer, 20 kWh, Reserve, the split line. Then "leave demo". |

**Insert each one:** click the grey area and note its size and position, then Insert › Video › This Device,
match that size and position, delete the grey area, and set Playback › Start: Automatically. Trim loading with
Playback › Trim Video. Keep the MP4s (H.264/AAC) next to the deck, not linked online.

## Rehearse and export

- Read the notes aloud against a timer; aim to finish by 6:35 (hard limit 7:00). Each slide's time range is in its notes.
- Slideshow › Record to narrate over the slides with the clips playing, then File › Export › Create a Video
  (1080p) for the standalone MP4. Check it's under 7:00 and plays offline on a second machine.
- One hostile run-through with `qa.md`: someone attacks the baseline, the hypothetical battery, the 50/25/25
  split and the CO₂ estimate.

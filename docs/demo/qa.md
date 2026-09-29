# Judge Q&A cheat sheet (issue #70)

Short answers. Evidence IDs refer to `evidence-ledger.md`.

**Is this real or simulated?**
Two charts are real data: EirGrid's recorded curtailment on 10 May 2026, and the GridToEv model's
+30-minute predictions for January 2026. The recordings replay real history through the app. The site, fleet,
tariff and battery are examples, and the money is projected, not earned. (E2, E5, E7–E10)

**Why 10 May?**
It's one recorded day that shows both the scale and the timing clearly. It isn't an average; the 11.2% on
slide 1 is the half-year figure. (E1, E2)

**Why is the heatmap January and the real day May?**
They answer different questions. May is what actually happened; January is what our forecast model predicted,
which is what the app decides on. (E2, E5)

**Do you store energy or stop curtailment today?**
No. The example hub's battery is hypothetical (2,000 kWh, 85% round trip). A pilot needs a real site,
metering and a network-access check before any energy claim. (E9)

**Isn't there already enough wasted energy for every EV?**
Nationally, perhaps; at one charger at one moment, no. We only count what the site's chargers, connection and
the cars' departure times can take, and we leave the rest. (E7, E8)

**What does the AI add over smart charging?**
We compare with good smart charging in the same window. In the evening, stored surplus beats it by €0.06–0.14
per kWh; in the morning, night-rate power at €0.16 is already cheaper, so there's no offer. (E11)

**What if the forecast is wrong?**
Power bought on a false alarm counts as ordinary grid power and is never offered. A driver's locked price is
honoured; any shortfall comes out of our commission and the operator's share, never the driver's. (E6)

**Are you profitable?**
In the pilot month, yes, thinly: +€40 a month for us and +€100 for the operator, after all costs. We break even
at 300 charges a month. The 25% is gross commission, not margin. It grows with charges per site (the example
hub fits 40 a window) and with overhead shared across sites: €90 of our €120 a month is a platform core every
site shares. (E9, E13)

**Why give drivers 50%?**
They have to change when they charge. Half the extra saving is what gets them to book, and the operator still
keeps its normal margin plus 25%. (E12)

**How reliable is the CO₂ number?**
It's an estimate: kWh delivered from stored surplus × a flat 0.25 kg/kWh, assuming that surplus would
otherwise have been turned away. It isn't measured marginal displacement, and we say so. (E15)

**How does this scale to Europe?**
The software repeats; the inputs don't. Each country needs its grid operator's data, a retrained model, local
tariffs and network rules, and each site is capped by its own hardware. We start with one Irish pilot. (E16)

**Why do the app's Impact numbers differ from slide 10?**
Slide 10 is the illustrative pilot month (400 charges) so every figure reconciles. The Impact page's
"Replay" view projects one historical week; its "400 sessions" preset shows the slide's figures. (E13)

**Is ESB a partner? Do you send energy to Aghada?**
No. The electrolyser is hypothetical and only sized like ESB's planned 1 MW demonstration at Aghada. There is no
agreement, connection or delivery. ESB could pilot the optimisation; that is a proposal. (E19)

**Why hydrogen, if the story is EVs?**
EVs can't take every spare kilowatt-hour: surplus often comes when cars are away or already full. We give EVs
what they can use, then the grid battery; once it's full, the surplus could go to an electrolyser instead of
being turned away. As EV demand grows, EVs take more. Hydrogen stays a second, flexible market. (E18, E20)

**How much hydrogen, and is it green?**
The kilograms on the page are potential, not delivered: electricity in divided by 55 kWh per kg, so about 40% is
lost in conversion. Its CO₂ benefit is not verified, and it is not priced: any fee would be separate from the
50/25/25 split. (E19)

**How do we know the maths is right?**
420 automated tests, including settlement to the cent and the no-look-ahead rules, run on every change. (E17)

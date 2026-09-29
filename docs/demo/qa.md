# Judge Q&A cheat sheet (issue #70)

One or two sentences each. Evidence IDs refer to `evidence-ledger.md`.

**Is this real or simulated?**
The forecasts are the real GridToEv model replayed over historical days, scored against EirGrid's observed
curtailment. The site, fleet, tariff and battery are simulated examples, and the money is projected, not
earned. We label each on screen. (E4, E6, E8, E9)

**Do you store energy or stop curtailment today?**
No. The battery is hypothetical (700 kWh, 85% round trip) to show what stored surplus would cost; a pilot
needs a real site, metering and a network-access check before any energy claim. (E8)

**Isn't there already enough wasted energy for every EV?**
Nationally, maybe; at one charger at one moment, no. We only count what the site's chargers, connection and
departure times can take, and we leave the rest unallocated. (E2, E7)

**What does the AI add over smart charging?**
We compare with competent smart charging in the same window, not with plug-in-and-charge. In the evening,
stored night surplus beats it by €0.06–0.14/kWh; in the morning it doesn't, so we make no offer. (E10)

**Why aren't 07:00–09:00 and 17:00–19:00 always discounted?**
They are commuter windows, not cheap or green by definition; 17:00–19:00 is the peak. An offer appears only
when stored surplus beats smart charging by enough to cover session costs. (E10)

**What if the forecast is wrong?**
Energy bought on a false alarm is treated as ordinary grid power and never offered. A driver's locked price
is honoured; any shortfall comes out of our commission and the operator's share, never the driver's. (E5)

**Are you profitable?**
In the pilot month, yes but thinly: +€40 a month for us, +€100 for the operator, after all their costs;
we break even at 300 sessions. The 25% is gross commission, not margin. Profit grows with sessions per
site (up to 16 a window) and with overhead shared across sites. (E12)

**Why give drivers 50%?**
Drivers have to change when they charge; half the extra saving is what gets them to book, and the operator
keeps its normal margin plus 25%. (E11)

**How reliable is the CO₂ number?**
It's an estimate: kWh delivered from stored surplus × a flat 0.25 kg/kWh, assuming that surplus would
otherwise have been dispatched down. It is not measured marginal displacement, and we say so. (E15)

**How does this scale to Europe?**
The software repeats; the inputs don't. Each country needs its TSO's data, a retrained forecast model, local
tariffs and network-access rules, and each site is capped by its own hardware. We start with one Irish pilot.
(E16)

**Why do the app's Impact numbers differ from the slides?**
The slides use the illustrative pilot month (400 sessions) so every figure reconciles; the Impact page's
"Replay" view projects one historical week. The "400 sessions" preset shows the slide figures.
(E12)

**How do we know the maths is right?**
406 automated tests, including settlement to the cent and the no-look-ahead rules, run on every change.
(E17)

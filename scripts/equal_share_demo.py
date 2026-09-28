"""See the equal-share optimizer and energy ledger with your own eyes.

Runs backend/optimizer.py on a made-up forecast window and fleet (no server or model needed)
and prints each car's share plus the ledger, so you can check that the energy is shared
equally and every kWh is accounted for.

    python scripts/equal_share_demo.py                      # 60 kWh, 60 cars needing 1 kWh each
    python scripts/equal_share_demo.py --cars 70            # more cars than energy: equal partial shares
    python scripts/equal_share_demo.py --kwh 30 --cars 5 --need 50 --efficiency 0.9
    python scripts/equal_share_demo.py --site-kw 16 --kwh 10 --cars 1 --need 50   # 8 of 10 kWh fit
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import optimizer  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--kwh', type=float, default=60, help='renewable energy at risk in the half-hour (kWh)')
parser.add_argument('--cars', type=int, default=60, help='number of plugged-in cars')
parser.add_argument('--need', type=float, default=1, help='battery kWh each car still needs')
parser.add_argument('--charger-kw', type=float, default=22, help='power of each charger (kW)')
parser.add_argument('--site-kw', type=float, default=100_000, help='site power limit (kW)')
parser.add_argument('--chargers', type=int, default=None, help='number of chargers (default: one per car)')
parser.add_argument('--efficiency', type=float, default=1.0, help='charging efficiency, e.g. 0.9')
args = parser.parse_args()

# One forecast half-hour (23:00-23:30 UTC), forecast +30 and +60 minutes ahead; all curtailment.
mwh = args.kwh / 1000
forecast = dict(dataMode='historical-prediction', targetAt='2026-01-31T23:00:00+00:00', predictions=[
    dict(horizonMinutes=h, issuedAt=f'2026-01-31T{issued}:00+00:00', targetAt='2026-01-31T23:00:00+00:00',
         atRiskMwh=mwh, curtailmentMwh=mwh, constraintMwh=0.0, lowerMwh=mwh, upperMwh=mwh, probability=1.0)
    for h, issued in ((30, '22:30'), (60, '22:00'))])
fleet = dict(chargingEfficiency=args.efficiency,
             sites=[dict(id='site', name='Test site', region='IE', chargers=args.chargers or max(1, args.cars),
                         chargerKw=args.charger_kw, sitePowerKw=args.site_kw)],
             # Plugged in from the plan start (22:00) until 02:00, so every car can use the 23:00 window.
             vehicles=[dict(id=f'car-{i + 1:03}', site='site', arriveMin=0, departMin=240,
                            requiredKwh=args.need, maxKw=args.charger_kw) for i in range(args.cars)])

result = optimizer.optimize(fleet, forecast)
plan, ledger = result['alternatives'][0]['optimized'], result['ledger']

print(f"\nPer-car share of the {args.kwh:g} kWh window (grid kWh in -> battery kWh out):")
shares = plan['opportunityAllocations']
for s in shares[:10]:
    print(f"  {s['vehicle']}  {s['gridKwh']:>9.3f} -> {s['batteryKwh']:>9.3f}  (loss {s['lossKwh']:.3f})")
if len(shares) > 10:
    print(f'  ... {len(shares) - 10} more')
if shares:
    grid = [s['gridKwh'] for s in shares]
    print(f'  {len(shares)} of {args.cars} cars got energy; smallest share {min(grid):.3f}, largest {max(grid):.3f} kWh')

print('\nEnergy ledger (kWh):')
for key in ('predictedAtRiskKwh', 'eligibleOpportunityKwh', 'allocatedToChargersGridKwh', 'allocatedToRealStorageKwh',
            'unallocatedOpportunityKwh', 'batteryDeliveredKwh', 'chargingLossKwh', 'utilizationFraction', 'outcome'):
    print(f'  {key:<28} {ledger[key]}')
for reason in ledger['unallocatedReasons']:
    print(f"  unallocated because: {reason['message']}")

E, A, U, B, Lo = (ledger[k] for k in ('eligibleOpportunityKwh', 'allocatedToChargersGridKwh',
                                      'unallocatedOpportunityKwh', 'batteryDeliveredKwh', 'chargingLossKwh'))
print('\nChecks:')
print(f'  eligible {E:g} = allocated {A:g} + storage 0 + unallocated {U:g}  ->  {abs(E - A - U) < 1e-6}')
print(f'  allocated {A:g} = batteries {B:g} + loss {Lo:g}  ->  {abs(A - B - Lo) < 1e-6}')
print(f"  per-car rows add up to allocated  ->  {round(sum(s['gridKwh'] for s in shares), 3) == A}")

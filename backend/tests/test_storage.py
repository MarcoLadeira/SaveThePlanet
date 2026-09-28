import unittest

import optimizer
import storage


def ledger(eligible, chargers):
    """An EV-only ledger as optimizer.energy_ledger builds it (grid-side kWh, 90% charging efficiency)."""
    return optimizer.energy_ledger(eligible, eligible, chargers, 0.9, [], [dict(code='fleet-limit', message='Fleet is full.')])


class GridBatteryTests(unittest.TestCase):
    def test_worked_example_power_limited(self):
        # 8,000 kWh eligible, EVs take 3,000: the 5 MW battery takes 2,500 kWh in the half-hour, 2,250 stored.
        L = storage.apply(ledger(8000, 3000))
        s = L['storage']
        self.assertEqual((s['gridKwh'], s['storedKwh'], s['lossKwh']), (2500, 2250, 250))
        self.assertEqual((s['startKwh'], s['endKwh'], s['endFraction']), (4000, 6250, 0.625))
        self.assertEqual(s['limitedBy'], 'power-limit')
        self.assertEqual(L['allocatedToRealStorageKwh'], 2500)
        self.assertEqual(L['unallocatedOpportunityKwh'], 2500)
        self.assertEqual(L['unallocatedReasons'][0]['code'], 'storage-power-limit')
        self.assertEqual(optimizer.check_ledger(L) + storage.check_storage(L), [])

    def test_takes_everything_that_is_left(self):
        L = storage.apply(ledger(1000, 400))
        self.assertEqual(L['storage']['gridKwh'], 600)
        self.assertEqual(L['unallocatedOpportunityKwh'], 0)
        self.assertEqual((L['outcome'], L['unallocatedReasons']), ('fully-allocated', []))
        self.assertEqual(L['usedWithStorageFraction'], 1)
        self.assertEqual(L['utilizationFraction'], 0.4)  # still the EV chargers' share

    def test_never_fills_past_capacity(self):
        nearly_full = dict(storage.DEFAULT, startFraction=0.95)  # 500 kWh of room = 555.555 grid kWh
        L = storage.apply(ledger(20000, 0), nearly_full)
        s = L['storage']
        self.assertEqual(s['limitedBy'], 'full')
        self.assertLessEqual(s['endKwh'], s['capacityKwh'])
        self.assertEqual(optimizer.check_ledger(L) + storage.check_storage(L), [])

    def test_nothing_offered(self):
        L = storage.apply(ledger(0, 0))
        self.assertEqual((L['storage']['gridKwh'], L['storage']['limitedBy'], L['outcome']), (0, 'nothing-offered', 'no-opportunity'))

    def test_checker_catches_violations(self):
        L = storage.apply(ledger(8000, 3000))
        L['storage']['gridKwh'] = L['allocatedToRealStorageKwh'] = 3000
        self.assertIn('battery charged faster than its power limit', storage.check_storage(L))
        L = storage.apply(ledger(8000, 3000))
        L['storage']['endKwh'] = 20000
        self.assertIn('battery filled past its capacity', storage.check_storage(L))

    def test_applied_once_per_ledger(self):
        L = storage.apply(ledger(8000, 3000))
        with self.assertRaises(RuntimeError):
            storage.apply(L)


if __name__ == '__main__':
    unittest.main()

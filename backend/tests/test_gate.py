from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gate import FOREGROUND, PREFETCH, Busy, ReplayGate, Superseded


def slow(result, seconds=.2, log=None, name=None):
    def fn():
        if log is not None:
            log.append(('start', name or result))
        time.sleep(seconds)
        if log is not None:
            log.append(('end', name or result))
        return result
    return fn


def in_thread(target, *args, **kwargs):
    box = {}

    def run():
        try:
            box['value'] = target(*args, **kwargs)
        except Exception as error:  # noqa: BLE001 - recorded for the assertion
            box['error'] = error
    thread = threading.Thread(target=run)
    thread.start()
    return thread, box


class ReplayGateTests(unittest.TestCase):
    def test_two_clients_asking_for_the_same_day_share_one_upstream_call(self):
        gate, calls = ReplayGate(), []

        def fn():
            calls.append(1)
            time.sleep(.2)
            return 'replay'
        a = in_thread(gate.run, 'day-1', fn, client='A', seq=1)
        time.sleep(.02)
        b = in_thread(gate.run, 'day-1', fn, client='B', seq=1)
        for thread, _ in (a, b):
            thread.join()
        self.assertEqual((a[1]['value'], b[1]['value'], len(calls)), ('replay', 'replay', 1))

    def test_replays_never_overlap_upstream(self):
        gate, log = ReplayGate(), []
        threads = [in_thread(gate.run, f'day-{i}', slow(i, .1, log), client=str(i), seq=1) for i in range(3)]
        for thread, _ in threads:
            thread.join()
        running = 0
        for event, _ in log:
            running += 1 if event == 'start' else -1
            self.assertLessEqual(running, 1)

    def test_foreground_is_admitted_before_earlier_prefetches(self):
        gate, log = ReplayGate(), []
        blocker = in_thread(gate.run, 'running', slow('running', .2, log))
        time.sleep(.02)
        prefetch = in_thread(gate.run, 'prefetch', slow('prefetch', .05, log), priority=PREFETCH)
        time.sleep(.02)
        foreground = in_thread(gate.run, 'foreground', slow('foreground', .05, log), priority=FOREGROUND)
        for thread, _ in (blocker, prefetch, foreground):
            thread.join()
        starts = [name for event, name in log if event == 'start']
        self.assertEqual(starts, ['running', 'foreground', 'prefetch'])

    def test_rapid_target_changes_drop_the_clients_obsolete_queued_work(self):
        gate, log = ReplayGate(), []
        blocker = in_thread(gate.run, 'other-viewer', slow('other', .2, log), client='B', seq=1)
        time.sleep(.02)
        old = in_thread(gate.run, 'day-1', slow('day-1', .05, log), client='A', seq=1)
        time.sleep(.02)
        new = in_thread(gate.run, 'day-2', slow('day-2', .05, log), client='A', seq=2)
        for thread, _ in (blocker, old, new):
            thread.join()
        self.assertIsInstance(old[1]['error'], Superseded)
        self.assertEqual(new[1]['value'], 'day-2')
        self.assertNotIn(('start', 'day-1'), log)  # the obsolete replay never reached the model

    def test_another_client_waiting_on_superseded_work_still_gets_it(self):
        gate = ReplayGate()
        blocker = in_thread(gate.run, 'busy', slow('busy', .2), client='X', seq=1)
        time.sleep(.02)
        owner = in_thread(gate.run, 'day-1', slow('day-1', .05), client='A', seq=1)
        time.sleep(.02)
        follower = in_thread(gate.run, 'day-1', slow('day-1', .05), client='B', seq=1)
        time.sleep(.02)
        in_thread(gate.run, 'day-2', slow('day-2', .05), client='A', seq=2)[0].join()
        for thread, _ in (blocker, owner, follower):
            thread.join()
        self.assertIsInstance(owner[1]['error'], Superseded)
        self.assertEqual(follower[1]['value'], 'day-1')

    def test_waiting_is_bounded(self):
        gate = ReplayGate(timeout=.1)
        blocker = in_thread(gate.run, 'long', slow('long', .4))
        time.sleep(.02)
        started = time.monotonic()
        with self.assertRaises(Busy):
            gate.run('queued', slow('queued', .01))
        self.assertLess(time.monotonic() - started, .3)
        blocker[0].join()

    def test_errors_release_the_slot_and_reach_everyone_waiting(self):
        gate = ReplayGate()

        def boom():
            time.sleep(.1)
            raise TimeoutError('upstream')
        a = in_thread(gate.run, 'day', boom, client='A', seq=1)
        time.sleep(.02)
        b = in_thread(gate.run, 'day', boom, client='B', seq=1)
        for thread, _ in (a, b):
            thread.join()
        self.assertIsInstance(a[1]['error'], TimeoutError)
        self.assertIsInstance(b[1]['error'], TimeoutError)
        self.assertEqual(gate.run('next', lambda: 'ok'), 'ok')  # slot was released


if __name__ == '__main__':
    unittest.main()

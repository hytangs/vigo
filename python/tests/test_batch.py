"""Ordered batches overlap work without unbounded submission or lost failures."""

import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from vigo import City, InvalidQuery, Matrix, Result, RuntimeInfo


class BatchTest(unittest.TestCase):
    def setUp(self):
        self.city = City(Path('.'), RuntimeInfo('0.5.2', '1.0', 'test', 'unused',
                                               ('unused',), {}), {})
        self.city._stream_limit = 2
        self.queries = [Matrix({'a': 'A'}, {'b': 'B'}) for _ in range(8)]

    def tearDown(self):
        self.city.close()

    def test_lazy_bounded_overlap_and_order(self):
        consumed = []
        barrier = threading.Barrier(2)
        second_done = threading.Event()
        def source():
            for i, query in enumerate(self.queries):
                consumed.append(i)
                yield query
        def execute(query, scenario):
            index = next(i for i, q in enumerate(self.queries) if q is query)
            if index < 2:
                barrier.wait(timeout=5)
                if index == 0:
                    self.assertTrue(second_done.wait(timeout=5))
                else:
                    second_done.set()
            return Result('matrix', {'resultSchemaVersion': 1, 'status': 'ready', 'index': index, 'rows': [{'journey': {'legs': [index]}}]}, 'test')
        with patch.object(self.city, '_execute', side_effect=execute):
            results = self.city.iter_run(source(), workers=2)
            self.assertEqual(consumed, [])
            self.assertEqual(next(results).to_dict()['index'], 0)
            self.assertEqual(consumed, [0, 1])
            rest = list(results)
        self.assertEqual([r.to_dict()['index'] for r in rest], list(range(1, 8)))
        self.assertEqual(rest[-1].rows[0]['journey']['legs'], [7])

    def test_close_does_not_consume_tail(self):
        consumed = []
        def source():
            for i, q in enumerate(self.queries):
                consumed.append(i)
                yield q
        with patch.object(self.city, '_execute', return_value=Result('matrix', {'resultSchemaVersion': 1, 'status': 'ready'}, 'test')):
            results = self.city.iter_run(source(), workers=2)
            next(results)
            results.close()
        self.assertEqual(consumed, [0, 1])

    def test_failure_is_propagated_without_consuming_remaining_input(self):
        consumed = []
        def source():
            for i, q in enumerate(self.queries):
                consumed.append(i)
                yield q
        with (patch.object(self.city, '_execute', side_effect=InvalidQuery('broken')),
              self.assertRaisesRegex(InvalidQuery, 'broken')):
            list(self.city.iter_run(source(), workers=2))
        self.assertEqual(consumed, [0, 1])

    def test_source_failure_and_empty_batch(self):
        def source():
            yield self.queries[0]
            raise ValueError('source failed')
        with patch.object(self.city, '_execute', return_value=Result('matrix', {'resultSchemaVersion': 1, 'status': 'ready'}, 'test')):
            with self.assertRaisesRegex(ValueError, 'source failed'):
                list(self.city.iter_run(source(), workers=2))
            self.assertEqual(self.city.run([], workers=2), [])

    def test_workers_validation_and_capacity(self):
        for workers in (0, 5, -1, True, 1.5, '2'):
            with self.subTest(workers=workers):
                with self.assertRaisesRegex(ValueError, 'workers'):
                    self.city.iter_run([], workers=workers)
                with self.assertRaisesRegex(ValueError, 'workers'):
                    self.city.run([], workers=workers)
        self.city._stream_limit = 1
        names = []
        with patch.object(self.city, '_execute', side_effect=lambda *_: names.append(threading.current_thread().name)):
            self.assertEqual(self.city.run(self.queries, workers=4), [None] * 8)
        self.assertEqual(set(names), {threading.current_thread().name})

    def test_default_stays_serial_and_scenario_is_preserved(self):
        scenario = self.city.scenario('test')
        expected = Result('matrix', {'resultSchemaVersion': 1, 'status': 'ready'}, 'test')
        with patch.object(self.city, '_execute', return_value=expected) as execute:
            self.assertEqual(scenario.run(self.queries, workers=2), [expected] * 8)
            self.assertTrue(all(call.args[1] is scenario for call in execute.call_args_list))
            execute.reset_mock()
            results = self.city.iter_run(self.queries)
            self.assertIs(next(results), expected)
            self.assertEqual(execute.call_count, 1)
            results.close()

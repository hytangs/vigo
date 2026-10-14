import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vigo._resources import _linux_limits, worker_count


class ResourceTest(unittest.TestCase):
    def test_nested_v2_parent_limits_and_unlimited_leaf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            leaf = root / 'parent/worker'
            leaf.mkdir(parents=True)
            membership = root / 'membership'
            membership.write_text('0::/parent/worker\n')
            (leaf / 'memory.max').write_text('max')
            (root / 'parent/memory.max').write_text(str(2 * 1024**3))
            (root / 'parent/memory.high').write_text(str(1024**3))
            (root / 'parent/cpu.max').write_text('150000 100000')
            (leaf / 'memory.swap.max').write_text(str(64 * 1024**3))
            memory, cpus = _linux_limits(root, membership)
            self.assertEqual(sorted(memory), [1024**3, 2 * 1024**3])
            self.assertEqual(cpus, [1])
            (root / 'parent/memory.high').write_text('0')
            self.assertIn(0, _linux_limits(root, membership)[0])

    def test_v1_and_malformed_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('memory', 'cpu,cpuacct'):
                (root / name / 'group').mkdir(parents=True)
            membership = root / 'membership'
            membership.write_text('3:memory:/group\n2:cpu,cpuacct:/group\n0::/../../outside\ninvalid\n')
            (root / 'memory/group/memory.limit_in_bytes').write_text(str(2 * 1024**3))
            (root / 'cpu,cpuacct/group/cpu.cfs_quota_us').write_text('200000')
            (root / 'cpu,cpuacct/group/cpu.cfs_period_us').write_text('100000')
            self.assertEqual(_linux_limits(root, membership), ([2 * 1024**3], [2]))
            (root / 'cpu,cpuacct/group/cpu.cfs_quota_us').write_text('-1')
            self.assertEqual(_linux_limits(root, membership)[1], [])

    def test_container_ram_and_cpu_override_large_host(self):
        with (patch('vigo._resources.os.cpu_count', return_value=64),
              patch('vigo._resources.os.sysconf', side_effect=lambda n: 4096 if n == 'SC_PAGE_SIZE' else 64 * 1024**3 // 4096),
              patch('vigo._resources.Path.is_file', return_value=True),
              patch('vigo._resources._linux_limits', return_value=([2 * 1024**3], [2]))):
            self.assertEqual(worker_count(), 1)
        with (patch('vigo._resources.os.cpu_count', return_value=64),
              patch('vigo._resources.os.sysconf', side_effect=OSError),
              patch('vigo._resources.Path.is_file', return_value=False)):
            self.assertEqual(worker_count(), 1)

"""Machine locations are configurable without changing pinned engineering rules."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('local_path_test_' + name, ROOT / 'hdk' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LocalPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / 'home'
        mocked = patch.object(Path, 'home', return_value=self.home); mocked.start(); self.addCleanup(mocked.stop)
        mocked = patch.dict(os.environ, {}, clear=True); mocked.start(); self.addCleanup(mocked.stop)

    def test_defaults_keep_existing_home_relative_locations_and_pinned_tool_versions(self):
        source = self.home / 'Documents/文档整理'
        self.assertEqual(load('runtime').SOURCE_ROOT, source.resolve())
        process = load('process_requirements')
        self.assertEqual(process.DEFAULT_TEMPLATE.parent.parent.parent, source / 'WT9932S31-TINY_HDK_V1.0')
        self.assertEqual(load('pipeline').TEMPLATE, process.DEFAULT_TEMPLATE)
        self.assertEqual(load('pinout_learning').DEFAULT_REFERENCE, source / 'WT9932S31-TINY_Pinout_V1.0.png')
        toolchain = load('test_firmware').default_toolchain()
        self.assertEqual(Path(toolchain['compilerBin']), self.home / '.espressif/tools/riscv32-esp-elf/esp-15.2.0_20251204/riscv32-esp-elf/bin')
        self.assertEqual(Path(toolchain['cmakeBin']), self.home / '.espressif/tools/cmake/3.30.2/CMake.app/Contents/bin')
        self.assertEqual(Path(toolchain['ninjaBin']), self.home / '.espressif/tools/ninja/1.12.1')

    def test_source_root_and_specific_file_overrides_are_explicit(self):
        source = self.root / 'inputs'
        template, reference = self.root / 'manufacturing.xlsx', self.root / 'pinout.png'
        with patch.dict(os.environ, {'WORKBENCH_HDK_SOURCE_ROOT': str(source)}):
            self.assertEqual(load('runtime').SOURCE_ROOT, source.resolve())
            self.assertTrue(load('process_requirements').DEFAULT_TEMPLATE.is_relative_to(source))
            self.assertTrue(load('pipeline').TEMPLATE.is_relative_to(source))
            self.assertTrue(load('pinout_learning').DEFAULT_REFERENCE.is_relative_to(source))
            with patch.dict(os.environ, {'WORKBENCH_HDK_PROCESS_TEMPLATE': str(template), 'WORKBENCH_HDK_PINOUT_REFERENCE': str(reference)}):
                self.assertEqual(load('process_requirements').DEFAULT_TEMPLATE, template)
                self.assertEqual(load('pipeline').TEMPLATE, template)
                self.assertEqual(load('pinout_learning').DEFAULT_REFERENCE, reference)

    def test_tool_overrides_do_not_change_the_pinned_sdk_or_other_bins(self):
        firmware = load('test_firmware')
        default = firmware.default_toolchain()
        tools = self.root / 'espressif'
        with patch.dict(os.environ, {'WORKBENCH_HDK_ESPRESSIF_HOME': str(tools)}):
            configured = firmware.default_toolchain()
            for key in ('compilerBin', 'cmakeBin', 'ninjaBin'):
                self.assertTrue(Path(configured[key]).is_relative_to(tools))
            self.assertEqual(configured['idfPath'], default['idfPath'])
            with patch.dict(os.environ, {'WORKBENCH_HDK_COMPILER_BIN': str(self.root / 'compiler')}):
                self.assertEqual(firmware.default_toolchain()['compilerBin'], str(self.root / 'compiler'))
                self.assertEqual(firmware.default_toolchain()['cmakeBin'], configured['cmakeBin'])


if __name__ == '__main__': unittest.main()

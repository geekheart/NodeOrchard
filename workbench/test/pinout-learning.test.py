import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pinout_learning', ROOT / 'hdk/pinout_learning.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PinoutLearningTests(unittest.TestCase):
    def fixture(self, root, side='front'):
        root.mkdir(parents=True, exist_ok=True)
        source = root / 'current.epro2'
        source.write_bytes(b'independent current source fixture')
        original = root / 'photo.png'
        photo = Image.new('RGBA', (200, 400), (60, 70, 80, 255))
        drawing = ImageDraw.Draw(photo)
        drawing.rectangle([20, 20, 180, 380], fill=(50, 60, 70, 255))
        photo.save(original)
        image_data = 'data:image/png;base64,' + base64.b64encode(original.read_bytes()).decode()
        groups, connectors, svg_groups = [], [], []
        raster = Image.new('RGBA', (380, 480), (0, 0, 0, 0))
        raster.paste(photo, (90, 40))
        drawing = ImageDraw.Draw(raster)
        for ref, x, px, names in [('J1', 15, 10, [('IO1', 'P4 IO1', '#3498db'), ('IO2', 'P4 IO2', '#3498db'), ('GND', 'GND', '#2ecc71')]),
                                  ('J2', 295, 190, [('C61_IO1', 'C61 IO1', '#3498db'), ('C61_EN', 'C61 EN', '#3498db'), ('5V', '5V', '#ff0000')])]:
            pins, facts_pins, parts = [], [], []
            for index, (net, label, color) in enumerate(names):
                y, pad = 60 + index*20, str(index+1)
                facts_pins.append({'pad': pad, 'net': net, 'imagePixel': [px, y+8-40]})
                pins.append({'_pin': pad, '_net': net, 'name': label, 'color': color})
                drawing.rounded_rectangle([x, y, x+69, y+15], radius=8, fill=color)
                drawing.text((x+6, y+1), label, fill='white')
                parts.append(f'<rect x="{x}" y="{y}" width="70" height="16" rx="8" fill="{color}"/>'
                             f'<text x="{x+6}" y="{y+12}" fill="#ffffff">{escape(label)}</text>')
            groups.append({'connector': ref, 'layout': 'vertical', 'scale': 1, 'gap': 20, 'start': [x, 60], 'pins': pins})
            connectors.append({'designator': ref, 'pins': facts_pins})
            svg_groups.append('<g font-size="12">' + ''.join(parts) + '</g>')
        png, svg, project_path, facts_path = [root / name for name in ('pinout.png', 'pinout.svg', 'saved.json', 'facts.json')]
        raster.save(png)
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="380" height="480">'
                       f'<image x="90" y="40" width="200" height="400" href="{image_data}"/>'
                       + ''.join(svg_groups) + '</svg>')
        project = {'format': 'openpinmap', 'version': 2, 'state': {'width': 380, 'height': 480, 'fontSize': 12,
                   'imageX': 90, 'imageY': 40, 'imageScale': 100, 'imageData': image_data, 'guides': False,
                   'background': 'transparent', 'exportSettings': {'scale': 1}, 'groups': groups},
                   'workbenchAlignment': {'calibration': {'passed': True}, 'maxAlignmentErrorPx': 0}}
        facts = {'source': {'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()},
                 'photograph': {'side': side, 'original': {'path': str(original), 'sha256': hashlib.sha256(original.read_bytes()).hexdigest()},
                                'cropBox': [0, 0, 200, 400]}, 'connectors': connectors}
        project_path.write_text(json.dumps(project))
        facts_path.write_text(json.dumps(facts))
        return {'side': side, 'pngPath': str(png), 'svgPath': str(svg), 'projectPath': str(project_path), 'factsPath': str(facts_path)}

    def evaluate(self, views):
        return MODULE.evaluate_pinout_views(views, reference_contract=MODULE.build_reference_contract(views[0]['pngPath']))

    def test_actual_pixels_and_reference_features_are_measured(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            contract = MODULE.build_reference_contract(view['pngPath'])
            self.assertGreater(contract['reference']['transparentFraction'], .4)
            self.assertEqual(contract['reference']['largestOpaqueComponent']['bbox'], [90, 40, 290, 440])
            self.assertEqual(contract['reference']['detachedCapsuleCount'], 6)
            self.assertEqual(contract['reference']['medianCapsuleWidthPx'], 70)
            expected = MODULE.build_learning_expected(reference_png=view['pngPath'])
            self.assertTrue(all(expected['qualitySummary']['checks'].values()))
            self.assertNotIn('IO1', json.dumps(expected))
            self.assertNotIn('current.epro2', json.dumps(expected))

    def test_selected_view_and_two_views_pass_without_fake_guides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front, back = self.fixture(root/'front'), self.fixture(root/'back', 'back')
            for views in ([front], [back], [front, back]):
                result = self.evaluate(views)
                self.assertTrue(result['passed'], result['diagnostics'])
                self.assertLess(len(json.dumps(result['learningComparison']).encode()), 60*1024)
                self.assertEqual(result['metrics'][0]['rowMaxErrorPx'], 0)
                self.assertEqual(result['metrics'][0]['photo']['samplePassFraction'], 1)

    def test_white_raster_cannot_hide_behind_transparent_project_setting(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            path = Path(view['pngPath'])
            image = Image.open(path).convert('RGBA')
            white = Image.new('RGBA', image.size, 'white')
            white.alpha_composite(image)
            white.save(path)
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['transparent-portrait'])
            self.assertEqual(result['metrics'][0]['png']['transparentFraction'], 0)

    def test_actual_image_edge_guides_fail_despite_passed_alignment_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            project = json.loads(Path(view['projectPath']).read_text())
            project['state']['guides'] = True
            Path(view['projectPath']).write_text(json.dumps(project))
            path = Path(view['svgPath'])
            guides = ''.join(f'<path d="M {85 if index < 3 else 295} {68+index%3*20} L {90 if index < 3 else 290} {68+index%3*20}" stroke="#3498db"/>' for index in range(6))
            path.write_text(path.read_text().replace('</svg>', guides+'</svg>'))
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['pad-row-or-guide-alignment'])
            self.assertEqual(result['metrics'][0]['guideMaxPadErrorPx'], 10)

    def test_actual_capsule_to_pad_row_error_is_not_self_reported_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            path = Path(view['svgPath'])
            path.write_text(path.read_text().replace('<g font-size="12">', '<g transform="translate(0 7)" font-size="12">', 1))
            result = self.evaluate([view])
            self.assertEqual(result['metrics'][0]['rowMaxErrorPx'], 7)
            self.assertFalse(result['qualitySummary']['checks']['pad-row-or-guide-alignment'])

    def test_matching_row_cannot_hide_labels_on_the_opposite_photo_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            path = Path(view['svgPath'])
            path.write_text(path.read_text().replace('<g font-size="12">', '<g transform="translate(280 0)" font-size="12">', 1))
            result = self.evaluate([view])
            self.assertEqual(result['metrics'][0]['rowMaxErrorPx'], 0)
            self.assertFalse(result['qualitySummary']['checks']['pad-row-or-guide-alignment'])
            self.assertTrue(any('opposite side' in issue['message'] for issue in result['diagnostics']))

    def test_exported_visible_label_and_retained_electrical_net_are_independent_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            path = Path(view['projectPath'])
            project = json.loads(path.read_text())
            project['state']['groups'][0]['pins'][0]['_net'] = 'IO99'
            path.write_text(json.dumps(project))
            svg = Path(view['svgPath'])
            svg.write_text(svg.read_text().replace('P4 IO1</text>', 'P4 IO99</text>'))
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['source-pin-trace'])
            self.assertFalse(result['qualitySummary']['checks']['visible-labels-match-project'])

    def test_missing_raster_labels_are_caught_at_actual_capsule_positions(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            image = Image.open(view['pngPath']).convert('RGBA')
            drawing = ImageDraw.Draw(image)
            drawing.rectangle([0, 0, 89, 479], fill=(0, 0, 0, 0))
            image.save(view['pngPath'])
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['visible-labels-match-project'])

    def test_compact_gpio_alias_must_not_erase_source_proven_boot_role(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            facts_path = Path(view['factsPath'])
            facts = json.loads(facts_path.read_text())
            facts['connectors'][0]['pins'][1]['net'] = 'IO2_BOOT'
            facts_path.write_text(json.dumps(facts))
            project_path = Path(view['projectPath'])
            project = json.loads(project_path.read_text())
            project['state']['groups'][0]['pins'][1]['_net'] = 'IO2_BOOT'
            project_path.write_text(json.dumps(project))
            result = self.evaluate([view])
            self.assertTrue(result['qualitySummary']['checks']['source-pin-trace'])
            self.assertFalse(result['qualitySummary']['checks']['multi-chip-disambiguation'])
            self.assertTrue(any('BOOT role disappears' in issue['message'] for issue in result['diagnostics']))

    def test_photo_pixel_tampering_is_caught_even_when_all_hash_fields_are_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            image = Image.open(view['pngPath']).convert('RGBA')
            ImageDraw.Draw(image).rectangle([90, 40, 289, 439], fill='#ffffff')
            image.save(view['pngPath'])
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['source-photo-preserved'])
            self.assertLess(result['metrics'][0]['photo']['samplePassFraction'], .1)

    def test_bilingual_style_learning_does_not_accept_wrong_view_electrical_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            front, back = self.fixture(root/'front'), self.fixture(root/'back', 'back')
            path = Path(back['factsPath'])
            facts = json.loads(path.read_text())
            facts['connectors'][0]['pins'][0]['net'] = 'IO7'
            path.write_text(json.dumps(facts))
            result = self.evaluate([front, back])
            self.assertFalse(result['qualitySummary']['checks']['two-view-electrical-consistency'])

    def test_unknown_transform_or_missing_picture_is_diagnostic_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            view = self.fixture(Path(directory))
            path = Path(view['svgPath'])
            path.write_text(path.read_text().replace('<g font-size="12">', '<g transform="skewX(30)" font-size="12">', 1))
            result = self.evaluate([view])
            self.assertFalse(result['qualitySummary']['checks']['actual-export-readable'])
            self.assertTrue(result['diagnostics'])


if __name__ == '__main__':
    unittest.main()

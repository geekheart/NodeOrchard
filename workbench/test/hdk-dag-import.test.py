"""Cross-run imports and current human reviews use actual SQLite and files."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('dag_existing_fixtures',Path(__file__).with_name('hdk-dag-capabilities.test.py'))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
capability=fixtures.capability

class ImportBoundaries(unittest.TestCase):
    setUp=fixtures.DAGCapabilityBoundaries.setUp
    save_row=fixtures.DAGCapabilityBoundaries.save_row
    save_run=fixtures.DAGCapabilityBoundaries.save_run
    save_profile=fixtures.DAGCapabilityBoundaries.save_profile
    completed_parent=fixtures.DAGCapabilityBoundaries.completed_parent

    def finished(self):
        result=self.completed_parent()
        self.run['status']='complete';self.save_run()
        return result

    def test_explicit_completed_import_rechecks_source_and_attested_current_attempt(self):
        token=self.finished()
        data=capability.foreign_receipt(token['receiptPath'],'hdk.four.prepare',capability.sha(self.source))
        self.assertEqual(data['importedReceipt']['nodeId'],'prepare')
        self.assertEqual(data['importedReceipt']['receiptSha256'],token['receiptSha256'])
        self.assertEqual(data['request']['images'],self.images)

    def test_import_refuses_learning_running_and_another_source(self):
        token=self.finished();original=copy.deepcopy(self.run)
        for mutation in [lambda r:r.update(status='waiting_review'),lambda r:r.update(learningId='training')]:
            self.run=copy.deepcopy(original);mutation(self.run);self.save_run()
            with self.assertRaises(ValueError):capability.foreign_receipt(token['receiptPath'],'hdk.four.prepare')
        self.run=original;self.save_run()
        with self.assertRaises(ValueError):capability.foreign_receipt(token['receiptPath'],'hdk.four.prepare','0'*64)

    def test_import_refuses_superseded_token_attempt_and_modified_original(self):
        token=self.finished();original=copy.deepcopy(self.run)
        for mutate in [lambda n:n.update(attempt=2),lambda n:n['output'].update(receiptSha256='0'*64),lambda n:n['output'].update(nodeId='other')]:
            self.run=copy.deepcopy(original);mutate(self.run['nodes']['prepare']);self.save_run()
            with self.assertRaises(ValueError):capability.foreign_receipt(token['receiptPath'],'hdk.four.prepare')
        self.run=original;self.save_run();self.source.write_bytes(b'changed source')
        with self.assertRaises(ValueError):capability.foreign_receipt(token['receiptPath'],'hdk.four.prepare')

    def review(self):
        file={'path':self.images[0]['path'],'sha256':self.images[0]['sha256']}
        value={'current':'image receipt'}
        run={'document':{'nodes':[{'id':'review','type':'human'},{'id':'consumer','type':'tool'}],
            'edges':[{'sourceNode':'review','targetNode':'consumer','targetPort':'pictures'}]},
            'nodes':{'review':{'status':'complete','output':value,'artifacts':[dict(file,id='artifact')],
            'review':{'decision':'approved','reviewedAt':'2026-10-25T09:00:00Z','artifactHashes':[{'id':'artifact','sha256':file['sha256']}]}}}}
        return run,value,file

    def test_review_supports_named_port_and_uses_exact_approved_current_file(self):
        run,value,file=self.review()
        proof=capability.reviewed_artifacts(run,{'nodeId':'consumer'},value,[file],port='pictures')
        self.assertEqual(proof['nodeId'],'review')
        with self.assertRaises(ValueError):capability.reviewed_artifacts(run,{'nodeId':'consumer'},value,[file])

    def test_review_refuses_old_output_nonhuman_wrong_approval_and_modified_bytes(self):
        original,value,file=self.review()
        for mutate in [lambda r:r['nodes']['review'].update(output={'old':'image'}),
                lambda r:r['document']['nodes'][0].update(type='merge'),
                lambda r:r['nodes']['review']['review'].update(decision='revise'),
                lambda r:r['nodes']['review']['review'].update(artifactHashes=[])]:
            run=copy.deepcopy(original);mutate(run)
            with self.assertRaises(ValueError):capability.reviewed_artifacts(run,{'nodeId':'consumer'},value,[file],port='pictures')
        Path(file['path']).write_bytes(b'changed after review')
        with self.assertRaises(ValueError):capability.reviewed_artifacts(original,{'nodeId':'consumer'},value,[file],port='pictures')

    def test_review_refuses_empty_or_duplicate_artifact_targets(self):
        run,value,file=self.review()
        for files in [[],[file,file]]:
            with self.assertRaises(ValueError):capability.reviewed_artifacts(run,{'nodeId':'consumer'},value,files,port='pictures')

if __name__=='__main__':unittest.main()

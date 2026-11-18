import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]))
import publication_transport as T

class TransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name)
        self.cfg=self.root/'config.json'
        self.env=mock.patch.dict(os.environ,MGU_PUBLICATION_TRANSPORT=str(self.cfg))
        self.env.start();self.addCleanup(self.env.stop)
    def configure(self):
        self.driver=self.root/'driver.py'
        self.driver.write_text('')
        self.config=dict(schema=1,mode='oss-with-edge',driver=str(self.driver),lock=str(self.root/'lock'),result=str(self.root/'acceptance.json'))
        self.cfg.write_text(json.dumps(self.config));self.cfg.chmod(0o600)
    def result(self):
        return dict(channel='stable',manifest_sha256='a'*64,public_verified=True,status='published')
    def test_disabled_does_not_change_public_url(self):
        self.assertEqual(T.storage_url(T.PUBLIC+'cn/cn-manifest.json'),T.PUBLIC+'cn/cn-manifest.json')
    def test_only_exact_production_prefix_reads_storage(self):
        self.configure()
        self.assertEqual(T.storage_url(T.PUBLIC+'cn/cn-manifest.json'),T.STORAGE+'cn/cn-manifest.json')
        for url in ['https://github.com/a','https://mgu.walle.pw.evil/mgu/x','https://mgu.walle.pw/other']:
            self.assertEqual(T.storage_url(url),url)
    @unittest.skipIf(os.name == "nt", "POSIX file permissions")
    def test_config_must_be_private(self):
        self.configure();self.cfg.chmod(0o644)
        with self.assertRaises(ValueError):T.settings()
    @unittest.skipIf(os.name == "nt", "POSIX publication lock")
    def test_publication_lock_excludes_another_writer(self):
        self.configure()
        with T.lock(True):
            with self.assertRaises(RuntimeError):
                with T.lock(True):pass
    def test_edge_failure_preserves_storage_success_without_public_success(self):
        self.configure();self.driver.write_text('raise SystemExit(1)')
        with self.assertRaisesRegex(RuntimeError,'OSS verified'):
            T.replicate(self.result(),self.root)
        r=json.loads((self.root/'result.json').read_text())
        self.assertTrue(r['storage_verified']);self.assertFalse(r['public_verified']);self.assertEqual(r['status'],'edge-pending')
    def test_edge_ack_must_name_triggering_manifest(self):
        self.configure()
        pathlib.Path(self.config['result']).write_text(json.dumps(dict(public_verified=True,manifests={})))
        with self.assertRaisesRegex(RuntimeError,'match'):T.replicate(self.result(),self.root)
    def test_exact_ack_permits_public_success(self):
        self.configure()
        pathlib.Path(self.config['result']).write_text(json.dumps(dict(public_verified=True,manifests={'mgu/cn/cn-manifest.json':'a'*64})))
        self.assertTrue(T.replicate(self.result(),self.root)['public_verified'])
    def test_missing_ack_records_storage_success_without_public_success(self):
        self.configure()
        with self.assertRaisesRegex(RuntimeError,'OSS verified'):T.replicate(self.result(),self.root)
        result=json.loads((self.root/'result.json').read_text())
        self.assertTrue(result['storage_verified']);self.assertFalse(result['public_verified'])
    def test_official_and_beta_bind_distinct_roots(self):
        self.configure()
        for channel,path in [(None,'mgu/mirror-manifest.json'),('beta','mgu/cn/beta/cn-manifest.json')]:
            result={'status':'unchanged','manifest_sha256':'b'*64,'remote_verified':True}
            if channel:result['channel']=channel
            pathlib.Path(self.config['result']).write_text(json.dumps(dict(public_verified=True,manifests={path:'b'*64})))
            self.assertTrue(T.replicate(result,self.root)['remote_verified'])

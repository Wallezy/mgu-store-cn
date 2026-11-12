'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const visibility = process.env.MGU_PUBLISH_VISIBILITY;
process.env.MGU_PUBLISH_VISIBILITY = 'public';
const publisher = require('../publish');
const original = cp.execFileSync;
const bytes = Buffer.from('published fixture');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const asset = { id: 1, size: bytes.length, browser_download_url: 'https://example.test/tool.tgz' };
const entry = { id: 'fixture-tool', version: '1.0.0', artifact: { size: bytes.length, sha256: digest } };
const calls = [];
let assets = [asset], payload = Buffer.from('different fixture');
cp.execFileSync = (program, args) => {
    assert.strictEqual(program, 'gh');
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/releases/tags/') ? { assets } : { private: false, visibility: 'public' });
    if (args[0] === 'release' && args[1] === 'download') {
        fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'fixture.tgz'), payload);
        return '';
    }
    throw new Error('Unexpected mutation in read-only release fixture');
};
try {
    assert.throws(() => publisher.uploadArtifact(entry, '/unused-fixture'), /immutable/);
    assets = [asset, asset];
    assert.throws(() => publisher.uploadArtifact(entry, '/unused-fixture'), /immutable/);
    assets = [asset]; payload = bytes;
    assert.strictEqual(publisher.uploadArtifact(entry, '/unused-fixture'), asset.browser_download_url);
    assert(calls.every((args) => args[0] === 'api' && args[1] !== '-X' || args[0] === 'release' && args[1] === 'download'));
    console.log('Immutable published assets: mismatches refused, identical bytes reused, no mutation');
} finally {
    cp.execFileSync = original;
    if (visibility === undefined) delete process.env.MGU_PUBLISH_VISIBILITY;
    else process.env.MGU_PUBLISH_VISIBILITY = visibility;
}

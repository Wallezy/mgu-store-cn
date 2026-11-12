#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const installer = require('../mgu-install');
const script = path.resolve(__dirname, '../mgu-install.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-edition-installer-'));
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const root = path.join(tmp, 'snapshot');
fs.mkdirSync(root);
const files = [];
function put(name, bytes) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
}
const built = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../hu'), 'artifact',
    path.resolve(__dirname, '..'), '--out', path.join(tmp, 'deploy')], { encoding: 'utf8' });
assert.strictEqual(built.status, 0, built.stdout + built.stderr);
const deployFile = fs.readdirSync(path.join(tmp, 'deploy')).find((f) => f.endsWith('.tgz'));
const deployVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../component.json'))).version;
const store = ['robertn_store', 'mgu-updater', 'mgu-deploy', 'mgu-python', 'app-privacy', 'mgu-render', 'mgu-uplink'];
const apps = ['robertn_waze_cluster', 'cluster-render', 'waze-on-cluster'];
const records = {};
for (const [repo, ids] of [['mgu-store', store], ['idrive-apps', apps]]) {
    const components = ids.map((id) => {
        const version = id === 'mgu-deploy' ? deployVersion : '1.2.3';
        const data = id === 'mgu-deploy' ? fs.readFileSync(path.join(tmp, 'deploy', deployFile)) :
            installer.tgz([{ name: 'fixture.txt', data: Buffer.from(id), mode: 0o644 }], 0);
        const name = `${id}@${version}.tgz`, sha = hash(data);
        const url = `packages/${sha}/${name}`;
        put(`${repo}/${url}`, data);
        return { id, kind: id.startsWith('robertn_') ? 'app' : 'tool', build: id.startsWith('robertn_') ? 'unit' : undefined,
            version, requires: id === 'robertn_waze_cluster' ? { 'cluster-render': '1.2.3', 'waze-on-cluster': '1.2.3' } : {},
            artifact: { name, url, size: data.length, sha256: sha } };
    });
    const commit = repo === 'mgu-store' ? '1'.repeat(40) : '2'.repeat(40);
    put(`${repo}/catalog.json`, Buffer.from(JSON.stringify({ schema: 2, distribution: 'walle-cn', commit, components })));
    records[repo] = { repository: `Wallezy/${repo}-cn`, commit,
        integration: { state: 'pending', sha: commit, context: 'release-check/cn-integration' } };
}
put('bootstrap/mgu-install.js', fs.readFileSync(script));
const manifest = { schema: 1, distribution: 'walle-cn', base_url: 'https://mgu.walle.pw/mgu/cn/',
    installReady: false, repositories: records, files };
const writeManifest = () => fs.writeFileSync(path.join(root, 'cn-manifest.json'), JSON.stringify(manifest));
writeManifest();
const snapshot = installer.migrationSnapshot(root);
assert.strictEqual(snapshot.components.length, 10);
console.log('ok - both catalogs, all packages and exact installer are checked locally');
const minimal = installer.migrationRelease(snapshot, { components: [{ id: 'robertn_store' }] });
assert(!minimal.artifacts.some((a) => a.entry.id === 'robertn_waze_cluster'));
assert(!minimal.artifacts.some((a) => a.entry.id === 'mgu-uplink'));
console.log('ok - an edition switch does not install unrelated optional apps');
const withMap = installer.migrationRelease(snapshot, { components: [{ id: 'robertn_waze_cluster' }] });
assert(['robertn_waze_cluster', 'cluster-render', 'waze-on-cluster'].every((id) =>
    withMap.artifacts.some((a) => a.entry.id === id)));
console.log('ok - installed map app brings its complete dependency set');
assert.throws(() => installer.migrationRelease(snapshot, {}), /inventory/);

const args = ['migrate-cn', '--from', root, '--host', 'fixture'];
function run(extra, env) {
    return cp.spawnSync(process.execPath, [script].concat(args, extra), {
        encoding: 'utf8', env: Object.assign({}, process.env, env || {}), input: ''
    });
}
assert.strictEqual(run([]).status, 2);
assert.strictEqual(run(['--plan-only', '--expect-plan', 'a'.repeat(64)]).status, 2);
console.log('ok - the caller must choose plan or exact-plan execution');
const unready = run(['--expect-plan', 'a'.repeat(64)]);
assert.strictEqual(unready.status, 2);
assert(unready.stderr.includes('preparation only'));
console.log('ok - unvalidated snapshot refuses execution before any SSH');

const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const log = path.join(tmp, 'ssh.log');
fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(bin, 'ssh.js')}' "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'ssh.js'), `
const fs = require('fs');
const c = process.argv[process.argv.length - 1];
if (c === '-V') { console.log('OpenSSH_9.0'); process.exit(0); }
fs.appendFileSync(process.env.EDITION_SSH_LOG, c + '\\n');
fs.readFileSync(0);
if (c.includes('status --read-only --json')) console.log(JSON.stringify({components:[{id:'robertn_waze_cluster',version:'1.2.3'}]}));
else if (c.includes('mgu-edition-runtime')) console.log(JSON.stringify({updater:{version:'1.0.0'},busy:null,components:[],sources:[]}));
else if (c.includes('edition-plan')) console.log(JSON.stringify({id:'a'.repeat(64),ready:false,plan:{blocked:[{id:'mgu-updater'}]}}));
else if (c.includes('edition-migrate')) { console.error('fixture target refuses its blocked plan'); process.exit(2); }
else if (!c.includes('tar -xzf') && !c.startsWith('rm -rf')) process.exit(99);
`);
const planned = run(['--plan-only'], { PATH: `${bin}:${process.env.PATH}`, EDITION_SSH_LOG: log });
assert.strictEqual(planned.status, 0, planned.stdout + planned.stderr);
const commands = fs.readFileSync(log, 'utf8');
assert(commands.includes('status --read-only --json'));
assert(commands.includes('edition-plan --distribution-manifest'));
assert(!commands.includes('edition-migrate'));
assert(!commands.includes('first-install'));
assert(!commands.includes('curl'));
console.log('ok - ENET preparation stages the release runner and calls its read-only inventory and plan');

manifest.release_channel = 'beta';
manifest.base_url = 'https://mgu.walle.pw/mgu/cn/beta/';
for (const f of files.filter((v) => v.path.endsWith('/catalog.json'))) {
    const file = path.join(root, f.path), catalog = JSON.parse(fs.readFileSync(file));
    catalog.release_channel = 'beta';
    const data = Buffer.from(JSON.stringify(catalog));
    fs.writeFileSync(file, data);
    f.size = data.length; f.sha256 = hash(data);
}
writeManifest();
const betaDigest = hash(fs.readFileSync(path.join(root, 'cn-manifest.json')));
const betaEnv = { PATH: `${bin}:${process.env.PATH}`, EDITION_SSH_LOG: log };
const logBefore = fs.readFileSync(log, 'utf8');
const betaFirstInstall = cp.spawnSync(process.execPath, [script, 'first-install', '--from', path.join(root, 'mgu-store'), '--host', 'fixture'],
    { encoding: 'utf8', env: Object.assign({}, process.env, betaEnv), input: '' });
assert.strictEqual(betaFirstInstall.status, 2);
assert(betaFirstInstall.stderr.includes('first-install uses Stable'));
assert.strictEqual(run(['--plan-only'], betaEnv).status, 2);
assert.strictEqual(run(['--channel', 'beta', '--expect-plan', 'a'.repeat(64)], betaEnv).status, 2);
assert.strictEqual(run(['--channel', 'beta', '--expect-plan', 'a'.repeat(64), '--expect-snapshot', '0'.repeat(64)], betaEnv).status, 2);
assert.strictEqual(fs.readFileSync(log, 'utf8'), logBefore);
const trial = run(['--channel', 'beta', '--expect-plan', 'a'.repeat(64), '--expect-snapshot', betaDigest], betaEnv);
assert.strictEqual(trial.status, 2);
assert(trial.stderr.includes('fixture target refuses'));
assert(fs.readFileSync(log, 'utf8').includes('edition-migrate'));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'cn-manifest.json'))).installReady, false);
console.log('ok - explicit Beta trial binds the snapshot and preserves target refusals without forging Stable readiness');

const item = files.find((f) => f.path.endsWith('robertn_waze_cluster@1.2.3.tgz'));
const saved = fs.readFileSync(path.join(root, item.path));
fs.writeFileSync(path.join(root, item.path), 'corrupt');
assert.throws(() => installer.migrationSnapshot(root), /bytes|sha256/i);
fs.writeFileSync(path.join(root, item.path), saved);
manifest.files.push(Object.assign({}, files[0]));
writeManifest();
assert.throws(() => installer.migrationSnapshot(root), /inventory/);
manifest.files.pop();
manifest.files[0].path = '../escape';
writeManifest();
assert.throws(() => installer.migrationSnapshot(root), /unsafe/);
console.log('ok - corrupt packages, duplicate inventory and path traversal are refused');
const runtime = { distribution: 'walle-cn', github: false, busy: null,
    components: [{ id: 'robertn_waze_cluster', installed: '1.2.3', source: 'maps' }],
    sources: [{ id: 'maps', type: 'https', label: 'https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json', status: 'ok' }] };
const journal = { steps: [{ id: 'robertn_waze_cluster', version: '1.2.3' }] };
assert.strictEqual(installer.migrationRuntimeCheck(runtime, journal), null);
const betaJournal = Object.assign({}, journal, { plan: { releaseChannel: 'beta' } });
assert(/another CN release channel/.test(installer.migrationRuntimeCheck(runtime, betaJournal)));
runtime.releaseChannel = 'beta';
runtime.sources[0].label = 'https://mgu.walle.pw/mgu/cn/beta/idrive-apps/catalog.json';
assert.strictEqual(installer.migrationRuntimeCheck(runtime, betaJournal), null);
runtime.releaseChannel = 'stable';
runtime.sources[0].label = 'https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json';
runtime.github = true;
assert(/not the CN/.test(installer.migrationRuntimeCheck(runtime, journal)));
runtime.github = false;
runtime.components.push(Object.assign({}, runtime.components[0]));
assert(/one matching/.test(installer.migrationRuntimeCheck(runtime, journal)));
runtime.components.pop();
runtime.sources[0].label = 'https://github.com/owner/repo';
assert(/catalog/.test(installer.migrationRuntimeCheck(runtime, journal)));
runtime.busy = { id: 'mgu-updater', phase: 'install' };
assert(/queued work/.test(installer.migrationRuntimeCheck(runtime)));
console.log('ok - runtime acceptance requires idle updater, CN channel, unique rows and domestic catalogs');
fs.rmSync(tmp, { recursive: true, force: true });

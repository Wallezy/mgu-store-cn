#!/usr/bin/env node
'use strict';

/* CN transport tests on macOS/Linux. SSH is a rejecting fixture, downloads
 * stay on loopback, and no head unit or private SDK is used. */
const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { tgz, untgz, SOURCES } = require('../mgu-install');

const installer = path.resolve(__dirname, '../mgu-install.js');
const wrapper = path.resolve(__dirname, '../install.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-cn-installer-'));
const requests = [];
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const script = Buffer.from('#!/bin/sh\nexit 0\n');
const artifact = tgz([
    { name: 'component.json', data: Buffer.from(JSON.stringify({ id: 'mgu-deploy', version: '1.0.0',
        files: [{ path: 'mgu-deploy.sh', mode: '0755', sha256: hash(script) }] })), mode: 0o644 },
    { name: 'files/mgu-deploy.sh', data: script, mode: 0o755 }
], 0);
const entry = { id: 'mgu-deploy', kind: 'tool', version: '1.0.0', title: 'Deploy fixture',
    artifact: { name: 'mgu-deploy@1.0.0.tgz', url: 'mgu-deploy@1.0.0.tgz', size: artifact.length, sha256: hash(artifact) } };
let catalog = { schema: 2, components: [entry] };
const installerData = fs.readFileSync(installer);
const server = http.createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    if (req.url === '/redirect-github.json') {
        res.writeHead(302, { Location: 'https://raw.githubusercontent.com/example/repo/main/catalog.json' });
        return res.end();
    }
    const files = {
        '/catalog.json': Buffer.from(JSON.stringify(catalog)),
        '/mgu-deploy@1.0.0.tgz': artifact,
        '/bootstrap/mgu-install.js': installerData,
        '/bootstrap/SHA256SUMS': `${hash(installerData)}  mgu-install.js\n`,
        '/bad/mgu-install.js': installerData,
        '/bad/SHA256SUMS': `${'0'.repeat(64)}  mgu-install.js\n`
    };
    if (!(req.url in files)) {
        res.writeHead(404);
        return res.end();
    }
    res.end(files[req.url]);
});

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, out }));
        child.stdin.end();
    });
}

async function main() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(tmp, 'ssh.jsonl');
    const stage = path.join(tmp, 'staged.tgz');
    const fake = path.join(bin, 'ssh.js');
    fs.writeFileSync(fake, `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-V') { console.log('OpenSSH_9.0'); process.exit(0); }
const cmd = args[args.length - 1];
fs.appendFileSync(process.env.CN_TEST_SSH_LOG, JSON.stringify(cmd) + '\\n');
if (cmd.includes('rawcodingdata')) { console.log('ok'); }
else if (cmd.includes('grep -q -e --read-only')) { console.log('read-only'); }
else if (cmd.includes('status --read-only')) { console.log('read-only fixture'); }
else if (cmd.includes('grep -q remove-all')) { console.log('old'); }
else if (cmd.includes('remove-all --json')) { fs.readFileSync(0); console.log(JSON.stringify({apps:[], tools:[]})); }
else if (cmd.includes('/run.sh;')) { fs.writeFileSync(process.env.CN_TEST_STAGE, fs.readFileSync(0)); }
else if (cmd.includes('status --json')) { console.log('active\\n{}'); }
else { console.error('unexpected SSH fixture command: ' + cmd); process.exit(99); }
`);
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 });
    const env = Object.assign({}, process.env, {
        PATH: `${bin}:${process.env.PATH}`, CI: 'true',
        MGU_INSTALL_CATALOG: `${base}/catalog.json`,
        MGU_INSTALL_GITHUB_API: `${base}/forbidden-github`,
        CN_TEST_SSH_LOG: log, CN_TEST_STAGE: stage
    });
    const invoke = (args) => run(process.execPath, [installer].concat(args), env);
    const check = (label, result, status = 0) => {
        assert.strictEqual(result.status, status, `${label}: ${result.out}`);
        console.log(`ok - ${label}`);
    };
    assert.deepStrictEqual(SOURCES, JSON.parse(fs.readFileSync(path.join(__dirname, '../sources.json'))));
    assert.deepStrictEqual(SOURCES.sources.map((s) => [s.id, s.type, s.url]), [
        ['mgu-store', 'https', 'https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json'],
        ['idrive-apps', 'https', 'https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json']
    ]);
    console.log('ok - stable source identities use CN HTTPS catalogs');
    check('first-install uses the public catalog', await invoke(['first-install', '--host', 'fixture',
        '--no-renderer', '--no-uplink', '--no-restart-prompt']));
    assert.deepStrictEqual(requests.map((r) => r.path), ['/catalog.json', '/mgu-deploy@1.0.0.tgz']);
    assert(requests.every((r) => !r.auth));
    const staged = untgz(fs.readFileSync(stage));
    assert.deepStrictEqual(JSON.parse(staged.find((f) => f.name === 'sources.json').data), SOURCES);
    console.log('ok - first-install sends checked artifacts and CN sources, without GitHub');

    requests.length = 0;
    check('status makes no HTTP request', await invoke(['status', '--host', 'fixture']));
    assert.strictEqual(requests.length, 0);
    check('old deploy uninstall fallback uses the public catalog', await invoke(['uninstall', '--host', 'fixture']), 2);
    assert.deepStrictEqual(requests.map((r) => r.path), ['/catalog.json', '/mgu-deploy@1.0.0.tgz']);

    requests.length = 0;
    const stick = path.join(tmp, 'offline resources');
    fs.mkdirSync(stick);
    check('default usb-repo prepares the CN distribution', await invoke(['usb-repo', stick]));
    const from = path.join(stick, 'mgu-repo/mgu-store');
    assert(fs.existsSync(path.join(from, 'catalog.json')));
    assert.deepStrictEqual(requests.map((r) => r.path), ['/catalog.json', '/mgu-deploy@1.0.0.tgz']);
    requests.length = 0;
    check('--from installs without HTTP', await invoke(['first-install', '--from', from,
        '--host', 'fixture', '--no-renderer', '--no-uplink', '--no-restart-prompt']));
    assert.strictEqual(requests.length, 0);
    fs.writeFileSync(log, '');
    for (const args of [['token'], ['token', '--list'], ['first-install', '--token'],
        ['usb-repo', stick, 'github:owner/repo'],
        ['usb-repo', stick, 'https://api.github.com/repos/owner/repo/catalog.json']]) {
        const denied = await invoke(args);
        check(`CN rejects ${args[0]} GitHub input before SSH`, denied, 2);
        assert(denied.out.includes('not supported by the CN installer'));
    }
    assert.strictEqual(requests.length, 0);
    assert.strictEqual(fs.readFileSync(log, 'utf8'), '');
    const redirected = await invoke(['usb-repo', stick, `${base}/redirect-github.json`]);
    check('CN rejects a GitHub redirect before following it', redirected, 2);
    assert(redirected.out.includes('GitHub downloads are not supported'));
    assert.deepStrictEqual(requests.map((r) => r.path), ['/redirect-github.json']);

    catalog = { schema: 2, components: [Object.assign({}, entry, {
        artifact: Object.assign({}, entry.artifact, { sha256: '0'.repeat(64) })
    })] };
    fs.unlinkSync(stage);
    fs.writeFileSync(log, '');
    const bad = await invoke(['first-install', '--host', 'fixture', '--no-renderer', '--no-uplink']);
    check('hash mismatch fails before staging', bad, 1);
    assert(bad.out.includes('sha256 does not match'));
    assert(!fs.existsSync(stage));
    assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);

    const wrapperEnv = Object.assign({}, env, { MGU_INSTALL_DOWNLOAD: `${base}/bootstrap` });
    check('shell wrapper verifies and runs the downloaded JavaScript', await run('sh', [wrapper, '--help'], wrapperEnv));
    check('shell wrapper preserves usage exit status', await run('sh', [wrapper, 'bogus'], wrapperEnv), 2);
    const otherStick = path.join(tmp, 'second stick');
    fs.mkdirSync(otherStick);
    check('shell wrapper preserves paths containing spaces', await run('sh',
        [wrapper, 'usb-repo', otherStick, from], wrapperEnv));
    assert(fs.existsSync(path.join(otherStick, 'mgu-repo/mgu-store/catalog.json')));
    const badWrapper = await run('sh', [wrapper, '--help'], Object.assign({}, env, { MGU_INSTALL_DOWNLOAD: `${base}/bad` }));
    check('shell wrapper refuses a checksum mismatch', badWrapper, 1);
    assert(badWrapper.out.includes('does not match SHA256SUMS'));
    assert(requests.every((r) => !r.path.includes('forbidden-github') && !r.auth));
    requests.length = 0;
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const oldNode = await run('sh', [wrapper, '--help'], wrapperEnv);
    check('shell wrapper requires a usable Node runtime before downloading', oldNode, 1);
    assert(oldNode.out.includes('Node 18 or newer must be installed'));
    assert.strictEqual(requests.length, 0);
    const bundle = path.join(tmp, 'bootstrap output');
    const prepared = require('../installer/bootstrap').prepare(bundle);
    const sums = fs.readFileSync(path.join(bundle, 'SHA256SUMS'), 'utf8');
    prepared.forEach((f) => {
        assert.strictEqual(hash(fs.readFileSync(path.join(bundle, f.name))), f.sha256);
        assert(sums.includes(`${f.sha256}  ${f.name}\n`));
    });
    assert.throws(() => require('../installer/bootstrap').prepare(bundle), /already contains/);
    console.log('ok - bootstrap preparation checksums every script and refuses overwrite');
    console.log('All CN installer transport tests passed; no head unit was contacted.');
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
}).finally(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

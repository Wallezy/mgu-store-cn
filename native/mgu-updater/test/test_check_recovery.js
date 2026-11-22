'use strict';

/* Real cache writes and isolated trial processes; no network or head unit. */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cn = require('../js/cn_sources');
const { Updater } = require('../js/updater');

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        mkdirp(path.dirname(dir));
        fs.mkdirSync(dir);
    }
}

function remove(dir) {
    if (fs.statSync(dir).isDirectory()) {
        fs.readdirSync(dir).forEach((name) => remove(path.join(dir, name)));
        fs.rmdirSync(dir);
    } else {
        fs.unlinkSync(dir);
    }
}

function fixture(root, domestic, channel) {
    const conf = { state_dir: path.join(root, 'state'), tool_root: path.join(root, 'tools'),
        distribution_channel: domestic ? cn.CHANNEL : '', release_channel: channel || 'stable', lease: '' };
    mkdirp(conf.state_dir);
    const def = cn.definition(cn.GROUPS[0], null, conf.release_channel);
    const cat = { mode: 'catalog', distribution: cn.CHANNEL, releaseChannel: conf.release_channel,
        components: ['mgu-updater', 'mgu-deploy', 'robertn_store'].map((id) => ({
            id, version: id === 'mgu-updater' ? '0.8.53' : '1.0.0',
            artifact: { url: `${id}.tgz`, sha256: 'a'.repeat(64) }
        })) };
    const u = Object.assign(Object.create(Updater.prototype), {
        conf, version: '0.8.53', sourcesError: null, src: new Map(), stored: [def], usb: [],
        busy: null, checking: null, reads: 0, notifications: 0,
        ctx: { net: { get: () => Promise.reject(new Error('network is forbidden in this fixture')) } },
        changed() { this.notifications++; },
        freshTokens: () => Promise.resolve(),
        readSource() {
            this.reads++;
            return Promise.resolve(JSON.parse(JSON.stringify(cat)));
        },
        fetchIcons: () => Promise.resolve(),
        recordRequires() {},
        recordContents: () => Promise.resolve(),
        checkUids: () => Promise.resolve(),
        scanUsb() {},
        scanTokens() {},
        pruneIcons() {},
        refresh: () => Promise.resolve(),
        repairStale() {}
    });
    const rt = u.addRuntime(def);
    return { u, rt, def, cat };
}

async function trialFixture(mode, root) {
    const { u } = fixture(root, true);
    const tool = path.join(u.conf.tool_root, 'mgu-updater');
    mkdirp(tool);
    const trial = path.join(tool, 'trial');
    fs.writeFileSync(trial, 'versions/0.8.52\n');
    fs.writeFileSync(path.join(u.conf.state_dir, 'queue.json'), '[{"id":"waiting","op":"install"}]\n');
    u.conf.deploy = path.join(root, 'deploy');
    fs.writeFileSync(u.conf.deploy, `#!${process.execPath}\nprocess.stdout.write("{}\\n");\n`, { mode: 0o755 });
    u.takeQueue = () => {};
    u.next = () => {};
    if (mode === 'reject' || mode === 'reason-write-fails') {
        u.checkTrialCatalog = () => Promise.reject(new Error('fixture catalog failure'));
    } else if (mode === 'throw') {
        u.checkTrialCatalog = () => { throw new Error('fixture synchronous failure'); };
    } else if (mode === 'cache-fails') {
        mkdirp(`${u.checkedFile('mgu-store')}.tmp`);
    }
    if (mode === 'reason-write-fails') {
        fs.mkdirSync(path.join(tool, 'trial-reason.tmp'));
    }
    await u.commitTrial(trial);
    assert.strictEqual(u.busy, null);
    assert(!fs.existsSync(trial));
    assert(fs.existsSync(u.checkedFile('mgu-store')));
    console.log('trial committed and idle');
}

async function main() {
    let passed = 0;
    const test = async (name, run) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-check-recovery-'));
        try {
            await run(root);
            console.log(`ok ${++passed} - ${name}`);
        } finally {
            remove(root);
        }
    };
    for (const channel of ['stable', 'beta']) {
        await test(`fresh CN ${channel} completes checks without an official cache directory`, async (root) => {
            const { u, rt } = fixture(root, true, channel);
            await u.check();
            assert.strictEqual(rt.status, 'ok');
            assert.strictEqual(rt.checking, null);
            assert.strictEqual(u.checking, null);
            assert(fs.existsSync(u.checkedFile('mgu-store')));
            assert(!fs.existsSync(path.join(u.conf.state_dir, 'sources')));
        });
    }
    await test('official distribution completes a fresh check', async (root) => {
        const { u, rt } = fixture(root, false);
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.status, 'ok');
        assert.strictEqual(rt.checking, null);
        assert(fs.existsSync(path.join(u.conf.state_dir, 'sources', 'mgu-store.checked')));
    });
    await test('CN retains a legacy timestamp and prefers its active cache timestamp', async (root) => {
        const { u, rt, def } = fixture(root, true);
        await u.checkSource('mgu-store');
        const checked = u.checkedFile('mgu-store');
        fs.unlinkSync(checked);
        const shared = path.join(u.conf.state_dir, 'sources');
        fs.mkdirSync(shared);
        const legacy = path.join(shared, 'mgu-store.checked');
        const legacyTime = rt.checkedAt + 10000;
        fs.writeFileSync(legacy, `${legacyTime}\n`);
        assert.strictEqual(u.addRuntime(def).checkedAt, legacyTime);
        fs.writeFileSync(checked, `${legacyTime + 10000}\n`);
        assert.strictEqual(u.addRuntime(def).checkedAt, legacyTime + 10000);
        assert.strictEqual(fs.readFileSync(legacy, 'utf8'), `${legacyTime}\n`);
    });
    await test('failed timestamp write releases the check and a later check succeeds', async (root) => {
        const { u, rt } = fixture(root, true);
        const blocked = `${u.checkedFile('mgu-store')}.tmp`;
        mkdirp(blocked);
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.status, 'error');
        assert(/EISDIR/.test(rt.error));
        assert.strictEqual(rt.checking, null);
        fs.rmdirSync(blocked);
        await u.checkSource('mgu-store');
        assert.strictEqual(u.reads, 2);
        assert.strictEqual(rt.status, 'ok');
        assert.strictEqual(rt.error, null);
        assert.strictEqual(rt.checking, null);
    });
    await test('failed catalog write releases the check and a later check succeeds', async (root) => {
        const { u, rt } = fixture(root, true);
        const blocked = `${u.cacheFile('mgu-store')}.tmp`;
        mkdirp(blocked);
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.status, 'error');
        assert.strictEqual(rt.checking, null);
        fs.rmdirSync(blocked);
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.status, 'ok');
        assert.strictEqual(u.reads, 2);
    });
    await test('a source post-processing exception does not wedge later checks', async (root) => {
        const { u, rt } = fixture(root, true);
        u.recordContents = () => Promise.reject(new Error('fixture content failure'));
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.error, 'fixture content failure');
        assert.strictEqual(rt.checking, null);
        u.recordContents = () => Promise.resolve();
        await u.checkSource('mgu-store');
        assert.strictEqual(rt.status, 'ok');
        assert.strictEqual(u.reads, 2);
    });
    await test('a failed global refresh releases the check for a retry', async (root) => {
        const { u } = fixture(root, true);
        u.refresh = () => Promise.reject(new Error('fixture refresh failure'));
        let failure = null;
        try { await u.check(); } catch (e) { failure = e; }
        assert(failure && failure.message === 'fixture refresh failure');
        assert.strictEqual(u.checking, null);
        u.refresh = () => Promise.resolve();
        await u.check();
        assert.strictEqual(u.checking, null);
        assert.strictEqual(u.reads, 2);
    });
    for (const mode of ['success', 'reject', 'throw', 'cache-fails', 'reason-write-fails']) {
        await test(`isolated upgrade trial: ${mode}`, async (root) => {
            const r = cp.spawnSync(process.execPath, [__filename, '--trial-fixture', mode, root], {
                env: Object.assign({}, process.env, { MGU_UPDATER_TRIAL_WAIT_MS: '-1' }),
                encoding: 'utf8', timeout: 6000
            });
            assert.ifError(r.error);
            assert.strictEqual(r.status, mode === 'success' ? 0 : 1, r.stdout + r.stderr);
            const tool = path.join(root, 'tools', 'mgu-updater');
            if (mode === 'success') {
                assert(r.stdout.includes('trial committed and idle'));
            } else {
                assert(fs.existsSync(path.join(tool, 'trial')));
                assert(!fs.existsSync(path.join(root, 'state', 'queue.json')));
                if (mode === 'reason-write-fails') {
                    assert(r.stdout.includes('cannot record update failure:'));
                } else {
                    const reason = fs.readFileSync(path.join(tool, 'trial-reason'), 'utf8');
                    assert(reason.includes(mode === 'cache-fails' ? 'cannot fetch the catalog' :
                        mode === 'throw' ? 'fixture synchronous failure' : 'fixture catalog failure'), reason);
                }
            }
        });
    }
    console.log(`${passed} check recovery tests passed`);
}

if (process.argv[2] === '--trial-fixture') {
    trialFixture(process.argv[3], process.argv[4]).catch((err) => {
        console.error(err);
        process.exitCode = 2;
    });
} else {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

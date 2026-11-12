'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cn = require('../js/cn_sources');
const sources = require('../js/sources');
const { Updater, loadConf } = require('../js/updater');

let passed = 0;
function test(name, run) {
    run();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
}

const store = { id: 'mgu-store', type: 'github', repo: 'robertnisipeanu/mgu-store', builtin: true };
const apps = { id: 'idrive-apps', type: 'github', repo: 'robertnisipeanu/idrive-apps', channel: 'releases' };
const mirror = { id: 's-map', type: 'https', url: 'https://mgu.walle.pw/mgu/idrive-apps/catalog.json' };
const other = { id: 'other', type: 'https', url: 'https://example.test/catalog.json' };
const branch = Object.assign({}, apps, { id: 'dev', channel: 'branch:main' });
const origins = { robertn_store: { source: 'mgu-store' }, robertn_waze_cluster: { source: 'idrive-apps' } };
const get = (rows, id) => rows.find((s) => s.id === id);

test('fresh setup has two HTTPS sources and one builtin', () => {
    const rows = cn.normalize([], {}, {});
    assert.strictEqual(rows.length, 2);
    assert(rows.every((r) => r.type === 'https' && r.url.startsWith(cn.ROOT)));
    assert.strictEqual(rows.filter((r) => r.builtin).length, 1);
});
test('Beta needs explicit selection and preserves installed source identities', () => {
    const stable = cn.normalize([store, apps, mirror], origins, {});
    const beta = cn.normalize([store, apps, mirror], origins, {}, 'beta');
    assert.deepStrictEqual(beta.map((s) => s.id), stable.map((s) => s.id));
    assert(beta.every((s) => s.url.startsWith(cn.ROOTS.beta)));
    assert.strictEqual(cn.releaseChannel({}), 'stable');
    assert.throws(() => cn.normalize([], {}, {}, 'preview'), /unknown/);
    assert.strictEqual(cn.normalize(beta, origins, {}).length, 2);
    assert.strictEqual(get(cn.normalize(beta, origins, {}), apps.id).url, cn.ROOT + 'idrive-apps/catalog.json');
});
test('Stable and Beta catalogs and resources cannot cross channels', () => {
    const beta = cn.definition(cn.GROUPS[0], null, 'beta');
    const value = { mode: 'catalog', distribution: cn.CHANNEL, releaseChannel: 'beta',
        components: [{ artifact: { url: 'packages/hash/tool.tgz' } }] };
    assert.strictEqual(cn.validateCatalog(beta, value), value);
    assert.throws(() => cn.validateCatalog(cn.definition(cn.GROUPS[0]), value), /another release channel/);
    assert.throws(() => cn.validateCatalog(beta, Object.assign({}, value, { releaseChannel: 'stable' })), /another release channel/);
    for (const root of [cn.ROOT, 'https://github.com/owner/repo/']) {
        assert.throws(() => cn.validateCatalog(beta, Object.assign({}, value, {
            components: [{ artifact: { url: root + 'mgu-store/packages/hash/tool.tgz' } }]
        })), /HTTPS/);
    }
    const rt = { def: beta, distribution: cn.CHANNEL, releaseChannel: 'beta', status: 'ok', answered: true,
        components: ['mgu-updater', 'mgu-deploy', 'robertn_store'].map((id) =>
            ({ id, version: '1.0.0', artifact: { sha256: 'a'.repeat(64) } })) };
    assert(cn.trialReady(rt, '1.0.0', 'beta'));
    assert(!cn.trialReady(rt, '1.0.0'));
});
test('shipped CN configuration does not enable automatic GitHub repositories', () => {
    const prior = process.env.MGU_UPDATER_CONF;
    process.env.MGU_UPDATER_CONF = '/nonexistent-mgu-cn-test.conf';
    const conf = loadConf();
    if (prior === undefined) {
        delete process.env.MGU_UPDATER_CONF;
    } else {
        process.env.MGU_UPDATER_CONF = prior;
    }
    assert(cn.enabled(conf));
    assert.strictEqual(conf.default_sources, '');
    assert(!Object.keys(conf).some((key) => /^github_/.test(key) || key === 'builtin_repo'));
});
test('official sources keep IDs and do not mutate persisted input or origins', () => {
    const input = [store, apps, other];
    const before = JSON.stringify({ input, origins });
    const rows = cn.normalize(input, origins, {});
    assert.strictEqual(get(rows, 'idrive-apps').url, cn.ROOT + 'idrive-apps/catalog.json');
    assert.deepStrictEqual(get(rows, 'other'), other);
    assert.strictEqual(JSON.stringify({ input, origins }), before);
});
test('unused mirror and official definitions collapse', () => {
    assert.strictEqual(cn.normalize([store, apps, mirror], origins, {}).length, 2);
});
test('removed official source with recorded canonical origin keeps that identity', () => {
    assert(get(cn.normalize([store, mirror], origins, {}), 'idrive-apps'));
});
test('mirror-installed app retains its random source ID', () => {
    const rows = cn.normalize([store, apps, mirror], { map: { source: mirror.id } }, {});
    assert(get(rows, mirror.id));
    assert(!get(rows, 'idrive-apps'));
});
test('two used identities refuse migration', () => {
    assert.throws(() => cn.normalize([store, apps, mirror],
        { map: { source: apps.id }, renderer: { source: mirror.id } }, {}), /identities/);
});
test('aliases prevent dropping another source identity', () => {
    assert.throws(() => cn.normalize([store, apps, mirror], origins, { 's-map:robertn_waze_cluster': 'map2' }), /identities/);
});
test('unrelated source using canonical ID is not overwritten', () => {
    assert.throws(() => cn.normalize([Object.assign({}, other, { id: store.id })], {}, {}), /custom source/);
});
test('unrecognized builtin is not overwritten', () => {
    assert.throws(() => cn.normalize([Object.assign({}, other, { builtin: true })], {}, {}), /custom source/);
});
test('unrelated GitHub sources are excluded without mutating recovery definitions', () => {
    const input = [store, branch, other, { id: 'raw', type: 'https', url: 'https://raw.githubusercontent.com/a/b/catalog.json' }];
    const before = JSON.stringify(input);
    const rows = cn.normalize(input, {}, {});
    assert(!get(rows, 'dev'));
    assert(!get(rows, 'raw'));
    assert.deepStrictEqual(get(rows, 'other'), other);
    assert.strictEqual(JSON.stringify(input), before);
});
test('GitHub host policy covers subdomains and not look-alike domestic domains', () => {
    ['https://github.com/repo', 'https://objects.githubusercontent.com/a',
        'https://raw.githubusercontent.com./a', 'https://owner.github.io/a',
        'https://ghcr.io/a'].forEach((url) => assert(cn.isGithubUrl(url), url));
    ['https://github.com.example.cn/a', 'https://mgu.walle.pw/mgu/github.com',
        'https://example.cn/catalog.json'].forEach((url) => assert(!cn.isGithubUrl(url), url));
});
test('changed URL changes cache identity', () => {
    assert.notStrictEqual(cn.cacheKey(apps), cn.cacheKey(cn.definition(cn.GROUPS[1])));
    assert.notStrictEqual(cn.cacheKey(mirror), cn.cacheKey(Object.assign({}, mirror, { url: mirror.url + '?other' })));
});
test('CN catalog rejects hidden external package and icon dependencies', () => {
    const def = cn.definition(cn.GROUPS[0]);
    const c = { mode: 'catalog', distribution: cn.CHANNEL,
        components: [{ artifact: { url: 'packages/hash/tool.tgz' }, icon: 'icons/hash/app.png' }] };
    assert.strictEqual(cn.validateCatalog(def, c), c);
    for (const url of ['https://github.com/owner/repo/asset.tgz', 'http://mgu.walle.pw/mgu/a',
        'https://mgu.walle.pw/elsewhere/a', 'https://mgu.walle.pw:8443/mgu/cn/a',
        'https://mgu.walle.pw/mgu/cn/a?signature=expiring', 'https://mgu.walle.pw/mgu/mgu-store/old.tgz']) {
        assert.throws(() => cn.validateCatalog(def, { mode: 'catalog', distribution: cn.CHANNEL,
            components: [{ artifact: { url } }] }), /HTTPS/);
        assert.throws(() => cn.validateCatalog(def, { mode: 'catalog', distribution: cn.CHANNEL,
            components: [{ artifact: { url: 'a.tgz' }, icon: url }] }), /HTTPS/);
    }
    assert.throws(() => cn.validateCatalog(def, { mode: 'tree', components: [] }), /release catalog/);
    assert.throws(() => cn.validateCatalog(def, Object.assign({}, c, { distribution: null })), /walle-cn/);
    assert.strictEqual(cn.validateCatalog(other, c), c);
});
test('online trial needs own answered usable catalog and updater version', () => {
    const rt = { def: cn.definition(cn.GROUPS[0]), distribution: cn.CHANNEL, status: 'ok', answered: true, error: null,
        components: ['mgu-updater', 'mgu-deploy', 'robertn_store'].map((id) =>
            ({ id, version: '0.8.40', artifact: { sha256: 'a'.repeat(64) } })) };
    assert(cn.trialReady(rt, '0.8.40'));
    assert(!cn.trialReady(Object.assign({}, rt, { answered: false }), '0.8.40'));
    assert(!cn.trialReady(Object.assign({}, rt, { error: 'partial' }), '0.8.40'));
    assert(!cn.trialReady(Object.assign({}, rt, { distribution: null }), '0.8.40'));
    assert(!cn.trialReady(Object.assign({}, rt, { def: other }), '0.8.40'));
    assert(!cn.trialReady(Object.assign({}, rt, { components: rt.components.slice(1) }), '0.8.40'));
    assert(!cn.trialReady(rt, '0.8.41'));
    assert(cn.trialReady(rt, '0.8.39'));
});
test('CN trial checks only its own catalog; non-CN keeps the full-source check', () => {
    const asked = [];
    const u = Object.assign(Object.create(Updater.prototype), {
        conf: { distribution_channel: cn.CHANNEL },
        checkSource: (id) => { asked.push(id); return Promise.resolve(); },
        check: () => { asked.push('all'); return Promise.resolve(); }
    });
    u.checkTrialCatalog();
    assert.deepStrictEqual(asked, ['mgu-store']);
    u.conf.distribution_channel = '';
    u.checkTrialCatalog();
    assert.deepStrictEqual(asked, ['mgu-store', 'all']);
});
test('legacy USB copies keep the source identity retained by CN normalization', () => {
    const u = Object.assign(Object.create(Updater.prototype), {
        conf: { distribution_channel: cn.CHANNEL },
        stored: cn.normalize([store, apps, mirror, other], { map: { source: mirror.id } }, {}),
        src: new Map([
            ['usb:store', { def: { type: 'usb' }, copyOf: 'github:robertnisipeanu/mgu-store' }],
            ['usb:maps', { def: { type: 'usb' }, copyOf: 'github:robertnisipeanu/idrive-apps' }],
            ['usb:mirror', { def: { type: 'usb' }, copyOf: mirror.url }],
            ['usb:other', { def: { type: 'usb' }, copyOf: other.url }],
            ['usb:unknown', { def: { type: 'usb' }, copyOf: 'github:another/repo' }]
        ])
    });
    assert.strictEqual(u.originOf('usb:store'), store.id);
    assert.strictEqual(u.originOf('usb:maps'), mirror.id);
    assert.strictEqual(u.originOf('usb:mirror'), mirror.id);
    assert.strictEqual(u.originOf('usb:other'), other.id);
    assert.strictEqual(u.originOf('usb:unknown'), 'usb:unknown');
    u.conf.distribution_channel = '';
    assert.strictEqual(u.originOf('usb:store'), 'usb:store');
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-cn-source-'));
try {
    const sourceFile = path.join(temp, 'sources.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ schema: 1, sources: [store, apps, mirror, other, branch] }));
    const original = fs.readFileSync(sourceFile);
    const make = () => Object.assign(Object.create(Updater.prototype), {
        conf: { distribution_channel: cn.CHANNEL, sources: sourceFile, state_dir: temp },
        origins, aliases: {}, src: new Map(),
        ctx: { githubApi: 'https://api.github.test', githubWeb: 'https://github.test',
            githubRaw: 'https://raw.github.test', githubCodeload: 'https://codeload.github.test' },
        version: '0.8.40', sourcesError: null
    });
    test('actual updater loads normalized runtime without rewriting source file', () => {
        const u = make();
        u.loadSources();
        assert.strictEqual(u.stored.length, 3);
        assert.strictEqual(u.src.get('mgu-store').def.type, 'https');
        assert.deepStrictEqual(fs.readFileSync(sourceFile), original);
    });
    test('source management retains excluded GitHub definitions on disk', () => {
        const u = make();
        u.loadSources();
        u.saveSources(u.stored);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(sourceFile)).sources.find((s) => s.id === branch.id), branch);
        assert(!u.stored.some((s) => s.id === branch.id));
        assert.notStrictEqual(u.freeSourceId(branch.id), branch.id);
        fs.writeFileSync(sourceFile, original);
    });
    test('CN uses separate cache and refuses a mismatched source key', () => {
        const u = make();
        const file = u.cacheFile('mgu-store');
        assert(file.includes('sources-walle-cn'));
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify({ components: [{ id: 'bad' }], sourceKey: cn.cacheKey(store) }));
        u.loadSources();
        assert.deepStrictEqual(u.src.get('mgu-store').components, []);
        fs.writeFileSync(file, JSON.stringify({ mode: 'catalog', distribution: cn.CHANNEL,
            components: [{ id: 'good', artifact: { url: 'good.tgz' } }],
            sourceKey: cn.cacheKey(cn.definition(cn.GROUPS[0])) }));
        u.loadSources();
        assert.strictEqual(u.src.get('mgu-store').components[0].id, 'good');
    });
    test('ambiguous migration loads no source and refuses source writes', () => {
        const u = make();
        u.origins = { one: { source: apps.id }, two: { source: mirror.id } };
        u.loadSources();
        assert(u.sourcesError);
        assert.strictEqual(u.stored.length, 0);
        assert.throws(() => u.saveSources([]), /left as it is/);
        assert.deepStrictEqual(fs.readFileSync(sourceFile), original);
    });
    test('CN does not inject GitHub default repositories', () => {
        const u = make();
        u.conf.default_sources = 'owner/repo:branch';
        u.loadSources();
        const before = JSON.stringify(u.stored);
        u.addDefaultSources();
        assert.strictEqual(JSON.stringify(u.stored), before);
    });
    test('known official and mirror sources cannot be duplicated through Add source', () => {
        const u = make();
        u.loadSources();
        assert(/disabled/.test(u.sourceAdd({ type: 'github', repo: apps.repo })));
        assert(/managed/.test(u.sourceAdd(mirror)));
        assert(/disabled/.test(u.sourceAdd({ type: 'https', url: 'https://raw.githubusercontent.com/owner/repo/catalog.json' })));
    });
    test('managed source cannot disappear until the next restart', () => {
        const u = make();
        u.loadSources();
        assert(/manages/.test(u.sourceRemove('idrive-apps')));
        assert(/cannot be removed/.test(u.sourceRemove('mgu-store')));
    });
    test('non-CN updater retains the original source definitions/cache location', () => {
        const u = make();
        u.conf.distribution_channel = '';
        u.loadSources();
        assert.deepStrictEqual(u.stored, [store, apps, mirror, other, branch]);
        assert(!u.cacheFile('mgu-store').includes('sources-walle-cn'));
    });
} finally {
    fs.readdirSync(temp).forEach((file) => {
        const p = path.join(temp, file);
        if (fs.statSync(p).isDirectory()) {
            fs.readdirSync(p).forEach((f) => fs.unlinkSync(path.join(p, f)));
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
        }
    });
    fs.rmdirSync(temp);
}
const badRuntime = { def: cn.definition(cn.GROUPS[0]), reader: { network: true }, components: [] };
let tokenRefreshes = 0;
const checking = Object.assign(Object.create(Updater.prototype), {
    conf: { distribution_channel: cn.CHANNEL, lease: '' }, src: new Map([['mgu-store', badRuntime]]),
    tokens: { all: () => [{ id: 'old', expiresAt: 1, refreshToken: 'old-refresh-token' }] },
    login: { refresh: () => { tokenRefreshes += 1; return Promise.resolve(null); } },
    changed: () => {},
    readSource: () => Promise.resolve({ mode: 'catalog', distribution: cn.CHANNEL, components: [
        { id: 'mgu-updater', artifact: { url: 'https://github.com/owner/repo/package.tgz' } }
    ] })
});
checking.checkSource('mgu-store').then(() => {
    test('invalid CN resource becomes a source error without wedging checks or committing content', () => {
        assert.strictEqual(badRuntime.status, 'error');
        assert.strictEqual(badRuntime.checking, null);
        assert.strictEqual(badRuntime.answered, false);
        assert.deepStrictEqual(badRuntime.components, []);
    });
    test('managed HTTPS checks do not renew due GitHub OAuth tokens', () => {
        assert.strictEqual(tokenRefreshes, 0);
    });
    let validated = 0;
    const u = Object.assign(Object.create(Updater.prototype), {
        conf: { distribution_channel: cn.CHANNEL }, stored: cn.normalize([], {}, {}), src: new Map(),
        tokens: { scan: () => true, all: () => [{ id: 'old' }] }, tokensChanged: () => {},
        validateTokens: () => { validated += 1; return Promise.resolve(); },
        changed: () => {}, checkUids: () => Promise.resolve(), scanUsb: () => {},
        checkSource: () => Promise.resolve(), pruneIcons: () => {}, refresh: () => Promise.resolve(),
        repairStale: () => {}, usb: []
    });
    return u.check().then(() => {
        test('periodic CN-only check and token scan avoid background GitHub accounts', () => {
            assert.strictEqual(validated, 0);
        });
        u.stored.push({ id: 'custom', type: 'github', repo: 'owner/repo' });
        return u.check();
    }).then(() => {
        test('CN never validates GitHub accounts even with stale runtime definitions', () => {
            assert.strictEqual(validated, 0);
        });
    });
}).then(() => {
    const fail = () => { throw new Error('GitHub runtime must not execute'); };
    const u = Object.assign(Object.create(Updater.prototype), {
        conf: { distribution_channel: cn.CHANNEL, github_client_id: 'old', lease: '' },
        tokens: { all: fail, scan: fail, get: fail, remove: fail }, login: { state: fail, account: fail, start: fail },
        resolved: () => new Map(), defs: () => [], src: new Map(), providers: {}, fetcher: {},
        catalogError: () => null, authorized: () => true
    });
    test('CN state hides accounts and exposes capability to old and new clients', () => {
        const state = u.state();
        assert.strictEqual(state.github, false);
        assert.strictEqual(state.distribution, cn.CHANNEL);
        assert.strictEqual(state.signin, false);
        assert.strictEqual(state.signinApp, null);
        assert.strictEqual(state.login, null);
        assert.deepStrictEqual(state.tokens, []);
    });
    test('CN rejects every GitHub request and does not touch credential storage', () => {
        ['login-start', 'login-cancel', 'token-add', 'token-remove', 'source-probe'].forEach((op) =>
            assert(/disabled/.test(u.handle({ op }, fail)), op));
        assert(/disabled/.test(u.sourceProbe({ repo: 'owner/repo' }, fail)));
        assert(/disabled/.test(u.tokenAdd({ token: 'test' }, fail)));
        assert(/disabled/.test(u.tokenRemove('old')));
        assert.strictEqual(u.scanTokens(), false);
        u.tokensChanged();
        u.signedIn('old', {});
    });
    return Promise.all([u.freshTokens(), u.validateTokens()]);
}).then(() => {
    const def = cn.definition(cn.GROUPS[0]);
    const artifact = { name: 'mgu-updater@0.8.40.tgz', url: 'packages/mgu-updater@0.8.40.tgz',
        sha256: 'a'.repeat(64), size: 10 };
    const doc = { schema: 2, distribution: cn.CHANNEL, components: [{
        id: 'mgu-updater', kind: 'tool', version: '0.8.40', artifact,
        icon: 'icons/updater.png', iconSha256: 'b'.repeat(64)
    }] };
    const reader = sources.reader(def, {
        version: '0.8.40', net: { get: () => Promise.resolve(Buffer.from(JSON.stringify(doc))) }
    });
    return reader.catalog().then((parsed) => {
        test('actual HTTPS reader preserves channel and normalized icon references', () => {
            assert.deepStrictEqual(parsed.components[0].icon, { ref: 'icons/updater.png', sha256: 'b'.repeat(64) });
            assert.strictEqual(cn.validateCatalog(def, parsed), parsed);
        });
        doc.components[0].icon = 'https://github.com/owner/repo/icon.png';
        return reader.catalog();
    }).then((parsed) => {
        test('actual HTTPS reader output rejects foreign normalized icon references', () => {
            assert.throws(() => cn.validateCatalog(def, parsed), /HTTPS/);
        });
    });
}).then(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-edition-queue-'));
    const dir = path.join(root, 'mgu-deploy', 'edition-migrations');
    fs.mkdirSync(path.dirname(dir));
    fs.mkdirSync(dir);
    const id = 'c'.repeat(64);
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id }));
    fs.writeFileSync(path.join(dir, id, 'journal.json'), JSON.stringify({ phase: 'applying' }));
    const u = Object.assign(Object.create(Updater.prototype), {
        conf: { tool_root: root, state_dir: root, distribution_channel: cn.CHANNEL }, authorized: () => true,
        queue: [], conflict: () => { throw new Error('should refuse before queue changes'); },
        next: Updater.prototype.next
    });
    test('active migration blocks queue and source/network mutations', () => {
        assert(/edition migration/.test(u.enqueue({ id: 'map', op: 'install' })));
        assert.strictEqual(u.queue.length, 0);
        ['install', 'source-add', 'source-remove', 'proxy-set', 'wifi-connect', 'reboot'].forEach((op) =>
            assert(/edition migration/.test(u.handle({ op, id: 'map' }, () => {})), op));
        assert.strictEqual(u.handle({ op: 'status' }, () => {}), null);
        assert.strictEqual(u.next(), undefined);
        fs.writeFileSync(path.join(root, 'queue.json'), JSON.stringify([{ id: 'map', op: 'install' }]));
        u.takeQueue();
        assert(fs.existsSync(path.join(root, 'queue.json')));
        assert.strictEqual(u.queue.length, 0);
    });
    test('normal restart is available while migration awaits verification', () => {
        fs.writeFileSync(path.join(dir, id, 'journal.json'), JSON.stringify({ phase: 'awaiting-verification' }));
        let rebooted = false;
        u.reboot = () => { rebooted = true; return null; };
        assert.strictEqual(u.handle({ op: 'reboot' }, () => {}), null);
        assert(rebooted);
    });
    test('malformed migration state refuses writes and removal unblocks the queue', () => {
        fs.writeFileSync(path.join(dir, 'active.json'), '{invalid');
        assert(/recovery-needed/.test(u.enqueue({ id: 'map' })));
        fs.unlinkSync(path.join(dir, 'active.json'));
        assert.strictEqual(u.editionMigration(), null);
        u.enqueue = (item) => u.queue.push(item);
        u.takeQueue();
        assert.strictEqual(u.queue[0].id, 'map');
        assert(!fs.existsSync(path.join(root, 'queue.json')));
    });
    fs.unlinkSync(path.join(dir, id, 'journal.json'));
    fs.rmdirSync(path.join(dir, id));
    fs.rmdirSync(dir);
    fs.rmdirSync(path.dirname(dir));
    fs.rmdirSync(root);
}).then(() => console.log(`${passed} CN source checks passed`)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

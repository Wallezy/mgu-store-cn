'use strict';

const crypto = require('crypto');
const catalog = require('./catalog');
const { URL } = require('url');

const CHANNEL = 'walle-cn';
const ROOT = 'https://mgu.walle.pw/mgu/cn/';
const ROOTS = { stable: ROOT, beta: ROOT + 'beta/' };
const GROUPS = [
    { id: 'mgu-store', repo: 'robertnisipeanu/mgu-store', fork: 'wallezy/mgu-store-cn', builtin: true },
    { id: 'idrive-apps', repo: 'robertnisipeanu/idrive-apps', fork: 'wallezy/idrive-apps-cn' }
];

function enabled(conf) {
    return conf.distribution_channel === CHANNEL;
}

function needsGithub(conf) {
    return !enabled(conf);
}

function releaseChannel(conf) {
    const value = conf && conf.release_channel || 'stable';
    if (!Object.prototype.hasOwnProperty.call(ROOTS, value)) {
        throw new Error('unknown CN release channel');
    }
    return value;
}

function isGithubUrl(value) {
    try {
        const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
        return ['github.com', 'githubusercontent.com', 'githubassets.com', 'github.io', 'ghcr.io']
            .some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch (e) {
        return false;
    }
}

function groupOf(def) {
    return GROUPS.find((g) => def.type === 'github' ?
        (!def.channel || def.channel === 'releases') &&
        [g.repo, g.fork].indexOf(String(def.repo || '').toLowerCase()) >= 0 :
        def.type === 'https' && [
            `${ROOT}${g.id}/catalog.json`,
            `${ROOTS.beta}${g.id}/catalog.json`,
            `https://mgu.walle.pw/mgu/${g.id}/catalog.json`,
            `https://walle-mgu.oss-cn-hangzhou.aliyuncs.com/mgu/${g.id}/catalog.json`,
            `https://walle-jenkins.oss-cn-beijing.aliyuncs.com/mgu/${g.id}/catalog.json`
        ].indexOf(def.url) >= 0);
}

function definition(group, id, channel) {
    const base = ROOTS[releaseChannel({ release_channel: channel })];
    const def = { id: id || group.id, type: 'https', url: `${base}${group.id}/catalog.json` };
    if (group.builtin) {
        def.builtin = true;
    }
    return def;
}

/* Normalization is in memory: startup does not rewrite the owner's sources or
 * installation origins, so an updater trial can return to its previous config. */
function normalize(list, origins, aliases, channel) {
    releaseChannel({ release_channel: channel });
    const out = list.filter((s) => !groupOf(s));
    GROUPS.forEach((g) => {
        const matches = list.filter((s) => groupOf(s) === g);
        if (out.some((s) => s.id === g.id || (g.builtin && s.builtin))) {
            throw new Error(`CN source ${g.id} conflicts with a custom source`);
        }
        const ids = matches.map((s) => s.id).concat(g.id);
        const used = new Set();
        Object.keys(origins || {}).forEach((id) => {
            if (ids.indexOf(origins[id].source) >= 0) {
                used.add(origins[id].source);
            }
        });
        Object.keys(aliases || {}).forEach((key) => {
            const id = key.split(':')[0];
            if (ids.indexOf(id) >= 0) {
                used.add(id);
            }
        });
        if (used.size > 1 || (g.builtin && used.size && !used.has(g.id))) {
            throw new Error(`CN source ${g.id} has multiple or incompatible installed identities`);
        }
        const id = used.size ? Array.from(used)[0] : g.id;
        if (out.some((s) => s.id === id)) {
            throw new Error(`CN source ${id} conflicts with a custom source`);
        }
        out.push(definition(g, id, channel));
    });
    return out.filter((s) => s.type !== 'github' && !(s.type === 'https' && isGithubUrl(s.url)))
        .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin));
}

function cacheKey(def) {
    return crypto.createHash('sha256').update(JSON.stringify({
        id: def.id, type: def.type, repo: def.repo, channel: def.channel, url: def.url, path: def.path
    })).digest('hex');
}

function validateCatalog(def, value) {
    if (!groupOf(def)) {
        return value;
    }
    if (!value || value.mode !== 'catalog' || value.distribution !== CHANNEL ||
        !Array.isArray(value.components) || !value.components.length) {
        throw new Error('CN source must provide a nonempty walle-cn release catalog');
    }
    const channel = def.url.startsWith(ROOTS.beta) ? 'beta' : 'stable';
    if ((value.releaseChannel || 'stable') !== channel) {
        throw new Error('CN catalog belongs to another release channel');
    }
    const prefix = new URL('.', def.url).pathname;
    value.components.forEach((entry) => {
        const urls = [entry.artifact && (entry.artifact.url || entry.artifact.name)];
        if (entry.icon) {
            urls.push(typeof entry.icon === 'string' ? entry.icon : entry.icon.ref);
        }
        urls.forEach((rel) => {
            if (typeof rel !== 'string' || !rel) {
                throw new Error('CN catalog needs a package URL');
            }
            const url = new URL(rel, def.url);
            if (url.protocol !== 'https:' || url.hostname !== 'mgu.walle.pw' || url.port ||
                url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) {
                throw new Error('CN catalog resources must use its domestic HTTPS host and prefix');
            }
        });
    });
    return value;
}

/* A response from another source cannot prove this distribution can update
 * itself. The current updater must also be present in its own catalog. */
function trialReady(runtime, version, channel) {
    const g = GROUPS[0];
    return !!(runtime && runtime.def.type === 'https' && runtime.def.url === definition(g, null, channel).url &&
        (runtime.releaseChannel || 'stable') === releaseChannel({ release_channel: channel }) &&
        runtime.distribution === CHANNEL && runtime.status === 'ok' && !runtime.error && runtime.answered &&
        ['mgu-updater', 'mgu-deploy', 'robertn_store'].every((id) =>
            runtime.components.some((c) => c.id === id && c.artifact && c.artifact.sha256 &&
                (id !== 'mgu-updater' || catalog.compareVersions(c.version, version) >= 0))));
}

module.exports = { CHANNEL, ROOT, ROOTS, GROUPS, enabled, needsGithub, releaseChannel, isGithubUrl, groupOf, definition, normalize, cacheKey, validateCatalog, trialReady };

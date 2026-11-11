'use strict';

/* A synthetic updater package for installer tests; never executed on a unit. */
const crypto = require('crypto');
const { tgz } = require('../mgu-install.js');

function artifact(version) {
    const bodies = {
        'updater.js': '// updater fixture\n',
        'cn_sources.js': '// CN policy fixture\n',
        'sources.js': '// sources fixture\n',
        'fetch.js': '// fetch fixture\n',
        'updater.conf': 'distribution_channel = walle-cn\nlocal_conf = /var/opt/mgu-updater/updater.local.conf\n'
    };
    const files = Object.keys(bodies).map((name) => ({ name: `files/${name}`, data: Buffer.from(bodies[name]), mode: 0o644 }));
    const component = { id: 'mgu-updater', kind: 'tool', version,
        files: files.map((f) => ({ path: f.name.slice(6), mode: '0644',
            sha256: crypto.createHash('sha256').update(f.data).digest('hex') })),
        units: [], enable: [], recmgr: [], restart: [] };
    return tgz([{ name: 'component.json', data: Buffer.from(JSON.stringify(component)), mode: 0o644 }].concat(files), 0);
}

module.exports = { artifact };

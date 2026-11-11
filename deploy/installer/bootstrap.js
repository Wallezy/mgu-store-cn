#!/usr/bin/env node
'use strict';

/* Prepare the CN bootstrap files locally; publication is a separate step. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function prepare(out) {
    const names = ['mgu-install.js', 'install.sh', 'install.ps1'];
    const all = names.concat('SHA256SUMS');
    for (const name of all) {
        if (fs.existsSync(path.join(out, name))) {
            throw new Error(`destination already contains ${name}`);
        }
    }
    const files = names.map((name) => {
        const data = fs.readFileSync(path.join(__dirname, '..', name));
        return { name, data, sha256: crypto.createHash('sha256').update(data).digest('hex') };
    });
    fs.mkdirSync(out, { recursive: true });
    files.forEach((f) => fs.writeFileSync(path.join(out, f.name), f.data, { flag: 'wx', mode: 0o644 }));
    fs.writeFileSync(path.join(out, 'SHA256SUMS'),
        files.map((f) => `${f.sha256}  ${f.name}\n`).join(''), { flag: 'wx', mode: 0o644 });
    return files.map((f) => ({ name: f.name, size: f.data.length, sha256: f.sha256 }));
}

if (require.main === module) {
    if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
        console.error('usage: node deploy/installer/bootstrap.js <output folder>');
        process.exitCode = 2;
    } else {
        try {
            console.log(JSON.stringify({ schema: 1, channel: 'walle-cn',
                files: prepare(path.resolve(process.argv[2])) }, null, 2));
        } catch (e) {
            console.error(e.message);
            process.exitCode = 1;
        }
    }
}

module.exports = { prepare };

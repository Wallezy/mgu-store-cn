'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const { contributorsOf } = require('../../native/mgu-updater/js/contributors');
const all = require('../release').components();
assert.strictEqual(all.length, 7);
all.forEach((c) => assert.deepStrictEqual(contributorsOf(c.contributors), c.contributors, c.id + ': reviewed record'));
const generated = require('../../apps/robertn_store/tools/gen_contributors').files();
const tree = require('../../apps/robertn_store/mgu-app.json').tree;
Object.keys(generated).forEach((name) => assert.strictEqual(
    fs.readFileSync(path.join(root, 'apps/robertn_store', tree, name), 'utf8'), generated[name], name + ': shipped credits'));
console.log('contributors: reviewed component records and generated Store package notices pass');

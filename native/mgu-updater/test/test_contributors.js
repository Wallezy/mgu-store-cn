'use strict';
const assert = require('assert');
const catalog = require('../js/catalog');
const { contributorsOf } = require('../js/contributors');
const records = [
    { role: 'author', name: 'Original author', contribution: 'Application implementation.', source: 'https://example.org/app' },
    { role: 'translation', name: 'Translator', contribution: 'Chinese display strings.', source: 'https://example.org/translation' }
];
assert.deepStrictEqual(contributorsOf(records), records);
[null, {}, 'author', 1].forEach((bad) => assert.deepStrictEqual(contributorsOf(bad), []));
['role', 'name', 'contribution', 'source'].forEach((key) => {
    const bad = Object.assign({}, records[0], { [key]: key === 'role' ? 'owner' : '\nnot plain text' });
    assert.deepStrictEqual(contributorsOf([bad, records[1]]), [records[1]]);
});
['http://example.org', 'https://user:secret@example.org/app', 'javascript:alert(1)'].forEach((source) => {
    assert.deepStrictEqual(contributorsOf([Object.assign({}, records[0], { source })]), []);
});
assert.strictEqual(contributorsOf(Array(99).fill(records[0])).length, 12);
assert.deepStrictEqual(contributorsOf([Object.assign({}, records[0], { name: 'x'.repeat(161) })]), []);
function entry(contributors) {
    return { id: 'example', kind: 'app', title: 'Example', version: '1.0.0', contributors,
        artifact: { name: 'example@1.0.0.tgz', sha256: 'a'.repeat(64), size: 123 } };
}
function row(contributors) {
    const c = catalog.parse(JSON.stringify({ schema: 2, components: [entry(contributors)] })).components[0];
    return catalog.plan([{ entry: c, source: 'example-source' }], [])[0];
}
assert.deepStrictEqual(row(records).contributors, records, 'catalog credits reach the Store state');
assert.deepStrictEqual(row(undefined).contributors, [], 'old catalogs remain usable');
assert.deepStrictEqual(row({ malformed: true }).contributors, [], 'optional metadata never blocks installation');
assert.strictEqual(row(records).status, 'available');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const all = require(path.join(root, 'release/release')).components();
assert.strictEqual(all.length, 7);
all.forEach((c) => assert.deepStrictEqual(contributorsOf(c.contributors), c.contributors, c.id + ': reviewed record'));
const generated = require(path.join(root, 'apps/robertn_store/tools/gen_contributors')).files();
Object.keys(generated).forEach((name) => assert.strictEqual(
    fs.readFileSync(path.join(root, 'apps/robertn_store/package', name), 'utf8'), generated[name], name + ': shipped credits'));
const files = require('../component.json').files;
assert(files.some((f) => f.path === 'contributors.js' && f.from === 'js/contributors.js'), 'the updater ships its parser');
console.log('contributors: bounded plain text, legacy catalogs and catalog-to-state propagation pass');

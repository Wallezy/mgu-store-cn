// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const { distribution, checkTarget, checkValidation } = require('../cn_policy');
const sha = 'a'.repeat(40);
const valid = { sha, statuses: [{ context: distribution.validationContext, state: 'success' }] };

checkTarget('Wallezy/mgu-store-cn');
assert.throws(() => checkTarget('robertnisipeanu/mgu-store'), /CN releases belong/);
assert.throws(() => checkTarget('Wallezy/mgu-store'), /CN releases belong/);
checkValidation(sha, valid);
assert.throws(() => checkValidation('b'.repeat(40), valid), /exact release commit/);
assert.throws(() => checkValidation(sha, { sha, statuses: [] }), /needs successful/);
assert.throws(() => checkValidation(sha, {
    sha, statuses: [{ context: 'ci', state: 'success' }]
}), /needs successful/);
assert.throws(() => checkValidation(sha, {
    sha, statuses: [{ context: distribution.validationContext, state: 'failure' }, ...valid.statuses]
}), /needs successful/);
assert.throws(() => checkValidation(sha, {
    sha, statuses: [{ context: distribution.validationContext, state: 'pending' }]
}), /needs successful/);
assert.strictEqual(distribution.catalog, 'https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json');
const root = path.resolve(__dirname, '../..');
const env = Object.assign({}, process.env);
delete env.MGU_PUBLISH;
delete env.GITHUB_ACTIONS;
const run = (code, extra) => cp.spawnSync(process.execPath, ['-e', code], {
    cwd: root, env: Object.assign({}, env, extra), encoding: 'utf8'
});
let result = run("console.log(require('./release/publish').describe())");
assert.strictEqual(result.status, 0);
assert.strictEqual(result.stdout.trim(), 'github:Wallezy/mgu-store-cn');
result = run("require('./release/publish').preflight(false)");
assert.notStrictEqual(result.status, 0);
assert.match(result.stderr, /publishing runs in GitHub Actions/);
result = run("require('./release/publish').preflight(true)", {
    MGU_PUBLISH: 'github:robertnisipeanu/mgu-store'
});
assert.notStrictEqual(result.status, 0);
assert.match(result.stderr, /CN releases belong/);
result = run("require('./release/publish').preflight(false)", {
    MGU_PUBLISH: 'dir:/tmp/cn-policy-no-write'
});
assert.strictEqual(result.status, 0);
console.log('CN release policy: target isolation and exact-commit validation passed');
require('./immutable_asset_test');

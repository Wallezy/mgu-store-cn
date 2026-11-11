// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const distribution = require('./distribution.json');

function checkTarget(repository) {
    if (repository !== distribution.repository) {
        throw new Error(`CN releases belong to ${distribution.repository}, not ${repository}`);
    }
}

function checkValidation(sha, response) {
    if (!/^[a-f0-9]{40}$/.test(sha) || !response || response.sha !== sha) {
        throw new Error('CN validation must identify the exact release commit');
    }
    const status = (response.statuses || []).find((s) => s.context === distribution.validationContext);
    if (!status || status.state !== 'success') {
        throw new Error(`CN release needs successful ${distribution.validationContext} on ${sha}`);
    }
}

module.exports = { distribution, checkTarget, checkValidation };

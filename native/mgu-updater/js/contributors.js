'use strict';
/* Optional, plain-text catalog credits. Bad metadata never blocks an update. */
const ROLES = ['author', 'translation', 'adaptation', 'runtime', 'assets'];
function contributorsOf(value) {
    if (!Array.isArray(value)) return [];
    const text = (v, max) => typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
    return value.slice(0, 12).filter((c) => c && ROLES.indexOf(c.role) >= 0 &&
        text(c.name, 160) && text(c.contribution, 240) && text(c.source, 240) &&
        /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/.test(c.source))
        .map((c) => ({ role: c.role, name: c.name.trim(), contribution: c.contribution.trim(), source: c.source }));
}
module.exports = { contributorsOf };

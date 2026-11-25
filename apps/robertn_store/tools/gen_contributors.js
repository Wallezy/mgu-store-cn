'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const root = path.resolve(APP, '../..');
function files() {
    const contributors = require(path.join(root, 'release/contributors.json')).components.robertn_store;
    const roles = { author: '上游作者', translation: '中文翻译', adaptation: '适配与维护', runtime: '共享代码', assets: '资源与数据' };
    const lines = ['# 作者与贡献', ''];
    contributors.forEach((c) => lines.push('## ' + roles[c.role] + '：' + c.name, '', c.contribution, '', '来源：' + c.source, ''));
    lines.push('第三方许可和版权声明见 LICENSES.txt；逐文件来源见对应发行源码中的 THIRD_PARTY_NOTICES.md。', '');
    return {
        'ATTRIBUTION.json': JSON.stringify({ schema: 1, component: 'robertn_store', contributors }, null, 2) + '\n',
        'CONTRIBUTORS.zh-CN.md': lines.join('\n')
    };
}
function write() {
    const generated = files();
    Object.keys(generated).forEach((name) => fs.writeFileSync(path.join(APP, 'package', name), generated[name]));
}
if (require.main === module) write();
module.exports = { files, write };

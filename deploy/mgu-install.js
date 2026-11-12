#!/usr/bin/env node
'use strict';
/**
 * mgu-install: sets up the Store on a head unit over SSH, and makes USB
 * sticks the Store installs and updates from without internet. One file,
 * no dependencies: Node 18 or newer and the system's OpenSSH client, on
 * Windows, macOS or Linux (deploy/README.md, "mgu-install").
 *
 *   node mgu-install.js first-install [--from <folder>] [--no-renderer] [--no-uplink] [--no-restart-prompt] [<ssh options>]
 *   node mgu-install.js uninstall [--yes] [--from <folder>] [--no-restart-prompt] [<ssh options>]
 *   node mgu-install.js status [<ssh options>]
 *   node mgu-install.js migrate-cn --from <CN snapshot> --plan-only [<ssh options>]
 *   node mgu-install.js migrate-cn --from <CN snapshot> --expect-plan <sha256> [<ssh options>]
 *   node mgu-install.js migration-status --transaction <sha256> [<ssh options>]
 *   node mgu-install.js migration-verify --transaction <sha256> [<ssh options>]
 *   node mgu-install.js migration-rollback --transaction <sha256> --yes [<ssh options>]
 *   node mgu-install.js usb-repo <stick folder> [<input>...]
 *
 * first-install downloads the published CN catalog's mgu-store release (the
 * deploy tool, app-privacy, the updater, the Store's source package, the
 * renderer the Store draws its screens with and the internet uplink;
 * --no-renderer and --no-uplink leave those two out, and one the deploy tool
 * refuses is left out), checks each file against the
 * catalog's size and sha256, sends them to the unit and installs them with
 * the release's own deploy tool, which builds the Store on the unit. Newer
 * installed components are kept; running it again is safe. When the head unit needs a
 * restart to finish, it asks at a terminal whether to restart it now
 * (not under CI, nor with --no-restart-prompt).
 *
 * first-install --from <folder> installs from a folder usb-repo wrote
 * (<folder>/mgu-repo/mgu-store) instead of the online catalog, each file checked
 * against its catalog the same way: download at home, install at the car
 * without internet.
 *
 * uninstall removes everything the Store setup put on the head unit: the
 * apps and tools the deploy tool installed, the app manager patch, the
 * provisioning fallback, the updater's sources and tokens, and last the
 * deploy tool with its backups. It lists them and asks first (--yes: no
 * question). What could not be removed is named, and running it again
 * finishes the job. When the head unit needs a restart to finish, it asks
 * as first-install does.
 *
 * status prints what the deploy tool on the head unit reports: each tool
 * and app, each app's tile, what waits for a restart. It changes nothing on
 * the unit; with a deploy tool older than its read-only status, that
 * status may also repair things, as the updater's does at its start.
 *
 * usb-repo writes a local repository onto a stick: one folder
 * mgu-repo/<name>/ per input, which the updater reads as a source while the
 * stick is in. Inputs: an https:// catalog.json URL,
 * a folder holding catalog.json or mgu-repo.json, or package files (*.tgz,
 * *.mgu: apps, source packages, tool kits; together in mgu-repo/local/).
 * Without inputs: the CN mgu-store HTTPS catalog.
 * Each catalog icon is copied and checked against iconSha256.
 *
 * Without --host or --port it finds the head unit itself: the
 * car's hotspot (172.16.222.97) when its SSH answers, else over ENET (an
 * interface with a 169.254.x.x address) the address the vehicle gateway
 * reports for the head unit (DID 22 17 2A, read without changing any
 * session), or the last ENET address that answered. ssh then binds to
 * that interface's address (ssh -b). --ssh-opt options apply either way.
 * A head unit found whose SSH does not answer is named as such.
 *
 * A step that takes over 30 s prints a line about every 30 s; Ctrl+C
 * prints how to finish.
 *
 * SSH options: --host <address>, --port <n> (22), --user <name> (root),
 * --identity <key file>, and --ssh-opt <option> (repeatable, passed as
 * ssh -o <option>).
 *
 * It also runs from stdin: curl -fsSL <url> | node - first-install ...
 *
 * CN downloads reject GitHub hosts, including redirects. Setup does not read
 * or remove existing credentials. Exit status: 0 done, 1 failed, 2 refused or bad usage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');
const net = require('net');
const dgram = require('dgram');
const tty = require('tty');

const STORE_CATALOG = process.env.MGU_INSTALL_CATALOG || 'https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json';
const HOTSPOT_IP = '172.16.222.97';
/* the hotspot address detection tries first (<host>[:<port>]; the tests point it elsewhere) */
const HOTSPOT = process.env.MGU_INSTALL_HOTSPOT || HOTSPOT_IP;
/* HSFZ (diagnostics over IP) to the ENET gateway: identification on UDP
 * 6811, UDS on TCP 6801, from tester 0xF4 to the head unit 0x63 */
const HSFZ_IDENT_PORT = 6811;
const HSFZ_DIAG_PORT = 6801;
const TESTER = 0xf4;
const HEAD_UNIT = 0x63;
/* the head unit's last ENET address that answered (deploy/transport keeps the same file) */
const LAST_ENET = path.join(os.homedir(), '.cache', 'mgu-store', 'last_hu_enet_ip');
/* run as `node -` with the script on stdin */
const FROM_STDIN = __filename === '[stdin]';
/* the updater's sources first-install seeds when it has none (deploy/sources.json) */
const SOURCES = { schema: 1, sources: [
    { id: 'mgu-store', type: 'https', url: 'https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json', builtin: true },
    { id: 'idrive-apps', type: 'https', url: 'https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json' }
] };
/* the installed deploy tool */
const DEPLOY = '/var/opt/mgu-deploy/mgu-deploy.sh';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ARTIFACT = 512 << 20;
const CN_BASE = 'https://mgu.walle.pw/mgu/cn/';
/* what the updater reads from a stick (native/mgu-updater/js/sources.js) */
const STICK_JSON_MAX = 1 << 20;
const STICK_REPO_MAX = 200 << 20;
const STICK_REPO_FILES = 20000;
/* an app's icon, as the updater reads it (native/mgu-updater/js/sources.js) */
const ICON_MAX = 128 << 10;
const PROGRESS_MS = 30000;

class Usage extends Error {}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function say(line) {
    process.stdout.write(`${line}\n`);
}

/* A wait's length for its progress line: "30 s", "1 min", "1 min 30 s". */
function elapsed(ms) {
    const s = Math.round(ms / 30000) * 30;
    const m = Math.floor(s / 60);
    return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`;
}

/* fn()'s result; while it runs, about every 30 s one line on stderr:
 * "<what> (<time so far>)". */
async function waiting(what, fn) {
    const start = Date.now();
    const tick = setInterval(() => process.stderr.write(`${what} (${elapsed(Date.now() - start)})\n`), PROGRESS_MS);
    try {
        return await fn();
    } finally {
        clearInterval(tick);
    }
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}

/* ---- tar ------------------------------------------------------------------------- */

/* A gzipped ustar archive of entries { name, data, mode }, owner 0:0. */
function tgz(entries, mtime) {
    const blocks = [];
    entries.forEach((e) => {
        const name = Buffer.from(e.name);
        if (name.length > 100) {
            throw new Error(`tar: name over 100 bytes: ${e.name}`);
        }
        const h = Buffer.alloc(512);
        name.copy(h, 0);
        const num = (v, off, len) => h.write(`${v.toString(8).padStart(len - 1, '0')}\0`, off, len, 'ascii');
        num(e.mode & 0o7777, 100, 8);
        num(0, 108, 8);
        num(0, 116, 8);
        num(e.data.length, 124, 12);
        num(mtime, 136, 12);
        h.fill(' ', 148, 156);
        h.write('0', 156, 1, 'ascii');
        h.write('ustar\0', 257, 6, 'ascii');
        h.write('00', 263, 2, 'ascii');
        let sum = 0;
        for (let i = 0; i < 512; i += 1) {
            sum += h[i];
        }
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
        blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
    });
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

/* The regular files of gzipped tar bytes: [{ name, data, mode }] (ustar,
 * pax and GNU long names; "./" prefixes dropped). */
function untgz(buf, max) {
    const tar = zlib.gunzipSync(buf, { maxOutputLength: max || MAX_ARTIFACT });
    const out = [];
    const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
    let off = 0;
    let longName = null;
    while (off + 512 <= tar.length) {
        const h = tar.slice(off, off + 512);
        if (h.every((x) => x === 0)) {
            break;
        }
        const size = parseInt(str(h.slice(124, 136)).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const data = tar.slice(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
        if (type === 'x') {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            longName = m ? m[1] : longName;
            continue;
        }
        if (type === 'L') {
            longName = str(data);
            continue;
        }
        const prefix = str(h.slice(345, 500));
        let name = longName || (prefix ? `${prefix}/${str(h.slice(0, 100))}` : str(h.slice(0, 100)));
        longName = null;
        name = name.replace(/^(\.\/)+/, '');
        if ((type === '0' || type === '\0') && name) {
            out.push({ name, data: Buffer.from(data), mode: parseInt(str(h.slice(100, 108)).trim() || '644', 8) });
        }
    }
    return out;
}

/* ---- downloads --------------------------------------------------------------------- */

/* https only; plain http to this machine for tests. */
function checkUrl(u) {
    const url = new URL(u);
    if (/(^|\.)(github\.com|githubusercontent\.com|githubassets\.com|github\.io|ghcr\.io)\.?$/i.test(url.hostname)) {
        throw new Usage('GitHub downloads are not supported by the CN installer');
    }
    if (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        return url;
    }
    throw new Usage(`not an https URL: ${u}`);
}

/* GET url's body, at most max bytes. Every redirect passes the CN URL policy. */
async function get(url, { accept, max } = {}) {
    let u = checkUrl(url);
    for (let hop = 0; hop < 8; hop += 1) {
        const headers = { 'User-Agent': 'mgu-install', Accept: accept || '*/*' };
        let res;
        try {
            res = await fetch(u, { headers, redirect: 'manual' });
        } catch (e) {
            throw new Error(`${u.origin}${u.pathname}: ${e.cause ? e.cause.message : e.message}`);
        }
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
            u = checkUrl(new URL(res.headers.get('location'), u));
            continue;
        }
        if (!res.ok) {
            throw Object.assign(new Error(`${u.origin}${u.pathname}: HTTP ${res.status}`), { status: res.status });
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of res.body) {
            total += chunk.length;
            if (total > (max || MAX_ARTIFACT)) {
                throw new Error(`${u.origin}${u.pathname}: more than ${max || MAX_ARTIFACT} bytes`);
            }
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    throw new Error(`${url}: too many redirects`);
}

/* An artifact's bytes, checked against the size and sha256 its catalog
 * lists (or that the release asset states). */
function checked(name, data, size, hash) {
    if (data.length !== size) {
        throw new Error(`${name}: ${data.length} bytes, the source lists ${size}; not used`);
    }
    if (hash && sha256(data) !== hash) {
        throw new Error(`${name}: sha256 does not match the source's; not used`);
    }
    return data;
}

/* The terminal to prompt at: stdin, or the terminal device when the
 * script itself came on stdin; null when there is none. */
function terminal() {
    if (process.stdin.isTTY) {
        return process.stdin;
    }
    if (!FROM_STDIN || process.platform === 'win32') {
        return null;
    }
    try {
        return new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
    } catch (e) {
        return null;
    }
}

/* Checks a catalog (schema 1 or 2, release/README.md) as the updater does. */
function parseCatalog(text, what) {
    let c;
    try {
        c = JSON.parse(text);
    } catch (e) {
        throw new Error(`${what} is not JSON`);
    }
    if (!c || (c.schema !== 1 && c.schema !== 2) || !Array.isArray(c.components)) {
        throw new Error(`${what}: schema is not 1 or 2`);
    }
    const seen = new Set();
    c.components.forEach((e) => {
        const a = e && e.artifact;
        if (!e || !ID.test(e.id) || !['app', 'tool'].includes(e.kind) || !SEMVER.test(e.version) || !a ||
            a.name !== `${e.id}@${e.version}.tgz` || !/^[0-9a-f]{64}$/.test(a.sha256) || !(a.size > 0) || seen.has(e.id)) {
            throw new Error(`${what}: entry ${e && e.id} is malformed`);
        }
        seen.add(e.id);
    });
    return { commit: typeof c.commit === 'string' ? c.commit : null, components: c.components };
}

/* ---- SSH ------------------------------------------------------------------------------- */

function shQuote(s) {
    return `'${String(s).split("'").join("'\\''")}'`;
}

let sshVersion = null;

/* OpenSSH 8.8 and newer leave ssh-rsa out, which the unit's sshd uses. */
function rsaOpts() {
    if (sshVersion === null) {
        const r = cp.spawnSync('ssh', ['-V'], { encoding: 'utf8', windowsHide: true });
        const m = /OpenSSH[^\d]*(\d+)\.(\d+)/.exec(`${r.stderr || ''}${r.stdout || ''}`);
        sshVersion = m ? Number(m[1]) + Number(m[2]) / 100 : 0;
    }
    return sshVersion >= 8.08 ? ['-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa'] : [];
}

/* The unit's host key is neither asked about nor kept: every car's hotspot
 * has the same address, and a unit's key can change. */
const HOST_KEY_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR'];

/* ssh's arguments for one remote command: the owner's -o options first
 * (ssh takes the first value of an option). */
function sshArgs(o, remote) {
    const args = ['-p', String(o.port)].concat(o.bind ? ['-b', o.bind] : []);
    o.sshOpts.forEach((x) => args.push('-o', x));
    if (o.identity) {
        args.push('-i', o.identity, '-o', 'IdentitiesOnly=yes');
    }
    return args.concat(HOST_KEY_OPTS, rsaOpts(), [`${o.user}@${o.host}`, remote]);
}

/* The ssh processes running, stopped with this one (stopOn). */
const sshRunning = new Set();

/* Runs remote on the unit; input on its stdin; capture: its stdout
 * returned; wait: the progress line's text while it takes long. */
function ssh(o, remote, { input, capture, wait } = {}) {
    return waiting(wait || 'still waiting for the head unit', () => new Promise((resolve, reject) => {
        const child = cp.spawn('ssh', sshArgs(o, remote), {
            windowsHide: true, stdio: [input !== undefined ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', 'inherit']
        });
        sshRunning.add(child);
        const out = [];
        const end = (err, value) => {
            sshRunning.delete(child);
            if (err) {
                reject(err);
            } else {
                resolve(value);
            }
        };
        if (capture) {
            child.stdout.on('data', (d) => out.push(d));
        }
        if (input !== undefined) {
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        }
        child.on('error', (e) => end(new Error(e.code === 'ENOENT' ? 'no ssh command found; install the OpenSSH client' : `ssh: ${e.message}`)));
        child.on('close', (code) => (code === 255 ? end(new Error(`ssh to ${o.user}@${o.host}:${o.port} failed`)) :
            end(null, { status: code === null ? 1 : code, stdout: capture ? Buffer.concat(out).toString() : '' })));
    }));
}

/* ---- finding the head unit ------------------------------------------------------------- */

/* The SSH banner host:port serves (connecting from local when given);
 * false when host answers there without SSH (refuses the connection, or
 * closes it or greets otherwise); null when nothing answers. */
function sshBanner(host, port, local, timeout = 4000) {
    return new Promise((resolve) => {
        const s = net.connect(Object.assign({ host, port: Number(port), timeout }, local ? { localAddress: local } : {}));
        let got = Buffer.alloc(0);
        const done = (v) => {
            s.destroy();
            resolve(v);
        };
        s.on('data', (d) => {
            got = Buffer.concat([got, d]);
            const nl = got.indexOf(10);
            if (nl >= 0 || got.length >= 255) {
                const line = got.slice(0, nl >= 0 ? nl : got.length).toString('latin1').trim();
                done(line.startsWith('SSH-') ? line : false);
            }
        });
        s.on('timeout', () => done(null));
        s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? false : null));
        s.on('end', () => done(false));
    });
}

/* The interfaces with a link-local (169.254.x.x) IPv4 address, the ENET
 * adapter among them: [{ name, address }]. */
function enetInterfaces(ifaces) {
    const out = [];
    Object.entries(ifaces || os.networkInterfaces()).forEach(([name, addrs]) => (addrs || []).forEach((a) => {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal && /^169\.254\./.test(a.address)) {
            out.push({ name, address: a.address });
        }
    }));
    return out;
}

/* One HSFZ diagnostic frame: length, control 0x0001, tester, head unit, UDS. */
function hsfzFrame(uds) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(2 + uds.length, 0);
    h.writeUInt16BE(0x0001, 4);
    h[6] = TESTER;
    h[7] = HEAD_UNIT;
    return Buffer.concat([h, uds]);
}

/* The complete HSFZ frames at the start of buf: { frames: [{ control,
 * payload }] (payload without the two address bytes), rest }. */
function hsfzFrames(buf) {
    const frames = [];
    let off = 0;
    while (buf.length - off >= 6 && buf.length - off >= 6 + buf.readUInt32BE(off)) {
        const len = buf.readUInt32BE(off);
        frames.push({ control: buf.readUInt16BE(off + 4), payload: buf.slice(off + 8, off + 6 + len) });
        off += 6 + len;
    }
    return { frames, rest: buf.slice(off) };
}

/* The head unit's address in a response to 22 17 2A (62 17 2A 00 AA BB CC
 * DD), else null. */
function didAddress(uds) {
    return uds.length >= 8 && uds[0] === 0x62 && uds[1] === 0x17 && uds[2] === 0x2a ? Array.from(uds.slice(4, 8)).join('.') : null;
}

/* The ENET gateway's address: HSFZ identification (00 00 00 00 00 11)
 * broadcast from local (from the gateway's port when it is free), answers
 * heard on that socket and on the gateway's port on all addresses (a
 * gateway may answer by broadcast); the first answer that is not the
 * request itself. null when nothing answers. */
const IDENT = Buffer.from([0, 0, 0, 0, 0, 0x11]);

function hsfzGateway(local, { to = ['169.254.255.255', '255.255.255.255'], port = HSFZ_IDENT_PORT, from = HSFZ_IDENT_PORT,
    listen = HSFZ_IDENT_PORT, timeout = 6000 } = {}) {
    const bind = (address, ports) => new Promise((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.once('error', () => {
            s.close();
            resolve(ports.length > 1 ? bind(address, ports.slice(1)) : null);
        });
        s.bind({ address, port: ports[0] }, () => {
            s.removeAllListeners('error');
            s.on('error', () => {});
            resolve(s);
        });
    });
    return Promise.all([bind(local, [from, 0]), bind('0.0.0.0', [listen])]).then(([send, all]) => new Promise((resolve) => {
        const socks = [send, all].filter(Boolean);
        let tick = null;
        let timer = null;
        const done = (v) => {
            clearTimeout(timer);
            clearInterval(tick);
            socks.forEach((x) => x.close());
            resolve(v);
        };
        if (!send) {
            done(null);
            return;
        }
        socks.forEach((x) => x.on('message', (m, r) => {
            if (!m.equals(IDENT)) {
                socks.forEach((y) => y.removeAllListeners('message'));
                done(r.address);
            }
        }));
        const out = () => to.forEach((dst) => send.send(IDENT, port, dst, () => {}));
        send.setBroadcast(true);
        timer = setTimeout(() => done(null), timeout);
        tick = setInterval(out, 1000);
        out();
    }));
}

/* The head unit's address from the gateway: DID 22 17 2A, sent alone (no
 * session change, no routine). null on a negative, odd or missing answer. */
function hsfzHuAddress(gw, local, { port = HSFZ_DIAG_PORT, timeout = 8000 } = {}) {
    return new Promise((resolve) => {
        const s = net.connect(Object.assign({ host: gw, port, timeout }, local ? { localAddress: local } : {}));
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => done(null), timeout);
        function done(v) {
            clearTimeout(timer);
            s.destroy();
            resolve(v);
        }
        s.on('connect', () => s.write(hsfzFrame(Buffer.from([0x22, 0x17, 0x2a]))));
        s.on('data', (d) => {
            const r = hsfzFrames(Buffer.concat([buf, d]));
            buf = r.rest;
            for (const f of r.frames) {
                const p = f.payload;
                // acks (control 0x0002), empty frames and "response pending" (7F xx 78) are not the answer
                if (f.control !== 0x0001 || !p.length || (p.length >= 3 && p[0] === 0x7f && p[2] === 0x78)) {
                    continue;
                }
                done(didAddress(p));
                return;
            }
        });
        s.on('timeout', () => done(null));
        s.on('error', () => done(null));
        s.on('end', () => done(null));
    });
}

function readLast() {
    try {
        const ip = fs.readFileSync(LAST_ENET, 'utf8').trim();
        return /^169\.254\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch (e) {
        return null;
    }
}

function saveLast(ip) {
    try {
        fs.mkdirSync(path.dirname(LAST_ENET), { recursive: true });
        fs.writeFileSync(LAST_ENET, `${ip}\n`);
    } catch (e) { /* only a hint for next time */ }
}

const NET = { banner: sshBanner, interfaces: () => enetInterfaces(), gateway: (local) => hsfzGateway(local),
    huAddress: (gw, local) => hsfzHuAddress(gw, local), last: readLast, save: saveLast, platform: process.platform };

/* Where the head unit's sshd answers: the hotspot; else, on each ENET
 * interface, the address the gateway reports, then the last one that
 * answered. { host, port, bind, via }; else { closed: <address> } when a
 * head unit was found without SSH (the hotspot's address answered
 * without it, or the gateway reported an address whose SSH does not
 * answer); else null. */
async function findUnit(d = NET) {
    const [hhost, hport] = HOTSPOT.split(':');
    const hotspot = await d.banner(hhost, hport || '22', null);
    if (hotspot) {
        return { host: hhost, port: hport || '22', bind: null, via: `the car's hotspot (${hhost})` };
    }
    let closed = hotspot === false ? (hport ? `${hhost}:${hport}` : hhost) : null;
    const last = d.last();
    // one interface at a time: an answer on the gateway's port names the interface asked
    for (const i of d.interfaces()) {
        const gw = await d.gateway(i.address);
        const ip = gw ? await d.huAddress(gw, i.address) : null;
        for (const c of [ip, last].filter((x, k, a) => x && a.indexOf(x) === k)) {
            if (await d.banner(c, '22', i.address)) {
                d.save(c);
                return { host: c, port: '22', bind: i.address, via: `ENET on ${i.name} (head unit ${c}${c === ip ? '' : ', the last that answered'})` };
            }
        }
        closed = closed || ip;
    }
    return closed ? { closed } : null;
}

/* What to check when no head unit answered. */
function notFound(d) {
    const lines = ['no head unit answered SSH. Join the car\'s Wi-Fi hotspot or connect the ENET cable, with the car awake, ' +
        'and run it again;', 'for another route, give --host (and --port).'];
    const ifs = d.interfaces();
    if (d.platform === 'linux' && !ifs.length) {
        lines.push('On Linux the ENET adapter needs a link-local address: nmcli con mod <its connection> ipv4.method link-local, then reconnect it.');
    } else if (d.platform === 'linux' && ifs.length > 1) {
        lines.push(`Linux reaches only one of the link-local interfaces ${ifs.map((i) => i.name).join(', ')}: unplug the others, or give --host.`);
    }
    return lines.join('\n');
}

/* Sets the SSH target: as given, or the head unit findUnit finds; which
 * one on stderr. */
async function reach(o, d = NET) {
    if (o.given) {
        o.host = o.host || HOTSPOT_IP;
        process.stderr.write(`connecting to ${o.host}:${o.port} as given\n`);
        return;
    }
    const u = await waiting('still looking for the head unit', () => findUnit(d));
    if (!u) {
        throw new Error(notFound(d));
    }
    if (u.closed) {
        throw new Error(`found the head unit at ${u.closed}, but its SSH is closed: enable root SSH first, then run this again`);
    }
    Object.assign(o, { host: u.host, port: u.port, bind: u.bind });
    process.stderr.write(`connecting over ${u.via}\n`);
}

/* ---- first-install ---------------------------------------------------------------------- */

/* The head unit's restart, as the Store's Restart head unit makes it
 * (native/mgu-updater/updater.conf, reboot): the Node State Manager's
 * normal restart. Refused (exit 3) while a deploy tool run of this boot
 * holds its lock ("<pid> <boot id>"). nsm_control exits 0 on a refusal
 * too, printing "[Error. <why>]". No double quote or backslash: Windows
 * passes the remote command through its own quoting. */
const RESTART = "L=/var/opt/mgu-deploy/lock; if [ -e $L ] && [ $(cut -d ' ' -f 2 $L) = $(cat /proc/sys/kernel/random/boot_id) ] && " +
    "kill -0 $(cut -d ' ' -f 1 $L) 2>/dev/null; then exit 3; fi; /usr/bin/nsm_control --requestRestart 7 --normal 2>&1";

/* A line typed at the terminal, which echoes it. */
function promptLine(question, input) {
    return new Promise((resolve) => {
        process.stderr.write(question);
        const rl = require('readline').createInterface({ input, terminal: false });
        let answer = '';
        rl.on('line', (line) => {
            answer = line;
            rl.close();
        });
        rl.on('close', () => {
            if (input !== process.stdin) {
                input.destroy();
            }
            resolve(answer);
        });
    });
}

/* Asks whether to restart the head unit now, at a terminal only; on yes
 * restarts it. Its exit status. */
async function offerRestart(o, later = 'restart it from the Store') {
    const term = o.noRestartPrompt || process.env.CI ? null : terminal();
    if (!term || !/^y(es)?$/i.test((await promptLine('Restart the head unit now? [y/N] ', term)).trim())) {
        return 0;
    }
    const r = await ssh(o, RESTART, { input: Buffer.alloc(0), capture: true });
    const refused = /\[Error\.\s*([^\]]*)\]/.exec(r.stdout);
    if (r.status === 3) {
        say(`An install is running on the head unit: ${later} once it is done.`);
        return 1;
    }
    if (r.status !== 0 || refused) {
        say(`The head unit did not take the restart${refused ? `: ${refused[1].trim()}` : ''}. ${later[0].toUpperCase()}${later.slice(1)}.`);
        return 1;
    }
    say('Restarting the head unit.');
    return 0;
}

/* The optional components first-install puts on too, unless told not to:
 * each one's flag and the unit that runs it. */
const WITH = [
    { id: 'mgu-render', skip: 'noRenderer', unit: 'mgu-render.socket' },
    { id: 'mgu-uplink', skip: 'noUplink', unit: 'mgu-uplink.service' }
];

/* On the unit, in the staging folder: the release's deploy tool installs
 * every artifact (itself among them; newer installed ones kept), leaving
 * WITH's tools, installed after, to their own install, and seeds the
 * updater's sources when it has none; then each of WITH on its own, so
 * one it refuses (exit 2) is left out and the
 * rest stays; one that fails fails the run. */
const RUN_SH = `set -e
S=$(cd "$(dirname "$0")" && pwd)
set --
for f in "$S"/artifacts/*.tgz; do set -- "$@" --artifact "$f"; done
for f in "$S"/with/*.tgz; do [ -e "$f" ] && set -- "$@" --leave "$(basename "$f" | sed 's/@.*//')"; done
sh "$S/mgu-deploy.sh" install "$@" --skip-older --yes
sh "$S/mgu-deploy.sh" updater-sources < "$S/sources.json"
for f in "$S"/with/*.tgz; do
    [ -e "$f" ] || continue
    sh "$S/mgu-deploy.sh" install --artifact "$f" --skip-older --yes || { st=$?; [ $st -eq 2 ] || exit $st; echo "first-install: $(basename "$f") left out" >&2; }
done
`;

/* Read-only, on the unit: oapcontroller starts no app manager when the
 * head unit's coding (/dev/shm/rawcodingdata, 0x1030 bytes; status flags in
 * byte 0x28: 0x08 header valid, 0x02 and 0x04 default values) is not valid
 * or is the default values. Prints "invalid" or "default" when the coding
 * says so and no app manager (node running MainApp's src/main.js) runs, else
 * "ok". One line with no double quote or backslash: Windows passes the
 * remote command through its own quoting. */
const CODING_CHECK = '/usr/bin/node -e \'var fs = require(`fs`), b = null, f, why = null, nul = String.fromCharCode(0);' +
    ' try { b = fs.readFileSync(`/dev/shm/rawcodingdata`); } catch (e) {}' +
    ' if (b && b.length === 0x1030) { f = b[0x28]; why = !(f & 8) ? `invalid` : f & 6 ? `default` : null; }' +
    ' var manager = why && fs.readdirSync(`/proc`).some(function (p) {' +
    ' var a; try { a = fs.readFileSync(`/proc/` + p + `/cmdline`, `utf8`).split(nul); } catch (e) { return false; }' +
    ' return (a[0] === `node` || a[0].slice(-5) === `/node`) && a.slice(1).some(function (s) {' +
    ' return [`oap-mainapp/src/main.js`, `oap-mainapp/src/main.bundle.js`, `oap-mainapp21/src/main.js`, `oap-mainapp21/src/main.bundle.js`]' +
    '.some(function (m) { return s.slice(-m.length - 1) === `/` + m; }); }); });' +
    ' console.log(why && !manager ? why : `ok`);\'';

const CODING_MISSING = {
    default: 'it holds default values',
    invalid: 'it is not valid'
};

/* Stops (exit 2) before anything reaches the unit when its coding keeps
 * MainApp from starting; a check that cannot run lets the install go on. */
async function checkCoding(o) {
    const r = await ssh(o, CODING_CHECK, { input: Buffer.alloc(0), capture: true });
    const why = r.status === 0 ? CODING_MISSING[r.stdout.trim()] : null;
    if (why) {
        say(`The head unit's coding is missing: ${why}. This often happens after enabling SSH or flashing. ` +
            'Restore the head unit\'s coding from a backup (BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car, ' +
            'restart the head unit, then run the install again.');
    }
    return !why;
}

/* The deploy tool's own files, from its published artifact: component.json
 * (its manifest) and files/<path>, each checked against the manifest. */
function deployToolFiles(artifact) {
    const members = new Map(untgz(artifact).map((m) => [m.name, m]));
    const c = JSON.parse(members.get('component.json').data.toString('utf8'));
    if (c.id !== 'mgu-deploy' || !Array.isArray(c.files)) {
        throw new Error('the mgu-deploy artifact has no deploy tool manifest');
    }
    return c.files.map((f) => {
        const m = members.get(`files/${f.path}`);
        if (!m || sha256(m.data) !== f.sha256 || f.path.includes('/')) {
            throw new Error(`the mgu-deploy artifact's ${f.path} does not match its manifest`);
        }
        return { name: f.path, data: m.data, mode: parseInt(f.mode, 8) };
    }).concat([{ name: 'component.json', data: members.get('component.json').data, mode: 0o644 }]);
}

/* first-install --from: a folder usb-repo wrote (<folder>/mgu-repo/mgu-store). */
function fromFolder(dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(path.join(d, 'catalog.json'))) {
        const inner = path.join(d, 'mgu-repo', 'mgu-store');
        throw new Usage(fs.existsSync(path.join(inner, 'catalog.json')) ? `--from: no catalog.json in ${d}; use --from ${inner}` :
            `--from: no catalog.json in ${d}; give the folder usb-repo wrote, <folder>/mgu-repo/mgu-store`);
    }
    return d;
}

/* The start of a remote command that unpacks the kit on stdin into the
 * fresh folder q, root's alone by its mode. umask 022: the hooks the deploy
 * tool runs write stock files their own users run. */
function unpackKit(q) {
    return `rm -rf ${q} && umask 022 && mkdir -m 700 -p ${q} && tar -xzf - -C ${q} && `;
}

const UPDATER_IDENTITY_FILES = ['updater.js', 'cn_sources.js', 'sources.js', 'fetch.js', 'updater.conf'];
const SETUP_INSTALLED = 'Installation completed. Verify the active CN updater and an online update in the Store.';

/* Reads bytes only: no status command, configuration changes or daemon code. */
const UPDATER_IDENTITY = '/usr/bin/node -e \'/* mgu-cn-updater-preflight */' +
    'var fs=require(`fs`),crypto=require(`crypto`),base=`/var/opt/mgu-updater/current/`;' +
    'var out={present:false,version:null,override:null,hashes:{}};' +
    'try{out.present=!!fs.lstatSync(base.slice(0,-1));}catch(e){if(e.code!==`ENOENT`)throw e;}' +
    'if(out.present){out.version=JSON.parse(fs.readFileSync(base+`component.json`,`utf8`)).version;}' +
    'var local=`/var/opt/mgu-updater/updater.local.conf`;' +
    'if(fs.existsSync(local)){fs.readFileSync(local,`utf8`).split(String.fromCharCode(10)).forEach(function(line){' +
    'var at=line.indexOf(`=`);if(at>=0&&line.slice(0,at).trim()===`distribution_channel`)out.override=line.slice(at+1).trim();});}' +
    '[`updater.js`,`cn_sources.js`,`sources.js`,`fetch.js`,`updater.conf`].forEach(function(name){' +
    'try{out.hashes[name]=crypto.createHash(`sha256`).update(fs.readFileSync(base+name)).digest(`hex`);}' +
    'catch(e){if(e.code!==`ENOENT`)throw e;out.hashes[name]=null;}});console.log(JSON.stringify(out));\'';

function updaterPackageIdentity(artifact) {
    const members = new Map(untgz(artifact.data).map((m) => [m.name, m]));
    const item = members.get('component.json');
    const c = item && JSON.parse(item.data.toString('utf8'));
    if (!c || c.id !== 'mgu-updater' || c.version !== artifact.entry.version || !Array.isArray(c.files)) {
        throw new Usage('the CN updater package has no matching component manifest');
    }
    const hashes = {};
    UPDATER_IDENTITY_FILES.forEach((name) => {
        const file = c.files.find((f) => f.path === name);
        const member = members.get(`files/${name}`);
        if (!file || !member || sha256(member.data) !== file.sha256) {
            throw new Usage(`the CN updater package has no verified ${name}`);
        }
        hashes[name] = file.sha256;
    });
    const conf = members.get('files/updater.conf').data.toString('utf8');
    if (!/^distribution_channel[ \t]*=[ \t]*walle-cn[ \t]*$/m.test(conf) ||
        !/^local_conf[ \t]*=[ \t]*\/var\/opt\/mgu-updater\/updater.local.conf[ \t]*$/m.test(conf)) {
        throw new Usage('the updater package does not declare the supported CN configuration');
    }
    return { version: c.version, hashes };
}

function updaterCompatibility(current, target) {
    if (!current || typeof current.present !== 'boolean' || !current.hashes ||
        !Object.prototype.hasOwnProperty.call(current, 'override')) {
        return 'the installed updater identity could not be read';
    }
    if (current.override !== null && current.override !== 'walle-cn') {
        return 'updater.local.conf overrides distribution_channel; preserve it and use a reviewed migration procedure';
    }
    if (current.present && !SEMVER.test(current.version || '')) {
        return 'the installed updater version is unknown';
    }
    if (current.present && compareVersions(current.version, target.version) >= 0 &&
        UPDATER_IDENTITY_FILES.some((name) => current.hashes[name] !== target.hashes[name])) {
        return `installed updater ${current.version} is not the verified CN payload; equal/newer versions need a reviewed migration, not a downgrade`;
    }
    return null;
}

async function firstInstall(o) {
    // --from: its catalog is read first, so a missing or bad one stops before the unit search
    const from = o.from ? fromFolder(o.from) : null;
    const local = from ? dirComponents(from) : null;
    const label = from || STORE_CATALOG;
    await reach(o);
    if (!(await checkCoding(o))) {
        return 2;
    }
    const { components } = local || await urlComponents(STORE_CATALOG);
    const wanted = WITH.filter((w) => !o[w.skip]);
    const chosen = components.filter((c) => !c.entry.optional || wanted.some((w) => w.id === c.entry.id));
    const withs = wanted.filter((w) => chosen.some((c) => c.entry.id === w.id));
    wanted.filter((w) => withs.indexOf(w) < 0).forEach((w) => say(`${label}: the catalog has no ${w.id}; installing without it`));
    if (!chosen.some((c) => c.entry.id === 'mgu-deploy')) {
        throw new Error(`${label}: the catalog has no mgu-deploy`);
    }
    const artifacts = [];
    for (const c of chosen) {
        const data = await c.fetch();
        say(`  ${sha256(data)}  ${c.entry.artifact.name}`);
        artifacts.push({ entry: c.entry, data });
    }
    const updater = artifacts.find((a) => a.entry.id === 'mgu-updater');
    if (!updater) {
        throw new Usage('the CN catalog has no mgu-updater; nothing was sent');
    }
    const target = updaterPackageIdentity(updater);
    const existing = await ssh(o, UPDATER_IDENTITY, { input: Buffer.alloc(0), capture: true });
    let current = null;
    try { current = existing.status === 0 ? JSON.parse(existing.stdout) : null; } catch (e) { /* fail closed */ }
    const refusal = updaterCompatibility(current, target);
    if (refusal) {
        throw new Usage(`${refusal}; nothing was sent`);
    }
    const deploy = artifacts.find((a) => a.entry.id === 'mgu-deploy');
    const entries = deployToolFiles(deploy.data)
        .concat(artifacts.map((a) => ({ name: `${withs.some((w) => w.id === a.entry.id) ? 'with' : 'artifacts'}/${a.entry.artifact.name}`,
            data: a.data, mode: 0o644 })))
        .concat([{ name: 'run.sh', data: Buffer.from(RUN_SH), mode: 0o755 },
            { name: 'sources.json', data: Buffer.from(`${JSON.stringify(SOURCES, null, 2)}\n`), mode: 0o644 }]);
    // named so the deploy tool removes it a day later if this run is cut short
    const stage = `/var/opt/mgu-deploy-kit-${process.pid}`;
    const q = shQuote(stage);
    say(`installing on ${o.host}:${o.port}`);
    const run = await ssh(o, unpackKit(q) +
        `{ sh ${q}/run.sh; st=$?; rm -rf ${q}; exit $st; }`,
    { input: tgz(entries, Math.floor(Date.now() / 1000)), wait: 'the head unit is still installing' });
    if (run.status !== 0) {
        say(`first-install: the install on the unit ended with status ${run.status}`);
        return run.status === 2 ? 2 : 1;
    }
    const services = [{ id: 'mgu-updater', unit: 'mgu-updater.service' }].concat(withs);
    // the status on stderr, shown as it comes; which services run on stdout (absent: not installed), then the status as JSON
    const st = await ssh(o, [`sh ${DEPLOY} status >&2`].concat(services.map((s) =>
        `if [ -e /var/opt/${s.id}/current ]; then systemctl is-active ${s.unit} 2>/dev/null || true; else echo absent; fi`),
    [`sh ${DEPLOY} status --json 2>/dev/null | tail -n 1`]).join('; '), { capture: true });
    const lines = st.stdout.split('\n');
    const tiles = tilesShow(lines[services.length]);
    const running = services.every((s, i) => ['active', 'absent'].indexOf((lines[i] || '').trim()) >= 0);
    if (tiles.why) {
        say(`The Store's tile cannot show: ${tiles.why}`);
        if (running) {
            return 1;
        }
    } else if (tiles.shown && running) {
        say(SETUP_INSTALLED);
        return 0;
    }
    say('Restart the head unit to finish setup.');
    return offerRestart(o);
}

/* One verified local snapshot binds bootstrap, both catalogs and all package
 * bytes. No catalog or download URL is followed while preparing a migration. */
function migrationSnapshot(folder) {
    if (SOURCE === null) throw new Usage('migration requires the verified installer saved as a local file');
    const root = path.resolve(folder);
    const regular = (name) => {
        if (typeof name !== 'string' || !name || /[\\:%?#]/.test(name) ||
            name.split('/').some((p) => !p || p === '.' || p === '..')) {
            throw new Usage(`unsafe CN snapshot path: ${name}`);
        }
        let p = root;
        for (const part of name.split('/')) {
            p = path.join(p, part);
            if (fs.lstatSync(p).isSymbolicLink()) throw new Usage(`linked CN snapshot file: ${name}`);
        }
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > MAX_ARTIFACT) throw new Usage(`invalid CN snapshot file: ${name}`);
        return fs.readFileSync(p);
    };
    const raw = regular('cn-manifest.json');
    const manifest = JSON.parse(raw);
    if (manifest.schema !== 1 || manifest.distribution !== 'walle-cn' || manifest.base_url !== CN_BASE ||
        !Array.isArray(manifest.files) || !manifest.repositories) throw new Usage('invalid CN snapshot manifest');
    const files = new Map();
    manifest.files.forEach((f) => {
        if (!f || files.has(f.path) || !Number.isSafeInteger(f.size) || f.size < 1 ||
            !/^[a-f0-9]{64}$/.test(f.sha256 || '')) throw new Usage('invalid CN snapshot inventory');
        const data = regular(f.path);
        checked(f.path, data, f.size, f.sha256);
        files.set(f.path, data);
    });
    if (!files.has('bootstrap/mgu-install.js') || !files.get('bootstrap/mgu-install.js').equals(Buffer.from(SOURCE))) {
        throw new Usage('run the installer belonging to this exact CN snapshot');
    }
    const components = [];
    const ids = new Set();
    for (const repo of ['mgu-store', 'idrive-apps']) {
        const record = manifest.repositories[repo];
        const bytes = files.get(`${repo}/catalog.json`);
        const catalog = bytes && JSON.parse(bytes);
        if (!record || record.repository !== `Wallezy/${repo}-cn` ||
            !catalog || catalog.schema !== 2 || catalog.distribution !== 'walle-cn' ||
            !/^[a-f0-9]{40}$/.test(catalog.commit || '') || catalog.commit !== record.commit ||
            !Array.isArray(catalog.components)) throw new Usage(`invalid CN ${repo} catalog`);
        catalog.components.forEach((entry) => {
            if (!entry || !ID.test(entry.id || '') || ids.has(entry.id) || !SEMVER.test(entry.version || '') ||
                !['app', 'tool'].includes(entry.kind) || (entry.kind === 'app' && entry.build !== 'unit')) {
                throw new Usage('invalid or duplicate CN component');
            }
            ids.add(entry.id);
            const a = entry.artifact;
            if (!a || a.name !== `${entry.id}@${entry.version}.tgz` ||
                a.url !== `packages/${a.sha256}/${a.name}`) throw new Usage(`invalid package path: ${entry.id}`);
            const data = files.get(`${repo}/${a.url}`);
            if (!data) throw new Usage(`missing migration package: ${entry.id}`);
            checked(a.name, data, a.size, a.sha256);
            components.push({ entry, data });
        });
    }
    for (const id of ['robertn_store', 'mgu-updater', 'mgu-deploy', 'mgu-python', 'app-privacy', 'mgu-render', 'mgu-uplink']) {
        if (!ids.has(id)) throw new Usage(`CN snapshot lacks ${id}`);
    }
    const resolved = new Map(components.map((c) => [c.entry.id, c.entry]));
    components.forEach(({ entry }) => Object.entries(entry.requires || {}).forEach(([id, minimum]) => {
        if (!SEMVER.test(minimum) || !resolved.has(id) || compareVersions(resolved.get(id).version, minimum) < 0) {
            throw new Usage(`unmet CN dependency: ${entry.id} -> ${id}`);
        }
    }));
    const deploy = components.find((c) => c.entry.id === 'mgu-deploy');
    const runner = deployToolFiles(deploy.data);
    if (!runner.some((f) => f.name === 'mgu-deploy.js' && f.data.includes(Buffer.from('edition-migrate')))) {
        throw new Usage('this snapshot deploy tool has no edition migration entrypoint');
    }
    return { manifest, components, runner, digest: sha256(raw) };
}
function migrationRelease(snapshot, installed) {
    if (!installed || !Array.isArray(installed.components)) throw new Usage('installed component inventory could not be read');
    const required = new Set(['robertn_store', 'mgu-updater', 'mgu-deploy', 'mgu-python', 'app-privacy']);
    installed.components.forEach((c) => required.add(c.id));
    let more = true;
    while (more) {
        more = false;
        snapshot.components.forEach(({ entry }) => {
            if (!required.has(entry.id)) return;
            Object.keys(entry.requires || {}).forEach((id) => {
                if (!required.has(id)) { required.add(id); more = true; }
            });
        });
    }
    const artifacts = snapshot.components.filter((a) => required.has(a.entry.id));
    return { artifacts, manifest: { schema: 1, distribution: 'walle-cn',
        installer: sha256(Buffer.from(SOURCE)), snapshot: snapshot.digest,
        components: artifacts.map(({ entry }) => ({
            id: entry.id, version: entry.version, sha256: entry.artifact.sha256, requires: entry.requires || {}
        })) } };
}
async function migrationRuntime(o) {
    const code = '/* mgu-edition-runtime */' +
        'var net=require(`net`),s=net.connect(`/dev/shm/mgu-updater/updater.sock`),b=``,done=false;' +
        'var t=setTimeout(function(){s.destroy();process.exitCode=1;},15000);' +
        's.on(`data`,function(d){b+=d;if(b.length>8388608){s.destroy();process.exitCode=1;return;}' +
        'var n=b.indexOf(String.fromCharCode(10));if(n<0||done)return;var v;try{v=JSON.parse(b.slice(0,n));}catch(e){s.destroy();process.exitCode=1;return;}' +
        'done=true;clearTimeout(t);console.log(JSON.stringify({updater:v.updater,github:v.github,distribution:v.distribution,' +
        'busy:v.busy,components:(v.components||[]).map(function(c){return {id:c.id,installAs:c.installAs,installed:c.installed,source:c.source,queued:c.queued};}),' +
        'sources:(v.sources||[]).map(function(c){return {id:c.id,type:c.type,label:c.label,status:c.status,error:c.error};})}));s.end();});' +
        's.on(`error`,function(){clearTimeout(t);process.exitCode=1;});';
    const result = await ssh(o, `/usr/bin/node -e ${shQuote(code)}`, { input: Buffer.alloc(0), capture: true });
    const state = result.status === 0 ? lastJson(result.stdout) : null;
    if (!state || !state.updater || !Array.isArray(state.components)) {
        throw new Usage('the running updater could not provide a read-only migration inventory');
    }
    return state;
}
function migrationRuntimeCheck(state, journal) {
    if (state.busy || state.components.some((c) => c.queued)) return 'the updater has running or queued work';
    if (!journal) return null;
    if (state.distribution !== 'walle-cn' || state.github !== false) return 'the running updater is not the CN distribution';
    for (const step of journal.steps) {
        const rows = state.components.filter((c) => (c.installAs || c.id) === step.id && c.installed);
        if (rows.length !== 1 || rows[0].installed !== step.version) {
            return `${step.id}: the updater does not show one matching installed component`;
        }
        const group = ['robertn_waze_cluster', 'waze-on-cluster', 'cluster-render'].includes(step.id) ? 'idrive-apps' : 'mgu-store';
        const source = state.sources.find((s) => s.id === rows[0].source);
        if (!source || source.type !== 'https' || source.label !== `${CN_BASE}${group}/catalog.json` ||
            source.status !== 'ok' || source.error) return `${step.id}: its managed CN update catalog is not ready`;
    }
    return null;
}
async function migrateCn(o) {
    if (!o.from || !!o.planOnly === !!o.expectPlan) {
        throw new Usage('migrate-cn needs --from and exactly one of --plan-only or --expect-plan');
    }
    if (o.expectPlan && !/^[a-f0-9]{64}$/.test(o.expectPlan)) throw new Usage('invalid expected migration plan');
    const snapshot = migrationSnapshot(o.from);
    if (!o.planOnly && (snapshot.manifest.installReady !== true ||
        ['mgu-store', 'idrive-apps'].some((repo) => {
            const r = snapshot.manifest.repositories[repo], s = r.integration;
            return !s || s.context !== 'release-check/cn-integration' || s.state !== 'success' || s.sha !== r.commit;
        }))) {
        throw new Usage('this snapshot is for preparation only; migration integration/publication evidence is missing');
    }
    await reach(o);
    const runtime = await migrationRuntime(o);
    const busy = migrationRuntimeCheck(runtime);
    if (busy) throw new Usage(busy);
    // A staged copy supplies a known read-only status implementation even when
    // the installed wrapper predates --read-only; it is not installed here.
    const stage = `/var/opt/mgu-deploy-kit-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const q = shQuote(stage), staged = snapshot.runner;
    let status;
    try {
        const upload = await ssh(o, unpackKit(q), { input: tgz(staged, 0) });
        if (upload.status) return 1;
        status = await ssh(o, `sh ${q}/mgu-deploy.sh status --read-only --json`, { input: Buffer.alloc(0), capture: true });
        const installed = status.status === 0 ? lastJson(status.stdout) : null;
        const release = migrationRelease(snapshot, installed);
        const entries = release.artifacts.map((a) => ({
            name: `artifacts/${a.entry.artifact.name}`, data: a.data, mode: 0o600
        })).concat([{ name: 'migration.json', data: Buffer.from(JSON.stringify(release.manifest)), mode: 0o600 }]);
        const send = await ssh(o, `umask 077; tar -xzf - -C ${q}`, { input: tgz(entries, 0) });
        if (send.status) return 1;
        const command = o.planOnly ? 'edition-plan' : 'edition-migrate';
        const args = release.artifacts.map((a) => ` --artifact ${q}/artifacts/${shQuote(a.entry.artifact.name)}`).join('');
        const remote = `sh ${q}/mgu-deploy.sh ${command} --distribution-manifest ${q}/migration.json${args}` +
            (o.planOnly ? ' --json' : ` --expect-plan ${o.expectPlan} --yes`);
        const result = await ssh(o, remote, { input: Buffer.alloc(0), capture: true, wait: 'the head unit is preparing or applying the migration' });
        process.stdout.write(result.stdout);
        if (!o.planOnly) say('Migration content must be verified after any required normal restart; online updates remain a separate check.');
        return result.status;
    } finally {
        await ssh(o, `rm -rf ${q}`, { input: Buffer.alloc(0) });
    }
}
async function migrationCommand(o) {
    if (!/^[a-f0-9]{64}$/.test(o.transaction || '')) throw new Usage('migration command needs --transaction <sha256>');
    if (o.command === 'migration-rollback' && !o.yes) throw new Usage('migration-rollback requires --yes');
    await reach(o);
    const runner = `/var/opt/mgu-deploy/edition-migrations/${o.transaction}/runner/mgu-deploy.sh`;
    const verb = { 'migration-status': 'edition-status', 'migration-verify': 'edition-verify',
        'migration-rollback': 'edition-rollback' }[o.command];
    if (o.command === 'migration-verify') {
        const saved = await ssh(o, `sh ${shQuote(runner)} edition-status ${o.transaction}`,
            { input: Buffer.alloc(0), capture: true });
        const journal = saved.status === 0 ? lastJson(saved.stdout) : null;
        if (!journal || !Array.isArray(journal.steps)) throw new Usage('migration journal is unavailable');
        const refusal = migrationRuntimeCheck(await migrationRuntime(o), journal);
        if (refusal) throw new Usage(refusal);
    }
    return (await ssh(o, `sh ${shQuote(runner)} ${verb} ${o.transaction}${o.yes ? ' --yes' : ''}`,
        { input: Buffer.alloc(0), wait: 'the head unit is checking or restoring the migration' })).status;
}

/* From the deploy tool's status --json, whether our apps' tiles show on an
 * iDrive 7 unit: they do once the running app manager runs the fallback
 * copy, and a restart brings that while the fallback is on. why: the
 * deploy tool's reason it could not turn the fallback on. A status
 * without manager_runs_copy (an older deploy tool, no status), no app
 * listed, or the retired installer's leftovers (which list the apps
 * themselves) count as shown. On iDrive 8 the Store and every app listed
 * in custom_apps.json show once the status reports their tiles visible
 * (from the provisioning MainApp-21 gets, or the sections the running
 * MainApp-21's fallback filled); a Store not yet registered does not.
 * why: the deploy tool's reason the fallback is off (live_installs). A
 * status without listed_by_manager (an older deploy tool) counts as
 * shown. */
function tilesShow(line) {
    let s = null;
    try {
        s = JSON.parse(line);
    } catch (e) {
        return { shown: true };
    }
    const fb = s && s.fallback;
    if (fb && (s.unit || {}).hmi === 'ID8' && 'listed_by_manager' in fb) {
        const apps = (s.components || []).filter((c) => c.kind === 'app');
        const ours = ['robertn_store'].concat(fb.apps || []);
        const shown = ours.every((id, i) => (i > 0 && !apps.some((c) => c.id === id)) ||
            apps.some((c) => c.id === id && c.tile_visible === true));
        const off = !shown && !fb.active && /^off: /.test((s.live_installs || {}).reason || '') ? s.live_installs.reason.slice(5) : null;
        return off ? { shown, why: off } : { shown };
    }
    if (!fb || !('manager_runs_copy' in fb) || (s.unit || {}).hmi === 'ID8' || !(fb.apps || []).length ||
        (s.retired_leftovers || []).length) {
        return { shown: true };
    }
    if (fb.manager_runs_copy === true) {
        return { shown: true };
    }
    return fb.refused ? { shown: false, why: fb.refused } : { shown: false };
}

/* ---- uninstall ------------------------------------------------------------------------------ */

/* Which deploy tool removes the setup, read on the unit: "installed" when
 * the unit's own has remove-all, "old" when it has none, "absent" without
 * a deploy tool. */
const DEPLOY_HAS = `if [ ! -e ${DEPLOY} ]; then echo absent; elif sh ${DEPLOY} help 2>/dev/null | grep -q remove-all; then echo installed; ` +
    'else echo old; fi';

/* Runs the deploy tool's remove-all with args: the unit's own, or kit (the
 * published deploy tool's files) sent like first-install's and removed
 * after. The steps' lines show on stderr; stdout is returned. */
function removeAllRun(o, kit, args) {
    const wait = args === '--yes' ? 'the head unit is still removing the setup' : undefined;
    if (!kit) {
        return ssh(o, `sh ${DEPLOY} remove-all ${args}`, { input: Buffer.alloc(0), capture: true, wait });
    }
    // a published deploy tool without remove-all answers the listing with its whole usage
    const quiet = args === '--json' ? ' 2>/dev/null' : '';
    const q = shQuote(`/var/opt/mgu-deploy-kit-${process.pid}`);
    return ssh(o, unpackKit(q) +
        `{ sh ${q}/mgu-deploy.sh remove-all ${args}${quiet}; st=$?; rm -rf ${q}; exit $st; }`,
    { input: tgz(kit, Math.floor(Date.now() / 1000)), capture: true, wait });
}

/* The last line of a remove-all's stdout as JSON, or null. */
function lastJson(stdout) {
    try {
        return JSON.parse(stdout.trim().split('\n').pop());
    } catch (e) {
        return null;
    }
}

function versioned(list) {
    return list.map((x) => (x.version ? `${x.id} ${x.version}` : x.id)).join(', ');
}

function showPlan(plan) {
    const rest = [];
    const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const updater = [plan.sources && count(plan.sources, 'source'), plan.tokens && count(plan.tokens, 'token')].filter(Boolean);
    if (updater.length) {
        rest.push(`the updater's ${updater.join(' and ')}`);
    }
    if (plan.fallback) {
        rest.push('the provisioning fallback');
    }
    rest.push(`the deploy tool ${plan.deploy_tool} with its backups`);
    say('Uninstall removes what the Store setup put on the head unit:');
    say(`  apps:  ${versioned(plan.apps) || 'none'}`);
    say(`  tools: ${versioned(plan.tools) || 'none'}`);
    say(`  and ${rest.join(', ')}`);
    if ((plan.kept || []).length) {
        say(`  It keeps what IterioDev's App Manager installed: ${plan.kept.join(', ')}`);
    }
}

/* Without the Store there is no Restart head unit to point at. */
const AFTER_UNINSTALL = 'restart the head unit later';

async function uninstall(o) {
    const from = o.from ? fromFolder(o.from) : null;
    await reach(o);
    const has = await ssh(o, DEPLOY_HAS, { input: Buffer.alloc(0), capture: true });
    const which = has.status === 0 ? has.stdout.trim() : '';
    if (which === 'absent') {
        say('The Store setup is not on this head unit: nothing to remove.');
        return 0;
    }
    let kit = null;
    if (which !== 'installed') {
        // the deploy tool on the unit has no remove-all: the published one removes the setup
        const { components } = from ? dirComponents(from) : await urlComponents(STORE_CATALOG);
        const c = components.find((x) => x.entry.id === 'mgu-deploy');
        if (!c) {
            throw new Error(`${from || STORE_CATALOG}: the catalog has no mgu-deploy`);
        }
        kit = deployToolFiles(await c.fetch());
    }
    const plan = lastJson((await removeAllRun(o, kit, '--json')).stdout);
    if (!plan || !Array.isArray(plan.apps) || !Array.isArray(plan.tools)) {
        say(kit ? 'The published deploy tool has no uninstall yet; nothing was removed.' :
            'The deploy tool on the head unit did not say what is installed; nothing was removed.');
        return 1;
    }
    showPlan(plan);
    if (!o.yes) {
        const term = process.env.CI ? null : terminal();
        if (!term) {
            say('Nothing was removed: run uninstall at a terminal to answer, or add --yes.');
            return 2;
        }
        if (!/^y(es)?$/i.test((await promptLine('Remove all of it? [y/N] ', term)).trim())) {
            say('Nothing was removed.');
            return 0;
        }
    }
    const run = await removeAllRun(o, kit, '--yes');
    const result = lastJson(run.stdout);
    if (!result || !Array.isArray(result.left)) {
        say(`The uninstall on the head unit ended with status ${run.status}. Run uninstall again to finish.`);
        return 1;
    }
    if (result.left.length) {
        const still = `Not finished: ${result.left.join(', ')} ${result.left.length === 1 ? 'is' : 'are'} still on the head unit. `;
        if (!result.restart) {
            say(still + 'Run uninstall again to finish.');
            return 1;
        }
        say(still + 'Restart the head unit, then run uninstall again to finish.');
        await offerRestart(o, AFTER_UNINSTALL);
        return 1;
    }
    if (result.self === 'next-start') {
        const going = (result.next_start || []).concat(['the deploy tool']);
        say(`Restart the head unit to finish: ${going.slice(0, -1).join(', ')} and ${going[going.length - 1]} go at its next start.`);
        return offerRestart(o, AFTER_UNINSTALL);
    }
    if (result.restart) {
        say('Removed. Restart the head unit to finish.');
        return offerRestart(o, AFTER_UNINSTALL);
    }
    say('Removed: nothing of the Store setup is left on the head unit.');
    return 0;
}

/* ---- status --------------------------------------------------------------------------------- */

/* Which status the unit's deploy tool gives: "read-only" when it has
 * status --read-only, "plain" when not, "absent" without a deploy tool. */
const STATUS_HAS = `if [ ! -e ${DEPLOY} ]; then echo absent; elif sh ${DEPLOY} help 2>/dev/null | grep -q -e --read-only; then echo read-only; ` +
    'else echo plain; fi';

/* Text to paste anywhere: printable ASCII, tabs and newlines; anything else a "?". */
function plainText(s) {
    return s.replace(/\r\n?/g, '\n').replace(/[^\x20-\x7e\t\n]/g, '?');
}

/* The deploy tool's status on the unit, its stderr with it, on stdout;
 * its exit status. */
async function statusCommand(o) {
    await reach(o);
    const has = await ssh(o, STATUS_HAS, { input: Buffer.alloc(0), capture: true });
    const which = has.status === 0 ? has.stdout.trim() : '';
    if (which === 'absent') {
        say('The Store is not installed on this head unit: it has no deploy tool.');
        return 1;
    }
    if (which !== 'read-only' && which !== 'plain') {
        say(`The head unit did not say which deploy tool it has (exit ${has.status}); nothing was run.`);
        return 1;
    }
    const r = await ssh(o, `sh ${DEPLOY} status${which === 'read-only' ? ' --read-only' : ''} 2>&1`, { input: Buffer.alloc(0), capture: true });
    process.stdout.write(plainText(r.stdout));
    if (which !== 'read-only') {
        say('(This deploy tool has no read-only status: it may have repaired things, as the updater does at its start.)');
    }
    return r.status;
}

/* ---- usb-repo ------------------------------------------------------------------------------ */

/* A folder name under mgu-repo/: safe on FAT, exFAT and NTFS. */
function folderName(s) {
    const n = String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'repo';
    // names Windows reserves for devices
    return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/.test(n) ? `${n}-repo` : n;
}

/* A file name a catalog gives: one plain name, no folder. */
function plainName(s) {
    return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,200}$/.test(s) && !s.includes('..');
}

function title(members, base) {
    const get = (n) => {
        const m = members.find((x) => x.name === n);
        return m ? JSON.parse(m.data.toString('utf8')) : null;
    };
    try {
        const rhmi = base === 'source/' ? 'rhmiData/' : `${base}rhmiData/`;
        const app = get(`${rhmi}application.json`).application;
        const textId = app.entryPoints && app.entryPoints[0] && app.entryPoints[0].textId;
        const dirs = ['variantGroups/Common/texts'].concat((app.variantGroups || []).map((g) => String(g.stringsPath || '').replace(/^\.\//, '')));
        for (const d of dirs) {
            const t = get(`${rhmi}${d}/en_GB.json`);
            if (t && textId && typeof t[textId] === 'string' && t[textId]) {
                return t[textId];
            }
        }
    } catch (e) { /* no entry-point text */ }
    return null;
}

/* What a package file is, from its content: a tool kit (component.json),
 * a source package (mgu-app.json), or an app (package.json flat, under
 * package/, or a .mgu's source/). */
function describePackage(file, data) {
    let members;
    try {
        members = untgz(data);
    } catch (e) {
        throw new Usage(`${file}: not a gzipped tar`);
    }
    const json = (n) => {
        const m = members.find((x) => x.name === n);
        return m ? JSON.parse(m.data.toString('utf8')) : null;
    };
    const tool = json('component.json');
    if (tool) {
        if (tool.kind !== 'tool' || !/^[a-z0-9][a-z0-9-]*$/.test(tool.id || '') || !SEMVER.test(tool.version || '')) {
            throw new Usage(`${file}: component.json is not a tool kit's`);
        }
        return { id: tool.id, kind: 'tool', version: tool.version, title: tool.title || tool.id, description: tool.description || '',
            mguHmi: tool.mguHmi, mguProvides: tool.mguProvides };
    }
    const src = json('mgu-app.json');
    if (src) {
        if (!ID.test(src.id || '') || !SEMVER.test(src.version || '')) {
            throw new Usage(`${file}: mgu-app.json needs an id and an x.y.z version`);
        }
        const pkg = json(`${src.tree}/package.json`) || {};
        return { id: src.id, kind: 'app', version: src.version, title: title(members, `${src.tree}/`) || pkg.productName || src.id,
            description: typeof pkg.description === 'string' ? pkg.description : '', build: 'unit', mguHmi: src.mguHmi || pkg.mguHmi };
    }
    const base = ['package/', '', 'source/'].find((b) => members.some((m) => m.name === `${b}package.json`));
    if (base === undefined) {
        throw new Usage(`${file}: no component.json, mgu-app.json or package.json`);
    }
    const pkg = json(`${base}package.json`);
    // a root-service package (renderer, tether) installs as the tool of its name, providing its kind
    if (pkg.mguService !== undefined && ['renderer', 'tether'].indexOf(pkg.mguService) < 0) {
        throw new Usage(`${file}: a root-service package of an unknown kind (mguService renderer or tether)`);
    }
    if (!ID.test(pkg.name || '') || !SEMVER.test(pkg.version || '')) {
        throw new Usage(`${file}: package.json needs a lower-case name and an x.y.z version`);
    }
    return { id: pkg.name, kind: pkg.mguService ? 'tool' : 'app', version: pkg.version,
        title: title(members, base) || pkg.productName || pkg.name,
        description: typeof pkg.description === 'string' ? pkg.description : '', mgu: base === 'source/',
        mguHmi: pkg.mguHmi, mguProvides: pkg.mguService, service: !!pkg.mguService };
}

/* A catalog entry as the stick lists it: the source's fields, the artifact
 * at `file` beside catalog.json. */
function stickEntry(entry, file, data) {
    const e = Object.assign({}, entry, { artifact: { name: `${entry.id}@${entry.version}.tgz`, size: data.length, sha256: sha256(data), url: file } });
    Object.keys(e).forEach((k) => (e[k] === undefined || e[k] === null) && delete e[k]);
    return e;
}

/* Writes one source folder: files (name -> bytes) and catalog.json last,
 * at the stick's root (where the updater looks for no source), then in
 * the old folder's place. */
function writeFolder(dest, files, catalog) {
    const stick = path.dirname(path.dirname(dest));
    const tmp = path.join(stick, `.mgu-repo-${path.basename(dest)}.partial`);
    const old = path.join(stick, `.mgu-repo-${path.basename(dest)}.old`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    files.forEach((f) => {
        const to = path.join(tmp, ...f.name.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, f.data);
    });
    if (catalog) {
        const text = `${JSON.stringify(catalog, null, 2)}\n`;
        if (Buffer.byteLength(text) > STICK_JSON_MAX) {
            throw new Error(`${path.basename(dest)}: catalog.json over ${STICK_JSON_MAX} bytes, which the updater does not read`);
        }
        fs.writeFileSync(path.join(tmp, 'catalog.json'), text);
    }
    if (fs.existsSync(dest)) {
        fs.renameSync(dest, old);
    }
    fs.renameSync(tmp, dest);
    fs.rmSync(old, { recursive: true, force: true });
}

/* The icon a component's catalog entry names, for the stick: { name:
 * <id>.png, data } when it reads and matches its iconSha256, else null
 * (said, never failing the stick). */
async function stickIcon(c) {
    const e = c.entry;
    if (typeof e.icon !== 'string' || !e.icon) {
        return null;
    }
    try {
        const data = await c.icon();
        if (typeof e.iconSha256 === 'string' && sha256(data) !== e.iconSha256.toLowerCase()) {
            throw new Error('its sha256 does not match the catalog\'s');
        }
        return { name: `${e.id}.png`, data };
    } catch (err) {
        say(`  ${e.id}: icon left out (${err.message})`);
        return null;
    }
}

/* A published CN catalog as a stick folder. Each
 * icon is copied beside catalog.json; one that is not keeps an https URL,
 * which the updater fetches when it is online, and leaves out any other. */
async function publishedFolder(components, commit, label) {
    const files = [];
    const entries = [];
    await waiting('still downloading', async () => {
        for (const c of components) {
            const data = await c.fetch();
            const file = c.file || c.entry.artifact.name;
            if (!plainName(file)) {
                throw new Error(`${label}: unusable artifact name ${file}`);
            }
            files.push({ name: file, data });
            say(`  ${c.entry.id} ${c.entry.version}  ${file}`);
            const icon = await stickIcon(c);
            const entry = Object.assign({}, c.entry);
            if (icon) {
                files.push(icon);
                Object.assign(entry, { icon: icon.name, iconSha256: sha256(icon.data) });
            } else if (!/^https:\/\//.test(entry.icon || '')) {
                delete entry.icon;
                delete entry.iconSha256;
            }
            entries.push(stickEntry(entry, file, data));
        }
    });
    return { files, catalog: Object.assign({ schema: 2 }, commit ? { commit } : {}, { components: entries }) };
}

/* A catalog.json at a URL, artifacts absolute or relative to it. */
async function urlComponents(url) {
    const catalog = parseCatalog((await get(url, { max: 4 << 20 })).toString('utf8'), url);
    return { commit: catalog.commit, components: catalog.components.map((entry) => ({ entry,
        fetch: () => get(new URL(entry.artifact.url || entry.artifact.name, url).toString(), { max: entry.artifact.size })
            .then((d) => checked(entry.artifact.name, d, entry.artifact.size, entry.artifact.sha256)),
        icon: () => get(new URL(entry.icon, url).toString(), { max: ICON_MAX }) })) };
}

/* An icon a folder's catalog names: an https URL, or a file inside the folder. */
function dirIcon(dir, ref) {
    if (/^https:\/\//.test(ref)) {
        return get(ref, { max: ICON_MAX });
    }
    return Promise.resolve().then(() => {
        const rel = ref.replace(/^\.\//, '');
        if (!plainName(path.posix.basename(rel)) || rel.split('/').some((x) => !x || x === '..')) {
            throw new Error(`unusable icon path ${ref}`);
        }
        const file = path.join(dir, ...rel.split('/'));
        if (fs.statSync(file).size > ICON_MAX) {
            throw new Error(`more than ${ICON_MAX} bytes`);
        }
        return fs.readFileSync(file);
    });
}

/* A folder with catalog.json (a dir: publish): its artifacts read beside it. */
function dirComponents(dir) {
    const catalog = parseCatalog(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'), path.join(dir, 'catalog.json'));
    return { commit: catalog.commit, components: catalog.components.map((entry) => {
        const rel = (entry.artifact.url || entry.artifact.name).replace(/^\.\//, '');
        if (/^https?:/.test(rel)) {
            return { entry, fetch: () => get(rel, { max: entry.artifact.size }).then((d) => checked(entry.artifact.name, d, entry.artifact.size, entry.artifact.sha256)),
                icon: () => dirIcon(dir, entry.icon) };
        }
        if (!plainName(path.posix.basename(rel)) || rel.split('/').includes('..')) {
            throw new Error(`${dir}: unusable artifact path ${rel}`);
        }
        const read = () => checked(entry.artifact.name, fs.readFileSync(path.join(dir, ...rel.split('/'))), entry.artifact.size, entry.artifact.sha256);
        return { entry, file: path.posix.basename(rel), read, fetch: () => Promise.resolve().then(read), icon: () => dirIcon(dir, entry.icon) };
    }) };
}

/* A checkout with mgu-repo.json: its files as they are in the repository
 * (git's tracked files when git is there), links and .git left out. */
function checkoutFiles(dir) {
    let names = null;
    if (fs.existsSync(path.join(dir, '.git'))) {
        const r = cp.spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
        names = r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
    }
    if (!names) {
        names = [];
        (function walk(rel) {
            fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean))).sort().forEach((n) => {
                if (n === '.git' || n === 'node_modules' || n === '.DS_Store' || n.startsWith('._')) {
                    return;
                }
                const r2 = rel ? `${rel}/${n}` : n;
                const st = fs.lstatSync(path.join(dir, ...r2.split('/')));
                if (st.isDirectory()) {
                    walk(r2);
                } else if (st.isFile()) {
                    names.push(r2);
                }
            });
        }(''));
    }
    let total = 0;
    const files = names.filter((n) => {
        const st = fs.lstatSync(path.join(dir, ...n.split('/')), { throwIfNoEntry: false });
        return st && st.isFile() && !n.split('/').some((s) => s === '.DS_Store' || s.startsWith('._'));
    }).map((n) => {
        const data = fs.readFileSync(path.join(dir, ...n.split('/')));
        total += data.length;
        return { name: n, data };
    });
    if (total > STICK_REPO_MAX || files.length > STICK_REPO_FILES) {
        throw new Error(`${dir}: over ${STICK_REPO_MAX} bytes or ${STICK_REPO_FILES} files, more than the updater reads from a folder`);
    }
    return files;
}

/* The stick's mgu-repo/local/ catalog with the given package files added:
 * per id the higher version stays. */
function localFolder(dest, inputs) {
    const byId = new Map();
    if (fs.existsSync(path.join(dest, 'catalog.json'))) {
        try {
            dirComponents(dest).components.forEach((c) => {
                try {
                    byId.set(c.entry.id, { entry: c.entry, file: c.file, data: c.read() });
                } catch (e) {
                    say(`  ${c.entry.id} ${c.entry.version} left out: ${e.message}`);
                }
            });
        } catch (e) {
            say(`  ${path.join(dest, 'catalog.json')}: ${e.message}; written anew`);
        }
    }
    inputs.forEach(({ file, data }) => {
        const d = describePackage(file, data);
        const have = byId.get(d.id);
        if (have && compareVersions(have.entry.version, d.version) > 0) {
            say(`  ${d.id} ${have.entry.version} stays (${path.basename(file)} is ${d.version})`);
            return;
        }
        if (d.mguHmi !== undefined && (!Array.isArray(d.mguHmi) || !d.mguHmi.length ||
            d.mguHmi.some((h, i) => ['ID7', 'ID8'].indexOf(h) < 0 || d.mguHmi.indexOf(h) !== i))) {
            throw new Usage(`${file}: mguHmi must list "ID7" and/or "ID8"`);
        }
        if (d.mguProvides !== undefined && !(d.kind === 'tool' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(d.mguProvides))) {
            throw new Usage(`${file}: mguProvides is one lower-case name, for a tool`);
        }
        const entry = { id: d.id, kind: d.kind, title: d.title, description: d.description, version: d.version,
            build: d.build, uninstallable: d.kind === 'app' || d.service ? true : undefined, mguHmi: d.mguHmi, mguProvides: d.mguProvides,
            // the deploy tool that installs a service package as a tool
            requires: d.service ? { 'mgu-deploy': '0.4.0' } : undefined };
        byId.set(d.id, { entry, file: `${d.id}@${d.version}.${d.mgu ? 'mgu' : 'tgz'}`, data });
        say(`  ${d.id} ${d.version}  ${path.basename(file)}`);
    });
    const rows = Array.from(byId.values()).sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
    return { files: rows.map((x) => ({ name: x.file, data: x.data })),
        catalog: { schema: 2, components: rows.map((x) => stickEntry(x.entry, x.file, x.data)) } };
}

/* The marker the updater reads a stick folder's source from: it updates
 * what that source installed (native/mgu-updater/README.md, "Ids"). */
function copyOf(source) {
    return { name: 'mgu-copy.json', data: Buffer.from(`${JSON.stringify({ copyOf: source })}\n`) };
}

async function usbRepo(o) {
    const stick = path.resolve(o.stick);
    if (!fs.existsSync(stick) || !fs.statSync(stick).isDirectory()) {
        throw new Usage(`not a folder: ${o.stick}`);
    }
    const inputs = o.inputs.length ? o.inputs : [STORE_CATALOG];
    if (inputs.some((input) => input.startsWith('github:'))) {
        throw new Usage('GitHub imports are not supported by the CN installer; use an HTTPS catalog or local files');
    }
    const repoDir = path.join(stick, 'mgu-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const names = new Set();
    const unique = (n) => {
        let name = n;
        for (let i = 2; names.has(name) || name === 'local'; i += 1) {
            name = `${n}-${i}`;
        }
        names.add(name);
        return name;
    };
    const packages = [];
    for (const input of inputs) {
        if (/^https?:\/\//.test(input)) {
            const u = checkUrl(input);
            const name = unique(input === STORE_CATALOG ? 'mgu-store' :
                folderName(`${u.hostname}-${path.posix.basename(path.posix.dirname(u.pathname)) || 'catalog'}`));
            say(`${input} -> mgu-repo/${name}/`);
            const { commit, components } = await urlComponents(u.toString());
            const out = await publishedFolder(components, commit, input);
            writeFolder(path.join(repoDir, name), out.files.concat([copyOf(u.toString())]), out.catalog);
        } else if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
            const dir = path.resolve(input);
            if (dir === stick || dir.startsWith(repoDir + path.sep)) {
                throw new Usage(`${input}: a folder on the stick itself`);
            }
            const name = unique(folderName(path.basename(dir)));
            say(`${input} -> mgu-repo/${name}/`);
            if (fs.existsSync(path.join(dir, 'catalog.json'))) {
                const { commit, components } = dirComponents(dir);
                const out = await publishedFolder(components, commit, input);
                writeFolder(path.join(repoDir, name), out.files, out.catalog);
            } else if (fs.existsSync(path.join(dir, 'mgu-repo.json'))) {
                writeFolder(path.join(repoDir, name), checkoutFiles(dir), null);
                say('  a repository checkout: the unit builds its components');
            } else {
                throw new Usage(`${input}: no catalog.json or mgu-repo.json`);
            }
        } else if (fs.existsSync(input) && fs.statSync(input).isFile()) {
            packages.push({ file: input, data: fs.readFileSync(input) });
        } else {
            throw new Usage(`not an https:// catalog URL, a folder or a package file: ${input}`);
        }
    }
    if (packages.length) {
        say('package files -> mgu-repo/local/');
        const dest = path.join(repoDir, 'local');
        const out = localFolder(dest, packages);
        writeFolder(dest, out.files, out.catalog);
    }
    const folders = fs.readdirSync(repoDir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(repoDir, n)).isDirectory());
    if (folders.length > 64) {
        say(`mgu-repo/ holds ${folders.length} folders; the updater reads the first 64 by name`);
    }
    say(`${stick}: the Store lists these while the stick is in the car`);
    return 0;
}

/* ---- command line ---------------------------------------------------------------------------- */

/* This script's text: the file, the copy a standalone executable carries
 * (deploy/installer), or null from stdin. */
function ownSource() {
    if (FROM_STDIN) {
        return null;
    }
    try {
        const sea = require('node:sea');
        if (sea.isSea()) {
            return sea.getAsset('mgu-install.js', 'utf8');
        }
    } catch (e) {
        // a Node without node:sea runs the file
    }
    return fs.readFileSync(__filename, 'utf8');
}

/* The header comment; from stdin there is no file to read it from. */
const SOURCE = ownSource();
const USAGE = SOURCE === null ? 'usage: deploy/README.md, "mgu-install"' : SOURCE.split('*/')[0].split('\n').slice(3)
    .map((l) => l.replace(/^ \* ?/, '')).join('\n').trimEnd();

function parse(argv) {
    if (argv[0] === 'token' || argv.includes('--token')) {
        throw new Usage('GitHub token operations are not supported by the CN installer');
    }
    const o = { command: argv[0], host: null, port: '22', bind: null, given: false, user: 'root', identity: null, sshOpts: [],
        noRenderer: false, noUplink: false, noRestartPrompt: false, yes: false, from: null, rest: [] };
    const value = (i, flag) => {
        if (i >= argv.length) {
            throw new Usage(`${flag} needs a value`);
        }
        return argv[i];
    };
    for (let i = 1; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--host') o.host = value(++i, a);
        else if (a === '--port') o.port = value(++i, a);
        else if (a === '--user') o.user = value(++i, a);
        else if (a === '--identity') o.identity = value(++i, a);
        else if (a === '--ssh-opt') o.sshOpts.push(value(++i, a));
        else if (a === '--plan-only' && o.command === 'migrate-cn') o.planOnly = true;
        else if (a === '--expect-plan' && o.command === 'migrate-cn') o.expectPlan = value(++i, a);
        else if (a === '--transaction' && o.command.startsWith('migration-')) o.transaction = value(++i, a);
        else if (a === '--no-renderer' && o.command === 'first-install') o.noRenderer = true;
        else if (a === '--no-uplink' && o.command === 'first-install') o.noUplink = true;
        else if (a === '--no-restart-prompt' && ['first-install', 'uninstall'].includes(o.command)) o.noRestartPrompt = true;
        else if (a === '--from' && ['first-install', 'uninstall', 'migrate-cn'].includes(o.command)) o.from = value(++i, a);
        else if (a === '--yes' && ['uninstall', 'migration-rollback'].includes(o.command)) o.yes = true;
        else if (a.startsWith('--')) throw new Usage(`unknown option ${a} for ${o.command}\n${USAGE}`);
        else o.rest.push(a);
    }
    // a target named: no detection
    o.given = argv.slice(1).some((a) => ['--host', '--port'].includes(a));
    if (!/^\d+$/.test(o.port)) {
        throw new Usage(`--port needs a number: ${o.port}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(o.user) || (o.host !== null && !/^[A-Za-z0-9.:%_[\]-]+$/.test(o.host))) {
        throw new Usage('--user and --host take a plain name or address');
    }
    return o;
}

/* On Ctrl+C (SIGINT) or SIGTERM: one line saying how to finish, the ssh
 * processes stopped, then the exit the signal would have made. */
function stopOn(signal, operation) {
    process.once(signal, () => {
        const migration = operation === 'migrate-cn' || String(operation).startsWith('migration-');
        const message = migration ? 'stopped; inspect the migration transaction before retrying or restoring' :
            'stopped; run the same command again to finish';
        process.stderr.write(`${process.stderr.isTTY ? os.EOL : ''}${message}${os.EOL}`);
        sshRunning.forEach((c) => c.kill(signal));
        if (process.platform === 'win32') {
            // STATUS_CONTROL_C_EXIT, as a console's Ctrl+C ends a program
            process.exit(-1073741510);
        }
        process.kill(process.pid, signal);
    });
}

async function main(argv) {
    const o = parse(argv);
    if (!o.command || o.command === 'help' || o.command === '--help') {
        say(USAGE);
        return 0;
    }
    stopOn('SIGINT', o.command);
    stopOn('SIGTERM', o.command);
    if (Number(process.versions.node.split('.')[0]) < 18) {
        throw new Usage(`Node 18 or newer is needed (this is ${process.version})`);
    }
    if (['first-install', 'uninstall', 'status', 'migrate-cn', 'migration-status', 'migration-verify', 'migration-rollback'].includes(o.command)) {
        if (o.rest.length) {
            throw new Usage(`${o.command} takes no ${o.rest[0]}`);
        }
        return { 'first-install': firstInstall, uninstall, status: statusCommand, 'migrate-cn': migrateCn,
            'migration-status': migrationCommand, 'migration-verify': migrationCommand,
            'migration-rollback': migrationCommand }[o.command](o);
    }
    if (o.command === 'usb-repo') {
        if (!o.rest.length) {
            throw new Usage('usage: node mgu-install.js usb-repo <stick folder> [<input>...]');
        }
        return usbRepo(Object.assign(o, { stick: o.rest[0], inputs: o.rest.slice(1) }));
    }
    throw new Usage(`unknown command ${o.command}\n${USAGE}`);
}

if (require.main === module || FROM_STDIN) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (e) => {
        process.stderr.write(`mgu-install: ${e.message}\n`);
        process.exitCode = e instanceof Usage ? 2 : 1;
    });
}

module.exports = { tgz, untgz, sshArgs, folderName, plainName, parse, SOURCES, updaterPackageIdentity, updaterCompatibility,
    migrationSnapshot, migrationRelease, migrationRuntimeCheck, SETUP_INSTALLED,
    sshBanner, enetInterfaces, hsfzFrame, hsfzFrames,
    didAddress, hsfzGateway, hsfzHuAddress, findUnit, reach, tilesShow, STATUS_HAS };

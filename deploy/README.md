# deploy: our tools and apps on the head unit

One installer puts our root tools (`native/<id>/component.json`) and OAP apps
(`apps/<id>/release.json`) on the unit, updates, rolls back and removes them,
snapshots every change first, and restores a snapshot on request.

| Part | Runs on | What it does |
|---|---|---|
| `deploy/mgu-install.js` | the owner's computer (Node 18+; Windows, macOS, Linux) | the first install over SSH from the CN catalog, USB sticks as local repos |
| `deploy/install.sh`, `deploy/install.ps1` | the owner's computer, Node 18+ | download and verify the CN JavaScript installer |
| `deploy/hu` | the Mac (system Node) | packs tool artifacts, installs components built from this checkout over SSH (development) |
| `deploy/sources.json` | | the managed CN Store and idrive-apps HTTPS catalogs |
| `deploy/transport/` | the Mac (system `python3`) | finds the unit's sshd over ENET or the hotspot, relays ENET, and the `--arm-debug` bootstrap |
| `deploy/unit/mgu-deploy.sh` → `mgu-deploy.js` | the unit, as root, under its Node 8 | the installer itself |
| `tools/oap_link.js`, `tools/oap_pack.js` | the unit (and the build machine) | build source packages and prepare packages built elsewhere |
| `deploy/component.json` | | the installer as a tool component, `mgu-deploy` |

The updater (`native/mgu-updater`) installs everything it downloads through
the installed deploy tool, `/var/opt/mgu-deploy/mgu-deploy.sh install
--artifact <file> --yes`, so every install takes the same path, whichever
installer starts it.

- **The local deploy tool** (this folder) bootstraps the car over SSH:
  `mgu-install.js` from the published release, `deploy/hu` from a
  checkout. It installs app-privacy, the updater and the Store and seeds the
  updater's CN sources. CN setup does not use a GitHub token.
- **The updater** (`native/mgu-updater`) is the cloud installer: it
  downloads from its sources and installs each artifact by calling the
  installed deploy tool, `/var/opt/mgu-deploy/mgu-deploy.sh install
  --artifact <file> --yes`.

`deploy/mgu-install.js` is the owner's side: one file, no dependencies,
Node 18 or newer, driving the system's OpenSSH client (built into
Windows 10/11, macOS and Linux). It runs from a file or from stdin
(`curl -fsSL <raw URL> | node - first-install ...`).

For an existing official installation, use the supported
[distribution migration](../docs/CN-MIGRATION.md). The
[two-snapshot Beta trial](../docs/CN-RELEASE-CHANNELS.md#prepared-online-update-trial)
separates the local migration from the subsequent real Store online update.
Verify the migration before that update; its old transaction does not describe
payloads installed by a later update.

## From the Mac

```sh
deploy/hu check  [<id>...] [--artifact <file>...]   # read-only checks of the unit (and the artifacts)
deploy/hu install [<id>...] [--with-uplink] [--artifact <file>...] [--updater-token-file <file>]
                                                    # build and install; no ids: every component but mgu-uplink
deploy/hu status [--json]
deploy/hu uninstall <id> --yes
deploy/hu rollback <id> --yes                       # a tool back to its other kept version
deploy/hu backups
deploy/hu restore [name] --yes                      # default: stock
deploy/hu fallback on|off|status|migrate
deploy/hu updater-token [--updater-token-file <file>] | --list [--json] | --remove <id>
deploy/hu artifact <dir> --out <dir>                # one tool artifact: native/<id>, or deploy
deploy/hu connect [--hold <seconds>] [--cmd <command>]   # reach root on the unit (below)
deploy/hu help
```

Bare ids name components to build locally (`app-privacy`,
`robertn_store`, ...); `--artifact` names files already built. After a
successful `install`, the updater's sources are seeded from
`deploy/sources.json` (kept when the unit has its own), and a token file
(`--updater-token-file`, or `HU_UPDATER_TOKEN_FILE`) is stored as the
updater's token. A token file is never committed; its content travels on
ssh's stdin only. `--keep-stage` keeps the upload folder on the unit.

SSH options: `--user` (`HU_USER`, root), `--identity <key>` (`HU_IDENTITY`),
and repeatable `--ssh-opt <option>` passed as `ssh -o`.

Exit status: 0 done, 1 failed (rolled back where it applies), 2 refused
before anything changed (and bad usage), 3 stopped by the MainApp guard
(iDrive 7): what it changed stays and is taken up at the next start of the
head unit.

### Connecting

`--host <addr>` (`HU_HOST`) and `--port <n>` (`HU_PORT`, 22) name the target
themselves: ssh goes there as given (host `172.16.222.97` when only a port
is given), and host-key checking is left to `--ssh-opt`.

Without them, every SSH command (and `connect`) finds the unit with
`deploy/transport/mgu_connect.py`:

- **ENET** when a `169.254.x` adapter is present (or `--iface <if>`): the
  unit's address is `--hu-ip <addr>`, else the one the gateway reports,
  else the last one that answered. A relay `127.0.0.1:<lport>` (`--lport`,
  2222) carries ssh.
- **The DIRECT-BMW hotspot** (`--wifi`, or no ENET adapter): ssh goes
  straight to `172.16.222.97` (or `--hu-ip`).

The unit must already have permanent root SSH. When no candidate serves
SSH, the command stops: "Permanent (field-mode) SSH seems disabled on this
HU".

**`--arm-debug`** is for a first-time bootstrap only, over ENET, when
permanent SSH is not set up yet or a firmware update removed it. **Arming
invalidates the MyBMW login and personal settings.** It arms debug mode,
relays to the debug sshd and disarms when the command ends, unless
`--keep-armed`. When no SSH appears after arming, debug is left armed and
the command says to restart the unit (or hold the volume/power knob about
25 s) and run it again with `--arm-debug`. Then set up permanent SSH on the
unit and go back to the default. It needs the Python package
`cryptography`, and cannot be combined with `--wifi` or `--hu-ip`.

**Assets.** The SSH key and the debug-certificate material are **not in this
repository** and must never be committed. `--assets-dir <dir>`
(`HU_ASSETS_DIR`; default `~/.config/mgu-store/assets`) holds
`mgu_ssh_key_rsa.pem` (root's key on the unit), and for `--arm-debug` also
`asset_03.bin` (PMO intermediate CA certificate) and `asset_04.bin` (its
key). `--identity` replaces the key.

```sh
deploy/hu connect                       # ENET or hotspot; prints the ssh command, holds until Ctrl-C
deploy/hu connect --hold 1800           # hold the relay 30 min for ssh from another terminal
deploy/hu connect --wifi --cmd 'id'     # one command
deploy/hu status --hu-ip 169.254.125.24
deploy/hu connect --arm-debug --keep-armed --hold 1800   # bootstrap only, see above
```

A unit on a local SSH port:

```sh
deploy/hu status --host 127.0.0.1 --port 2225 \
    --ssh-opt StrictHostKeyChecking=no --ssh-opt UserKnownHostsFile=/dev/null
```

Exit status everywhere: 0 done, 1 failed (rolled back where it applies),
2 refused before anything changed (and bad usage), 3 stopped by the MainApp
guard (iDrive 7, "Bouncing the app manager"): what it changed stays.

### The updater's sources and tokens

The updater reads its sources from `/var/opt/mgu-updater/sources.json`
(native/mgu-updater/README.md). The installers seed it with
`deploy/sources.json`, the CN HTTPS catalogs with source IDs `mgu-store`
and `idrive-apps`, when the updater is installed and has none: `sh
mgu-deploy.sh updater-sources < sources.json` writes it, root's, mode 0600,
and keeps an existing one, since the owner adds sources from the Store.

The following token operations describe retained upstream deploy compatibility.
The CN updater does not load or use these credentials; the CN installer and
Store do not expose token management. Existing files remain for recovery.

The upstream updater's tokens are its own, not a source's (native/mgu-updater/
README.md, "Tokens"): each one's text in `/var/opt/mgu-updater/credentials/
token-<id>` and its entry (id, label, account) in `credentials/tokens.json`,
root's, mode 0600, in a 0700 folder; the updater reads each GitHub source
with whichever token reaches it. The owner supplies a GitHub token (one
that reads the private repositories the car reads) as a file on the Mac; it is never committed. `deploy/hu install
--updater-token-file <file>` stores it after the install, and `deploy/hu
updater-token --updater-token-file <file>` stores it alone; both default to
`HU_UPDATER_TOKEN_FILE`. `deploy/hu updater-token --list [--json]` names the
stored tokens (id, label, account; never a token) and `--remove <id>`
removes one. Over SSH the file's content travels on ssh's stdin only: it is
never an argument or part of the staging upload, nor printed.
On the unit, `sh mgu-deploy.sh updater-token < <file>` stores a
token, as a new id, unless one with that text is stored already; it writes
the files only (the running updater notices them within 5 s, asks GitHub
whose the token is and reads the sources that need it). `--list [--json]`
and `--remove <id>` as above.

## Artifacts

A **tool artifact** `<id>@<version>.tgz` holds `component.json` at its root,
`files/<path>`, `units/<name>` and `dropins/<unit>.d/<name>`. `deploy/hu artifact` builds it from a
folder holding a `component.json` (`native/<id>`, or `deploy` for the deploy
tool itself):

- `build`, when present, is a command run in that folder first
  (mgu-uplink: `make target`, which needs Go, and Docker for its
  wpa_supplicant);
- `files[{path, from, mode}]` are read from `from`; a missing one fails,
  naming the build command;
- the artifact's `component.json` is `{id, kind, version, title,
  description, files[{path, mode, sha256}], units[{name}], enable, recmgr,
  restart}`, `dropins[{unit, name}]` (each read from `from`), and `internet`
  with `uids`, `mguHmi`, `mguProvides`, `keepRunning`, `crashNames`,
  `postInstall`, `check`, `activate` and `deactivate` when the tool declares
  them;
- members are sorted, owned 0:0, with the listed modes (`component.json` and
  units 0644) and one mtime: `SOURCE_DATE_EPOCH` when set, else the packer's
  fixed one (`tools/oap_pack.js`, which also writes the gzip header's OS byte
  as Unix on any machine). The same tree gives the same bytes;
  `release/release.js` packs tools with this command.

An **app artifact** is one of:

- an OAP package: the flat tgz our builds pack (`tools/oap_pack.js`, files
  at the root, `"mguLocalOnly": true`), installed byte for byte; or one
  built elsewhere (below): an npm-format tgz (files under `package/`), or a
  `.mgu` (`meta.json`, the package as `source/`, `rhmiData/`, `oapgen/`);
- a **source package**: a tgz with `mgu-app.json` at its root, built on the
  unit (below). The Store is published this way.

A **service package** (IterioDev's App Manager format: `package.json` with
`mguService`) installs as a tool when it is a renderer; a tether is refused
("Service packages").

## mgu-install

`deploy/mgu-install.js` is the owner's side: one file, no dependencies,
Node 18 or newer (its own `fetch`, `crypto` and `zlib`; what it sends is
packed in Node, no `tar`, shell or Python on the computer), driving the system's
OpenSSH client (`ssh`, built into Windows 10/11, macOS and Linux). It runs
from a file or from stdin (`curl -fsSL <raw URL> | node - first-install
...`); from stdin restart prompts read the terminal device (`/dev/tty`),
and where there is none (Windows) the downloaded file is run instead.

`first-install` and `uninstall` find the head unit by themselves, and print
which connection they used:

1. the car's hotspot, `172.16.222.97:22`, when it serves an SSH banner;
2. else ENET, on each interface with a `169.254.x.x` address in turn: HSFZ
   gateway identification (UDP `00 00 00 00 00 11` to `:6811`, sent from
   that address, answers heard there and on `:6811` on all addresses, so a
   gateway that answers by broadcast is heard too), then DID `22 17 2A` read from the head unit (`0x63`)
   through the gateway's `:6801` — that request alone, no session change,
   no routine, nothing armed — and the last ENET address that answered
   (`~/.cache/mgu-store/last_hu_enet_ip`, which `deploy/transport` keeps
   too). The first of these that serves an SSH banner from the
   interface's address is the target, and ssh binds to that address
   (`ssh -b`), so the link-local route goes out of the ENET interface
   without a relay. The address that answered is remembered.

When the head unit was found but its SSH does not answer (the hotspot's
address refuses port 22 or answers there without SSH, or the gateway
reported an address whose port 22 does not answer), it stops with
`found the head unit at <address>, but its SSH is closed: enable root SSH
first, then run this again`. When nothing answers it stops before downloading anything, naming the
hotspot, the ENET cable and `--host`; on Linux also how to give the ENET
adapter a link-local address (`nmcli con mod <its connection>
ipv4.method link-local`) when no interface has one, or, with several
link-local interfaces (Linux routes them by destination only), their
names and to unplug the others or give `--host`. `--host <address>` and
`--port <n>` (22) name the target themselves and skip the search
(`--host` defaults to the hotspot's address). `--ssh-opt <option>`
(repeatable, `ssh -o`, before the tool's own; e.g.
`ConnectTimeout=30`) applies to whichever target is used;
through a jump host give `--host` as well (`--ssh-opt ProxyJump=<host>`),
as the search runs from this computer. `--user <name>`
(root) and `--identity <key file>` apply to either. The unit's host key
is neither asked about nor kept (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null`): every car's hotspot has the same address,
and a unit's key can change. With OpenSSH 8.8 or newer it adds
`HostKeyAlgorithms=+ssh-rsa` and `PubkeyAcceptedAlgorithms=+ssh-rsa`,
which the unit's sshd needs.
`--arm-debug` stays with `deploy/hu`.

While a step takes longer than 30 s (finding the unit, a download, the
install or removal on the head unit) it prints one line about every 30 s,
such as `the head unit is still installing (2 min)`. Stopped with Ctrl+C
(or SIGTERM), it prints `stopped; run the same command again to finish`
and exits as the signal would.

```sh
node mgu-install.js first-install [--from <folder>] [--no-renderer] [--no-uplink] [ssh options]
node mgu-install.js uninstall [--yes] [--from <folder>] [--no-restart-prompt] [ssh options]
node mgu-install.js status [ssh options]
node mgu-install.js usb-repo <stick folder> [<input>...]
```

```powershell
node .\mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key
node .\mgu-install.js usb-repo E:\
```

**CN launcher.** `deploy/install.sh` (POSIX sh) and `deploy/install.ps1`
(Windows PowerShell 5.1 and PowerShell 7) require Node 18 or newer already
installed. They download `mgu-install.js` and `SHA256SUMS` from
`https://mgu.walle.pw/mgu/cn/bootstrap/`, check its SHA-256 before running
it, and remove the temporary files afterwards. The launchers do not
download Node. Install the runtime separately before working at the car.
`MGU_INSTALL_DOWNLOAD` names another bootstrap folder; the default always
uses the CN domain. These endpoints are usable only once a validated CN
release has been published.

Maintainers prepare the three scripts and `SHA256SUMS` in an empty output
folder with `node deploy/installer/bootstrap.js <folder>`. This only writes
local files. Publication and head-unit update-order validation are separate
steps.

Through `curl | sh`, Node's stdin is the terminal for interactive prompts.
PowerShell quotes every argument, including the downloaded script's path,
and leaves the installer's exit status in `$LASTEXITCODE` (1 for a
failed download or checksum). GitHub repository imports and token commands are not available in the CN installer.
GitHub hosts are rejected for catalogs, artifacts and redirects. Existing credentials
are neither read nor removed.

```sh
curl -fsSL https://mgu.walle.pw/mgu/cn/bootstrap/install.sh | sh -s -- usb-repo /Volumes/STICK
```

```powershell
& ([scriptblock]::Create((irm https://mgu.walle.pw/mgu/cn/bootstrap/install.ps1))) status --identity $HOME\.ssh\mgu_root_key
```

**first-install** first reads, without changing anything, whether the
head unit's coding (`/dev/shm/rawcodingdata`) is missing (not valid, or the
default values) while no app manager runs: oapcontroller then never starts
MainApp, so the Store cannot install. It stops there (exit 2), before any
download, saying to restore the head unit's coding from a backup
(BimmerCode, E-Sys or ISTA) or have HU_MGU coded to the car, restart the
head unit and run the install again. A unit where that cannot be read
installs as usual.

It reads `https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json`
(`MGU_INSTALL_CATALOG` can name another HTTPS catalog), takes every entry but the
optional ones, and of those the renderer `mgu-render` (the Store draws its
screens with it) and the internet uplink `mgu-uplink` (`--no-renderer`,
`--no-uplink` leave them out; one the catalog does not list is skipped,
saying so, and one the deploy tool refuses is left out after the rest
installs), downloads each
artifact and checks its size and sha256 against the catalog; a mismatch
stops it before anything is sent. The deploy tool's own files come from the
published `mgu-deploy` artifact, each checked against its manifest; nothing
is built on the computer, and the Store's source package is built on the
unit. One ssh call sends them as a tar stream to
`/var/opt/mgu-deploy-kit-<pid>` (0700) and runs there: `mgu-deploy.sh
install --artifact ... --skip-older --yes` with the release's deploy tool
(it installs itself as `mgu-deploy`, keeps newer installed tools and apps,
does not build an installed Store version again) and `updater-sources`
with the CN HTTPS sources `mgu-store` and `idrive-apps` (kept
when the unit has its own); then removes
the folder. `status` is then printed. Its last line
is `Restart the head unit to finish setup.` while any of
`mgu-updater.service`, `mgu-render.socket` and `mgu-uplink.service` is
installed but not active, or, on iDrive 7, while the running app manager
does not yet run the provisioning fallback that shows our apps' tiles,
or, on iDrive 8, while the deploy tool's `status` does not report the
Store's tile and those of the other apps listed in `custom_apps.json`
as shown (a Store not yet registered included); otherwise it reports installation
completed and asks for CN runtime/update acceptance. When the fallback could not be turned on, it says
`The Store's tile cannot show:` and the reason (exit 1 when the services
run). After the restart line, at a
terminal (not under CI, nor with `--no-restart-prompt`), it asks
`Restart the head unit now? [y/N]`; `y` or `yes` restarts the head unit
the way the Store's Restart head unit does (`/usr/bin/nsm_control
--requestRestart 7 --normal`) and prints `Restarting the head unit.`;
any other answer ends it there. After `y`, no restart is requested while a
deploy tool run of this boot holds its lock, and none is taken when
`nsm_control` answers `[Error. <why>]`; either ends it with exit 1, saying so. Through
`install.sh` and `install.ps1` the question is asked at the terminal they
run in. Exit status: 0 done, 1 failed, 2 refused (the coding, or the deploy tool's own).

**first-install --from <folder>** takes the component list from a folder
`usb-repo` wrote (`<folder>/mgu-repo/mgu-store`: its `catalog.json` and the
artifacts beside it) instead of the online CN catalog. Nothing is
downloaded; each artifact is checked against the catalog's size and sha256
as it is read, before anything is sent, and the rest is the same. The
folder's `catalog.json` is read before the head unit is searched for; a
folder without one is refused (exit 2). For a computer that has internet
only away from the car:

```sh
node mgu-install.js usb-repo <folder>                                                   # at home
node mgu-install.js first-install --from <folder>/mgu-repo/mgu-store --identity <key>   # at the car
```

CN setup reads the installed updater's version, relevant file hashes and
`updater.local.conf` before sending its install kit. A same/newer updater must
match the verified CN payload; an unknown or different payload is refused.
An explicit non-CN `distribution_channel` override is refused at any version.
The installer never downgrades to force an edition switch or edits that override.

Package installation, visible tiles and running services do not prove the
active edition. After restart, acceptance requires the updater to report
`distribution: "walle-cn"` and `github: false`, the intended effective sources,
and a successful subsequent CN online update. Until then, report installation
completed with runtime/update verification pending.

Before installing, the car is parked, on stable power (engine running or a
charger connected), and stays awake until the command finishes.

**uninstall** removes everything the Store setup put on the head unit,
with the deploy tool's `remove-all` ("Removing the Store setup" below). It
first lists what is installed (the apps and tools the deploy tool
installed, from any source, the updater's sources and tokens, the deploy
tool) and asks `Remove all of it? [y/N]`; `--yes` skips the question, and
without a terminal it removes nothing unless given `--yes` (exit 2). A
deploy tool on the unit without `remove-all` hands the job to the
published one, read like first-install's (or from `--from <folder>`),
which stays installed should the run not finish.
It ends with one line:
`Removed: nothing of the Store setup is left on the head unit.`;
`Removed. Restart the head unit to finish.` or, on iDrive 8 with apps
removed at the next start, `Restart the head unit to finish: <apps> and
the deploy tool go at its next start.`, either followed by the restart
question as first-install asks it; or `Not finished: <what> is still on
the head unit. Run uninstall again to finish.` (exit 1), or, when what
is left goes only after a restart, `… Restart the head unit, then run
uninstall again to finish.` and the restart question (exit 1).

```sh
curl -fsSL https://mgu.walle.pw/mgu/cn/bootstrap/install.sh | sh -s -- uninstall --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://mgu.walle.pw/mgu/cn/bootstrap/install.ps1))) uninstall --identity $HOME\.ssh\mgu_root_key
```

**status** prints the deploy tool's report from the head unit: each tool
and app, each app's tile (`tile=provisioned`, `fallback` or `hidden`) and
what waits for a restart. It finds the unit like `first-install` and
changes nothing there (`mgu-deploy.sh status --read-only`). A deploy tool
without `--read-only` runs its plain `status`, which may repair things as
the updater's does at its start; a line after the report says so. Without
a deploy tool it says the Store is not installed (exit 1). Paste the
output when asking for help:

```sh
curl -fsSL https://mgu.walle.pw/mgu/cn/bootstrap/install.sh | sh -s -- status --identity ~/.ssh/mgu_root_key
```

```powershell
& ([scriptblock]::Create((irm https://mgu.walle.pw/mgu/cn/bootstrap/install.ps1))) status --identity $HOME\.ssh\mgu_root_key
```

**Downloads** use HTTPS and validate the catalog's size and SHA-256. The CN
installer rejects GitHub hosts, including redirects, and never reads a GitHub
CLI token. `status` makes no HTTP request. Use the chosen HTTPS catalog or
verified local resources; `token`, `--token` and `github:` inputs fail before
contacting a head unit.

**usb-repo** writes a local repository onto a stick for a car without
internet. Each input becomes `mgu-repo/<name>/` (names lower-case, safe on
FAT, exFAT and NTFS), which the updater reads as source
`usb:<label>/mgu-repo/<name>` (native/mgu-updater/README.md, "USB media"):

| Input | Folder | Written |
|---|---|---|
| `https://.../catalog.json` | `<host>-<folder>` | as a catalog release |
| a folder with `catalog.json` (a `dir:` publish) | its name | as a catalog release |
| a folder with `mgu-repo.json` (a checkout) | its name | the repository's files (git's tracked files, else all but `.git` and `node_modules`), which the unit builds |
| package files `*.tgz`, `*.mgu` | `local` | added to `local/`'s catalog by their content: an app (`package.json` flat, under `package/`, or a `.mgu`), a source package (`mgu-app.json`, `build: "unit"`), a tool kit (`component.json`), a renderer or tether package (`mguService`) as a tool providing its kind; of an id the higher version stays |

No input: the CN mgu-store HTTPS catalog, written to `mgu-repo/mgu-store/`. The folder of an HTTPS input holds `mgu-copy.json`, `{"copyOf": "<the input>"}`: the
updater then updates from it what that source installed
(native/mgu-updater/README.md, "Ids"). A written catalog is schema
2 with the source's fields (`build`, `requires`, `optional`,
`uninstallable`, `mguHmi`, `mguProvides`; apps and service packages from
releases or package files are `uninstallable`)
and each artifact beside it under a relative URL; an `.mgu` keeps its file
name and is listed as `<id>@<version>.tgz`, which the deploy tool installs
by its content. Each icon a catalog entry lists (`icon`) is copied beside
it as `<id>.png`, checked against its `iconSha256`, and the entry names
that file; an icon that cannot be read or does not match is left out,
saying so, and never stops the stick (an `https` icon stays listed for
the updater to fetch when online). A folder is written next to the old one and replaces it
once complete, so the stick holds the newer versions only; other folders
and the stick's other files stay. A root-service package of another
`mguService`, a folder over the updater's limits (catalog.json over 1 MiB, a checkout over
200 MB or 20000 files) or an artifact that does not match is refused.

## On the unit

```
mgu-deploy.sh check [--artifact <file>...]
mgu-deploy.sh install [--artifact <file>...] [--skip-older] [--other-source] [--leave <id>...] [--keep-safe-mode] [--repair] [--yes]
mgu-deploy.sh status [--read-only] [--json]   # --read-only: changes nothing
mgu-deploy.sh relay [<id>...] [--keep-safe-mode] --yes   # a stale tool's files again, without its install step
mgu-deploy.sh setup <id> --yes                # a tool laid again, its install step included
mgu-deploy.sh uninstall <id> [--yes]
mgu-deploy.sh remove-all [--json] | remove-all --yes
mgu-deploy.sh rollback <id> [--keep-safe-mode] [--repair] [--yes]
mgu-deploy.sh restore [name] [--yes]
mgu-deploy.sh backups
mgu-deploy.sh fallback <on|off|status|migrate> [--yes]
mgu-deploy.sh updater-token                   # a token on stdin
mgu-deploy.sh updater-token --list [--json] | --remove <id>
mgu-deploy.sh updater-sources                 # sources.json on stdin
mgu-deploy.sh sdk-donor [--json]
mgu-deploy.sh safe-mode [--json] | safe-mode off --yes
mgu-deploy.sh appmanager [--json] | appmanager adopt [--yes]
mgu-deploy.sh apply-pending                   # iDrive 8, at boot
mgu-deploy.sh relist                          # iDrive 8, at boot
mgu-deploy.sh verify                          # at boot
mgu-deploy.sh remove-unused                   # at boot
```

`install` without `--artifact` takes every `*.tgz` and `*.mgu` in
`./artifacts` beside the script. Tools install before apps, `app-privacy`
first. `--other-source` (the updater's) installs a tool another source
installed, deactivating the version it replaces first. Each artifact is its own transaction: when one fails, only its
changes are undone, and the ones installed before it stay. One changing
command runs at a time; another waits for it, up to an hour.

`--repair` (the updater's) installs again an app `status` lists under
`lost_apps`, from its kept package, once: after that, or when it fails,
the app is listed under `lost_held` with the reason until it is installed
from the Store.

`--repair` (the updater's) installs again an app `status` lists under
`lost_apps`, from its kept package, once: after that, or when it fails,
the app is listed under `lost_held` with the reason until it is installed
from the Store.

- **rollback <id>** switches a tool to its other kept version (an update
  keeps the version before), or, on iDrive 7, an app to its kept older
  package, carrying its data over. Refused on iDrive 8 apps.
- **backups** / **restore [name]**: every change is snapshotted first.
  `stock` is the first snapshot ever taken; the 10 newest others are kept.
  A restore puts back the files the snapshot recorded and keeps the deploy
  tool and the updater's sources and tokens. It needs `--yes`, or `YES`
  typed at a terminal. A restore of a snapshot taken under other firmware
  that would write system files is refused: after a firmware update, use
  `mgu-install.js uninstall` to take the Store setup off.
- **remove-all** lists what the Store setup put on the unit; with `--yes`
  it removes all of it, the deploy tool last (`mgu-install.js uninstall`
  runs this).
- **sdk-donor** makes a readable copy of the unit's oap-sdk donor bundle in
  `/run/mgu-deploy/sdk-donor/` and prints its path; the updater hands it to
  a repository's own build (docs/PUBLISHING.md).

## Artifacts

A **tool artifact** `<id>@<version>.tgz` holds `component.json` at its
root, `files/<path>`, `units/<name>` and `dropins/<unit>.d/<name>`.
`deploy/hu artifact` builds it from a folder holding a `component.json`
(`native/<id>`, or `deploy` for the deploy tool itself); `build`, when
present, is a command run in that folder first. The same tree gives the
same bytes; `release/release.js` packs tools with this command.

An **app artifact** is one of:

- an OAP package: a flat tgz (`tools/oap_pack.js`, files at the root), an
  npm-format tgz (files under `package/`), or a `.mgu` (`meta.json`, the
  package as `source/`);
- a **source package**: a tgz with `mgu-app.json` at its root, built on the
  unit ("Source packages"). The Store is published this way.

A **service package** (IterioDev's App Manager format: `package.json` with
`mguService`) installs as a tool when it is a renderer ("Service packages").

### component.json

| Field | What it does |
|---|---|
| `id`, `kind: "tool"`, `version` (x.y.z), `title`, `description` | the tool |
| `build` | a command run in the folder before packing |
| `files[{path, from, mode}]` | files installed under `/var/opt/<id>/versions/<version>/`, `current` pointing at the version in use |
| `units[{name, from, runsInSafeMode}]` | systemd units installed in `/etc/systemd/system` ("Safe mode" for `runsInSafeMode`) |
| `enable` | units to enable, as `<target>.wants` links |
| `restart` | units started or restarted after an install; `[]` starts nothing |
| `recmgr` | extra names for recmgr's restart list (letters, digits and `:._+@-`); every service and socket unit the tool installs is listed there already |
| `dropins[{unit, name, from}]` | a drop-in for a unit the tool does not own, such as `hmi.service`; it takes effect at that unit's next start |
| `keepRunning` | `true`: a running service is never restarted by an update or rollback; the new version runs from its next start (a renderer) |
| `crashNames` | program file names for the crash handler's list (letters, digits and `._+-`), when they differ from the tool's executables' names ("The crash handler's list") |
| `postInstall` | `["<script>", "<arg>", ...]`: run with `sh` from `current/` after every install, for at most 5 minutes; a failure is a warning |
| `check` | `["<script>", "<arg>", ...]`: run from `current/` (node for `.js`, else sh) once a new version runs, for at most 5 minutes; a non-zero exit rolls the tool back |
| `activate`, `deactivate` | "Activate and deactivate" |
| `internet`, `uids` | "Internet for selected components" |
| `mguHmi` | `["ID7"]`, `["ID8"]` or both ("Compatibility") |
| `mguProvides` | the capability it provides ("Capabilities") |
| `versionFiles` | source files that carry the version as `VERSION = 'x.y.z'` |

Every unit a tool starts must be up and not restarting 10 s later, and its
`check` must pass, or the tool goes back to its previous version. A unit
starts or restarts only once recmgr has its entry, which it reads at boot:
a new tool's units start at the next boot, and the tool is reported
pending until then. `oapcontroller` is never stopped or restarted: an
artifact naming it is refused.

### Activate and deactivate

A tool may name a command its installs run, `"activate"`, and one its
removal runs, `"deactivate"`: `["node", <argument>...]` (the Node the deploy
tool runs on) or `[<an executable file of the tool>, <argument>...]`,
non-empty strings without `..`, no shell. Each runs as root in the
version's folder for at most 120 s, its output prefixed `<id> activate:`.
When its last non-empty stdout line is a JSON object, `"reboot"` says why
the change needs a head-unit restart (the tool is then pending with that
reason), `"status"` is a line for the output, and `"removeWhenUnused"` lists
files on `/` to remove once no process runs them.

- `activate` runs on every install of the tool (the same version again too)
  and on a rollback to a version that has one, after its units are in
  place. It must be idempotent. A non-zero exit or the timeout fails the
  install, which rolls back.
- `deactivate` runs before a removal or a rollback changes anything, with
  the tool in place. It must succeed, doing nothing, when what it reverts is
  already stock (after a firmware update, say). A non-zero exit refuses the
  removal (exit 2) and the tool stays.

A command that writes to `/` remounts it read-write itself. Stock files the
car's services run as their own user (`/usr/bin/carplay`, `/usr/bin/aapd`,
`/etc/aapd.conf`) must stay readable (and runnable) by them; the deploy
tool puts their mode back with a warning when a hook leaves them otherwise.

### Compatibility

A component may name the head units it is for, `"mguHmi": ["ID7"]`,
`["ID8"]` or both: an app in its `package.json` (or `mgu-app.json`), a tool
in its `component.json`. An app that does not is taken to be for the HMIs
its rhmiData has a UI for. An install on another head unit is refused
before anything changes (exit 2: `oap-cardash 1.1.4 is for iDrive 8 (its
rhmiData); this head unit is iDrive 7`).

### Source packages

A source package is a tgz with `mgu-app.json` at its root
(`tools/oap_link.js` has the format): the app's staged package tree without
`javascript/app.js`, its modules (the entry first), and the require names
its modules take from the oap-sdk. The unit builds it before anything
changes, linking those names from a stock BMW app on the unit (the
**donor**), and installs the result as any app. The same inputs give the
same bundle on the unit and on the build machine. No donor, a module that
does not compile, or a bad `mgu-app.json` refuses the artifact (exit 2,
nothing changed). `"internet": true` in `mgu-app.json` becomes
`"mguInternet": true` in the built `package.json`.

### Packages built elsewhere

An OAP package from another repository installs as it is published, with
what the head unit's app manager needs to install it added:

- an npm-format tgz or a `.mgu` (`meta.json` must name the same id and
  version as its `source/`) is repacked flat;
- `"mguLocalOnly": true` is added to its `package.json`;
- without `node_modules/` or `npm-shrinkwrap.json`, an empty
  `npm-shrinkwrap.json` is added;
- `permissions.json` gets the ACL tables it lacks (`masterAccessTable`,
  `masterRegistrationTable`), empty;
- its SOME/IP manifest gets `de.bmw.infotainment.certification.Certification`
  (`"*"`), without which the app cannot get its keychain;
- on iDrive 7, the interfaces its SOME/IP manifest names that the head
  unit's firmware does not have (such as iDrive 8's `hmi.entrypoint2`) are
  taken out, and the output names them;
- when its javascript calls `require('oap-sdk')` and it ships no
  `node_modules/oap-sdk`, that module is generated from the unit's donor.
  The approach follows `kit/tools/extract_sdk.js` of
  [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
  (MIT); `tools/oap_link.js` is its own implementation.

A package that needs the oap-sdk on a unit with no donor is refused (exit 2,
nothing changed).

### App package fields

In an app's `package.json`:

| Field | What it does |
|---|---|
| `mguHmi` | the head units it is for ("Compatibility") |
| `mguInternet` | `true`: the app gets internet through the uplink |
| `mguAppStartType` | `manually` (default), `autostart` or `lum`; an `autostart` app starts with the head unit and is started again when it stops. Any other value is refused |
| `mguLocalOnly` | added by the installer: marks the app as ours, so app-privacy keeps it out of the head unit's reports to BMW |

Only a higher version updates an app; the same version is reported as
already installed, a lower one is refused (use `rollback`).

### Service packages

IterioDev's App Manager installs root services as packages: an npm-format
tgz holding `package.json` `{ name, version, mguService }` and an x86-64
program under its name. A renderer (`mguService` `renderer`, name
`mgu-renderd`) installs as a tool of that name, run by
`mgu-renderd.service` from boot; a tether (`tether`, `ipheth-tether`) is
refused: mgu-uplink drives the iPhone. Any other `mguService`, a version
that is not x.y.z, or a program that is not a 64-bit x86-64 ELF of at most
16 MiB is refused.

### Capabilities

A tool may say which capability it provides, `"mguProvides": "<name>"` in
its `component.json`; a service package provides its kind. Providers of one
capability install side by side: renderers keep to their own sockets, and
mgu-render leaves the community socket to another installed renderer
(native/mgu-render/README.md, "Beside other renderers").

**idrive7-apps' own installer.** A tool of ours takes over the renderer and
controller gate units that idrive7-apps' `mgu-app-install.sh` wrote. The
apps that installer put on the unit are updated and removed by the Store
like any app.

### Internet for selected components

A tool whose `component.json` says `"internet": true` lists its numeric
`uids`, or names in `uids` a file under `/var/opt/<id>/` where it keeps
them, one per line; an app's `package.json` says `"mguInternet": true`.
While `mgu-uplink` is installed, those uids and apps get internet through
it.

### The crash handler's list

The head unit restarts when a process crashes whose executable's file name
is not in the crash handler's list. Every ELF file a tool ships executable
goes into the list by its file name; `crashNames` adds others:

```json
"crashNames": ["mgu-uplink", "mgu-wpa"]
```

A name the car's own programs use (`sh`, `wpa_supplicant`, `dbus-send`)
does not belong there: give the program a name of its own instead. The
list takes effect from the next boot.

Every service a tool installs runs with `LimitCORE=1`, so a crash of it or
of a program it starts restarts that service, not the head unit, and with
a start limit: a service that has started 20 times within 10 minutes stays
failed until the next boot or the next install of its tool.

### The deploy tool as a tool

`mgu-deploy` is a tool component like the others (`deploy/component.json`;
`VERSION` in `mgu-deploy.js` equals its version). Its artifact is
`deploy/unit/`, `tools/oap_link.js` and `tools/oap_pack.js`; `deploy/hu`,
`mgu-install.js`, the tests and this README are not part of it. A change to
a file of the artifact adds its line under `## Unreleased` in
`deploy/CHANGELOG.md`; the release sets the version (release/README.md,
"Versions"). The updater updates it like any tool. `uninstall mgu-deploy`
is refused: it goes last in `remove-all`.

## On the head unit

### iDrive 8 apps

When the running app manager (MainApp-21) supports it, app installs,
updates and removals take effect at once. Otherwise they are queued and
applied at the next start of the head unit, and the Store shows them as
pending (`installs at the next start`, `removed at the next start`). An
update MainApp-21 rejects at that start is put back to the version before
at the next one.

After the car's first **Update apps and services** with BMW's backend, the
backend's provisioning lists none of our apps; the deploy tool keeps their
tiles listed through the provisioning fallback.

### IterioDev's App Manager

The Store replaces IterioDev's App Manager
([IterioDev/mgu-app-store](https://github.com/IterioDev/mgu-app-store)): its
app `oap-appmanager` and its tether are refused from any source.
`appmanager adopt [--yes]` takes over what it installed, nothing
reinstalled: its daemon stops, its queued app changes and its renderer
become ours, and the updater gives each app it installed its origin.
`uninstall oap-appmanager` adopts first, then removes it; the apps and
services it installed stay.

### Safe mode

When the head unit restarts four times in a row within 2 minutes of
starting, by a crash or recovery restart none of our tools asked for, our
tools' units stay off from the next start: **safe mode**. BMW's units are
never touched. Units marked `"runsInSafeMode": true` in their tool's
`component.json` still run; give it to units that recover the head unit or
leave safe mode:

```json
"units": [{ "name": "acme-recovery.service", "from": "systemd/acme-recovery.service", "runsInSafeMode": true }]
```

The next install that goes through as a whole (of any app or tool) leaves
safe mode, as does `safe-mode off --yes` (the Store's **Leave safe mode**).
Our tools start again at the next start of the head unit.

A tool that restarts the head unit itself writes the start's boot id
(`/proc/sys/kernel/random/boot_id`) to
`/var/opt/mgu-deploy/restart-requested` first, so that restart does not
count.

### After a firmware update

A firmware update puts the root file system back and keeps `/var/opt`:
the components stay installed, but their units and boot entries are gone.
Running `mgu-install.js first-install` again, or any install from the
Store, sets every component up again. A tool with an install step of its
own (`activate`, `postInstall`) gets its files only and is listed as
`needs setup`; its step runs at its next install or with `setup <id>
--yes` (the Store's **Set up**). The app manager marks every app as needing
an update after a firmware update; an install of such an app, already
current, installs it afresh with its data kept.

### Bouncing the app manager

On iDrive 7, an app install the running app manager cannot make in place
restarts it. The app manager's supervisor wipes every app and its data on
the third app manager crash in a row, so the deploy tool waits until the
manager has been up 60 s, and since the last restart as long, before it
restarts it: an install can pause for up to a minute, saying why. When the
manager dies right after a restart anyway, the run stops (exit 3) and app
changes wait for the next start of the head unit.

## Tests

```sh
node deploy/test/cn_installer.js     # CN transport/bootstrap fixtures on macOS/Linux, no head unit
node deploy/test/run.js              # MGU_TEST_ONLY=testKit,... runs those test functions only; MGU_TEST_INSTALL_EXE=<file> runs an mgu-install executable in place of the script
sh deploy/test/run.sh                # in Docker: the unit's code on Node 8.16.2 (MGU_TEST_UNIT_NODE)
node tools/test/run.js               # the linker and packer; sh tools/test/run.sh: on Node 8.16.2
MGU_TEST_NODE_VERSION=8.9.4 sh deploy/test/run.sh   # both run.sh: on Node 8.9.4
```

Offline, against a fake root (`MGU_DEPLOY_FAKE_ROOT=1` and the
`MGU_DEPLOY_*` path and command overrides at the top of `mgu-deploy.js`;
`systemctl`, `journalctl`, `ps`, `kill`, `ssh`, the app manager and
app-privacy are the stand-ins in `deploy/test/`): reproducible artifacts
(the deploy tool's own included), refused artifacts leaving the root
unchanged, tool layout, pruning and idempotence, pending reboots, restarts
with their health check and the rollback after a crash loop, `rollback`,
app-privacy as a tool, the fresh-install and update flows through the
simulated manager, bounce spacing, the MainApp guard (a manager that dies within the watch
after a bounce: the run stops with exit 3, an install, an update and an
uninstall through the sh window keeping what they did with no rootfs write
after the death and their records following it, a rollback stopped in its
removal or its install keeping the record, kept package and data that the
next install completes, a restore stopped or failing, an unmount that
fails, a boot check stopped, no further bounce, app change or app-privacy apply, main.js unbound,
until the next start; one that dies after it: nothing; a watch a killed
run left, judged at the next status; the copy's guard loaded once per
start; a data folder set aside taken by its app registered again with an
empty data folder, kept recorded beside one with data, never through a
link, kept through a later reinstall of the app that succeeds, fails or
is stopped (both folders recorded then), all of them removed by an
uninstall, kept through status and later commands after a failed reinstall, and
gone after a removal, a restore or remove-all; a fallback install stopped
recording its version; the records of a stopped app-privacy install, update
and rollback, restore and fallback on and off matching the finished ones; a stopped boot
check keeping the rest due; a hook's stock-file fix before a stopped
bounce and with the guard off; remove-all while the guard is off); a
restore that removes an app dropping its record, per-artifact transactions, the stock
restore, `status --json`, the fallback, the in-place install, update and
uninstall (the copy built from `fixtures/main.js`, its hook run by
`fake_inplace.js` as the running manager: installs, updates and uninstalls
with no bounce, the request's rules, the bounce instead after a failed, refused or untaken request, a
restarted manager or a copy written after the manager started, no bounce
for an app the manager installs by itself during the bounce's wait or
while the manager is still installing, or updates by itself before the request, an uninstall
the manager fails, does not take or does not finish in time removed through
the bounce, one with no manager running removed with no bounce, and the copy
built without the hook when its anchor is missing), the retired
installer's leftovers (detection, the migration through an update and an uninstall and of
`AppManagement.js` alone, an unmarked app the retired edit lists keeping its
tile, its rollback after a failure before and after its bounce and when a
tile that showed is lost, a rollback that fails too, the restore guard for
carried apps, and the refusals), the updater's sources and tokens (on the
unit and through `deploy/hu`), source packages built against the made-up
donor in `tools/test/synthetic_donor.js` (installed, not built again, no
donor refused), packages built elsewhere (npm format, `.mgu`, unmarked,
oap-sdk generated, no donor refused), the internet drop-ins, `sdk-donor`,
the head unit (iDrive 7 and 8 by MainApp's folder, by the running HMI with
both or neither, unknown), compatibility (rhmiData, a declared `mguHmi`,
a tool's, a malformed one), service packages (the renderer as a tool with
its unit, link and recmgr entry, starting at the next boot; refusals, the
tether among them; uninstall; on an iDrive 8 without a recmgr list started
at once with touch routing), capabilities (a second renderer installed
beside the first, two in one call, one left after the other's uninstall),
`keepRunning` (a running service and its changed socket left as they are,
pending the next start; with the service stopped the socket restarted; a
renderer package not restarted), iDrive 8 apps against made-up das files (queued, the boot unit,
`apply-pending` refused while MainApp runs, applied, an update and a
removal with everything moved to the trash, an update MainApp-21 rejects
put back at the next start (and one it installs left), a flat package repacked, a
queued install dropped, refusals; with `MGU_TEST_ID8_PROV=<folder>` also
against real das files, never part of the repository),
IterioDev's App Manager on a made-up iDrive 8 laid out as its `install.sh`
and service leave it (its app refused; adopt: its daemon and tether
stopped, its queue moved, its renderer our tool, the record without its
token, nothing reinstalled; again; Remove and the next start; a failed
adopt rolled back; our renderer installed first; under recmgr finished at
the next boot),
and `mgu-install.js`: `first-install` against a fake root
through a stand-in `ssh` (`fake_ssh_exec.js`) with the release from a
public catalog fixture (`fake_github.js`), run twice (the restart line while the
updater is not running, none once it is), with the uplink, without a
token, with an artifact that does not match; `usb-repo` from every kind of
input, the stick then read by the updater's own `sources.js` on the unit's
Node (`stick_read.js`); the script run from stdin, finding the unit
at the hotspot address by itself; and Windows paths and names
(`path.win32`). `deploy/test/connect_test.js` covers how it finds the
unit: the order with stand-ins, the interface choice, HSFZ framing and the
DID answer, and the banner check, gateway identification and the DID read
against servers on `127.0.0.1`.
`tools/test/run.js` builds and runs linked and module-mode apps against
that donor; with `MGU_TEST_DONORS` and `MGU_TEST_THIRDPARTY` it also
checks real donors and third-party packages on the machine (never part of
the repository).

The connection is tested without a car or an ENET adapter:
`deploy/test/transport_test.py` (run by `run.js`, on the system `python3`)
covers the selection with stand-ins for the adapter, HSFZ, the certificate
and the banner probe, the banner check and the relay against servers on
`127.0.0.1`, and the `--arm-debug` sequence, hold and disarm.
`deploy/hu`'s own tests run the real transport with `MGU_CONNECT_FAKES`
pointing at `deploy/test/fake_transport.py` (the unit as a banner server on
`127.0.0.1`) and check the target of every ssh call.

## [on-car-unconfirmed]

- The manager's fresh install of an app listed only by the fallback, and an
  update re-seeded with `installationSource: null`, on the car (both proven on
  a test unit).
- The in-place install and update on the car (proven on a test unit): the
  running manager installing with the other apps up, its trigger_service
  check at each install, and only that app stopping and starting.
- The in-place uninstall on the car (proven on a test unit): the
  tile leaving the HMI at once and the other apps staying up.
- oapcontroller's crash counting and alive window on the car (proven on a
  test unit; the 60 s spacing covers it, with room for a slower start).
- recmgr's rules: an entry counts once it was in the list at boot; a stopped,
  unlisted service rebooting the unit.
- The rootfs window (`mount -o remount,rw /` and back to `ro`).
- The fallback anchors in the car's `main.js`, and the bind mount taking
  effect before oapcontroller starts.
- `setquota` clearing an app uid's quota on `/var/opt`.
- busybox `tar -xzf -` reading the staging stream from ssh stdin.
- SSH over the ENET relay in field mode.
- The unit answering DID `22 17 2A` while debug is disarmed.
- `mgu-install.js` over ENET: the gateway answering identification sent from
  the interface's address, and `ssh -b <that address>` reaching the unit's
  link-local address on macOS, Linux and Windows.
- `deploy/hu`'s `--arm-debug` flow end to end on the car.
- The migration of the retired installer's leftovers on the car: its
  backups' names and content, and our apps keeping their tiles through the
  fallback once the stock bundles are back (proven on a test unit with a
  reproduction of the car's state).
- The car's donors: which preinstalled package resolves the Store's sdk
  names first (on a replica of the car's rootfs it is
  `ts_diagnostic_service@4.20.2`, oap-sdk 24.10.2 with module ids of its
  own; x_call's closure is byte-identical to oap-sdk 24.10.2), and the
  Store built from it, with that package's entry point, starting on the car.
- A package built elsewhere running on the car with the generated
  `node_modules/oap-sdk` under the manager's install (its native modules
  resolved for the app as for a stock app).
- `/run/mgu-deploy` writable and readable by other uids on the car.

On an iDrive 8 head unit (IterioDev's car), the
whole iDrive 8 path:

- the detection (`/usr/lib/oap-mainapp21` present and
  `/usr/lib/oap-mainapp` absent; the `Hmi8` process name; the firmware line
  from `/etc/os-release-id-dlt` or `/etc/os-release`);
- whether `/etc/recmgr-restartlist.conf` exists there (without it units
  start at once; with it, the iDrive 7 rules hold);
- `mgu-deploy-apply.service` running at boot before oapcontroller with
  `late.target`, and `apply-pending`'s das edits, package placement and
  removal steps giving the same result as the App Manager's;
- MainApp-21 installing an npm-format package from `preinstalled_apps`
  repacked by this tool (a flat or `.mgu` one), and a source package built
  from an iDrive 8 donor;
- the renderer and tether units as written here (a renderer the App
  Manager installed is refused here; remove it there first);
- MainApp-21 running as node with `oap-mainapp21/src/main.js` as its script
  (`apply-pending` refuses while it runs, by that);
- live changes (the copy bound at boot, the hook, tiles shown and removed
  at once, no corruption handling in oapcontroller's log) on the car's
  MainApp-21 build;
- MainApp-21 supplying `oap-sdk` to an npm package that names it in
  `dependencies` without shipping it (IterioDev's packages do so).

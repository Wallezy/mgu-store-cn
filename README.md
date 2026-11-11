# mgu-store-cn

English | [简体中文](README.zh-CN.md)

**Development preview: no CN installation release is available yet.** This
community fork of [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store)
keeps the original component identities and adds a separate domestic update
channel. Source migration and self-update need head-unit integration validation
before public vehicle installation. See [CN distribution](docs/CN-DISTRIBUTION.md).

An app store for BMW iDrive 7 and iDrive 8 head units (MGU). Browse,
install, update and remove apps on the car's screen from domestic HTTPS
catalogs or a USB stick. This edition has no GitHub login, token management
or GitHub repository sources.

It installs:

- the **Store** app;
- the **updater**, which downloads and installs what the Store asks for;
- the **deploy tool**, which performs and can roll back every install;
- **app privacy**, which keeps installed apps out of the head unit's reports to BMW;
- the **renderer**, which draws the Store and other apps' graphics;
- **Python**, for apps the head unit builds from source;
- the **internet uplink**, for internet through a USB adapter, an LTE stick, a tethered phone or Wi-Fi.

iDrive 8 is not yet tested on a real car. On iDrive 8,
installs and removals take effect at the next head-unit restart.

## Screenshots

These are reference images from the upstream UI, not CN release validation.
The CN edition does not include GitHub source or account management.

The Store: apps and head-unit tools from every source.

![The Store page, listing installed tools and the apps available from the sources](docs/screenshots/store.png)

An app's page, with its source, version and Install.

![The page of the Drag Timer app, with its version, source and an Install button](docs/screenshots/app.png)

Installed: the apps and tools on the head unit.

![The Installed page, listing the installed apps and head-unit tools with their versions](docs/screenshots/installed.png)

## Requirements

- A computer (Windows 10/11, macOS or Linux, x64 or arm64) with the
  OpenSSH client and Node.js 18+. Windows may need OpenSSH enabled separately.
- Root SSH access to the head unit and root's private key. Tools such as
  [idrive7-8-ssh-root](https://github.com/cauliflowermossgrape/idrive7-8-ssh-root)
  set it up over an ENET cable.
- A way to reach the head unit's SSH: the car's Wi-Fi hotspot (default
  address `172.16.222.97`), ENET, or any other SSH route.
- The car parked and on stable power until the install finishes.

## Installation status

Do not replace a working Store with this development checkout. The planned CN
installer and updater use `https://mgu.walle.pw/mgu/cn/`, separate from the
unmodified upstream mirror at `/mgu/`. No ready CN catalog, installer or
head-unit validation is claimed here.

Existing upstream installations keep their supported maintenance path until
an exact CN release passes the migration and update-order tests. Removing the
Store is not a prerequisite for changing distributions. The release checklist
and return-to-upstream boundary are in [CN distribution](docs/CN-DISTRIBUTION.md).

## Using the Store

The side menu has four pages:

- **Store**: apps and tools from your sources, with their state (installed,
  update available, restart pending, …).
- **Installed**: what is installed, with **Update** and **Update all**.
- **USB**: what a plugged-in USB stick offers.
- **Settings**: sources, Wi-Fi, proxy, phone access, **Check now** and
  **Restart head unit**.

Open an app or tool to install, update or remove it. Updates never install
on their own. Tools marked *Restart pending* take effect after a head-unit
restart (Settings → **Restart head unit**).

### Sources

The CN edition manages two catalogs under `https://mgu.walle.pw/mgu/cn/`:
Store infrastructure and the cluster/HUD apps. There is no automatic GitHub
fallback. Known official/mirror identities are normalized without installing
competing updater instances; ambiguous ownership blocks migration.
Existing GitHub sources/accounts are inactive, with recovery data retained.

Other apps can use complete HTTPS catalogs or USB packages. GitHub repository,
branch, tag, private-repository, login and token features are unavailable in
this edition. Source hosting, attribution and developer links on GitHub are
separate from head-unit runtime downloads.

### Phone page

Settings → **Phone access** → **On** shows a QR code. Scan it with a phone on the
car's hotspot to see sources, installs, errors and logs, and to add sources
with the phone's keyboard. Turn it off when done.

### Internet

The internet uplink gives the updater and apps that need it internet
through:

- a USB Ethernet adapter;
- an LTE stick (e.g. Huawei E3372h);
- an Android phone with USB tethering;
- an iPhone with Personal Hotspot on, kept unlocked (tap **Trust** when
  asked); its USB music playback stops while it tethers;
- Wi-Fi, such as a phone's hotspot: Settings → **Wi-Fi**. The car's own
  hotspot and wireless CarPlay keep working beside it. On iDrive 7 units
  with a Broadcom radio, WPA3-only networks can't be joined.

The Store shows `Online` once connected.

### Offline maintenance and your apps

Validated releases retain the local `--from` and `usb-repo` installer paths.
A prepared computer folder is not a mounted USB source on the head unit.
Use supported Store operations for USB imports and installation; this development
edition has no approved vehicle installation instructions.

Publish your apps as an HTTPS `catalog.json` with package sizes, SHA-256 values,
stable component IDs, versions and declared requirements. Apps declare compatible
`mguHmi` targets and must not contain the BMW SDK; source packages link an existing
donor on the unit when needed. [Publishing formats](docs/PUBLISHING.md) retain
upstream reference material; their GitHub modes are not CN runtime features.

## Development

Each component's README covers its build and tests.
[`deploy/README.md`](deploy/README.md) has the full installer reference
and `deploy/hu`, which
installs components from a checkout; [`release/README.md`](release/README.md)
covers releases. [`CONTRIBUTING.md`](CONTRIBUTING.md): versions, CHANGELOG
entries and `requires` in a pull request.

## License

Copyright (C) 2026 Robert Nisipeanu and IterioDev. GPL-3.0-or-later
(`LICENSE`). Third-party parts keep their own licences:
`THIRD_PARTY_NOTICES.md`.

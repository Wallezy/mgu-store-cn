# CN distribution migration

Status: **owner Beta trial entrypoint; no Stable vehicle approval**.
状态：**支持车主明确选择的 Beta 试验入口，尚无 Stable 实车验收**。
Channel preparation, publication and promotion are described in
[CN-RELEASE-CHANNELS.md](CN-RELEASE-CHANNELS.md).

## Scope

The computer-side installer binds the entire selected snapshot: bootstrap,
Store/updater/deploy tools, installed dependencies and installed map components.
It reads both catalogs and verifies all inventoried bytes before connecting.
An optional app absent from the current installation is not installed just
because the target catalog lists it.

The current executor supports migration **to Walle CN on ID7**:

- Identical, compatible packages are retained.
- A newer management component uses a normal deployment step.
- An ordinary app with the same version can be explicitly reinstalled after
  its candidate has compiled and its actual installed package is backed up.
- A same-version `waze-on-cluster` change is limited to `logs.js`; its binary,
  lifecycle declarations and other files must match. Patch hooks do not run.
- Third-party apps and tools outside the managed component set retain their
  payloads, settings and origin records. Their payload fingerprints bind the
  plan and verification; their declared dependencies must remain satisfied.
  GitHub-only sources are unavailable in CN, so these retained components are
  not reported as migrated or able to update from the CN catalogs.
- Same-version Store/updater/deploy changes, lower versions, ID8, conflicting
  origins and missing managed components are refused before replacement.

This is not a generic force-install option. Returning to arbitrary official
versions or another fork is not implemented. `migration-rollback` restores the
specific transaction's verified prior packages, not an arbitrary release.

## Installer entrypoints

The local `deploy/mgu-install.js` exposes:

| Operation | Inputs | Result |
| --- | --- | --- |
| `migrate-cn` preparation | `--from`, `--plan-only`, existing SSH options | Stages its verified runner and packages; compiles candidates and returns a plan hash plus refusals |
| `migrate-cn` execution | `--from`, `--expect-plan`, existing SSH options | Rechecks the exact plan and applies supported changes |
| Beta owner trial | Explicit `--channel beta`, `--expect-snapshot`, `--expect-plan`, `--from` | Permits the reviewed test snapshot without claiming Stable approval; all compatibility/recovery checks remain |
| `migration-status` | `--transaction`, existing SSH options | Reads the durable journal without repairs |
| `migration-verify` | `--transaction`, existing SSH options | Verifies installed contents, tiles and required restart; does not claim online-update acceptance |
| `migration-rollback` | `--transaction`, `--yes`, existing SSH options | Restores independent old payloads and saved application data |

These are development interfaces for the agent/operator, not steps an owner
must type on the unit. All vehicle operations remain behind the installer.
No Root reflash is part of migration.

`--from` is the combined directory produced by `release/prepare_cn.py`, including
`cn-manifest.json`. Its bootstrap must match the running installer exactly.
Stable execution refuses a preparation snapshot (`installReady: false`) before
SSH. Beta execution requires the explicit channel and exact reviewed snapshot
and plan hashes. It leaves `installReady: false`; successful trial installation
does not promote the candidate. The local preparation helper never sets it ready.
Stable promotion and public acceptance are separate operations.

## Transaction behavior

Plans bind the local installer, snapshot, target artifacts, compiled code,
installed content, firmware, boot identity, release channel and source-state hashes. The
linker's build timestamp is excluded from the compiled-code comparison;
complete before/after package SHA-256 values remain in the journal.

Before changing an installed component, the executor keeps all candidate
packages, independent old packages, source/origin/alias configuration and a
private copy of its recovery runner under
`/var/opt/mgu-deploy/edition-migrations/<plan-sha256>/`.
It never puts the sole old copy at the ordinary same-version kept-package path.
Credentials, firmware and SDK donors are not copied into public resources.

The deployment lock serializes writes. The active marker also blocks later
deployment commands, while the CN updater pauses its queue and source/settings
mutations. Nested installs do not silently install the staged deploy tool.
That tool changes only at its recorded step.

The journal records prepared, applying, per-component changes,
awaiting-verification, verified, restoring, restored or recovery-needed.
A failed replacement attempts reverse-order restoration. An interrupted
transaction must be inspected and explicitly restored; repeating initial
installation is not a resume mechanism. Source state or payloads modified
outside the recorded transaction are preserved and reported, not overwritten.

Same-version log presentation takes effect after a normal head-unit restart.
Successful content verification releases the migration marker. Existing
application settings are carried through the manager's install lifecycle;
the old code cache is cleared by the reviewed upstream deploy behavior.

An application's runtime files are checked in `source/`. MainApp's selected
RHMI description, merged strings, images and declared entry points are checked
in the app home's `rhmiData/` and `rhmiDataStartWidget/`. Those resources are
consumed during installation and need not remain in `source/`.

Recovery packages retain the complete kept package's HMI variants and the
actual installed runtime bytes. Preparation checks that the kept HMI resources
reproduce the installed interface and that no required runtime file is missing.
Generated native-module links are recreated by MainApp. A missing UI resource
fails verification even if provisioning still registers the tile as visible.
The owner still confirms that the tile actually opens on the screen.

## Acceptance still required

Offline fake-root and Node 8 tests exercise same-version replacement, settings,
independent recovery bytes including relocated RHMI resources, stale plans,
refusals, process interruption and queue/source locks. A private replay of the
owner's saved Store package and installed files checks the same matcher and
recovery packer. Neither layer emulates proprietary MainApp, recmgr or a real
head unit.

Before enabling an installation release, verify the supported starting
versions on the required HU runtime: management-component update order,
UID/keychain/ACL and data retention, Store visibility, manager stability,
normal reboot, failed-update recovery and the actual CN update channel.
Verify a genuinely newer subsequent release separately. The app's version
label, successful CI and reachable OSS files alone cannot establish this.

Map components retain `robertn_waze_cluster 0.6.7`, `waze-on-cluster 0.9.10`
and `cluster-render 0.5.4`. The migration candidate uses Store `0.9.38`,
updater `0.8.42` and deploy `0.8.17`, including the reviewed upstream changes
through `e883efb`. These are candidate versions without Stable vehicle approval.
Store `0.9.39` is the subsequent online-update candidate; see the two-snapshot
trial in [CN-RELEASE-CHANNELS.md](CN-RELEASE-CHANNELS.md).
Deploy `0.8.16` has a known failed owner trial: its whole-package comparison
rejects relocated RHMI files and its source-only recovery omits interface
resources. It must not be used for a new migration trial.

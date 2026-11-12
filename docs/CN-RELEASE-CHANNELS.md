# CN release channels

The same code and component IDs serve two channels. They do not install two
Stores, and selecting a channel does not change Root access.

| Channel | Catalog root | Audience |
| --- | --- | --- |
| Stable (default) | `https://mgu.walle.pw/mgu/cn/` | Validated installations |
| Beta (explicit opt-in) | `https://mgu.walle.pw/mgu/cn/beta/` | Owner development and vehicle trials |

The updater persists `release_channel` in its private local configuration.
It preserves source IDs and origins while selecting one managed catalog per
repository. Catalog metadata, resource prefixes and cached identities separate
the channels. A Beta catalog cannot satisfy the Stable updater's trial.
Neither channel falls back to GitHub.

## Build once, promote the tested bytes

1. Review upstream changes, dependencies, localization and recovery behavior.
   Build both repositories from fixed commits and pass their source/installer CI.
2. `release/prepare_cn.py --channel beta` creates a complete local candidate,
   including the exact bootstrap, packages, icons, sources and licenses.
   It sets `release_channel: beta` and keeps `installReady: false`.
3. `release/publish_cn.py` validates the exact snapshot and its GitHub CI,
   checks the fixed Hangzhou bucket/domain binding, then prepares an upload
   plan. `--publish` uploads only its chosen channel. Supply the private
   ossutil path/config, one shared maintainer work directory and the exact
   manifest digest via `--expect-snapshot`. This is a maintainer tool.
4. Record owner vehicle results against that exact Beta manifest SHA-256.
   The owner's explicitly chosen real-vehicle trial may replace an unavailable
   emulator. Offline fixtures remain a separate validation layer.
5. `release/promote_cn.py` accepts the Beta directory, a private evidence file
   and a new output directory. The evidence must identify the exact manifest,
   an actual report file, a validation method and passed checks for source
   tests, installation, migration, component update order, restart, settings,
   update-channel access, self-update and rollback.
6. Promotion changes channel/catalog/validation metadata only. Package, icon,
   corresponding-source and bootstrap bytes are retained. The Stable publisher
   independently checks the archived public Beta manifest and identical payloads,
   then verifies the public Stable files. Local promotion is not publication.

The publisher retains immutable candidate manifests under
`candidates/<manifest-sha256>/cn-manifest.json`. Resources use hash/commit paths.
Fixed paths use `no-cache`; immutable resources have a long immutable lifetime.
It uploads and verifies resources before fixed catalogs and commits the root
manifest last. A failed publication attempts to restore prior mutable files;
initial publication without prior files or a concurrent writer needs inspection.
It never deletes objects or changes ACLs. Use one maintainer host/work directory;
the filesystem lock does not coordinate independent publishers on other hosts.

## Owner trial

The initial Beta route is the existing-store **ID7 migration** described in
[CN-MIGRATION.md](CN-MIGRATION.md). Normal `first-install` remains Stable and
refuses a Beta catalog. Beta fresh setup, ID8 and arbitrary downgrades are not
enabled by the channel feature.

The operator selects `migrate-cn --channel beta --from <snapshot> --plan-only`.
Execution additionally binds `--expect-snapshot <manifest-sha256>` and the exact
`--expect-plan <plan-sha256>`. The owner authorizes the trial in the session; a
flag is not a substitute for that authorization, verified current identity,
compatible versions and recovery preparation. These are agent/operator
interfaces, not shell steps to hand an owner.

The transaction saves and restores the prior channel configuration alongside
the old payloads and settings. A normal restart loads a changed channel.
`migration-verify` checks the actual running channel and usable managed
catalogs. It does not certify a later online update or promote a release.

Beta components keep ordinary numeric versions for updater compatibility.
Once published, changed package bytes require a new component version, even
within Beta. The publisher refuses same-version replacement and catalog
downgrades. Beta-to-Stable either uses compatible retained bytes/a newer
Stable version or the verified recovery transaction; it never forces a
downgrade merely to change a label.

## Prepared online-update trial

Keep two complete, independently verified Beta snapshots. The first is the
local migration input; the second is the newer public catalog. After migration
and its local/channel verification succeed, the owner updates through the
Store. A real code change, rather than a fabricated version or modified
same-version archive, supplies the online update.

The RHMI recovery trial uses deploy 0.8.17 and Store 0.9.38 for migration,
then deploy 0.8.18 and Store 0.9.39 for the online update. Deploy 0.8.18 also
refuses a kept recovery package without HMI resources when the installed app
has a UI. The initial trial requires complete kept packages for both apps,
checked against the saved vehicle files before connection.
Store 0.9.39 shows `CN Beta` or
`CN Stable` in Settings from the running updater's reported channel. The
updater and native map components keep the same bytes between
these two snapshots. Both snapshots retain independent hashes and provenance.

Verify the migration transaction before the online update. Once its installed
payloads have been updated, the old transaction is historical and is not a
valid verifier or blind rollback for the new payloads. Use the updater's
supported component rollback for the online update; preserve both the migration
and subsequent-update evidence. Promotion evidence names the final snapshot
and records the tested path from the initial snapshot.

## Maintenance automation

Monitor upstream review, CN adaptation, CI, Beta publication, vehicle evidence,
Stable promotion and public acceptance as separate stages. Official-package
mirrors use the existing maintenance scripts and cannot write either CN channel.
Monitoring does not authorize merging unreviewed code, fabricating vehicle
evidence, promoting Stable automatically or operating a car.

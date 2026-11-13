# CN release channels

The same code and component IDs serve two channels. They do not install two
Stores, and selecting a channel does not change Root access.

| Channel | Catalog root | Audience |
| --- | --- | --- |
| Stable (default) | `https://mgu.walle.pw/mgu/cn/` | Reviewed upstream updates and validated installations |
| Beta (explicit opt-in) | `https://mgu.walle.pw/mgu/cn/beta/` | Owner development and vehicle trials |

The updater persists `release_channel` in its private local configuration.
It preserves source IDs and origins while selecting one managed catalog per
repository. Catalog metadata, resource prefixes and cached identities separate
the channels. A Beta catalog cannot satisfy the Stable updater's trial.
Neither channel falls back to GitHub.

## Build once, promote the tested bytes

Owner release policy: reviewed upstream synchronization and its CN compatibility
adaptations publish the same payloads to both Beta and Stable in one release
operation. Vehicle/emulator results are recorded honestly and are not a gate
for this route. A separately requested development trial publishes only Beta
until the owner requests its wider release.

The upstream route uses `release/promote_cn.py` with exact-candidate evidence:
`method: reviewed-upstream`, passed `source_checks`, `upstream_review` and
`reproducible_build`, the two pinned `upstream_commits`, and an actual private
review report. Stable records `stable-upstream-reviewed`, pending runtime
integration and `fully_vehicle_validated: false`. Both channels still require
exact-commit CI, complete dependencies, immutable versioned packages and public
download verification. Publish Beta first and then Stable from identical bytes;
the two remote manifests cannot be committed atomically.

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
4. For a vehicle-validated release, record owner vehicle results against that exact Beta manifest SHA-256.
   The owner's explicitly chosen real-vehicle trial may replace an unavailable
   emulator. Offline fixtures remain a separate validation layer.
5. The vehicle-validated route of `release/promote_cn.py` accepts the Beta directory, a private evidence file
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

Monitor upstream review, CN adaptation, CI, channel publication, any requested
vehicle trial and public acceptance as separate stages. Reviewed upstream
updates use the owner's dual-channel policy above. Official-package
mirrors use the existing maintenance scripts and cannot write either CN channel.
Monitoring does not authorize merging unreviewed code, fabricating vehicle
evidence or operating a car.

## Explicit owner-reviewed improvements

An owner may explicitly authorize a small improvement for both channels without
a vehicle trial. `owner-reviewed` records that authorization, source checks,
code review and reproducible builds; it never claims vehicle validation.
Exact-commit CI, immutable packages and public verification remain required.

When Beta contains a separate trial, promote only the shared repository and
retain the other repository from an exact current Stable snapshot using
`--stable-base`. The publisher verifies the changed payloads against the public
Beta candidate and every retained catalog and payload against current Stable.
A changed Stable baseline stops publication. This does not promote a Beta-only
trial or replace its packages.

For a shared app added to a repository that also contains a Beta trial, prepare
two source candidates and use `--stable-candidate` with `retained_components`
in the review (repository names mapped to component ID lists). The review binds
both candidate hashes and the current Stable hash. Each selected component must
match current Stable exactly; every other component must match public Beta,
including its artifact, icon, dependencies and release notes. Each candidate
keeps its own source commit and must pass that commit's CI. Bootstrap and
unselected repositories remain identical. This allows the same new app on both
channels without moving a trial into Stable.

A shared fix can update an app that has a separate Beta trial. The owner review
lists `channel_variants` as repository → component ID → `{beta, stable}`, where
each value is `component_digest` of that channel's complete catalog entry.
Both candidates, their exact source commits and the current Stable baseline are
pinned. A variant must already exist, retain its component kind and increase its
Stable version. The publisher checks both entry hashes against public Beta and
the reviewed Stable snapshot, including dependencies and release notes. Other
components either match public Beta or remain exact retained Stable entries.
This publishes a common fix in both app variants while preserving Beta's trial.

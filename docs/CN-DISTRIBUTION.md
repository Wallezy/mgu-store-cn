# MGU CN distribution / 国内发行版

Status: **Beta owner trials and Stable promotion are separate; Stable acceptance is pending**.
状态：**Beta 车主试验与 Stable 晋升分开管理，正式版验收待完成**。

The [migration candidate](CN-MIGRATION.md) provides complete-snapshot planning,
supported ID7 replacements and transaction recovery. It does not establish the
integration approval needed to enable a Stable release. See
[release channels](CN-RELEASE-CHANNELS.md) for explicit Beta admission.

This community distribution is based on `robertnisipeanu/mgu-store` and
`robertnisipeanu/idrive-apps`. Original authorship and licenses remain intact.
It is not an official BMW product or an upstream-endorsed release.

## Channel and identity

The default Stable runtime uses these release catalogs:

- `https://mgu.walle.pw/mgu/cn/mgu-store/catalog.json`
- `https://mgu.walle.pw/mgu/cn/idrive-apps/catalog.json`

Explicit Beta trials use the same paths below `/mgu/cn/beta/`. A channel switch
preserves component/source IDs, with its configuration in the recovery transaction.

These addresses are not installation promises. A catalog becomes usable only
when its complete, validated release and bootstrap are published. The existing
`/mgu/mgu-store/` and `/mgu/idrive-apps/` directories contain unmodified upstream
mirrors; their daily synchronization must never write into `/mgu/cn/`.

The Store and updater retain their component IDs, service names and application
settings. The domestic channel changes the source transport, not the identity
of the installed software. It does not install a second competing updater.
Known official/mirror sources are normalized by the CN updater. Existing GitHub
sources are inactive; compatible HTTPS/local sources remain separate. GitHub
login, tokens and repository browsing are unavailable in the CN runtime.
Recovery data is retained. Ambiguous ownership is refused, not guessed.

国内版保留组件及应用身份，目标是切换发行通道后保持已有应用和设置，不并行安装两套
更新器。来源缓存与通道隔离，不能在国内目录失败时继续使用旧 GitHub 制品链接。
GitHub 来源与账号功能停用，其他 HTTPS/本地来源不自动迁移。
重复身份或无法确认的安装归属必须先解决。GitHub 仍用于源码维护与溯源，
不作为国内版车机的在线下载入口。

## Release procedure

1. Pin the upstream base, review each changed component and stamp its numeric
   version in a scratch checkout. CN versions use the supported three-number
   format; version numbers alone do not protect the update channel.
2. Run component, installer, catalog and reproducibility checks. Build only
   SDK-free artifacts. Retain corresponding sources, licenses and exact hashes.
3. Prepare and publicly verify a Beta candidate with successful source/installer
   CI using the dedicated publisher. The owner may choose real-vehicle trials
   instead of an unavailable emulator. Test only supported operations;
   the initial Beta entrypoint supports existing-store ID7 migration.
   Before Stable approval, test migration from the published upstream release, fresh setup and the
   owner's existing removable-mirror case. Test each changed component first,
   with dependencies brought by the updater, followed by required restart,
   Store tile, service health and another update.
4. Test CN updater self-update with unreachable CN catalog, hash corruption,
   process failure and interrupted startup. Successful unrelated sources must
   not commit an unusable CN updater. Validate return to the prior working
   installation; do not bypass the trial/supervisor mechanism.
5. Record actual integration evidence against the exact Beta manifest and
   source commits. Promote using `release/promote_cn.py`; the report is private
   and the public manifest retains only its validation summary. Unit-test CI
   alone cannot establish it. The separate GitHub Release workflow, if used,
   also requires `release-check/cn-integration` on its exact commit.
6. Publish the promoted bytes with `release/publish_cn.py` to the Stable
   directory; it checks the archived public Beta and does not rebuild.
   Upload and verify immutable assets before the
   catalogs and readiness manifest. Check dependency closure across both repos,
   all runtime URLs, hashes, caching and HTTPS through the public custom domain.
7. Mark the matching Skill release ready only after the public snapshot and
   complete installation/recovery evidence pass. A source commit or fork alone
   never enables the install option.

## Local snapshot preparation

`release/prepare_cn.py` prepares both catalogs together from local release
folders. Each input catalog must use flat local package/icon filenames.
Export both exact catalog commits with `git archive --format=tar.gz`; source
archives retain the commit in their global archive header. Prepare the bootstrap
from the same Store source with `node deploy/installer/bootstrap.js <new-folder>`.

The validation input is a private JSON file with `schema: 1` and
`repositories.mgu-store` / `repositories.idrive-apps`. Each record identifies
`repository`, `commit`, `catalog_sha256`, `source_sha256`, and `integration`
with `context: "release-check/cn-integration"`, `state: "success"`, the same
`sha`, and a nonempty `evidence` reference to completed integration tests.
This is an operator attestation, not a way to create test evidence. The publisher
independently checks exact-commit source/installer CI; Stable also checks
promotion of the publicly recorded Beta payload.

For local integration preparation, use `state: "pending"` and the same exact
commit/hash fields; no evidence reference is needed. The helper preserves that
pending state and never marks the result install-ready. Preparing the resources
needed for testing does not require pretending those tests already passed.

```sh
python3 release/prepare_cn.py \
  --store-dir /path/to/store-release \
  --apps-dir /path/to/apps-release \
  --store-source /path/to/store-source.tar.gz \
  --apps-source /path/to/apps-source.tar.gz \
  --bootstrap-dir /path/to/bootstrap \
  --validation /path/to/private-integration-record.json \
  --output /path/to/new-cn-snapshot
```

The helper verifies package identities/hashes, icons, complete dependencies,
corresponding sources, bootstrap bytes and the shipped updater channel files.
It refuses dependency cycles, SDK bundles and linked application binaries.
It copies no private evidence details into the public manifest. Its output
retains `installReady: false`; the helper does not upload or contact a vehicle.
An independently validated Beta may produce a separate Stable promotion with
`installReady: true`. Public publication/acceptance is still a separate result.

The upstream mirror's `sync_oss.py` does not publish these snapshots. A dedicated
CN upload/acceptance step remains required; do not point the official mirror job
at this prefix or advertise GitHub publication as a successful OSS update.

## Validation matrix still required

| Scenario | Required evidence |
|---|---|
| Fresh installation | Store opens, only one managed row per component, domestic catalogs selected |
| Existing official installation | IDs, versions and settings preserved; no official artifact fallback |
| Existing mirror source with installed owners | Ownership preserved or explicit conflict refused |
| Update order | Store-first and updater-first starting from published upstream |
| CN N to N+1 | Updater and dependencies remain on the CN channel |
| Failed update | Prior process/version works with recoverable source configuration |
| Return to upstream | Verified supported maintenance path, including sources and version handling |
| Public release | Corresponding source, all packages/icons, complete hashes and dependencies |

No integration row is marked complete in this development revision. Local
Node fixtures are useful, but do not replace head-unit validation. The inherited
workspace requirement also calls for the licensed head-unit emulator; that
runtime is not present in this checkout. The owner has explicitly chosen
controlled real-vehicle Beta validation as the alternative; that choice does
not mark any validation row complete.

## Existing users

Do not uninstall the Store or delete origins, aliases, caches, patch originals
or firmware files in preparation. A successful source-normalization unit test
is not a proven migration of a live head unit. Keep the working upstream
maintenance route until a tested CN release is explicitly available.

Beta 必须明确选择并使用固定候选、实际公开验收和受支持的迁移入口；不能把任意
开发包或未发布的 URL 当作可用安装。返回原版不是“卸载全部再安装”的默认操作，
需独立验证其迁移路径。

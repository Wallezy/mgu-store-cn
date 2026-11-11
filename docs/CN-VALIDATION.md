# CN development validation

Date: 2026-11-11. Upstream base:
`fc79a75f07f364c69165dec830f2fa4553ff20e4`.

This record covers source and fixture checks. It is not a vehicle release
approval and does not establish `release-check/cn-integration`.

| Area | Local result |
| --- | --- |
| CN installer transport/bootstrap | 26 checks passed, including GitHub commands, imports, direct downloads and redirect refusal |
| Existing installer compatibility | 96 Linux root checks passed with the migration guard; targeted first-install rerun including the local-override regression passed 41/41 |
| CN snapshot preparation | 19 tests passed, including hashes, icons, source identity, dependency closure/cycles, pending test preparation and private evidence exclusion |
| CN source, identity and network rules | 33 Node 8.16.2 checks passed; six shipped-config checks passed after removing GitHub configuration |
| Updater compatibility | 614 checks passed; certificate/UID suites passed, proxy 41 and web 23 checks passed |
| Phone page | Legacy form tests and CN account/source refusal passed |
| Release destination and exact-commit policy | Passed; wrong repository and missing/failed integration status refused |
| Cross-platform bootstrap | macOS, Linux, Windows x64 and Windows ARM checks passed on source commit `2e918e5`; subsequent installer migration guard has its own checks |
| Store UI | 293 view, 1161 screen, 342 ID7 flow and 415 ID8 flow checks passed; Store 0.9.36 requires updater 0.8.40 |
| Clean reproducible builds | Store 0.9.36, updater 0.8.40 and deploy 0.8.11 each built twice from committed sources with identical bytes |
| Head-unit integration | Not run |
| Public CN OSS snapshot | Not published or accepted |

Commands:

```sh
node deploy/test/cn_installer.js
MGU_TEST_ONLY=testMguInstall,testMguInstallFrom,testMguInstallCoding,testMguInstallUsb,testMguInstallUninstall,testMguInstallStatus,testMguInstallPaths node deploy/test/run.js
python3 -m unittest discover -s release/test -p 'test_*.py' -v
node release/test/cn_distribution_test.js
sh native/mgu-updater/test/run.sh
node release/release.js check mgu-updater robertn_store mgu-deploy
```

Linux fixtures use a generic Docker environment. They do not emulate BMW HMI,
MainApp, system startup or real car hardware. The full updater suite runs on
Node 8.16.2 for compatibility; its test output is distinct from vehicle evidence.

The installer preflight refuses an equal/newer installed updater whose shipped
channel files differ from the verified CN payload, and refuses a conflicting
local channel override. It does not downgrade or rewrite the override. Service
health and a visible tile alone do not establish an active CN channel.

The installer needs a local Node.js 18+ runtime; no standalone executable
runtime is distributed by the CN bootstrap in this revision.

Required remaining integration and release scenarios are listed in
[CN distribution](CN-DISTRIBUTION.md). The project must not expose an install-ready
release or redirect existing mirror clients to this development channel before
those checks pass.

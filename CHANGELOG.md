# Changelog

## [0.21.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.21.0...mandrel-platform-v0.21.1) (2026-07-03)


### Fixed

* **ci:** bump composite-action pins to v0.21.0 — activate require-wrangler + gitleaks-scan (refs [#252](https://github.com/dsj1984/mandrel-platform/issues/252)) ([#257](https://github.com/dsj1984/mandrel-platform/issues/257)) ([eb0fe4d](https://github.com/dsj1984/mandrel-platform/commit/eb0fe4d91e3fed9c61a38c58007dd58825d33bf5))
* **release:** add force_publish recovery lever for interrupted npm publish ([#255](https://github.com/dsj1984/mandrel-platform/issues/255)) ([5f25f20](https://github.com/dsj1984/mandrel-platform/commit/5f25f200b144eb332401d0eeb32de8f40240ad4f))

## [0.21.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.20.1...mandrel-platform-v0.21.0) (2026-07-03)


### Added

* **ci:** add a runner input to deploy-cloudflare.yml and release-automation.yml (refs [#222](https://github.com/dsj1984/mandrel-platform/issues/222)) ([#224](https://github.com/dsj1984/mandrel-platform/issues/224)) ([3f28d8e](https://github.com/dsj1984/mandrel-platform/commit/3f28d8e7dc924b973362782a3d39943f87331149))
* **ci:** dogfood — run the platform's own secret scan and security tier on itself (refs [#236](https://github.com/dsj1984/mandrel-platform/issues/236)) ([#250](https://github.com/dsj1984/mandrel-platform/issues/250)) ([931a1f5](https://github.com/dsj1984/mandrel-platform/commit/931a1f52d522b2c00a0f20887ac1f091848fa449))
* **ci:** opt-in fail-fast for pr-quality.yml — cancel the run on first tier failure (refs [#223](https://github.com/dsj1984/mandrel-platform/issues/223)) ([#245](https://github.com/dsj1984/mandrel-platform/issues/245)) ([6bff2f3](https://github.com/dsj1984/mandrel-platform/commit/6bff2f33b3c89b9a692b921ed08bd3ad427ce997))
* **ci:** single-source the pinned-gitleaks installer as a composite action ([#229](https://github.com/dsj1984/mandrel-platform/issues/229)) ([#251](https://github.com/dsj1984/mandrel-platform/issues/251)) ([f5cddc4](https://github.com/dsj1984/mandrel-platform/commit/f5cddc4bb5c880d72e9ec4fa0beda227aa0e2f45))
* **runner:** ship generalized runner-scoped hygiene kit + provisioning runbook (refs [#226](https://github.com/dsj1984/mandrel-platform/issues/226)) ([#242](https://github.com/dsj1984/mandrel-platform/issues/242)) ([1f3c07d](https://github.com/dsj1984/mandrel-platform/commit/1f3c07dedaa7e57c29313d9c4d5023d27a7ad7d7))


### Fixed

* **ci:** make the ci-required aggregators toJSON(needs)-driven (refs [#234](https://github.com/dsj1984/mandrel-platform/issues/234)) ([#241](https://github.com/dsj1984/mandrel-platform/issues/241)) ([06199a2](https://github.com/dsj1984/mandrel-platform/commit/06199a25dd6a6fbe78879375fb7f1db69cfccaaf))
* **deploy:** add timeout-minutes to every deploy-cloudflare job (refs [#232](https://github.com/dsj1984/mandrel-platform/issues/232)) ([#243](https://github.com/dsj1984/mandrel-platform/issues/243)) ([e2ad35e](https://github.com/dsj1984/mandrel-platform/commit/e2ad35e9078e9a3d94e31abab0643fcfe373c517))
* **deploy:** pin worker-secrets step to lockfile wrangler via pnpm exec (refs [#228](https://github.com/dsj1984/mandrel-platform/issues/228)) ([#239](https://github.com/dsj1984/mandrel-platform/issues/239)) ([7c8dc61](https://github.com/dsj1984/mandrel-platform/commit/7c8dc61ae8817af053c4b1a1d446295351a0c487))
* **release:** remove the dead package-name input from release-automation.yml (refs [#233](https://github.com/dsj1984/mandrel-platform/issues/233)) ([#240](https://github.com/dsj1984/mandrel-platform/issues/240)) ([71de87e](https://github.com/dsj1984/mandrel-platform/commit/71de87e609f30cc226ec59ad1a0b8125552ae3e4))


### Changed

* **ci:** pr-quality gates run the platform's tested scripts via job_workflow_sha side-checkout (refs [#230](https://github.com/dsj1984/mandrel-platform/issues/230)) ([#247](https://github.com/dsj1984/mandrel-platform/issues/247)) ([0417fb9](https://github.com/dsj1984/mandrel-platform/commit/0417fb920203f6eb6602487b90b46f4dc32e3e6d))
* **ci:** pr-quality interface simplification — derive shard count, dedupe the tier preamble (refs [#235](https://github.com/dsj1984/mandrel-platform/issues/235)) ([#248](https://github.com/dsj1984/mandrel-platform/issues/248)) ([6cfb145](https://github.com/dsj1984/mandrel-platform/commit/6cfb14554da06b0626bdf0fc0b90d5076d2007e1))
* **deploy:** extract deploy-cloudflare inline bash into versioned scripts; fold the wrangler preflight into setup-toolchain ([#231](https://github.com/dsj1984/mandrel-platform/issues/231)) ([#249](https://github.com/dsj1984/mandrel-platform/issues/249)) ([96a2320](https://github.com/dsj1984/mandrel-platform/commit/96a2320254fd02c0f8fd88ac60e215f7982dff07))
* **deploy:** slim the deploy-cloudflare job topology (refs [#237](https://github.com/dsj1984/mandrel-platform/issues/237)) ([#246](https://github.com/dsj1984/mandrel-platform/issues/246)) ([d6e1cc3](https://github.com/dsj1984/mandrel-platform/commit/d6e1cc388341d67f0765fe0ddae7b46762a37857))

## [0.20.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.20.0...mandrel-platform-v0.20.1) (2026-07-03)


### Fixed

* **ci:** route pr-quality ci-required aggregator to inputs.runner ([#220](https://github.com/dsj1984/mandrel-platform/issues/220)) ([7e3e196](https://github.com/dsj1984/mandrel-platform/commit/7e3e196e050d8283f455677ffb60a0491008da7d))

## [0.20.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.19.2...mandrel-platform-v0.20.0) (2026-07-02)


### Added

* **config:** ship a shared secretlint base (refs [#214](https://github.com/dsj1984/mandrel-platform/issues/214)) ([#217](https://github.com/dsj1984/mandrel-platform/issues/217)) ([aeb2188](https://github.com/dsj1984/mandrel-platform/commit/aeb2188308a5b857c1575c2a95e4830492d568eb))
* **config:** ship markdownlint.base.jsonc + standardize the fleet on markdownlint-cli2 (refs [#216](https://github.com/dsj1984/mandrel-platform/issues/216)) ([#219](https://github.com/dsj1984/mandrel-platform/issues/219)) ([c823de9](https://github.com/dsj1984/mandrel-platform/commit/c823de98cf5d33c2894ebb4928a5d787faf088f7))

## [0.19.2](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.19.1...mandrel-platform-v0.19.2) (2026-07-02)


### Fixed

* **deploy:** let the environments-isolation-audit use a PAT (audit-token) ([#213](https://github.com/dsj1984/mandrel-platform/issues/213)) ([fc2613c](https://github.com/dsj1984/mandrel-platform/commit/fc2613c52482a80d98800e74b5fc068289ed0082))

## [0.19.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.19.0...mandrel-platform-v0.19.1) (2026-07-02)


### Fixed

* restore push-to-main CI + staging deploys (SAST push-scoping + isolation-audit pin) ([#211](https://github.com/dsj1984/mandrel-platform/issues/211)) ([b519c85](https://github.com/dsj1984/mandrel-platform/commit/b519c85440395a042d69610e1071d48a9564f194))

## [0.19.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.18.0...mandrel-platform-v0.19.0) (2026-07-02)


### Added

* **deploy:** provision worker secrets in-pipeline via versions secret API (refs [#170](https://github.com/dsj1984/mandrel-platform/issues/170)) ([#208](https://github.com/dsj1984/mandrel-platform/issues/208)) ([3039227](https://github.com/dsj1984/mandrel-platform/commit/30392277f1623acc9bd32aa71d80496385a1e0db))
* Epic [#189](https://github.com/dsj1984/mandrel-platform/issues/189) ([#210](https://github.com/dsj1984/mandrel-platform/issues/210)) ([f832141](https://github.com/dsj1984/mandrel-platform/commit/f83214145e7092d671b37e1267db9a02ada5fd1e))

## [0.18.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.17.2...mandrel-platform-v0.18.0) (2026-07-02)


### Added

* **config:** check-ruleset.mjs — live branch-ruleset drift detection against the main-protection contract (refs [#178](https://github.com/dsj1984/mandrel-platform/issues/178)) ([#187](https://github.com/dsj1984/mandrel-platform/issues/187)) ([a11938d](https://github.com/dsj1984/mandrel-platform/commit/a11938d47c465f969bb1e9a599bda99e627a2a88))
* **config:** check-wrangler-baseline.mjs — enforce env split, logpush, Analytics Engine, compatibility_date policy ([#177](https://github.com/dsj1984/mandrel-platform/issues/177)) ([#204](https://github.com/dsj1984/mandrel-platform/issues/204)) ([c1d0ca7](https://github.com/dsj1984/mandrel-platform/commit/c1d0ca75b26075614d31648a6f1740d700cfde26))
* **config:** repo-settings baseline contract + GitHub-side check/apply in platform-sync ([#171](https://github.com/dsj1984/mandrel-platform/issues/171)) ([#184](https://github.com/dsj1984/mandrel-platform/issues/184)) ([511d154](https://github.com/dsj1984/mandrel-platform/commit/511d154d7c7309dd81e3b5a6879a9c8729587cd0))
* **config:** ship commitlint.base.mjs — single-source the conventional-commit type-enum ([#179](https://github.com/dsj1984/mandrel-platform/issues/179)) ([#186](https://github.com/dsj1984/mandrel-platform/issues/186)) ([587fc13](https://github.com/dsj1984/mandrel-platform/commit/587fc133715fd05274b315ed668009f4d0679bb0))
* **deploy:** opt-in verify-commit-sha — boot-smoke asserts the deployed SHA (refs [#176](https://github.com/dsj1984/mandrel-platform/issues/176)) ([#188](https://github.com/dsj1984/mandrel-platform/issues/188)) ([6de1311](https://github.com/dsj1984/mandrel-platform/commit/6de131181099144c7dbbd6a49224b15c5a01b87f))
* **deploy:** own the CI-green gate in deploy-cloudflare.yml (refs [#175](https://github.com/dsj1984/mandrel-platform/issues/175)) ([#181](https://github.com/dsj1984/mandrel-platform/issues/181)) ([ba82e8f](https://github.com/dsj1984/mandrel-platform/commit/ba82e8f1d0e49858a8fd88a7e00dca75289a504c))
* **environments:** deployment branch-policy guidance + shared Environments isolation-audit unit ([#172](https://github.com/dsj1984/mandrel-platform/issues/172)) ([#185](https://github.com/dsj1984/mandrel-platform/issues/185)) ([57ae0b2](https://github.com/dsj1984/mandrel-platform/commit/57ae0b24c3d5ffd59bf93d11e52d6bb595d75450))
* **release:** harden release-automation contract docs and token preflight ([#205](https://github.com/dsj1984/mandrel-platform/issues/205)) ([c3bcf94](https://github.com/dsj1984/mandrel-platform/commit/c3bcf9487a1c1ef85e06dcc469fd6d7e2e26fb62))
* **uptime:** reusable uptime-apply.yml + shared Better Stack monitor schema/apply unit ([#180](https://github.com/dsj1984/mandrel-platform/issues/180)) ([#207](https://github.com/dsj1984/mandrel-platform/issues/207)) ([ce814a2](https://github.com/dsj1984/mandrel-platform/commit/ce814a2049ca227502443dc9c2c2326ed56f83fb))


### Fixed

* **ci:** move release-token preflight check out of step-level if ([#206](https://github.com/dsj1984/mandrel-platform/issues/206)) ([a810ef8](https://github.com/dsj1984/mandrel-platform/commit/a810ef877bf512af0880277b5e86c4b62f261505))

## [0.17.2](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.17.1...mandrel-platform-v0.17.2) (2026-07-01)


### Fixed

* **deploy:** scan secrets via event-agnostic gitleaks CLI so workflow_run callers work ([#167](https://github.com/dsj1984/mandrel-platform/issues/167)) ([ff175a2](https://github.com/dsj1984/mandrel-platform/commit/ff175a231d6962de3b2e44d2f9b348a2d78ee448))

## [0.17.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.17.0...mandrel-platform-v0.17.1) (2026-07-01)


### Fixed

* **ci:** bump pr-quality.yml internal setup-toolchain pin to v0.17.0 so trust-lockfile takes effect ([#164](https://github.com/dsj1984/mandrel-platform/issues/164)) ([e642540](https://github.com/dsj1984/mandrel-platform/commit/e64254050f38a2bf8f3e4a8e853f67468ff81c49))
* **ci:** pr-quality.yml coverage gate discovers coverage-summary.json at any depth (refs [#163](https://github.com/dsj1984/mandrel-platform/issues/163)) ([#166](https://github.com/dsj1984/mandrel-platform/issues/166)) ([3633c18](https://github.com/dsj1984/mandrel-platform/commit/3633c180808328ba61a9e631564e7e4ca83eb5c1))

## [0.17.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.16.0...mandrel-platform-v0.17.0) (2026-07-01)


### Added

* **baselines:** one-shot BUNDLE_SIZE_REFRESH acknowledge for bundle-size ratchet ([#156](https://github.com/dsj1984/mandrel-platform/issues/156)) ([a67dfe7](https://github.com/dsj1984/mandrel-platform/commit/a67dfe7dd5160de02604c155c308c765329cec1f)), closes [#151](https://github.com/dsj1984/mandrel-platform/issues/151)
* **config:** ship mechanism-neutral lighthouse-thresholds.base.json for puppeteer baseline-drift consumers (refs [#157](https://github.com/dsj1984/mandrel-platform/issues/157)) ([#159](https://github.com/dsj1984/mandrel-platform/issues/159)) ([4832cae](https://github.com/dsj1984/mandrel-platform/commit/4832cae6769bd11bed2a4dfac52cfab5d726a42d))


### Fixed

* **ci:** findCoverageSummaries discovers per-workspace coverage dirs (refs [#158](https://github.com/dsj1984/mandrel-platform/issues/158)) ([#160](https://github.com/dsj1984/mandrel-platform/issues/160)) ([da31772](https://github.com/dsj1984/mandrel-platform/commit/da31772b796f66b4d325fbcbb94b1c86a1484ad3))
* **config:** reauthor biome.base.json to the Biome v2 schema (refs [#153](https://github.com/dsj1984/mandrel-platform/issues/153)) ([#154](https://github.com/dsj1984/mandrel-platform/issues/154)) ([c983449](https://github.com/dsj1984/mandrel-platform/commit/c9834492b5d168e2f040bc300e41a7de78859b49))

## [0.16.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.15.1...mandrel-platform-v0.16.0) (2026-07-01)


### Added

* **ci:** trust-lockfile passthrough for setup-toolchain / pr-quality.yml ([#150](https://github.com/dsj1984/mandrel-platform/issues/150)) ([d50afe9](https://github.com/dsj1984/mandrel-platform/commit/d50afe9147eb60c16cc32c5524b0d63ed6b3d3d4))
* **security:** per-finding suppression/allow-list for osv-scan (refs [#145](https://github.com/dsj1984/mandrel-platform/issues/145)) ([#147](https://github.com/dsj1984/mandrel-platform/issues/147)) ([787d610](https://github.com/dsj1984/mandrel-platform/commit/787d610acf4584a83bf95d9c9a6cd59ad81d912d))

## [0.15.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.15.0...mandrel-platform-v0.15.1) (2026-06-30)


### Fixed

* **ci:** replace bash4+ mapfile with portable read loop in migration-guard (refs [#142](https://github.com/dsj1984/mandrel-platform/issues/142)) ([#143](https://github.com/dsj1984/mandrel-platform/issues/143)) ([67de46d](https://github.com/dsj1984/mandrel-platform/commit/67de46db7f7d26e34aecd554c066ed573b09f039))

## [0.15.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.14.2...mandrel-platform-v0.15.0) (2026-06-30)


### Added

* **security:** canonical pnpm supply-chain config for the fleet (refs [#133](https://github.com/dsj1984/mandrel-platform/issues/133)) ([#138](https://github.com/dsj1984/mandrel-platform/issues/138)) ([74d2080](https://github.com/dsj1984/mandrel-platform/commit/74d2080c89cd2f0348b9542fc96a75bbffd57201))
* **security:** pin/vendor the Semgrep SAST ruleset (refs [#132](https://github.com/dsj1984/mandrel-platform/issues/132)) ([#140](https://github.com/dsj1984/mandrel-platform/issues/140)) ([ff4f995](https://github.com/dsj1984/mandrel-platform/commit/ff4f99515a53a8b79ffed0f203c0a934a8fc52dd))

## [0.14.2](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.14.1...mandrel-platform-v0.14.2) (2026-06-30)


### Fixed

* **release:** add repository/homepage/bugs to package.json for provenance ([#136](https://github.com/dsj1984/mandrel-platform/issues/136)) ([965239e](https://github.com/dsj1984/mandrel-platform/commit/965239e28540c850988a54f1480b26a5d63e68bf))

## [0.14.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.14.0...mandrel-platform-v0.14.1) (2026-06-30)


### Fixed

* **release:** drop setup-node registry-url so OIDC trusted publishing works ([#134](https://github.com/dsj1984/mandrel-platform/issues/134)) ([eb08bb5](https://github.com/dsj1984/mandrel-platform/commit/eb08bb588379e1416c47e84f311e3ddb634c7f81))

## [0.14.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.13.0...mandrel-platform-v0.14.0) (2026-06-30)


### Added

* **ci:** action-pin ratchet + harden-runner egress audit in shared workflows (refs [#112](https://github.com/dsj1984/mandrel-platform/issues/112)) ([#130](https://github.com/dsj1984/mandrel-platform/issues/130)) ([2726753](https://github.com/dsj1984/mandrel-platform/commit/2726753ea610c2dc73aae6bc7e3229843a4fde70))
* **ci:** couple npm config-package version to workflow uses: pin with minimumReleaseAge awareness (refs [#107](https://github.com/dsj1984/mandrel-platform/issues/107)) ([#122](https://github.com/dsj1984/mandrel-platform/issues/122)) ([0558c4a](https://github.com/dsj1984/mandrel-platform/commit/0558c4acc88d164615879c97c96e674418940037))
* **ci:** lint stale platform-ref pin literals beyond uses: lines (refs [#110](https://github.com/dsj1984/mandrel-platform/issues/110)) ([#127](https://github.com/dsj1984/mandrel-platform/issues/127)) ([abbf023](https://github.com/dsj1984/mandrel-platform/commit/abbf02347e66efdb2fa3e253c174ffe60836ca6b))
* **ci:** optional coverage-threshold gate in pr-quality.yml ([#109](https://github.com/dsj1984/mandrel-platform/issues/109)) ([#125](https://github.com/dsj1984/mandrel-platform/issues/125)) ([75aa291](https://github.com/dsj1984/mandrel-platform/commit/75aa2913f06d0538c30fc7e16d056f0bea59519d))
* **ci:** platformize the destructive-migration label guard as a reusable unit (refs [#111](https://github.com/dsj1984/mandrel-platform/issues/111)) ([#129](https://github.com/dsj1984/mandrel-platform/issues/129)) ([3a435a6](https://github.com/dsj1984/mandrel-platform/commit/3a435a678237cc4fce281e04b8403be206b0829c))
* **ci:** scheduled platform-sync repair-PR loop (close detect→repair) (refs [#113](https://github.com/dsj1984/mandrel-platform/issues/113)) ([#126](https://github.com/dsj1984/mandrel-platform/issues/126)) ([5f2a4cb](https://github.com/dsj1984/mandrel-platform/commit/5f2a4cb83fc0be4cffea8b53ab4c89aee15a521b))
* **config:** ship shared code-quality tooling base configs (refs [#115](https://github.com/dsj1984/mandrel-platform/issues/115)) ([#118](https://github.com/dsj1984/mandrel-platform/issues/118)) ([4de2046](https://github.com/dsj1984/mandrel-platform/commit/4de204678e8a336aa80c8cb582b7a2bbd1021553))
* **release:** add reusable consumer release-automation workflow (refs [#117](https://github.com/dsj1984/mandrel-platform/issues/117)) ([#124](https://github.com/dsj1984/mandrel-platform/issues/124)) ([72d1cc1](https://github.com/dsj1984/mandrel-platform/commit/72d1cc1b44b403930283b3d92ee61008ac4ddaf8))
* **release:** npm provenance + OIDC trusted publishing (refs [#106](https://github.com/dsj1984/mandrel-platform/issues/106)) ([#120](https://github.com/dsj1984/mandrel-platform/issues/120)) ([e85b998](https://github.com/dsj1984/mandrel-platform/commit/e85b9985cd0d74032a8f4949371f906166155f93))
* **security:** add OSV-scanner advisory tier to pr-quality.yml (refs [#114](https://github.com/dsj1984/mandrel-platform/issues/114)) ([#131](https://github.com/dsj1984/mandrel-platform/issues/131)) ([163a021](https://github.com/dsj1984/mandrel-platform/commit/163a0211691f1a6b585d1908f63c82fabc22009b))
* **security:** reusable edge-security middleware units (refs [#116](https://github.com/dsj1984/mandrel-platform/issues/116)) ([#123](https://github.com/dsj1984/mandrel-platform/issues/123)) ([c63b608](https://github.com/dsj1984/mandrel-platform/commit/c63b608ea8bb1af22d3e684d1751b09997803e6f))

## [0.13.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.12.0...mandrel-platform-v0.13.0) (2026-06-30)


### Added

* **security:** add reusable secret-scan-push.yml full-history scan (refs [#103](https://github.com/dsj1984/mandrel-platform/issues/103)) ([#104](https://github.com/dsj1984/mandrel-platform/issues/104)) ([dcfaaf1](https://github.com/dsj1984/mandrel-platform/commit/dcfaaf16aae9425b2cc4c3a8c63accfca5a00675))

## [0.12.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.7...mandrel-platform-v0.12.0) (2026-06-30)


### Added

* **pin-drift:** detect npm-package lag and surface skew, not just uses: pins ([#100](https://github.com/dsj1984/mandrel-platform/issues/100)) ([e985780](https://github.com/dsj1984/mandrel-platform/commit/e985780e70f2b3c2aebde9e7c8d9db83456f724a))

## [0.11.7](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.6...mandrel-platform-v0.11.7) (2026-06-30)


### Fixed

* **security:** make SAST Semgrep pip fallback hermetic via ephemeral venv (refs [#92](https://github.com/dsj1984/mandrel-platform/issues/92)) ([#97](https://github.com/dsj1984/mandrel-platform/issues/97)) ([fe69815](https://github.com/dsj1984/mandrel-platform/commit/fe6981596b8214eec2b066bc1962558fd83d08e9))

## [0.11.6](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.5...mandrel-platform-v0.11.6) (2026-06-30)


### Fixed

* **security:** exclude vendored .agents/ from the shared SAST (refs [#93](https://github.com/dsj1984/mandrel-platform/issues/93)) ([#94](https://github.com/dsj1984/mandrel-platform/issues/94)) ([53f76eb](https://github.com/dsj1984/mandrel-platform/commit/53f76eb98318c0ded84d8746882096e6c8c625d9))

## [0.11.5](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.4...mandrel-platform-v0.11.5) (2026-06-29)


### Fixed

* **security:** install Semgrep against system python3 for self-hosted SAST (refs [#85](https://github.com/dsj1984/mandrel-platform/issues/85)) ([#90](https://github.com/dsj1984/mandrel-platform/issues/90)) ([1a60e42](https://github.com/dsj1984/mandrel-platform/commit/1a60e42c681c9758439bb6beda2a3d7e655ebbba))

## [0.11.4](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.3...mandrel-platform-v0.11.4) (2026-06-29)


### Fixed

* **security:** scope Semgrep SAST to the PR diff on pull_request (refs [#87](https://github.com/dsj1984/mandrel-platform/issues/87)) ([#88](https://github.com/dsj1984/mandrel-platform/issues/88)) ([d85ae20](https://github.com/dsj1984/mandrel-platform/commit/d85ae207ce66732e6a2cc1532695d687f69751cc))

## [0.11.3](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.2...mandrel-platform-v0.11.3) (2026-06-29)


### Fixed

* **security:** default Semgrep SAST to p/default (p/ci was too narrow) ([#80](https://github.com/dsj1984/mandrel-platform/issues/80)) ([e28ab07](https://github.com/dsj1984/mandrel-platform/commit/e28ab072614726a8deb215f39e7a7a661987e970))
* **security:** replace bash-4 declare -A with bash-3.2-compatible case statement (refs [#82](https://github.com/dsj1984/mandrel-platform/issues/82)) ([#84](https://github.com/dsj1984/mandrel-platform/issues/84)) ([d8aca8c](https://github.com/dsj1984/mandrel-platform/commit/d8aca8c084708db717be49c21312daf7ca158ad5))

## [0.11.2](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.1...mandrel-platform-v0.11.2) (2026-06-29)


### Fixed

* **security:** run Semgrep on Python 3.11 + install setuptools (pkg_resources) ([#78](https://github.com/dsj1984/mandrel-platform/issues/78)) ([d120e47](https://github.com/dsj1984/mandrel-platform/commit/d120e47a6b9e4bdcce1aa8f69805aeddf85b2046))

## [0.11.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.11.0...mandrel-platform-v0.11.1) (2026-06-29)


### Fixed

* **security:** install Semgrep from PyPI and use a metrics-off-compatible ruleset ([#76](https://github.com/dsj1984/mandrel-platform/issues/76)) ([a0f681b](https://github.com/dsj1984/mandrel-platform/commit/a0f681b48c36117f9066705c532956af9745b99e))

## [0.11.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.10.0...mandrel-platform-v0.11.0) (2026-06-29)


### Added

* **ci:** cross-consumer pin-drift dashboard (MP-12) ([#67](https://github.com/dsj1984/mandrel-platform/issues/67)) ([#73](https://github.com/dsj1984/mandrel-platform/issues/73)) ([a2d1251](https://github.com/dsj1984/mandrel-platform/commit/a2d12513c2b8ccf60d4e28dbd9b440ce9831b2e3))
* **cli:** add platform-sync adoption/drift-repair CLI (refs [#69](https://github.com/dsj1984/mandrel-platform/issues/69)) ([#75](https://github.com/dsj1984/mandrel-platform/issues/75)) ([cba63d4](https://github.com/dsj1984/mandrel-platform/commit/cba63d480d0854ea77355c11644f55d3f03c2a19))
* **renovate:** auto-bump consumer mandrel-platform uses: pins (refs [#66](https://github.com/dsj1984/mandrel-platform/issues/66)) ([#71](https://github.com/dsj1984/mandrel-platform/issues/71)) ([14490be](https://github.com/dsj1984/mandrel-platform/commit/14490be505e8dbab5a9aeb704d497664e7da5f3e))
* **security:** add private-repo-capable security tier to shared pr-quality workflow (refs [#65](https://github.com/dsj1984/mandrel-platform/issues/65)) ([#74](https://github.com/dsj1984/mandrel-platform/issues/74)) ([1789d28](https://github.com/dsj1984/mandrel-platform/commit/1789d2899900a06882d1c8ac68e07d7ac3934fef))

## [0.10.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.9.0...mandrel-platform-v0.10.0) (2026-06-29)


### Added

* **deploy:** freeze deploy-cloudflare secret allowlist at {CLOUDFLARE_*, TURSO_*} (refs [#61](https://github.com/dsj1984/mandrel-platform/issues/61)) ([#62](https://github.com/dsj1984/mandrel-platform/issues/62)) ([e20e576](https://github.com/dsj1984/mandrel-platform/commit/e20e5765216804dcde6627be58ee3ebc23e119c3))

## [0.9.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.8.0...mandrel-platform-v0.9.0) (2026-06-29)


### Added

* **deploy:** add build-artifact handoff to deploy-cloudflare (refs [#56](https://github.com/dsj1984/mandrel-platform/issues/56)) ([#59](https://github.com/dsj1984/mandrel-platform/issues/59)) ([c4e8fd6](https://github.com/dsj1984/mandrel-platform/commit/c4e8fd67debdba6a29ee2d39396adc40718846b3))

## [0.8.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.7.0...mandrel-platform-v0.8.0) (2026-06-29)


### Added

* **deploy:** add SENTRY_PROJECT/SENTRY_ORG/PUBLIC_SENTRY_DSN/SITE_URL secret passthrough (refs [#55](https://github.com/dsj1984/mandrel-platform/issues/55)) ([#57](https://github.com/dsj1984/mandrel-platform/issues/57)) ([b8e600c](https://github.com/dsj1984/mandrel-platform/commit/b8e600c3adfa463b5fe0677fbfd74aac6ab87912))

## [0.7.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.6.0...mandrel-platform-v0.7.0) (2026-06-29)


### Added

* **deploy:** add gh-environment input so Environment-scoped secrets resolve (refs [#51](https://github.com/dsj1984/mandrel-platform/issues/51)) ([#53](https://github.com/dsj1984/mandrel-platform/issues/53)) ([1016934](https://github.com/dsj1984/mandrel-platform/commit/1016934cbd8803dc32ee2a55124f178c687597bd))

## [0.6.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.5.1...mandrel-platform-v0.6.0) (2026-06-29)


### Added

* **ci:** wire cross-repo smoke — dispatch on push + gate release publish (refs [#38](https://github.com/dsj1984/mandrel-platform/issues/38)) ([ea0d791](https://github.com/dsj1984/mandrel-platform/commit/ea0d7911b195c14505cddb1be437d8dc430453d4))


### Fixed

* **ci:** trigger smoke via workflow_dispatch, not repository_dispatch (refs [#38](https://github.com/dsj1984/mandrel-platform/issues/38)) ([6328f69](https://github.com/dsj1984/mandrel-platform/commit/6328f69005d039ac0dab6f891fdf09e03bd630b5))
* **ci:** use built-in token for smoke pending status; PAT only for cross-repo dispatch (refs [#38](https://github.com/dsj1984/mandrel-platform/issues/38)) ([53a1d6b](https://github.com/dsj1984/mandrel-platform/commit/53a1d6bd66c19694c94d68eee8fac3f30abd4072))

## [0.5.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.5.0...mandrel-platform-v0.5.1) (2026-06-29)


### Fixed

* **deploy:** correct invalid gitleaks-action pin to real v2.3.9 SHA (Closes [#49](https://github.com/dsj1984/mandrel-platform/issues/49)) ([4532ff7](https://github.com/dsj1984/mandrel-platform/commit/4532ff7ff9096d2b3849689d4daf52c5c2e85dfa))

## [0.5.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.4.0...mandrel-platform-v0.5.0) (2026-06-29)


### Added

* **deploy:** add deploy-command seam + named secret passthrough (refs [#46](https://github.com/dsj1984/mandrel-platform/issues/46)) ([#47](https://github.com/dsj1984/mandrel-platform/issues/47)) ([20f29fb](https://github.com/dsj1984/mandrel-platform/commit/20f29fbc75a439a3bd6f9cd1e2fe458f90fc1a2c))

## [0.4.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.3.1...mandrel-platform-v0.4.0) (2026-06-29)


### Added

* **ci:** add live cross-repo reusable-workflow smoke test ([b95e088](https://github.com/dsj1984/mandrel-platform/commit/b95e088d3f324d525e60fc9fb3c610d58c4ecdce))


### Fixed

* **deploy:** add command seams to deploy-cloudflare.yml + fix boot-smoke URL (refs [#41](https://github.com/dsj1984/mandrel-platform/issues/41)) ([#44](https://github.com/dsj1984/mandrel-platform/issues/44)) ([c54b0d3](https://github.com/dsj1984/mandrel-platform/commit/c54b0d34eb86b2f241ff7cee0ce91d9a436d319b))

## [0.3.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.3.0...mandrel-platform-v0.3.1) (2026-06-29)


### Fixed

* **ci:** bump setup-toolchain pin off stale 519a337; guard internal pin lag ([d993b4f](https://github.com/dsj1984/mandrel-platform/commit/d993b4fc2d20c273e56df1b1ea2c6b941d5c6ca5))

## [0.3.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.5...mandrel-platform-v0.3.0) (2026-06-29)


### Added

* **ci:** add cross-repo workflow portability lint ([d00ba73](https://github.com/dsj1984/mandrel-platform/commit/d00ba739c103dbb2b8589479ed0a19ddf49b0899))

## [0.2.5](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.4...mandrel-platform-v0.2.5) (2026-06-29)


### Fixed

* **ci:** strip ${{ }} expressions from pnpm-dest input descriptions ([39fa8a4](https://github.com/dsj1984/mandrel-platform/commit/39fa8a43dc42dbca2bd3b87640ceee04c19b3ef7))

## [0.2.4](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.3...mandrel-platform-v0.2.4) (2026-06-29)


### Fixed

* **ci:** revert relative uses: path in pr-quality.yml to absolute cross-repo SHA ([85f77d3](https://github.com/dsj1984/mandrel-platform/commit/85f77d37c3eee5f5e3b3cab8cc3db34ed7a30cbd))

## [0.2.3](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.2...mandrel-platform-v0.2.3) (2026-06-29)


### Fixed

* **actions:** correct pnpm-dest default handling and resolve self-referential SHA ([8c13425](https://github.com/dsj1984/mandrel-platform/commit/8c13425ce18508980a553db96ba175dd168b74ba))

## [0.2.2](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.1...mandrel-platform-v0.2.2) (2026-06-29)


### Fixed

* **actions:** setup-toolchain incompatible with self-hosted runners (cache: false + git-clean path) ([#25](https://github.com/dsj1984/mandrel-platform/issues/25)) ([#26](https://github.com/dsj1984/mandrel-platform/issues/26)) ([c5647e7](https://github.com/dsj1984/mandrel-platform/commit/c5647e7bc23c5eb8d0af62f5a84821d9f6cd8511))

## [0.2.1](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.2.0...mandrel-platform-v0.2.1) (2026-06-28)


### Fixed

* **release:** drop install step from npm-publish job ([1104767](https://github.com/dsj1984/mandrel-platform/commit/1104767b8e81e8e80dc0e15be72ea811485efe66))

## [0.2.0](https://github.com/dsj1984/mandrel-platform/compare/mandrel-platform-v0.1.0...mandrel-platform-v0.2.0) (2026-06-28)


### Added

* **actions:** add shared setup-toolchain composite action (refs [#3](https://github.com/dsj1984/mandrel-platform/issues/3)) ([#13](https://github.com/dsj1984/mandrel-platform/issues/13)) ([9d93101](https://github.com/dsj1984/mandrel-platform/commit/9d9310176dbef2e15c31dec050300a40f5b63217))
* **ci:** add main-protection contract + required-context lint (refs [#9](https://github.com/dsj1984/mandrel-platform/issues/9)) ([#20](https://github.com/dsj1984/mandrel-platform/issues/20)) ([4313a8a](https://github.com/dsj1984/mandrel-platform/commit/4313a8a8711bbe4cbe2a20ce2f3a0a1a07297bde))
* **ci:** add reusable pr-quality workflow_call (refs [#4](https://github.com/dsj1984/mandrel-platform/issues/4)) ([#18](https://github.com/dsj1984/mandrel-platform/issues/18)) ([11c88b4](https://github.com/dsj1984/mandrel-platform/commit/11c88b428860987e796582fd5f354702da8e40b9))
* **config:** publish shared tsconfig/biome base + CVE-gate via npm package ([#15](https://github.com/dsj1984/mandrel-platform/issues/15)) ([17868b8](https://github.com/dsj1984/mandrel-platform/commit/17868b84fa1491e506172bac8426737b0cf99092))
* **deploy:** add reusable deploy-cloudflare workflow_call with defence-in-depth (refs [#5](https://github.com/dsj1984/mandrel-platform/issues/5)) ([#17](https://github.com/dsj1984/mandrel-platform/issues/17)) ([da93a89](https://github.com/dsj1984/mandrel-platform/commit/da93a89f51abd11a175e8e8a7bc624e79d665ad0))
* **docs:** centralize common runbooks + docs-staleness lint (refs [#10](https://github.com/dsj1984/mandrel-platform/issues/10)) ([#19](https://github.com/dsj1984/mandrel-platform/issues/19)) ([7fe3093](https://github.com/dsj1984/mandrel-platform/commit/7fe3093da58b03102bb53cf5266e63804d31fcfc))
* **renovate:** add shared Renovate preset ([#8](https://github.com/dsj1984/mandrel-platform/issues/8)) ([#16](https://github.com/dsj1984/mandrel-platform/issues/16)) ([9eb9865](https://github.com/dsj1984/mandrel-platform/commit/9eb98650e30e52d393727eb9d54ac3804e15915b))
* **security:** add unconditional CodeQL reusable workflow (refs [#6](https://github.com/dsj1984/mandrel-platform/issues/6)) ([#14](https://github.com/dsj1984/mandrel-platform/issues/14)) ([b59f8cc](https://github.com/dsj1984/mandrel-platform/commit/b59f8cc19fe7d77c2dcd2c7953abbd29251c3aeb))

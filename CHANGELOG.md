# Changelog

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

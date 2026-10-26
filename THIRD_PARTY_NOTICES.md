# Third-party notices

This document distinguishes code included in this repository from external tools and design references. It does not assign a license to NodeOrchard's original code or relicense any third-party work. Each component retains its own terms.

## Included code: cJSON

The test-firmware template includes **cJSON 1.7.19**, by Dave Gamble and cJSON contributors, under the MIT License.

- Upstream: [DaveGamble/cJSON v1.7.19](https://github.com/DaveGamble/cJSON/releases/tag/v1.7.19)
- Included files: [hdk_cjson/](workbench/skills/hdk-test-firmware/assets/companion/components/hdk_cjson/)
- Copyright and full license: [hdk_cjson/LICENSE](workbench/skills/hdk-test-firmware/assets/companion/components/hdk_cjson/LICENSE)
- Version and file hashes: [third-party.json](workbench/skills/hdk-test-firmware/assets/companion/third-party.json)

The copyright and permission notices are retained in the source files and accompanying license. Keep them with copies or substantial portions of this component.

## External runtime and converters

NodeOrchard contains adapters for the following projects. Their repositories, installed dependencies, compiled applications, and generated assets are **not included** in this repository. They are installed separately in the user's local environment.

| Project | Integration | Upstream license |
| --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | External agent runtime, Skills, memory, and model connection | [MIT](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE); Copyright 2025 Nous Research |
| [OpenPinMap](https://github.com/geekheart/OpenPinMap) | Photo-based Pinout rendering; pinned commit `de6196839c6cf8126f4bf29b9792f73c17013b44` | [MIT](https://github.com/geekheart/OpenPinMap/blob/de6196839c6cf8126f4bf29b9792f73c17013b44/LICENSE); Copyright 2026 geekheart |
| [OpenInterfaceMark](https://github.com/geekheart/OpenInterfaceMark) | Interface annotation; pinned commit `f8f92636b2eb87ac956997e77c9239cf483913fc` | [MIT](https://github.com/geekheart/OpenInterfaceMark/blob/f8f92636b2eb87ac956997e77c9239cf483913fc/LICENSE); Copyright 2026 geekheart |
| [OpenStep2DWG](https://github.com/geekheart/OpenStep2DWG) | STEP projection and CAD conversion; pinned commit `afd6a844e39ba0a205918dc866b60211f978b2b9` | [MIT](https://github.com/geekheart/OpenStep2DWG/blob/afd6a844e39ba0a205918dc866b60211f978b2b9/LICENSE); Copyright 2026 geekheart and OpenStep2DWG contributors |

The OpenStep2DWG installation includes separately licensed engines: OpenCascade.js under LGPL-2.1-only, Open CASCADE Technology under LGPL-2.1 with the OCCT exception, acadrust under MPL-2.0, and wasm-bindgen under MIT / Apache-2.0. Its upstream [third-party notices](https://github.com/geekheart/OpenStep2DWG/blob/afd6a844e39ba0a205918dc866b60211f978b2b9/THIRD_PARTY_NOTICES.md), license files, and source/build instructions remain relevant when distributing those components. These engines and their WASM binaries are not vendored here.

Other optional integrations, including DrawIO, Chrome/Playwright, 嘉立创 EDA, Python packages, and ESP-IDF/BSP/toolchains, are supplied by their respective projects or vendors. Installing or redistributing them does not change their licenses. Board photos, design files, training answers, and generated business deliverables belong to the user's local workspace and are not part of this source distribution.

## Design reference: Multica

[Multica](https://github.com/multica-ai/multica), by Index Labs (Hong Kong) Limited, informed the organization of workflow lists, status, and application navigation. NodeOrchard's application code is implemented separately. The local reference checkout is ignored by Git; Multica source code, logos, and runtime are not bundled or required to run this repository.

Multica has its own [license](https://github.com/multica-ai/multica/blob/main/LICENSE) and [NOTICE](https://github.com/multica-ai/multica/blob/main/NOTICE). This reference acknowledgement does not grant rights to redistribute Multica code, remove its branding, or operate services using it.

# Third-party notices

This document covers NodeOrchard's current external runtime and design references. It does not assign a license to NodeOrchard's original code or relicense any third-party work.

## External runtime: Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) provides the external agent runtime, Skills, memory, and model connection. Its code, installed dependencies, authentication, and generated user assets are installed and managed separately; they are not bundled in this repository.

Hermes Agent retains its [MIT License](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), Copyright 2025 Nous Research. The user's additional tools, Skills, MCP integrations, and software retain their respective licenses.

## Archived hardware integrations

The former hardware adapters, converters, firmware templates, and their cJSON copy have been moved outside this repository into the local `NodeOrchard-HDK/` source archive. The original third-party notices, component license, and version records accompany that archive. They are not part of NodeOrchard's current source distribution, and this change does not grant redistribution rights to any archived component.

## Design reference: Multica

[Multica](https://github.com/multica-ai/multica), by Index Labs (Hong Kong) Limited, informed the organization of workflow lists, status, and application navigation. NodeOrchard's application code is implemented separately. Multica source code, logos, and runtime are not bundled or required to run this repository.

Multica has its own [license](https://github.com/multica-ai/multica/blob/main/LICENSE) and [NOTICE](https://github.com/multica-ai/multica/blob/main/NOTICE). This reference acknowledgement does not grant rights to redistribute Multica code, remove its branding, or operate services using it.

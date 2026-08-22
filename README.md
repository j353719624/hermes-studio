<p align="center">
  <strong>Hermes Studio · fnOS 适配版</strong>
</p>

<p align="center">
  Hermes Studio is a fnOS adaptation and packaged distribution for Hermes Agent.
  <br/>
  <a href="./README_zh.md">中文说明</a>
</p>

> This repository is a modified fnOS build of Hermes Studio. It is not the upstream desktop, npm, or Docker distribution. The documentation below describes the fnOS package shipped by this repository.

## What this project is

Hermes Studio is an application, mobile companion, and web console for Hermes Agent. It provides a web interface for chatting with an agent, building visual workflows, managing models and profiles, and keeping work connected across devices.

This fork adapts that experience to 飞牛 fnOS and distributes it as a `.fpk` application. The fnOS package includes the required Linux runtime, so a separate Python, Node.js, or Hermes Agent installation is not required on the NAS.

## Current package

| Item | Value |
| --- | --- |
| Hermes Studio | `0.6.45` |
| Target | 飞牛 fnOS x86 |
| Hermes Runtime | `0.20.4` (bundled) |
| Package format | `.fpk` |
| Web entry | `/app/hermes-studio` |
| Gateway socket | `hermes-studio.sock` |
| Process user | fnOS package user, not root |

## Included features

- Hermes Agent chat with streaming responses, model/profile configuration, sessions, and file handling.
- Visual workflows, group chat rooms, tasks, channels, memory, plugins, MCP, and coding-agent configuration where supported by the current build.
- Skills management. The package contains the bundled skills shipped with this build; they are synchronized on startup while user-installed or user-modified skills are kept.
- fnOS application entry, gateway routing, lifecycle scripts, logging, runtime validation, runtime rollback, and data-preserving uninstall.

The feature set is constrained by fnOS and the bundled runtime. Desktop-only functions and upstream deployment instructions are not part of this package's supported installation path.

## Install on fnOS

1. Download the `hermes-studio-0.6.45-linux-x64.fpk` package from the repository release.
2. In fnOS App Center, choose **Manual Install** and select the FPK.
3. Open **Hermes Studio** after installation and configure the provider, model, profile, and workspace in the web console.

For an update, install the newer FPK from the App Center. If fnOS does not allow replacing the same version, uninstall the existing app and choose **keep application data**, then install the new package. Do not choose data deletion unless the stored configuration, sessions, workspaces, uploads, and runtime data are no longer needed.

## Data locations

The package uses fnOS's `${TRIM_PKGVAR}` directory as its persistent data root. On the author's fnOS setup this is under `/vol2/@appdata/hermes-studio`; the actual location is provided by fnOS and may be different on another volume.

| Purpose | Path |
| --- | --- |
| Hermes Agent home | `${TRIM_PKGVAR}/hermes` |
| Workspaces | `${TRIM_PKGVAR}/workspace` |
| Uploads | `${TRIM_PKGVAR}/uploads` |
| Bundled/updateable runtime | `${TRIM_PKGVAR}/runtime` |
| Studio logs and temporary files | `${TRIM_PKGVAR}/logs`, `${TRIM_PKGVAR}/tmp` |

The runtime is installed inside the application data directory and is checked before startup. If a newly updated runtime fails validation, the lifecycle script attempts to restore the previous runtime.

## For contributors

This repository includes the fnOS packaging and build configuration. Development and packaging details are kept with the project scripts and fnOS package files.

## Repository scope

This repository contains the fnOS adaptation, package template, lifecycle scripts, gateway integration, and build verification for this distribution. It should be read together with the fnOS package files under [`fnos/hermes-studio`](./fnos/hermes-studio).

The code is based on Hermes Studio and Hermes Agent related work. Upstream references:

- [Hermes Studio upstream](https://github.com/EKKOLearnAI/hermes-studio)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)

The current repository and release files are maintained for the fnOS build at [j353719624/hermes-studio](https://github.com/j353719624/hermes-studio).

## License

See [`LICENSE`](./LICENSE). The project currently uses the BSL-1.1 license.

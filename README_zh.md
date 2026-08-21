<p align="center">
  <strong>Hermes Studio · 飞牛 fnOS 适配版</strong>
</p>

<p align="center">
  面向 Hermes Agent 的 fnOS 改造与打包版本<br/>
  <a href="./README.md">English</a>
</p>

> 本仓库不是 Hermes Studio 的通用桌面版、npm 包或 Docker 发行版，而是面向飞牛 fnOS 的改造版本。下面的说明只对应本仓库生成的 fnOS 应用包。

## 项目定位

Hermes Studio 是面向 Hermes Agent 的应用、移动端伴侣与 Web 控制台。与智能体对话、搭建可视化工作流、管理模型和配置，并让工作在不同设备间保持连接。

本版本针对飞牛 fnOS 做了应用入口、统一网关、生命周期脚本、运行时打包、数据目录和权限适配，最终以 `.fpk` 应用包安装。Hermes 所需的 Linux 运行时已经随包提供，正常使用不需要再单独安装 Python、Node.js 或 Hermes Agent。

## 当前版本

| 项目 | 内容 |
| --- | --- |
| Hermes Studio | `0.6.44` |
| 目标平台 | 飞牛 fnOS x86 |
| Hermes Runtime | `0.20.4`（内置） |
| 安装包格式 | `.fpk` |
| Web 入口 | `/app/hermes-studio` |
| 网关 Socket | `hermes-studio.sock` |
| 运行用户 | fnOS package 用户，非 root |

## 当前包含的功能

- Hermes Agent 对话、流式回复、模型和配置管理、会话管理及文件处理。
- 可视化工作流、群聊房间、任务、频道、记忆、插件、MCP 和 Coding Agent 配置；具体能力以当前 fnOS 构建和运行时为准。
- 技能管理。安装包内置当前版本的技能，应用启动时会同步内置技能；用户安装或修改的技能会保留。
- fnOS 应用入口、网关路由、启停脚本、日志、运行时校验、运行时回滚和保留数据卸载。

当前功能受 fnOS 环境和内置运行时限制。桌面端专属功能，以及上游项目中的通用部署方式，不属于本版本的安装路径。

## 在飞牛 fnOS 上安装

1. 从仓库 Release 下载 `hermes-studio-0.6.44-linux-x64.fpk`。
2. 打开 fnOS 应用中心，选择**手动安装**并导入 FPK。
3. 安装完成后打开 **Hermes Studio**，在 Web 控制台中配置供应商、模型、配置文件和工作区。

升级时直接在应用中心安装新的 FPK。若 fnOS 不允许覆盖同版本安装，先卸载原应用，并在卸载界面选择**保留应用数据**，再安装新包。除非确定不再需要配置、会话、工作区、上传文件和运行时，否则不要选择删除应用数据。

## 数据目录

应用使用 fnOS 提供的 `${TRIM_PKGVAR}` 作为持久化数据根目录。在作者的 fnOS 环境中，该目录位于 `/vol2/@appdata/hermes-studio`；不同存储卷上的实际路径以 fnOS 注入的变量为准。

| 用途 | 路径 |
| --- | --- |
| Hermes Agent 主目录 | `${TRIM_PKGVAR}/hermes` |
| 工作区 | `${TRIM_PKGVAR}/workspace` |
| 上传文件 | `${TRIM_PKGVAR}/uploads` |
| 内置及可更新运行时 | `${TRIM_PKGVAR}/runtime` |
| 日志和临时文件 | `${TRIM_PKGVAR}/logs`、`${TRIM_PKGVAR}/tmp` |

运行时安装在应用数据目录中，启动前会进行完整性检查。新运行时校验失败时，生命周期脚本会尝试恢复上一个可用版本。

## 构建 fnOS 安装包

构建目标为 fnOS x86。在 Windows 上构建时，需要通过 WSL 准备 Linux 二进制文件和原生模块。

```bash
npm install
npm run build:fnos
npm run verify:fnos
```

生成的 FPK 位于：

```text
build/fnos/output/hermes-studio-0.6.44-linux-x64.fpk
```

`verify:fnos` 会检查 manifest、网关资源、内置运行时、原生依赖、技能文件、package 用户权限以及最终 FPK 内容。`package.json` 和 `fnos/hermes-studio/manifest` 中的版本必须保持一致；当前 fnOS 发布版本固定为 `0.6.44`。

## 仓库范围

本仓库主要维护 fnOS 适配代码、应用模板、生命周期脚本、网关接入和 FPK 构建校验。相关文件位于 [`fnos/hermes-studio`](./fnos/hermes-studio)。

项目基于 Hermes Studio 与 Hermes Agent 相关代码改造，保留上游来源说明：

- [Hermes Studio 上游仓库](https://github.com/EKKOLearnAI/hermes-studio)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)

当前 fnOS 改造版本和发布文件维护于 [j353719624/hermes-studio](https://github.com/j353719624/hermes-studio)。

## 许可证

许可证见 [`LICENSE`](./LICENSE)，当前项目使用 BSL-1.1。

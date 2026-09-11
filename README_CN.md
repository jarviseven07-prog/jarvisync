# JarviSync

**给多个 Agent 共用的本地协作看板。**

[![CI](https://github.com/jarviseven07-prog/jarvisync/actions/workflows/ci.yml/badge.svg)](https://github.com/jarviseven07-prog/jarvisync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

[English](README.md) | [中文](README_CN.md)

> 当前为早期版本，界面为中文；已验证的运行平台是 Windows，macOS 和 Linux 尚未验证。

[下载 v0.1.2](https://github.com/jarviseven07-prog/jarvisync/releases/tag/v0.1.2) ·
[观看 30 秒工作流演示](https://github.com/jarviseven07-prog/jarvisync/releases/download/v0.1.0/JarviSync-Workflow-30s.mp4)

视频使用重构的 UI 与虚构案例说明工作流，不是真实 Agent 执行过程的录屏。

![Windows 桌面版内置示例画布](docs/images/board.png)

---

## 要解决的问题

你同时开了三个 Agent 跑长任务。十分钟后，你不知道谁干到哪了。于是挨个问一遍，
再把 A 的结论手动粘给 B。

问题就是这个。不是模型不够好，也不是提示词不对——**工作不可见，上下文不会自己走。**

## JarviSync 做什么

一张本地画布，装下项目、节点和它们之间的依赖。

- **进展可见。** 每个节点显示实际做了什么、谁做的、卡在哪——因为每个 Agent
  自己把回执写回来。
- **上下文共享。** A 节点交付的成果留在节点上，B 节点直接读取上游交付摘要和成果链接。
  链接指向的文件按需读取，看板不会自动广播全部原文。
- **多项目并行也不乱。** 摘要统计哪些在跑、哪些能接着做、哪些在等你。
- **任何 Agent 都能接。** 提供 Codex、Claude Code、Hermes 的本机接入包和通用
  MCP 工具，为同时用多个 Agent、多个模型的人准备。
- **它是梯子，不是笼子。** 看板负责结构，往上搭什么是你的事。

看板数据保存在本机，服务只监听本地地址。宿主 Agent 可能将读到的内容发送给模型
服务商；这取决于宿主与服务商设置，本地保存不代表模型调用也不外发数据。

## 它刻意不做的事

这部分比功能清单更重要，因为同类工具最容易在这里过度承诺：

- **不监控你的 Agent。** 进展来自 Agent 主动写回，不通过探测进程存活或监听
  每条命令输出来判断。一个看起来没动静的节点，可能只是那个 Agent 没有汇报。
- **不启动也不调度 Agent。** `start` 和 `stop` 只写回执，真正的启动和停止由宿主
  （Claude Code、Codex、Hermes……）完成。在节点上写了执行者或模型名，不代表
  有任何东西在运行。
- **不替你选模型，也不常驻唤醒器。**
- **浏览和 Agent 读写都不调用模型。** 看板本身不做任何推理。

## 快速开始

v0.1.2 包含阶段提醒、建点时同时保存依赖连线，以及已有 Hermes 插件的升级修复。
Agent 新建节点须明确上游；
确实独立时说明原因。现有节点和连线不会被自动重排或补造关系。
活动执行约十分钟没有新进展写回时，宿主会在支持的事件中限频提醒核对阶段成果，
仍由 Agent 判断是否已有事实可写；系统不会代写进展或判定完成。

升级前关闭旧应用并备份数据目录，把新版 ZIP 解压到另一目录。
在“接入我的 Agent”中更新接入，并在宿主中重新加载插件，才能载入新版工具和 Hook。
需要回退旧版时保留并使用升级前备份。

**Windows x64 便携版：**从
[v0.1.2 发布页](https://github.com/jarviseven07-prog/jarvisync/releases/tag/v0.1.2)
下载桌面 ZIP，完整解压后打开其中的 `JarviSync.exe`，保留同目录的其它文件。
便携版自带运行时，无需另装 Node.js。

**从源码运行：**需要 **Git 和 Node.js 24 或更新版本**，在终端运行：

```bash
git clone https://github.com/jarviseven07-prog/jarvisync.git
cd jarvisync
git checkout v0.1.2
npm ci
npm run build
```

**网页服务**——数据在 `data/board.json`：

```bash
npm run start:server
```

然后打开 <http://127.0.0.1:4317>。

**桌面应用**（Electron）——数据在 `%APPDATA%/Nodeboard/data`：

```bash
npm start
```

两种模式的数据目录互相独立。网页服务用 `NODEBOARD_DATA_DIR` 指定数据目录；
桌面应用用 `NODEBOARD_DESKTOP_DATA_DIR` 指定应用配置目录，业务数据保存在它的
`data/` 子目录中。首次启动会生成一个明确标记的示例项目，新建项目为空白。

开发时先起服务，再另开终端：

```bash
npm run dev:web
```

## 接入你的 Agent

点右上角 **接入我的 Agent**，选择宿主与记录范围，准备并安装。`integrations/`
下提供：

| 宿主 | 方式 |
|---|---|
| Claude Code | 插件 + MCP |
| Codex | 插件 + MCP |
| Hermes | 原生插件 + 独立 MCP 配置 |

提供适配包不代表每个宿主和模型都已通过真实新会话验收。请在自己的环境中完成
安装、宿主信任和读写验证，见[验证范围](docs/agent-onboarding.md#验证范围)。
通用 stdio MCP 提供工具，不含原生会话 Hook；运行在远程机器上的 Agent 不能直接
连接你的 localhost 服务。

日常协作优先用宿主里的 JarviSync MCP 工具。也有 CLI：

```bash
npm run agent -- projects
npm run agent -- context <项目ID> --project
```

写入需要安装入口生成的接入文件和宿主提供的真实会话，详见
[docs/agent-onboarding.md](docs/agent-onboarding.md)；协作约定见
[docs/agent-collaboration.md](docs/agent-collaboration.md)。

每次写入都要带上读取到的版本号。发生冲突时重新读上下文再判断，不要盲目重试。

## 实际的协作流程

1. 人在跟 Agent 的正常对话里确认目标和主要任务。
2. 那个 Agent 创建项目、节点和依赖，并记录来源对话。
3. 执行 Agent 读取自己节点的上下文，记录开始，写回进展，交付成果。
4. 下游节点读取上游成果，继续往下做。

节点的标题、状态、执行者、模型、进度、决定和依赖在网页上是只读的——它们由
Agent 通过本地接口维护。**你的补充**面板是人直接留下目标、约束、材料、反馈或
决定的地方，支持上传附件。

## 常见问题

**多个 Agent 能共享同一个代码库或同一个任务吗？**
不建议。让它们从不同角度切入，或者重新执行。两个 Agent 同时改同一批文件就是在
制造冲突，看板拦不住。

**节点没动静是不是 Agent 挂了？**
不是。只说明没有东西被写回来。看板报告的是回执，不是存活状态。

**我的数据在哪？**
`data/board.json`，以及同目录下的 `uploads/`、`history/`、`instance.json` 和
`agent-integrations/`。完整备份要保留整个数据目录——界面里的 JSON 导出刻意
不含附件原件。

## 测试

```bash
npm test
npm run build
```

`npm test` 覆盖数据保存、版本冲突、CLI、执行回执、交付接续、来源边界、协作汇总、
布局与人工输入。`npm run build` 检查类型并构建页面。

## 技术栈

React · React Flow · Vite · Electron · Node.js JSON 持久化。无数据库、无云端、
无遥测。

## 许可证

[MIT](LICENSE)

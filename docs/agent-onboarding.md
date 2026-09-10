# Agent 接入

用户已于 2026-09-10 采纳新用户接入方案，并追加 Hermes 为首批宿主。JarviSync 提供本地共享上下文与工作记录，执行仍由用户自己的 Agent 完成。

## 用户入口

打开看板右上角「接入我的 Agent」，选择 Codex、Claude Code 或 Hermes，再选择记录明确交办的工作，或限定到一个已有项目。点击准备接入后再安装到宿主。安装操作仅在用户点击时执行，不改动账号和其它工具设置。

Codex 安装后仍需在 `/hooks` 中查看并信任当前 JarviSync Hook 定义，再新开对话。Claude Code 和 Hermes 也需要新开对话让插件与工具生效。按宿主提示完成原生确认。宿主命令行不在本机时，界面保留待安装状态。

Claude Code 2.1.260 的原生校验不支持 `Interrupt` Hook，且用户中断不会触发 `Stop`。因此此适配器尚不能自动观察所有用户中断；需要立即阻止该接入继续写回时，在看板中停用它。跨会话接管须由用户确认原执行已停止，不能声称已从 Claude 宿主观察到中断。见 [Claude Code 官方 Hook 说明](https://code.claude.com/docs/en/hooks#stop)。

在新对话里发送界面提供的验证文字。Agent 应通过 `jarvisync_verify` 在独立验证区依次读、写、读回；这不会创建正式项目。界面只在实际读回匹配回执后显示「工具读写已验证」。新会话自动建档需要另用正常工作请求观察，Hook 被观察到也不等于这一项验收通过。

每个宿主可单独停用；停用会拒绝该接入的请求，原项目保留。通用 MCP 只提供工具连接，不含宿主自动会话检查。云端 Agent 不能连接本机地址。

会话、停用与项目范围检查适用于正式 Agent 接口和随附 CLI。人工修改入口属于本机桌面用户；当前产品不隔离同一 Windows 用户下可以读取连接配置、模拟人工请求或直接改文件的进程。这些协作检查不能宣称为本机不可信程序的安全沙箱。

## 默认协作动作

1. 从宿主入口取得本次真实 `sessionId`，用 `jarvisync_discover` 只读发现绑定与项目候选。普通问答不调用建档工具；用户说不记录时遵循当前指示。
2. 明确交办的工作用 `jarvisync_attach` 关联项目，或原子建立项目、少量节点和依赖。使用服务返回的 ID。已有会话绑定优先作为上下文，但同一项目新增独立成果仍应建立自己的节点，不能都写入旧节点 progress；cwd 不决定项目。有多个真正无法区分的候选时才澄清。仅 `project.conversationRef` 严格等于当前 `host:profile:session` 的原主会话，可在仍绑定执行节点时创建同项目节点和依赖；普通执行会话保留节点范围限制。
3. `jarvisync_context` 读取绑定节点、项目和直接上游成果。按引用读取成果原件，再开始工作。
4. `jarvisync_start` 记录实际开始，保存返回的 `binding.runId`。实际模型来自宿主事件；缺失时明确保留缺失，不从计划或历史推断。
5. 用 `jarvisync_progress` 记录有意义的阶段进展、受阻问题与下一步。真正交付后才用 `jarvisync_deliver` 保存结论、原件引用和未解决事项。
6. `jarvisync_change` 处理项目范围内的后续节点、依赖、反馈和已经实际停止的回执。原主会话可在仍绑定执行节点时增加同项目后续节点和依赖；普通执行绑定不能修改整个项目结构。当前执行结束后可显式重新关联同项目工作；同项目重绑不需要跨项目确认，但活动 run 仍不能离开原节点。已授权范围内的常规节点续接无需为工具参数另问用户。

原会话无法恢复且节点还有活动执行时，新会话先关联原节点并读上下文，再用 `jarvisync_takeover` 接续。必须已有原宿主的真实 Interrupt 记录，或用户明确确认原执行已停止；服务原子保存停止原因、确认来源和新旧执行关系。Stop/SessionEnd、同目录或仅更改署名都不能作为接管依据，旧会话也不能写入新执行。

写入记录时，目标或下一步含多个事项就用真实换行的 `- ` 或 `1. ` 为每项单列，不同主题空一行；不要写字面 `\n`。进展按已完成和待办分段，只写事实；决定单列。保留人工原话，不删必要信息来换短，也不复制整段工具日志。简单一句可以保持一段。

主负责 Agent 仍调用宿主本身的委派能力，把项目与目标节点一并交给子 Agent。子 Agent 必须使用自己的宿主身份和节点，不能拿父任务的 `runId` 写回。只有子身份确实可用时才允许绑定；缺少时提示未完成接入，不伪造子任务。

`Stop` 和 `SessionEnd` 只表示宿主事件；它们不提交业务成果。结束检查只提示本会话已有的待同步条目，同组仅提示一次，不自动续跑。它不能检测模型从未调用工具、也从未生成的进度内容。用户中断立即尊重，不重启任务。

自动会话检查共享两秒网络预算，同一次检查复用连接核对；离线后约一分钟再探测。Hook 不自动启动服务，普通 MCP 工具仍保留原有的按需启动能力。SessionStart（含恢复和压缩后的入口）提供完整范围；普通回合在绑定、记录开关、实际模型或中断状态变化时才重发提醒。

Claude Code 可用 `/jarvisync:status` 查看本会话记录状态，`/jarvisync:off` 停用、`/jarvisync:on` 恢复本会话记录意图。未绑定会话的开关只保存本地选择，不创建项目；停用期间普通业务写入受阻，恢复不会自动清除用户中断。Windows 有可用外部 Node 时 Hook 直接启动 Node；没有时保留已有的桌面包装回退。宿主维护的 `.in_use` 标记不属于插件更新范围。

## 稳定实例、写回与恢复

每个数据目录保存稳定 `instance.json`。接入配置固定 `boardInstanceId` 与原数据目录；原实例丢失或端口指向其它实例时拒绝写入。服务关闭时，接入程序仅在原身份文件与原 board 都存在时按需后台启动该服务，不弹出看板，不生成另一份示例数据。

会话绑定按 host/profileId/sessionId 三元组保存；真实会话恢复查原绑定，新会话不会仅凭相同目录冒认旧执行。项目被删除时清理绑定和当前回执内的业务内容，仅保留最小已提交/已删除事实，避免重放已完成写入；删除前的本地历史仍保留。

每个业务写入（包括 attach）必须提供稳定 `clientOperationId` 和原始 `expectedRevision`。业务内容与紧凑回执一起原子提交到 `board.json`；最近 256 条回执仅保留 ID、版本、绑定和结果状态，不重复保存业务正文。窗口内同 ID 同内容返回原结果，同 ID 不同内容拒绝。版本冲突重新读取并判断，不自动换版本覆盖。超过回执窗口且原始版本不晚于淘汰边界的未知请求返回 `410 operation-expired`，保留待核对内容；不能更换旧请求的版本后自动重放。

历史备份在成功落盘后保留最近 32 份，以及最近 30 个 UTC 日每天一份。清理失败会记录警告，已经提交的业务写入仍按成功返回；不会为了清理回执或历史改写正式业务正文。已核对版本加载前的救援备份会复制 `data/` 的所有顶层业务项和旧 `dist/`；运行中的 `data/desktop-profile/` 是 Electron 浏览器 userData，会原地保留并在备份记录中明确排除。除此以外任何复制错误都会停止加载。

发送前将请求保存在本接入独立的 pending 目录。网络结果未知或响应丢失时，`jarvisync_sync` 先查询原请求是否已提交；已提交直接取回原回执，未提交才核对原执行和版本。409 后先用 `jarvisync_context` 比较当前实际内容、当前版本和当前 run，不修改旧请求的版本重放。状态变化的条目保留为 `needs-review`，不覆盖现有工作。同步只处理当前完整会话身份的记录，不能重放另一个宿主或对话。

核对后才可用 `jarvisync_resolve(sessionId, clientOperationId=<原失败请求ID>, resolution=retry|discard, expectedRevision=<当前版本>)` 结清失败请求。`retry` 只重提相同业务体，运行时生成新的 attempt ID，并明确结清旧 pending；若原请求已经提交，直接返回原回执。`discard` 只撤销本地失败请求，不停止实际执行，也不删除已有成果。resolve 不能恢复已中断会话或旧 run。全局 revision 暂按保守冲突处理；该机制不宣称消除并发冲突。

## 安装与文件范围

- 接入记录、验证区与安装源：当前数据目录 `agent-integrations/`，独立于业务项目。
- 稳定身份与动态端口：`instance.json`、`agent-endpoint.json`。
- Codex / Claude Code：生成本地来源并通过宿主官方插件命令安装。权限与 Hook 信任仍由宿主负责。
- Hermes：原生插件复制到所选 Hermes home 的 `plugins/jarvisync-hermes`，通过宿主命令启用并合并 `mcp_servers.jarvisync`。同名非本接入的配置拒绝覆盖。
- 接入配置包含本地连接凭据；不要随研究证据或公开源码上传。完整迁移备份应保留同一数据目录及附件，也应保留实例身份和接入目录。仅导出 board 不是完整迁移。

新接入协议使用本地 stdio MCP；工具进程与 Hook 使用安装器写入的绝对运行时，不要求新用户编辑 JSON 或拼接开发仓库路径。各宿主模板与运行时位于 `integrations/`，没有增加模型 API Key 或模型路由。

## 验证范围

实现与实际验收是两件事。本轮精确检查、浏览器截图、原生 CLI 安装证据、缺失的宿主信任或真实新会话证据统一记录在 [本轮交接](../work/agent-onboarding/handoff.md)。未经验证的项保持待验，不由自动测试替代。

格式依据：[MCP stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[Codex 插件](https://learn.chatgpt.com/docs/plugins)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code 插件](https://code.claude.com/docs/en/plugins)、[Claude Code Hooks](https://code.claude.com/docs/en/hooks)。Hermes 对应本机源码的原生插件 API，源码定位与边界见 `work/agent-onboarding/hermes-findings.md`。

---
name: jarvisync-collaboration
description: Use JarviSync when a user has explicitly assigned work that should be associated with a local project, recorded as meaningful progress, or continued across supported hosts.
---

# JarviSync 协作约定

只记录用户已明确交办的工作。普通问答、探索中的想法和用户明确说“不记录”的内容不建立或更新 JarviSync 记录；用户当前指示优先。

每次使用 JarviSync MCP 工具都传入 Hook 注入的实际 `sessionId`。先读取该会话的绑定和直接相关上下文，再决定是否关联既有项目或创建少量可交付节点。工作目录只是线索，不能据此猜测项目。

明确工作时，先用 `jarvisync_discover`，再按需要用 `jarvisync_attach` 和 `jarvisync_context`。按独立、可交付的成果建立少量节点；用户在同一项目追加新的独立成果时，建立或关联该成果自己的节点，不能把所有新增工作塞进旧节点的 `progress`。已有会话绑定只说明已有工作，不强迫新工作复用旧节点。宿主没有子 Agent 能力时，仍可建立这些节点并由当前执行者顺序完成。

“在看板安排给 Codex”只记录计划或节点归属；只有用户明确要求立即启动外部 Codex 进程时才请求宿主实际启动。节点署名不是已派活：只有宿主真实派发成功后，才记录 `jarvisync_start` 和本次实际模型。实际开始后用 `jarvisync_start`，长任务在关键阶段、受阻和下一步明确时用 `jarvisync_progress`，只有业务工作真正完成才用 `jarvisync_deliver`。断线恢复用 `jarvisync_sync`；接入测试只用隔离的 `jarvisync_verify`。需要原有看板范围内的结构或反馈变更时才用 `jarvisync_change`。

实际开始、关键进展、受阻和明确交付时才写回。不要复制完整聊天记录；不要把 `Stop`、`SessionEnd`、空闲或宿主状态当作完成。交付需要明确成果和当前执行关联。响应丢失时仍用原操作 ID、原版本和原正文重试；409 后不能给旧操作 ID 换版本，先读取上下文核对。同步失败或有待核对内容时，先读取上下文并核对当前版本，再用 `jarvisync_resolve` 携带原失败请求的 `clientOperationId`、`resolution`（`retry` 或 `discard`）和当前 `expectedRevision`：`retry` 只重提相同业务正文并结清旧 pending，`discard` 明确撤销失败请求但不停止实际执行。

写入目标或下一步时，多个事项必须各占一行，使用真实换行的 `- ` 或 `1. `；不同主题空一行，绝不把 `\n` 写成文字。进展只写事实，已完成和待办分段；决定单列。保留人工原话，不为缩短而漏掉必要信息，也不复制整段工具日志。简单一句可以保持一段。

宿主提供的实际模型可作为执行元数据；没有该元数据时保留 `null` 和 `host-unavailable`，不从计划、环境变量或历史记录猜测。子 Agent 只使用宿主实际传入的任务范围，不能把父会话或推测范围冒充为自己的任务。

用户中断、转向或停止立即生效。不得用 Hook 自动 `deliver`、重启工作或无限续跑；仅在服务给出未写回状态时提示一次，后续由 Agent 在正常对话中核对处理。

新会话接续原节点而旧执行未结束时，先关联原节点并读上下文。只有宿主已报告原会话 Interrupt，或用户已明确确认原执行停止，才用 `jarvisync_takeover` 留下停止原因并取得新 runId；普通 Stop/SessionEnd 不足以接管。不要改普通 node.stop 绕过旧执行归属。

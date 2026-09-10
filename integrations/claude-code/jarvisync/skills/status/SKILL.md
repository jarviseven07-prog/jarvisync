---
name: status
description: 查看当前 Claude 会话的 JarviSync 记录状态。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" status --connection "${CLAUDE_PLUGIN_ROOT}/runtime/connection.json" --session-id "${CLAUDE_SESSION_ID}"`

向用户简洁说明上面的 JSON 结果。不要关联项目、创建项目或修改记录状态。

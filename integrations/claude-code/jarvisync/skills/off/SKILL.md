---
name: off
description: 停用当前 Claude 会话的 JarviSync 自动记录。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" off --connection "${CLAUDE_PLUGIN_ROOT}/runtime/connection.json" --session-id "${CLAUDE_SESSION_ID}"`

向用户简洁说明上面的 JSON 结果。此操作只停用当前会话；不要关联项目、创建项目或改变其他会话。

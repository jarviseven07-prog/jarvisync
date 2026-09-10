---
name: on
description: 恢复当前 Claude 会话的 JarviSync 自动记录意愿。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/runtime/recording-command.mjs" on --connection "${CLAUDE_PLUGIN_ROOT}/runtime/connection.json" --session-id "${CLAUDE_SESSION_ID}"`

向用户简洁说明上面的 JSON 结果。此操作不会关联或创建项目；若远端仍停用或当前不可用，如实说明其结果。

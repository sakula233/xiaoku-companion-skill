# 独立伴侣技能完整参考（CLI · 记忆胶囊 · 分享接入 · MCP 模式）

## 1. 目录说明

```text
.agents/skills/xiaoku/
├── .gitignore                        # 忽略本地 data/ 与 *.capsule.json，保证分享出去时是空白新角色
├── SKILL.md                          # 会话激活主指令与三步工作流
├── resources/
│   └── persona.template.json         # 默认初始角色种子（默认名「小库」，零个人聊天记录）
├── references/
│   └── cli-and-capsule-guide.md      # 本参考手册
├── scripts/
│   ├── companion.mjs                 # 统一 CLI 与 stdio MCP 入口（仅依赖 Node 22+ 内置模块）
│   └── lib/
│       ├── store.mjs                 # 本地 SQLite (FTS5) 存储、定制档案与胶囊导入导出
│       └── weather.mjs               # 中文口语日期/时段解析 + Open-Meteo 天气事实卡片
└── data/                             # 首次运行自动生成（仅存于使用者本地）
    ├── profile.json                  # 使用者专属伴侣名字、称呼、兴趣、边界与共同的梗
    ├── memory.sqlite                 # 事件进展、情绪余波、虚拟日常、共创项目与会话摘要
    └── backups/                      # 导入或重置前自动生成的安全备份胶囊
```

## 2. 如何分享给别人接入（每个人拥有专属伙伴）

1. 直接将 `.agents/skills/xiaoku` 文件夹复制给对方（放入对方工作区的 `.agents/skills/xiaoku` 或全局技能目录，无需 `npm install`，只要机器上有 Node.js `>= 22.5` 即可）。
2. 因为 `data/` 不随模板分发，对方第一次在会话里说话时，脚本会自动从 `resources/persona.template.json` 初始化一个**完全空白的崭新小库**。
3. 对方只需在对话里说一句：
   > “以后你就叫小夏吧，平时叫我阿林就行。”
   会话模型就会执行 `profile --name "小夏" --call-user "阿林"`，从此这个实例就变成专属于阿林的「小夏」，后续聊出的所有经历、雷区、日常都只属于他们自己。

## 3. 记忆胶囊（`.capsule.json`）导入与导出细节

导出的胶囊是带 SHA-256 完整性签名的纯 JSON 文件（格式标识：`companion-skill-capsule-v1`）：

- **导出到指定路径**：
  ```bash
  node .agents/skills/xiaoku/scripts/companion.mjs export --out ./xiaoku-backup.capsule.json --note "换新电脑迁移"
  ```
- **整包恢复到新环境（`--mode replace`，默认）**：
  ```bash
  node .agents/skills/xiaoku/scripts/companion.mjs import --in ./xiaoku-backup.capsule.json --mode replace
  ```
  - 导入前会自动校验 `integrity.sha256`，防止损坏文件破坏本地库；
  - 若目标环境原本已有记忆，会先自动备份到 `data/backups/pre-import-replace-*.capsule.json`，再原子替换并重建全文检索索引。
- **多端增量合并（`--mode merge`）**：
  ```bash
  node .agents/skills/xiaoku/scripts/companion.mjs import --in ./other-session.capsule.json --mode merge
  ```
  - 按 `eventId` / `projectId` / `day` 自动去重合并历史补丁与日常记录，不会覆盖丢失另一端独有的记忆。

## 4. 可选：作为标准 MCP Server 挂载

除了由 `SKILL.md` 驱动脚本外，`companion.mjs` 也内置了标准 JSON-RPC 2.0 `stdio` MCP 服务，可在支持 `mcp_config.json` 的客户端中直接挂载：

```json
{
  "mcpServers": {
    "my-companion": {
      "command": "node",
      "args": [".agents/skills/xiaoku/scripts/companion.mjs", "mcp"]
    }
  }
}
```

提供的 MCP 工具包括：`companion_get_context`、`companion_remember`、`companion_update_profile`、`companion_update_daily`、`companion_query_weather`、`companion_forget`、`companion_capsule`。

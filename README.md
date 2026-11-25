# 小库（Xiaoku Companion Skill）— 零依赖本地虚拟朋友技能包

> 一个住在你会话里的虚拟朋友技能。没有后台常驻进程、不需要 `npm install`、不上传任何隐私记忆。  
> **每个人接入时拿到的都是一个全新的空白角色**——你可以直接叫它「小库」，也可以一句话给它改成任何名字，在日常聊天中长出只属于你们自己的记忆、默契与生活日常。

---

## 核心特性

- **开箱空白、一人一伴侣**：模板不含任何历史私人数据；首次对话自动在本地初始化专属档案，互不串味。
- **一句话自由改名与定制**：随时在会话里说 *“以后你就叫阿泽吧，平时叫我老陈”*，名字、称呼、相处雷区、兴趣与共同的梗持久生效。
- **有证据的长期记忆（SQLite + FTS5）**：记录现实事件进展（打算 → 进行中 → 完成/取消）、情绪余波、待跟进的挂念（如惦记你周五面试顺不顺利），并严格将「虚构共创项目」与「现实生活事实」隔离。
- **自己的虚拟日常 + 口语天气**：角色每天有自己正在忙活的小事与心情状态；内置免 Key 的中文口语天气事实卡片（Open-Meteo）。
- **记忆胶囊导入 / 导出（SHA-256 校验）**：一键打包为单个 `.capsule.json` 文件，支持换电脑整包恢复（`replace`）或多端增量合并（`merge`），导入前自动留存本地备份。
- **双模式兼容**：既可作为 **Agent Skill（`SKILL.md`）** 直接放进工作区使用，也可作为标准 **`stdio` MCP Server** 挂载。

---

## 环境要求

- **Node.js `>= 22.5.0`**（使用 Node 原生内置 `node:sqlite`，**零第三方 npm 依赖**）

---

## 30 秒快速接入

### 方式 A：直接克隆到工作区技能目录（推荐，支持 Antigravity / T3 Code / Claude / Codex 等）

在你的工作区根目录执行：

```bash
git clone https://github.com/sakula233/xiaoku-companion-skill.git .agents/skills/xiaoku
```

或者先把仓库下载/解压到任意位置，运行内置一键安装脚本：

```bash
# 安装到指定项目工作区的 .agents/skills/xiaoku
node install.mjs --target /path/to/your-workspace

# 或安装到本机全局技能目录（~/.gemini/config/skills/xiaoku）
node install.mjs --global
```

装好后，直接在会话里对 AI 说：

- *“小库在吗？以后你改名叫小夏吧，叫我阿林就行。”*
- *“这周六我要去长沙面试，顺便帮我看看周六晚上那边冷不冷。”*
- *“我们一起搞个虚构的深夜电台企划吧，第一期主题叫雨夜便利店。”*
- *“把你现在的记忆导出备份一下。”*

### 方式 B：作为标准 MCP Server 挂载（可选）

在客户端 `mcp_config.json` 中加入：

```json
{
  "mcpServers": {
    "my-companion": {
      "command": "node",
      "args": ["/abs/path/to/xiaoku/scripts/companion.mjs", "mcp"]
    }
  }
}
```

---

## 记忆胶囊导出、导入与重置

所有本地数据默认存放在技能目录下的 `data/`（已被 `.gitignore` 排除，不会误提交到 Git）：

```bash
# 导出专属记忆胶囊（附带 SHA-256 完整性签名）
node .agents/skills/xiaoku/scripts/companion.mjs export --out ./my-companion.capsule.json --note "换电脑备份"

# 在新设备整包恢复（replace）或增量合并（merge）
node .agents/skills/xiaoku/scripts/companion.mjs import --in ./my-companion.capsule.json --mode replace

# 重置回全新空白角色（会自动在 data/backups/ 保存一份重置前备份）
node .agents/skills/xiaoku/scripts/companion.mjs reset --name "小库"
```

更多命令行参数说明见 [references/cli-and-capsule-guide.md](./references/cli-and-capsule-guide.md)。

---

## 运行自检测试

```bash
npm test
```

---

## License

[MIT](./LICENSE)

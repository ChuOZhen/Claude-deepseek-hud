# claude-deepseek-hud

Claude Code 的 DeepSeek API 状态栏插件 — 实时费用追踪、余额显示、Reasonix 风格 UI。

## 功能

- **实时费用追踪** — 每轮对话费用、累计费用，基于 DeepSeek 官方 CNY 定价
- **账户余额显示** — 从 DeepSeek API 实时获取钱包余额（5 分钟缓存）
- **Token 统计** — 输入/输出 token 计数、缓存命中率
- **上下文监控** — 上下文窗口使用百分比和 token 数
- **Reasonix 风格** — 单行紧凑布局，` · ` 分隔符，语义配色

## 显示效果

```
DeepSeek V4 Pro · ¥0.076/轮 · 缓存 91% · 上下文 9% · 88.4k/1.0M · 已花费 ¥0.076 / 剩余 ¥8.21
```

各段含义：
- **模型名** — 当前使用的 DeepSeek 模型
- **¥X/轮** — 上一轮对话费用（按金额着色：dim/green/yellow/orange）
- **缓存 XX%** — 缓存命中率（有缓存数据时显示）
- **上下文 X%** — 上下文窗口使用率（按占用率变色）
- **已花费 / 剩余** — 本次会话累计费用 + 账户剩余余额

## 安装

### 方式一：npm 全局安装（推荐）

```bash
npm install -g claude-deepseek-hud
claude-deepseek-hud --setup
```

然后重启 Claude Code。

### 方式二：从源码安装

```bash
git clone https://github.com/your-username/claude-deepseek-hud.git
cd claude-deepseek-hud
npm install
npm run build
npm run setup
```

### 方式三：手动配置

编辑 `~/.claude/settings.json`，添加：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/path/to/claude-deepseek-hud/dist/src/index.js\"",
    "refreshInterval": 2
  }
}
```

## 前提条件

- Node.js >= 18
- Claude Code 已配置 DeepSeek 作为后端（在 `~/.claude/settings.json` 中设置）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-your-deepseek-api-key"
  }
}
```

## 配置

### 自定义定价

编辑 `pricing.json` 可自定义各模型的 CNY 定价（每百万 token）：

```json
{
  "models": {
    "deepseek-v4-flash": { "input": 1, "output": 2, "cache_read": 0.02, "cache_write": 0.02 },
    "deepseek-v4-pro": { "input": 3, "output": 6, "cache_read": 0.025, "cache_write": 0.025 },
    "deepseek-r1": { "input": 4, "output": 16, "cache_read": 1, "cache_write": 4 }
  }
}
```

修改后无需重启，下次刷新自动生效。

### 余额缓存

余额数据缓存在 `.balance-cache.json`，TTL 5 分钟。删除该文件可强制刷新。

## 命令

```bash
claude-deepseek-hud --setup    # 自动配置 Claude Code statusLine
claude-deepseek-hud --help     # 显示帮助
```

## 致谢

本项目灵感来源于：

- **[claude-hud](https://github.com/jarrodwatts/claude-hud)** by Jarrod Watts — Claude Code statusLine 的 stdin 读取机制和单次执行模式
- **[DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)** — DeepSeek CNY 定价数据、`/user/balance` API 集成、显示风格

## 许可证

MIT

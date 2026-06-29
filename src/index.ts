#!/usr/bin/env node
/**
 * claude-deepseek-hud
 * A Claude Code statusLine plugin that shows real-time DeepSeek API cost,
 * balance, and token usage for users running Claude Code with DeepSeek as backend.
 *
 * Inspired by:
 *   - claude-hud (https://github.com/jarrodwatts/claude-hud)
 *     stdin reading mechanism, single-execution statusLine pattern
 *   - DeepSeek-Reasonix (https://github.com/esengine/DeepSeek-Reasonix)
 *     DeepSeek CNY pricing data, /user/balance API integration, display style
 *
 * How it works:
 *   1. Claude Code sends JSON events via stdin (context %, model, session info)
 *   2. We also watch the active JSONL transcript for token usage per turn
 *   3. We look up DeepSeek pricing from pricing.json (editable, no restart needed)
 *   4. We fetch wallet balance from DeepSeek API (cached 5 min)
 *   5. We render a Reasonix-style statusline: model · ¥/turn · cache · context · spent / balance
 */

import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StdinEvent {
  type?: string;
  session_id?: string;
  transcript_path?: string;
  context_window?: {
    used_tokens?: number;
    max_tokens?: number;
    used_percentage?: number;
    context_window_size?: number;
  };
  model?: { id?: string; display_name?: string } | string;
  cost?: { total_cost_usd?: number };
  rate_limits?: unknown;
  [key: string]: unknown;
}

interface TranscriptEntry {
  type: string;
  uuid?: string;
  role?: string;
  model?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  // Legacy flat format (fallback)
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface ModelPricing {
  displayName: string;
  aliases: string[];
  input: number; // CNY per 1M tokens
  output: number;
  cache_read: number;
  cache_write: number;
}

interface PricingConfig {
  models: Record<string, ModelPricing>;
  fallback: ModelPricing & { displayName: string };
}

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceCache {
  available: boolean;
  infos: BalanceInfo[];
  fetchedAt: number; // epoch ms
}

interface SessionCost {
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number; // percent
  lastTurnCost: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
}

// ─── Config & State ───────────────────────────────────────────────────────────

// __dirname is dist/src/ so go up two levels to project root
const PRICING_PATH = path.resolve(__dirname, "../../pricing.json");
const BALANCE_CACHE_PATH = path.resolve(__dirname, "../../.balance-cache.json");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const BALANCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let currentState: {
  model: string;
  contextUsed: number;
  contextMax: number;
  sessionId: string;
  transcriptPath: string;
  cost: SessionCost;
  lastJSONLSize: number;
  pricingMtime: number;
  pricing: PricingConfig;
  balance: BalanceCache | null;
  seenMsgIds: Set<string>;
} = {
  model: "",
  contextUsed: 0,
  contextMax: 200_000,
  sessionId: "",
  transcriptPath: "",
  cost: zeroCost(),
  lastJSONLSize: 0,
  pricingMtime: 0,
  pricing: loadPricing(),
  balance: null,
  seenMsgIds: new Set(),
};

// ─── Pricing helpers ──────────────────────────────────────────────────────────

function loadPricing(): PricingConfig {
  try {
    const raw = fs.readFileSync(PRICING_PATH, "utf8");
    return JSON.parse(raw) as PricingConfig;
  } catch {
    // Minimal fallback if pricing.json is missing
    return {
      models: {},
      fallback: {
        displayName: "DeepSeek",
        aliases: [],
        input: 1,
        output: 2,
        cache_read: 0.02,
        cache_write: 0.02,
      },
    };
  }
}

function maybereloadPricing() {
  try {
    const stat = fs.statSync(PRICING_PATH);
    const mtime = stat.mtimeMs;
    if (mtime !== currentState.pricingMtime) {
      currentState.pricing = loadPricing();
      currentState.pricingMtime = mtime;
    }
  } catch {
    // pricing.json missing, keep existing
  }
}

function resolveModel(rawModel: string): ModelPricing {
  const { models, fallback } = currentState.pricing;
  const key = rawModel?.toLowerCase() ?? "";

  // Direct key match
  if (models[key]) return models[key];

  // Alias match
  for (const m of Object.values(models)) {
    if (m.aliases.some((a) => key.includes(a.toLowerCase()))) return m;
  }

  // Partial key match (e.g. "deepseek-v4" matches "deepseek-v4-flash")
  for (const [modelKey, m] of Object.entries(models)) {
    if (key.includes(modelKey) || modelKey.includes(key)) return m;
  }

  return fallback;
}

function calcTurnCost(
  usage: TranscriptEntry["usage"],
  pricing: ModelPricing
): number {
  if (!usage) return 0;
  const inp = (usage.input_tokens ?? 0) / 1_000_000;
  const out = (usage.output_tokens ?? 0) / 1_000_000;
  const cr = (usage.cache_read_input_tokens ?? 0) / 1_000_000;
  const cw = (usage.cache_creation_input_tokens ?? 0) / 1_000_000;
  return (
    inp * pricing.input +
    out * pricing.output +
    cr * pricing.cache_read +
    cw * pricing.cache_write
  );
}

function zeroCost(): SessionCost {
  return {
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    lastTurnCost: 0,
    lastTurnInputTokens: 0,
    lastTurnOutputTokens: 0,
  };
}

// ─── Transcript reader ────────────────────────────────────────────────────────

function findActiveTranscript(sessionId: string): string {
  // Claude Code stores transcripts in ~/.claude/projects/**/<session-id>.jsonl
  // Also check currentState.transcriptPath set from stdin
  if (currentState.transcriptPath && fs.existsSync(currentState.transcriptPath)) {
    return currentState.transcriptPath;
  }

  if (!sessionId) return "";

  try {
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    const found = findFileRecursive(projectsDir, `${sessionId}.jsonl`);
    return found ?? "";
  } catch {
    return "";
  }
}

function findFileRecursive(dir: string, filename: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      } else if (entry.name === filename) {
        return full;
      }
    }
  } catch {
    // ignore permission errors
  }
  return null;
}

function readNewTranscriptEntries(transcriptPath: string): TranscriptEntry[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    const stat = fs.statSync(transcriptPath);
    const currentSize = stat.size;

    if (currentSize <= currentState.lastJSONLSize) return [];

    const fd = fs.openSync(transcriptPath, "r");
    const bufSize = currentSize - currentState.lastJSONLSize;
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, currentState.lastJSONLSize);
    fs.closeSync(fd);
    currentState.lastJSONLSize = currentSize;

    const newLines = buf.toString("utf8").split("\n").filter(Boolean);
    const entries: TranscriptEntry[] = [];
    for (const line of newLines) {
      try {
        entries.push(JSON.parse(line) as TranscriptEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function processNewEntries(entries: TranscriptEntry[]) {
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;

    // Extract usage: prefer entry.message.usage, fall back to entry.usage
    const usage = entry.message?.usage ?? entry.usage;
    if (!usage) continue;

    // Deduplicate by message ID (same turn has thinking + text entries)
    const msgId = entry.message?.id ?? entry.uuid;
    if (msgId) {
      if (currentState.seenMsgIds.has(msgId)) continue;
      currentState.seenMsgIds.add(msgId);
      // Keep the set from growing unbounded
      if (currentState.seenMsgIds.size > 1000) {
        const arr = Array.from(currentState.seenMsgIds);
        currentState.seenMsgIds = new Set(arr.slice(arr.length - 500));
      }
    }

    const rawModel = entry.message?.model ?? entry.model ?? currentState.model;
    const pricing = resolveModel(rawModel);

    const inp = usage.input_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? 0;
    const cw = usage.cache_creation_input_tokens ?? 0;
    const turnCost = calcTurnCost(usage, pricing);

    currentState.cost.inputTokens += inp;
    currentState.cost.outputTokens += out;
    currentState.cost.cacheReadTokens += cr;
    currentState.cost.cacheWriteTokens += cw;
    currentState.cost.totalCost += turnCost;
    currentState.cost.lastTurnCost = turnCost;
    currentState.cost.lastTurnInputTokens = inp;
    currentState.cost.lastTurnOutputTokens = out;

    // Cache hit rate: cache_read / (input + cache_read)
    const totalInput = currentState.cost.inputTokens + currentState.cost.cacheReadTokens;
    currentState.cost.cacheHitRate =
      totalInput > 0
        ? Math.round((currentState.cost.cacheReadTokens / totalInput) * 100)
        : 0;
  }
}

// ─── Balance API ──────────────────────────────────────────────────────────────

function readApiKey(): string {
  // Prefer settings.json (the user's real API key). Claude Code sets env vars
  // from its env block before running the statusLine command, but those may be
  // proxy tokens that don't work for the balance endpoint.
  try {
    const settingsPath = path.join(CLAUDE_DIR, "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const key = settings?.env?.ANTHROPIC_AUTH_TOKEN;
    if (key) return key;
  } catch {
    // fall through
  }

  // Fall back to environment variable
  return process.env.ANTHROPIC_AUTH_TOKEN ?? "";
}

function loadBalanceCache(): BalanceCache | null {
  try {
    const raw = fs.readFileSync(BALANCE_CACHE_PATH, "utf8");
    const cache = JSON.parse(raw) as BalanceCache;
    if (Date.now() - cache.fetchedAt < BALANCE_TTL_MS) {
      return cache;
    }
  } catch {
    // cache miss or corrupt
  }
  return null;
}

function saveBalanceCache(balance: BalanceCache) {
  try {
    fs.writeFileSync(BALANCE_CACHE_PATH, JSON.stringify(balance), "utf8");
  } catch {
    // non-critical
  }
}

function fetchBalance(apiKey: string): Promise<BalanceCache | null> {
  return new Promise((resolve) => {
    const req = https.get("https://api.deepseek.com/user/balance", {
      timeout: 5000,
      headers: {
        "Accept": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data) as {
              is_available?: boolean;
              balance_infos?: BalanceInfo[];
            };
            const balance: BalanceCache = {
              available: json.is_available ?? false,
              infos: json.balance_infos ?? [],
              fetchedAt: Date.now(),
            };
            saveBalanceCache(balance);
            resolve(balance);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  brightBlue: "\x1b[94m",
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  orange: "\x1b[38;5;208m",
};

function c(color: keyof typeof COLORS, text: string): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function contextBar(used: number, max: number, width = 10): string {
  if (max <= 0) return "".padEnd(width, "░");
  const pct = Math.min(used / max, 1);
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  if (pct >= 0.85) return c("red", bar);
  if (pct >= 0.65) return c("yellow", bar);
  return c("dim", bar);
}

function formatCost(cny: number): string {
  if (cny === 0) return "¥0";
  if (cny < 0.001) return `<¥${cny.toFixed(4)}`;
  if (cny < 0.01) return `¥${cny.toFixed(4)}`;
  if (cny < 0.1) return `¥${cny.toFixed(3)}`;
  if (cny < 1.0) return `¥${cny.toFixed(2)}`;
  return `¥${cny.toFixed(2)}`;
}

function formatCostColor(cny: number): string {
  if (cny === 0) return c("dim", "¥0");
  if (cny < 0.01) return c("dim", formatCost(cny));
  if (cny < 1.0) return c("green", formatCost(cny));
  if (cny < 7.0) return c("yellow", formatCost(cny));
  return c("orange", formatCost(cny));
}

// Reasonix-style short token format: 88400 → "88.4k", 1000000 → "1.0M"
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function getModelLabel(): string {
  const rawModel = currentState.model;
  if (!rawModel) return c("dim", "?");

  const pricing = resolveModel(rawModel);
  const name = pricing.displayName;
  return c("dim", name);
}

function formatBalance(balance: BalanceCache | null): string {
  if (!balance || balance.infos.length === 0) return "";

  // Prefer CNY
  let pick = balance.infos[0];
  for (const info of balance.infos) {
    if (info.currency === "CNY") { pick = info; break; }
  }

  const total = parseFloat(pick.total_balance);
  if (isNaN(total)) return "";

  const sym = pick.currency === "CNY" ? "¥" : pick.currency === "USD" ? "$" : pick.currency + " ";
  return `${sym}${total.toFixed(2)}`;
}

function balanceColor(balance: BalanceCache | null): keyof typeof COLORS {
  if (!balance || balance.infos.length === 0) return "dim";
  let pick = balance.infos[0];
  for (const info of balance.infos) {
    if (info.currency === "CNY") { pick = info; break; }
  }
  const total = parseFloat(pick.total_balance);
  if (isNaN(total) || total <= 0) return "red";
  if (total < 5) return "yellow";
  return "green";
}

function render(): string {
  const { contextUsed, contextMax, cost, balance } = currentState;
  const pct =
    contextMax > 0 ? Math.round((contextUsed / contextMax) * 100) : 0;
  const sep = c("dim", " · ");

  // ── Model tag (dim) ──
  const modelTag = getModelLabel();

  // ── Cost per turn ──
  const turnCostStr = formatCostColor(cost.lastTurnCost);
  const turnTag = `${turnCostStr}${c("dim", "/轮")}`;

  // ── Cache hit rate ──
  const cacheTag = cost.cacheReadTokens > 0
    ? `${c("dim", "缓存")}${c("brightBlue", ` ${cost.cacheHitRate}%`)}`
    : "";

  // ── Context: percentage + token counts ──
  const ctxColor: keyof typeof COLORS =
    pct >= 85 ? "red" : pct >= 60 ? "yellow" : "dim";
  const ctxTag = `${c("dim", "上下文")} ${c(ctxColor, `${pct}%`)}${c("dim", ` · ${shortTokens(contextUsed)}/${shortTokens(contextMax)}`)}`;

  // ── Spending: spent / remaining ──
  const spentStr = formatCost(cost.totalCost);
  const balStr = formatBalance(balance);
  const balClr = balanceColor(balance);
  const spendTag = balStr
    ? `${c("dim", "已花费")} ${c("green", spentStr)}${c("dim", " / 剩余")} ${c(balClr, balStr)}`
    : `${c("dim", "已花费")} ${c("green", spentStr)}`;

  // ── Assemble: model · ¥X/轮 · [缓存 XX% ·] 上下文 X% · tokens · 已花费 / 剩余 ──
  const parts: string[] = [
    modelTag,
    turnTag,
  ];
  if (cacheTag) parts.push(cacheTag);
  parts.push(ctxTag);
  parts.push(spendTag);

  return parts.join(sep);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function tick() {
  // Reload pricing if file changed (no restart needed)
  maybereloadPricing();

  // Find and read new transcript entries
  const tPath = findActiveTranscript(currentState.sessionId);
  if (tPath) {
    const newEntries = readNewTranscriptEntries(tPath);
    if (newEntries.length > 0) {
      processNewEntries(newEntries);
    }
  }

  // Output the statusline
  const output = render();
  process.stdout.write(output + "\n");
}

function applyStdinEvent(event: StdinEvent) {
  if (event.model) {
    if (typeof event.model === 'string') {
      currentState.model = event.model;
    } else if (typeof event.model === 'object' && event.model !== null) {
      currentState.model = (event.model as {id?: string; display_name?: string}).id
        ?? (event.model as {id?: string; display_name?: string}).display_name
        ?? '';
    }
  }

  if (event.session_id) {
    if (event.session_id !== currentState.sessionId) {
      currentState.sessionId = event.session_id;
      currentState.cost = zeroCost();
      currentState.lastJSONLSize = 0;
      currentState.transcriptPath = "";
      currentState.seenMsgIds = new Set();
    }
  }

  if (event.transcript_path) {
    if (event.transcript_path !== currentState.transcriptPath) {
      currentState.transcriptPath = event.transcript_path;
      currentState.lastJSONLSize = 0;
    }
  }

  if (event.context_window) {
    const cw = event.context_window;
    if (cw.used_tokens !== undefined) {
      currentState.contextUsed = cw.used_tokens;
      currentState.contextMax = cw.max_tokens ?? 200_000;
    } else if (cw.used_percentage !== undefined) {
      const size = cw.context_window_size ?? 200_000;
      currentState.contextMax = size;
      currentState.contextUsed = Math.round((cw.used_percentage / 100) * size);
    }
  }
}

// ─── Stdin reader (claude-hud style: raw data + timeouts) ─────────────────────

function readStdin(): Promise<StdinEvent | null> {
  const stream = process.stdin;

  // If stdin is a TTY (no pipe), return null immediately
  if (stream.isTTY) {
    return Promise.resolve(null);
  }

  try {
    stream.setEncoding('utf8');
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<StdinEvent | null>((resolve) => {
    let raw = '';
    let settled = false;
    let sawData = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = undefined; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
    };

    const finish = (value: StdinEvent | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const tryParse = (): StdinEvent | null | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed) as StdinEvent;
      } catch {
        return undefined;
      }
    };

    const scheduleIdleParse = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const parsed = tryParse();
        finish(parsed ?? null);
      }, 30); // 30ms idle timeout
    };

    const onData = (chunk: string | Buffer) => {
      sawData = true;
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = undefined; }
      raw += String(chunk);
      if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) { finish(null); return; }

      const parsed = tryParse();
      if (parsed !== undefined) { finish(parsed); return; }
      scheduleIdleParse();
    };

    const onEnd = () => {
      const parsed = tryParse();
      finish(parsed ?? null);
    };

    const onError = () => { finish(null); };

    // 250ms first-byte timeout
    firstByteTimer = setTimeout(() => {
      if (!sawData) finish(null);
    }, 250);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

// ─── Setup command ────────────────────────────────────────────────────────────

function runSetup() {
  const scriptPath = path.resolve(__dirname, "../../dist/src/index.js");
  const settingsPath = path.join(CLAUDE_DIR, "settings.json");

  // Ensure .claude directory exists
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.log("警告: 无法读取 settings.json，将创建新文件");
    }
  }

  // Build the command based on platform
  // On Windows, use double quotes around the path
  // On Unix, single quotes are fine but double quotes work too
  const command = `node "${scriptPath}"`;

  // Update statusLine config
  settings.statusLine = {
    type: "command",
    command: command,
    refreshInterval: 2,
  };

  // Write back
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  console.log("✓ 已配置 Claude Code statusLine");
  console.log(`  脚本路径: ${scriptPath}`);
  console.log(`  配置文件: ${settingsPath}`);
  console.log("");
  console.log("重新启动 Claude Code 即可看到效果。");
  console.log("");
  console.log("statusLine 显示:");
  console.log("  模型名 · ¥X/轮 · 缓存 XX% · 上下文 X% · tokens · 已花费 / 剩余余额");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const event = await readStdin();
  if (event) {
    applyStdinEvent(event);
  }

  // Load balance: try cache first, fetch from API if stale
  const cached = loadBalanceCache();
  if (cached) {
    currentState.balance = cached;
  } else {
    const apiKey = readApiKey();
    if (apiKey) {
      const fresh = await fetchBalance(apiKey);
      if (fresh) currentState.balance = fresh;
    }
  }

  tick();
  process.exit(0);
}

// Handle graceful exit
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Check for CLI commands
if (process.argv.includes("--setup") || process.argv.includes("-s")) {
  runSetup();
  process.exit(0);
} else if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("claude-deepseek-hud — DeepSeek API 状态栏 for Claude Code");
  console.log("");
  console.log("用法:");
  console.log("  claude-deepseek-hud --setup    自动配置 Claude Code statusLine");
  console.log("  claude-deepseek-hud --help     显示帮助");
  console.log("");
  console.log("安装后重新启动 Claude Code 即可看到状态栏。");
  process.exit(0);
} else {
  main();
}

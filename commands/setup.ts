#!/usr/bin/env node
/**
 * /claude-deepseek-hud:setup
 * Writes the statusLine config into ~/.claude/settings.json
 * and explains what to do next.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
// __dirname is dist/commands/, project root is two levels up
const PLUGIN_DIR = path.resolve(__dirname, "../..");
const INDEX_JS = path.join(PLUGIN_DIR, "dist", "src", "index.js");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>) {
  ensureDir(path.dirname(CLAUDE_SETTINGS));
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

function main() {
  console.log("\n🚀 claude-deepseek-hud setup\n");

  if (!fs.existsSync(INDEX_JS)) {
    console.error(
      `❌ Built file not found: ${INDEX_JS}\n   Run: npm run build\n`
    );
    process.exit(1);
  }

  const settings = loadSettings();

  const statusLineCmd = `node "${INDEX_JS}"`;

  settings.statusLine = {
    type: "command",
    command: statusLineCmd,
  };

  saveSettings(settings);

  console.log("✅ statusLine configured in ~/.claude/settings.json");
  console.log(`   Command: ${statusLineCmd}\n`);
  console.log("📝 Next steps:");
  console.log("   1. Restart Claude Code (fully quit and reopen)");
  console.log("   2. Start a session using DeepSeek as your backend");
  console.log("   3. The HUD will appear below your input\n");
  console.log("💡 To update DeepSeek pricing:");
  console.log(`   Edit: ${path.join(PLUGIN_DIR, "pricing.json")}`);
  console.log("   No restart needed — changes apply on next HUD refresh\n");
}

main();

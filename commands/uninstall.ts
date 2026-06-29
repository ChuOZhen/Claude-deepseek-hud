#!/usr/bin/env node
/**
 * /claude-deepseek-hud:uninstall
 * Removes the statusLine entry from ~/.claude/settings.json
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CLAUDE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

function main() {
  console.log("\n🗑️  claude-deepseek-hud uninstall\n");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch {
    console.log("⚠️  ~/.claude/settings.json not found — nothing to remove.\n");
    return;
  }

  if (!settings.statusLine) {
    console.log("ℹ️  No statusLine entry found — already clean.\n");
    return;
  }

  delete settings.statusLine;
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");

  console.log("✅ statusLine removed from ~/.claude/settings.json");
  console.log("   Restart Claude Code to apply.\n");
}

main();

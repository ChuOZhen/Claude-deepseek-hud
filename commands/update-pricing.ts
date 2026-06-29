#!/usr/bin/env node
/**
 * /claude-deepseek-hud:update-pricing  (or: npm run update-pricing)
 *
 * Interactive tool to update pricing.json when DeepSeek releases new models
 * or changes prices. Changes take effect on the next HUD refresh — no restart.
 *
 * Usage:
 *   node dist/commands/update-pricing.js              # show current pricing
 *   node dist/commands/update-pricing.js --edit       # open in $EDITOR
 *   node dist/commands/update-pricing.js --add        # add a new model interactively
 *   node dist/commands/update-pricing.js --set <model> <input> <output> [cache_read] [cache_write]
 */

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as readline from "readline";

// __dirname is dist/commands/ so go up two levels to project root
const PRICING_PATH = path.resolve(__dirname, "../../pricing.json");

interface ModelPricing {
  displayName: string;
  aliases: string[];
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

interface PricingConfig {
  _comment?: string;
  _source?: string;
  _updated?: string;
  models: Record<string, ModelPricing>;
  fallback: ModelPricing & { displayName: string };
  currency: string;
}

function load(): PricingConfig {
  return JSON.parse(fs.readFileSync(PRICING_PATH, "utf8")) as PricingConfig;
}

function save(config: PricingConfig) {
  config._updated = new Date().toISOString().slice(0, 7); // YYYY-MM
  fs.writeFileSync(PRICING_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`✅ Saved to ${PRICING_PATH}`);
  console.log("   Changes will apply on next HUD refresh (no restart needed).\n");
}

function showTable(config: PricingConfig) {
  console.log("\n📊 Current DeepSeek Pricing (CNY ¥ per 1M tokens)");
  console.log(`   Source: ${config._source ?? "unknown"}`);
  console.log(`   Updated: ${config._updated ?? "unknown"}\n`);

  const header = "  Model ID".padEnd(28) + "Input".padStart(10) + "Output".padStart(10) + "Cache R".padStart(10) + "Cache W".padStart(10);
  console.log(header);
  console.log("  " + "─".repeat(66));

  for (const [id, m] of Object.entries(config.models)) {
    const row =
      `  ${id}`.padEnd(28) +
      `¥${m.input}`.padStart(10) +
      `¥${m.output}`.padStart(10) +
      `¥${m.cache_read}`.padStart(10) +
      `¥${m.cache_write}`.padStart(10);
    console.log(row);

    if (m.aliases.length > 0) {
      console.log(`  ${"  aliases: " + m.aliases.join(", ")}`.padEnd(68));
    }
  }
  console.log("  " + "─".repeat(66));
  const f = config.fallback;
  const fallrow =
    `  (fallback)`.padEnd(28) +
    `¥${f.input}`.padStart(10) +
    `¥${f.output}`.padStart(10) +
    `¥${f.cache_read}`.padStart(10) +
    `¥${f.cache_write}`.padStart(10);
  console.log(fallrow);
  console.log();
}

async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function addModel(config: PricingConfig) {
  console.log("\n➕ Add a new model to pricing.json\n");

  const id = await promptLine("Model ID (e.g. deepseek-v5-flash): ");
  if (!id) { console.log("Cancelled."); return; }

  const displayName = await promptLine(`Display name [${id}]: `) || id;
  const aliasesRaw = await promptLine("Aliases (comma-separated, or blank): ");
  const aliases = aliasesRaw ? aliasesRaw.split(",").map((a) => a.trim()) : [];

  const inputStr = await promptLine("Input price (¥/1M tokens): ");
  const outputStr = await promptLine("Output price (¥/1M tokens): ");
  const crStr = await promptLine("Cache-read price (¥/1M, enter for 20% of input): ");
  const cwStr = await promptLine("Cache-write price (¥/1M, enter for 2x input): ");

  const input = parseFloat(inputStr);
  const output = parseFloat(outputStr);
  const cache_read = crStr ? parseFloat(crStr) : +(input * 0.2).toFixed(4);
  const cache_write = cwStr ? parseFloat(cwStr) : +(input * 2).toFixed(4);

  if (isNaN(input) || isNaN(output)) {
    console.error("❌ Invalid price values.");
    return;
  }

  config.models[id] = { displayName, aliases, input, output, cache_read, cache_write };
  save(config);
  console.log(`✅ Added model: ${id}\n`);
}

async function setModel(args: string[], config: PricingConfig) {
  // --set <model-id> <input> <output> [cache_read] [cache_write]
  const [modelId, inputStr, outputStr, crStr, cwStr] = args;
  if (!modelId || !inputStr || !outputStr) {
    console.error("Usage: --set <model-id> <input> <output> [cache_read] [cache_write]");
    process.exit(1);
  }

  const input = parseFloat(inputStr);
  const output = parseFloat(outputStr);
  const cache_read = crStr ? parseFloat(crStr) : +(input * 0.2).toFixed(4);
  const cache_write = cwStr ? parseFloat(cwStr) : +(input * 2).toFixed(4);

  if (config.models[modelId]) {
    config.models[modelId].input = input;
    config.models[modelId].output = output;
    config.models[modelId].cache_read = cache_read;
    config.models[modelId].cache_write = cache_write;
    console.log(`✅ Updated ${modelId}`);
  } else {
    config.models[modelId] = {
      displayName: modelId,
      aliases: [],
      input,
      output,
      cache_read,
      cache_write,
    };
    console.log(`✅ Added ${modelId}`);
  }

  save(config);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args[0];
  const config = load();

  if (!flag || flag === "--show") {
    showTable(config);
    console.log("Options:");
    console.log("  --edit           Open pricing.json in $EDITOR");
    console.log("  --add            Add a new model interactively");
    console.log("  --set <id> <in> <out> [cr] [cw]  Update prices for a model\n");
    return;
  }

  if (flag === "--edit") {
    const editor = process.env.EDITOR ?? "nano";
    console.log(`Opening ${PRICING_PATH} in ${editor}...\n`);
    child_process.spawnSync(editor, [PRICING_PATH], { stdio: "inherit" });
    return;
  }

  if (flag === "--add") {
    await addModel(config);
    return;
  }

  if (flag === "--set") {
    await setModel(args.slice(1), config);
    return;
  }

  console.error(`Unknown flag: ${flag}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

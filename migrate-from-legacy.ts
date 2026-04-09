#!/usr/bin/env npx tsx
/**
 * Migrate from legacy agent → Agent Platform
 *
 * Extracts: personality, memories, secrets, config, workspace
 * Run: npx tsx migrate-legacy agent.ts [legacy agent-home-dir]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { Database } from "better-sqlite3"; // Will need: pnpm add better-sqlite3

// ============================================================
// Config
// ============================================================
const legacy agent_HOME = process.argv[2] ?? findlegacy agentHome();
const PLATFORM_DIR = process.env.INSTALL_DIR ?? "/opt/agent-platform";
const SOUL_DIR = join(PLATFORM_DIR, "agent-soul");
const ENV_PATH = join(PLATFORM_DIR, ".env");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

function log(msg: string) { console.log(`${GREEN}[✓]${NC} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}[!]${NC} ${msg}`); }
function err(msg: string) { console.log(`${RED}[✗]${NC} ${msg}`); }

const stats = { found: 0, migrated: 0, skipped: 0, errors: 0 };

// ============================================================
// Find legacy agent installation
// ============================================================
function findlegacy agentHome(): string {
  const candidates = [
    join(process.env.HOME ?? "", ".legacy agent"),
    "/home/user/.legacy agent",
    join(process.cwd(), ".legacy agent"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "legacy agent.json"))) return c;
  }
  console.error("Could not find legacy agent installation. Pass the path as argument:");
  console.error("  npx tsx migrate-legacy agent.ts /path/to/.legacy agent");
  process.exit(1);
}

// ============================================================
// Main
// ============================================================
console.log(`
╔══════════════════════════════════════════╗
║  legacy agent → Agent Platform Migration     ║
╚══════════════════════════════════════════╝
`);
console.log(`legacy agent home: ${legacy agent_HOME}`);
console.log(`Agent Platform: ${PLATFORM_DIR}`);
console.log("");

mkdirSync(SOUL_DIR, { recursive: true });
mkdirSync(join(SOUL_DIR, "memory"), { recursive: true });

// ============================================================
// 1. Personality (SOUL.md + USER.md)
// ============================================================
console.log("━━━ 1. Personality ━━━");

const soulPaths = [
  join(legacy agent_HOME, "workspace", "SOUL.md"),
  join(legacy agent_HOME, "workspace-codex", "SOUL.md"),
];

for (const sp of soulPaths) {
  if (existsSync(sp)) {
    const dest = join(SOUL_DIR, `SOUL-${basename(sp, ".md")}-${basename(join(sp, ".."))}.md`);
    copyFileSync(sp, join(SOUL_DIR, "SOUL.md"));
    stats.found++; stats.migrated++;
    log(`SOUL.md found and copied (${(readFileSync(sp, "utf-8").length / 1024).toFixed(1)}KB)`);
    break;
  }
}

const userPaths = [
  join(legacy agent_HOME, "workspace", "USER.md"),
];
for (const up of userPaths) {
  if (existsSync(up)) {
    copyFileSync(up, join(SOUL_DIR, "USER.md"));
    stats.found++; stats.migrated++;
    log("USER.md found and copied");
    break;
  }
}

// ============================================================
// 2. Memories (SQLite → text files + optionally Postgres)
// ============================================================
console.log("\n━━━ 2. Memories ━━━");

const memoryDb = join(legacy agent_HOME, "memory", "main.sqlite");
if (existsSync(memoryDb)) {
  stats.found++;
  try {
    // Use sqlite3 CLI since better-sqlite3 might not be installed
    const tables = execSync(`sqlite3 "${memoryDb}" ".tables"`, { timeout: 5000 }).toString().trim();
    log(`Memory database found (tables: ${tables.replace(/\s+/g, ", ")})`);

    // Extract all memory chunks as text files
    const chunks = execSync(
      `sqlite3 "${memoryDb}" "SELECT path, text FROM chunks ORDER BY path, start_line;"`,
      { timeout: 30000, maxBuffer: 50 * 1024 * 1024 }
    ).toString();

    const memoryFiles = new Map<string, string[]>();
    for (const line of chunks.split("\n")) {
      const sep = line.indexOf("|");
      if (sep < 0) continue;
      const path = line.slice(0, sep);
      const text = line.slice(sep + 1);
      const existing = memoryFiles.get(path) ?? [];
      existing.push(text);
      memoryFiles.set(path, existing);
    }

    let memCount = 0;
    for (const [path, texts] of memoryFiles) {
      const safePath = path.replace(/[^a-zA-Z0-9_\-./]/g, "_");
      const destDir = join(SOUL_DIR, "memory", safePath.includes("/") ? safePath.split("/").slice(0, -1).join("/") : "");
      mkdirSync(destDir, { recursive: true });
      const destFile = join(SOUL_DIR, "memory", safePath);
      writeFileSync(destFile, texts.join("\n\n"));
      memCount++;
    }

    log(`Extracted ${memCount} memory files (${memoryFiles.size} unique paths)`);
    stats.migrated++;

    // Copy raw SQLite too for vector re-embedding later
    copyFileSync(memoryDb, join(SOUL_DIR, "memory", "legacy agent-memory.sqlite"));
    log("Raw SQLite database copied for re-embedding");

  } catch (e) {
    warn(`Memory extraction partial: ${e instanceof Error ? e.message : e}`);
    // Still copy the raw file
    try {
      copyFileSync(memoryDb, join(SOUL_DIR, "memory", "legacy agent-memory.sqlite"));
      log("Raw SQLite copied (extraction failed, but file preserved)");
      stats.migrated++;
    } catch { stats.errors++; }
  }
} else {
  warn("No memory database found");
}

// ============================================================
// 3. Configuration (legacy agent.json → .env)
// ============================================================
console.log("\n━━━ 3. Configuration ━━━");

const configPath = join(legacy agent_HOME, "legacy agent.json");
if (existsSync(configPath)) {
  stats.found++;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const env = config.env ?? {};
    const channels = config.channels ?? {};

    // Extract Telegram config
    const tgToken = channels.telegram?.botToken ?? "";
    if (tgToken) log(`Telegram bot token found`);

    // Extract API keys
    const keys: Record<string, string> = {};
    const keyMap: Record<string, string> = {
      OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
      ELEVENLABS_API_KEY: "ELEVENLABS_API_KEY",
      GROQ_API_KEY: "GROQ_API_KEY",
      N8N_API_KEY: "N8N_API_KEY",
      GITHUB_TOKEN: "GITHUB_TOKEN",
      COHERE_API_KEY: "COHERE_API_KEY",
      PINECONE_API_KEY: "PINECONE_API_KEY",
      MISTRAL_API_KEY: "MISTRAL_API_KEY",
      OUTSCRAPER_API_KEY: "OUTSCRAPER_API_KEY",
      UNISENDER_API_KEY: "UNISENDER_API_KEY",
      YANDEX_ACCESS_TOKEN: "YANDEX_ACCESS_TOKEN",
      YANDEX_OCR_API_KEY: "YANDEX_OCR_API_KEY",
      YANDEX_STT_API_KEY: "YANDEX_STT_API_KEY",
      YANDEX_CLIENT_ID: "YANDEX_CLIENT_ID",
      YANDEX_CLIENT_SECRET: "YANDEX_CLIENT_SECRET",
      KIE_API_KEY: "KIE_API_KEY",
    };

    let keyCount = 0;
    for (const [src, dest] of Object.entries(keyMap)) {
      if (env[src]) { keys[dest] = env[src]; keyCount++; }
    }
    log(`Found ${keyCount} API keys`);

    // Write to .env (append, don't overwrite)
    const envLines: string[] = [];
    if (tgToken) envLines.push(`# Migrated from legacy agent`, `TELEGRAM_BOT_TOKEN=${tgToken}`);
    for (const [k, v] of Object.entries(keys)) {
      envLines.push(`${k}=${v}`);
    }

    if (envLines.length > 0) {
      const envContent = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
      writeFileSync(ENV_PATH, envContent + "\n\n# --- Migrated from legacy agent ---\n" + envLines.join("\n") + "\n");
      log(`${envLines.length} config values written to .env`);
    }

    // Save model config
    const models = config.models ?? {};
    if (Object.keys(models).length > 0) {
      writeFileSync(join(SOUL_DIR, "legacy agent-models.json"), JSON.stringify(models, null, 2));
      log("Model configuration saved");
    }

    // Save channel configs (system prompts per group)
    if (channels.telegram?.groups) {
      const groups = channels.telegram.groups;
      const groupConfig: Record<string, string> = {};
      for (const [groupId, cfg] of Object.entries(groups) as [string, any][]) {
        if (cfg.systemPrompt) groupConfig[groupId] = cfg.systemPrompt;
      }
      if (Object.keys(groupConfig).length > 0) {
        writeFileSync(join(SOUL_DIR, "group-prompts.json"), JSON.stringify(groupConfig, null, 2));
        log(`${Object.keys(groupConfig).length} group-specific prompts saved`);
      }
    }

    stats.migrated++;
  } catch (e) {
    err(`Config extraction failed: ${e instanceof Error ? e.message : e}`);
    stats.errors++;
  }
} else {
  warn("No legacy agent.json found");
}

// ============================================================
// 4. Secrets
// ============================================================
console.log("\n━━━ 4. Secrets ━━━");

const secretsDirs = [
  join(legacy agent_HOME, "workspace", ".secrets"),
  join(legacy agent_HOME, ".secrets"),
];

let secretCount = 0;
const secretsDir = join(SOUL_DIR, "secrets");
mkdirSync(secretsDir, { recursive: true });

for (const sd of secretsDirs) {
  if (!existsSync(sd)) continue;
  try {
    const files = readdirSync(sd);
    for (const f of files) {
      const src = join(sd, f);
      if (statSync(src).isFile()) {
        copyFileSync(src, join(secretsDir, f));
        secretCount++;
      }
    }
  } catch {}
}

if (secretCount > 0) {
  stats.found++; stats.migrated++;
  log(`${secretCount} secret files copied`);
  warn("Review secrets in agent-soul/secrets/ — remove what you don't need");
} else {
  warn("No secrets found");
}

// ============================================================
// 5. Workspace files
// ============================================================
console.log("\n━━━ 5. Workspace ━━━");

const workspacePath = join(legacy agent_HOME, "workspace");
if (existsSync(workspacePath)) {
  stats.found++;
  // Don't copy everything — just list what's there
  try {
    const items = readdirSync(workspacePath);
    const dirs = items.filter(i => {
      try { return statSync(join(workspacePath, i)).isDirectory(); } catch { return false; }
    });
    const files = items.filter(i => {
      try { return statSync(join(workspacePath, i)).isFile(); } catch { return false; }
    });

    log(`Workspace found: ${dirs.length} directories, ${files.length} files`);
    if (dirs.length > 0) log(`  Directories: ${dirs.join(", ")}`);
    if (files.length > 0) log(`  Files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}`);

    // Save workspace index
    writeFileSync(join(SOUL_DIR, "workspace-index.txt"),
      `legacy agent workspace: ${workspacePath}\n\nDirectories:\n${dirs.map(d => `  ${d}/`).join("\n")}\n\nFiles:\n${files.map(f => `  ${f}`).join("\n")}\n`);
    log("Workspace index saved (files not copied — reference original path)");

    stats.migrated++;
  } catch (e) {
    warn(`Workspace listing failed: ${e instanceof Error ? e.message : e}`);
  }
} else {
  warn("No workspace found");
}

// ============================================================
// 6. Session history (conversation logs)
// ============================================================
console.log("\n━━━ 6. Sessions ━━━");

const sessionsPath = join(legacy agent_HOME, "agents", "main", "sessions");
if (existsSync(sessionsPath)) {
  stats.found++;
  try {
    let sessionCount = 0;
    const countFiles = (dir: string): number => {
      let count = 0;
      for (const item of readdirSync(dir)) {
        const full = join(dir, item);
        try {
          if (statSync(full).isDirectory()) count += countFiles(full);
          else if (item.endsWith(".jsonl")) count++;
        } catch {}
      }
      return count;
    };
    sessionCount = countFiles(sessionsPath);
    log(`${sessionCount} session logs found (kept in original location for reference)`);
    stats.migrated++;
  } catch {
    warn("Could not count sessions");
  }
} else {
  warn("No session logs found");
}

// ============================================================
// 7. Build FULL-CONTEXT.md
// ============================================================
console.log("\n━━━ 7. Assembling agent context ━━━");

const parts: string[] = [];
if (existsSync(join(SOUL_DIR, "SOUL.md"))) {
  parts.push(readFileSync(join(SOUL_DIR, "SOUL.md"), "utf-8"));
}
if (existsSync(join(SOUL_DIR, "USER.md"))) {
  parts.push("\n\n# User Profile\n\n" + readFileSync(join(SOUL_DIR, "USER.md"), "utf-8"));
}

// Add TOOLS.md if exists, otherwise create empty
const toolsPath = join(SOUL_DIR, "TOOLS.md");
if (!existsSync(toolsPath)) {
  writeFileSync(toolsPath, "# Tools & Services\n\nAdd your service credentials and URLs here.\n");
}
parts.push("\n\n" + readFileSync(toolsPath, "utf-8"));

writeFileSync(join(SOUL_DIR, "FULL-CONTEXT.md"), parts.join("\n"));
log("FULL-CONTEXT.md assembled");

// ============================================================
// Summary
// ============================================================
console.log(`
╔══════════════════════════════════════════╗
║          Migration Complete!             ║
╚══════════════════════════════════════════╝

  Found: ${stats.found} data sources
  Migrated: ${stats.migrated}
  Skipped: ${stats.skipped}
  Errors: ${stats.errors}

  Files saved to: ${SOUL_DIR}/
  ├── SOUL.md          — personality
  ├── USER.md          — user profile
  ├── TOOLS.md         — service credentials
  ├── FULL-CONTEXT.md  — assembled context
  ├── memory/          — extracted memories
  ├── secrets/         — credentials (review!)
  ├── group-prompts.json    — per-group system prompts
  ├── workspace-index.txt   — workspace contents
  └── legacy agent-models.json  — model config

  Next steps:
  1. Review secrets/ — remove what you don't need
  2. Edit TOOLS.md — add service URLs and credentials
  3. Run the setup wizard or start the bot
  4. Your agent will have all legacy agent memories and personality
`);

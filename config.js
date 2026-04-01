import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";

export function getClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function findConfigPath() {
  const claudeDir = getClaudeConfigDir();

  const legacyPath = join(claudeDir, ".config.json");
  if (existsSync(legacyPath)) return legacyPath;

  const home = process.env.CLAUDE_CONFIG_DIR || homedir();
  const defaultPath = join(home, ".claude.json");
  if (existsSync(defaultPath)) return defaultPath;

  return null;
}

export function getUserId(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.oauthAccount?.accountUuid ?? config.userID ?? "anon";
}

export function backupConfig(configPath) {
  const dir = dirname(configPath);
  const name = basename(configPath, ".json");
  const backupPath = join(dir, `${name}.backup.json`);
  copyFileSync(configPath, backupPath);
  return backupPath;
}

export function clearCompanion(configPath) {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);
  const hadCompanion = "companion" in config || "companionMuted" in config;
  delete config.companion;
  delete config.companionMuted;
  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  writeFileSync(configPath, JSON.stringify(config, null, indent) + "\n");
  return hadCompanion;
}

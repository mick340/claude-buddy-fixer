import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";
import { ORIGINAL_SALT, SALT_LEN } from "./buddy.js";

export function findBinaryPath() {
  try {
    const allPaths = execSync("which -a claude 2>/dev/null", { encoding: "utf-8" }).trim().split("\n");
    for (const entry of allPaths) {
      try {
        const resolved = realpathSync(entry.trim());
        if (resolved && existsSync(resolved) && statSync(resolved).size > 1_000_000) return resolved;
      } catch {}
    }
  } catch {}

  const versionsDir = join(homedir(), ".local", "share", "claude", "versions");
  if (existsSync(versionsDir)) {
    try {
      const versions = readdirSync(versionsDir)
        .filter((f) => !f.includes(".backup"))
        .sort();
      if (versions.length > 0) return join(versionsDir, versions[versions.length - 1]);
    } catch {}
  }

  return null;
}

export function findCurrentSalt(binaryData) {
  if (binaryData.includes(Buffer.from(ORIGINAL_SALT))) return ORIGINAL_SALT;

  const text = binaryData.toString("utf-8");

  const patterns = [
    new RegExp(`x{${SALT_LEN - 8}}\\d{8}`, "g"),
    new RegExp(`friend-\\d{4}-.{${SALT_LEN - 12}}`, "g"),
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      if (m[0].length === SALT_LEN) return m[0];
    }
  }

  const saltRegex = new RegExp(`"([a-zA-Z0-9_-]{${SALT_LEN}})"`, "g");
  const candidates = new Set();
  const markers = ["rollRarity", "CompanionBones", "inspirationSeed", "companionUserId"];
  for (const marker of markers) {
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) continue;
    const window = text.slice(Math.max(0, markerIdx - 5000), Math.min(text.length, markerIdx + 5000));
    let match;
    while ((match = saltRegex.exec(window)) !== null) {
      candidates.add(match[1]);
    }
  }

  for (const c of candidates) {
    if (/[\d-]/.test(c)) return c;
  }

  return null;
}

export function isClaudeRunning() {
  try {
    const out = execSync("pgrep -af claude 2>/dev/null", { encoding: "utf-8" });
    return out.split("\n").some((line) => !line.includes("buddy-fixer") && line.trim().length > 0);
  } catch {
    return false;
  }
}

export function patchBinary(binaryPath, oldSalt, newSalt) {
  if (oldSalt.length !== newSalt.length) {
    throw new Error(`Salt length mismatch: "${oldSalt}" (${oldSalt.length}) vs "${newSalt}" (${newSalt.length})`);
  }

  const data = readFileSync(binaryPath);
  const oldBuf = Buffer.from(oldSalt);
  const newBuf = Buffer.from(newSalt);

  let count = 0;
  let idx = 0;
  while (true) {
    idx = data.indexOf(oldBuf, idx);
    if (idx === -1) break;
    newBuf.copy(data, idx);
    count++;
    idx += newBuf.length;
  }

  if (count === 0) throw new Error(`Salt "${oldSalt}" not found in binary`);

  writeFileSync(binaryPath, data);
  return count;
}

export function backupBinary(binaryPath) {
  const backupPath = binaryPath + ".backup";
  if (!existsSync(backupPath)) {
    copyFileSync(binaryPath, backupPath);
    return backupPath;
  }
  return null;
}

export function resignBinary(binaryPath) {
  if (platform() !== "darwin") return false;
  try {
    execSync(`codesign -s - --force "${binaryPath}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

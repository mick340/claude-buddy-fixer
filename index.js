#!/usr/bin/env bun

import * as p from "@clack/prompts";
import chalk from "chalk";
import { readFileSync } from "fs";
import { renderSprite, colorizeSprite, RARITY_STARS, RARITY_COLORS } from "./sprites.js";
import {
  SPECIES, RARITIES, RARITY_LABELS, EYES, HATS, STAT_NAMES,
  rollFrom, matches, bruteForce,
} from "./buddy.js";
import { findConfigPath, getUserId, backupConfig, clearCompanion } from "./config.js";
import { findBinaryPath, findCurrentSalt, isClaudeRunning, patchBinary, backupBinary, resignBinary } from "./binary.js";

if (typeof Bun === "undefined") {
  console.error("buddy-fixer requires Bun runtime (uses Bun.hash).\nInstall: https://bun.sh");
  process.exit(1);
}

// Display helpers

function formatCompanionCard(result) {
  const sprite = renderSprite({ species: result.species, eye: result.eye, hat: result.hat });
  const colored = colorizeSprite(sprite, result.rarity);
  const colorFn = chalk[RARITY_COLORS[result.rarity]] ?? chalk.white;
  const stars = RARITY_STARS[result.rarity] ?? "";

  const meta = [];
  meta.push(`${result.species} / ${result.rarity}${result.shiny ? " / shiny" : ""}`);
  meta.push(`eye: ${result.eye} / hat: ${result.hat}`);
  meta.push(stars);

  const lines = [];
  const spriteWidth = 14;
  for (let i = 0; i < colored.length; i++) {
    const right = meta[i] ?? "";
    lines.push(`  ${colored[i]}${" ".repeat(Math.max(0, spriteWidth - sprite[i].length))}${right}`);
  }

  for (const [k, v] of Object.entries(result.stats)) {
    const bar = colorFn("█".repeat(Math.round(v / 10)) + "░".repeat(10 - Math.round(v / 10)));
    lines.push(`  ${k.padEnd(10)} ${bar} ${String(v).padStart(3)}`);
  }

  return lines.join("\n");
}

// Setup

async function setup() {
  const binaryPath = findBinaryPath();
  if (!binaryPath) {
    p.cancel("Could not find Claude Code binary. Is it installed?");
    process.exit(1);
  }

  const configPath = findConfigPath();
  if (!configPath) {
    p.cancel("Could not find Claude Code config file.");
    process.exit(1);
  }

  const userId = getUserId(configPath);
  if (userId === "anon") {
    p.log.warn("No user ID found — using anonymous identity.");
  }

  const binaryData = readFileSync(binaryPath);
  const currentSalt = findCurrentSalt(binaryData);
  if (!currentSalt) {
    p.cancel("Could not find companion salt in binary.");
    process.exit(1);
  }

  const currentBuddy = rollFrom(currentSalt, userId);

  return { binaryPath, configPath, userId, currentSalt, currentBuddy };
}

// Flow: View buddy

function viewBuddy(currentBuddy) {
  p.log.info("Your current buddy:");
  console.log(formatCompanionCard(currentBuddy));
  console.log();
}

// Flow: Delete buddy

async function deleteBuddy(configPath) {
  const confirm = await p.confirm({
    message: "Are you sure you want to delete your buddy? (config will be backed up)",
  });

  if (p.isCancel(confirm) || !confirm) {
    p.log.info("Cancelled.");
    return;
  }

  const backupPath = backupConfig(configPath);
  p.log.success(`Backup saved to ${backupPath}`);

  const hadCompanion = clearCompanion(configPath);
  if (hadCompanion) {
    p.log.success("Buddy data removed from config. Restart Claude Code and run /buddy to get a new one.");
  } else {
    p.log.info("No buddy data found in config — already clean.");
  }
}

// Flow: Customize buddy

async function customizeBuddy(binaryPath, configPath, userId, currentSalt, currentBuddy) {
  const species = await p.select({
    message: "Choose a species:",
    options: SPECIES.map((s) => ({
      value: s,
      label: s,
      hint: s === currentBuddy.species ? "current" : undefined,
    })),
  });
  if (p.isCancel(species)) return;

  const rarity = await p.select({
    message: "Choose a rarity:",
    options: RARITIES.map((r) => ({
      value: r,
      label: RARITY_LABELS[r],
      hint: r === currentBuddy.rarity ? "current" : undefined,
    })),
  });
  if (p.isCancel(rarity)) return;

  const eye = await p.select({
    message: "Choose an eye style:",
    options: EYES.map((e) => ({
      value: e,
      label: e,
      hint: e === currentBuddy.eye ? "current" : undefined,
    })),
  });
  if (p.isCancel(eye)) return;

  const hatOptions = rarity === "common"
    ? [{ value: "none", label: "none", hint: "common buddies don't get hats" }]
    : HATS.map((h) => ({
        value: h,
        label: h,
        hint: h === currentBuddy.hat ? "current" : undefined,
      }));

  const hat = await p.select({
    message: "Choose a hat:",
    options: hatOptions,
  });
  if (p.isCancel(hat)) return;

  const shiny = await p.confirm({
    message: "Shiny? (rare sparkle effect)",
    initialValue: false,
  });
  if (p.isCancel(shiny)) return;

  const anyStatOption = { value: "", label: "any", hint: "don't care" };

  const peakStat = await p.select({
    message: "Highest stat:",
    options: [
      anyStatOption,
      ...STAT_NAMES.map((s) => {
        const currentPeak = Object.entries(currentBuddy.stats).reduce((a, b) => b[1] > a[1] ? b : a)[0];
        return { value: s, label: s, hint: s === currentPeak ? "current" : undefined };
      }),
    ],
  });
  if (p.isCancel(peakStat)) return;

  const dumpStat = await p.select({
    message: "Lowest stat:",
    options: [
      anyStatOption,
      ...STAT_NAMES.filter((s) => s !== peakStat).map((s) => {
        const currentDump = Object.entries(currentBuddy.stats).reduce((a, b) => b[1] < a[1] ? b : a)[0];
        return { value: s, label: s, hint: s === currentDump ? "current" : undefined };
      }),
    ],
  });
  if (p.isCancel(dumpStat)) return;

  const target = { species, rarity, eye, hat, shiny };
  if (peakStat) target.peakStat = peakStat;
  if (dumpStat) target.dumpStat = dumpStat;

  if (matches(currentBuddy, target)) {
    p.log.success("Your buddy already matches these specs!");
    console.log(formatCompanionCard(currentBuddy));
    return;
  }

  const statInfo = [peakStat ? `peak:${peakStat}` : "", dumpStat ? `dump:${dumpStat}` : ""].filter(Boolean).join(" / ");
  p.log.info(`Searching for: ${species} / ${rarity} / eye:${eye} / hat:${hat}${shiny ? " / shiny" : ""}${statInfo ? ` / ${statInfo}` : ""}`);

  if (isClaudeRunning()) {
    p.log.warn("Claude Code appears to be running. Quit it before patching to avoid issues.");
    const proceed = await p.confirm({ message: "Continue anyway?" });
    if (p.isCancel(proceed) || !proceed) return;
  }

  const s = p.spinner();
  s.start("Brute-forcing a matching salt...");

  const found = await bruteForce(userId, target, (checked, elapsed) => {
    s.message(`Checked ${checked.toLocaleString()} salts (${(elapsed / 1000).toFixed(0)}s)...`);
  });

  if (!found) {
    s.stop("No match found");
    p.log.error("Could not find a matching salt. Try relaxing some constraints.");
    return;
  }

  s.stop(`Found in ${found.checked.toLocaleString()} attempts (${(found.elapsed / 1000).toFixed(1)}s)`);

  p.log.info("Preview of your new buddy:");
  console.log(formatCompanionCard(found.result));
  console.log();

  const apply = await p.confirm({ message: "Apply this buddy?" });
  if (p.isCancel(apply) || !apply) {
    p.log.info("Cancelled — no changes made.");
    return;
  }

  const binaryBackup = backupBinary(binaryPath);
  if (binaryBackup) {
    p.log.info(`Binary backup: ${binaryBackup}`);
  }

  const configBackup = backupConfig(configPath);
  p.log.info(`Config backup: ${configBackup}`);

  const patchCount = patchBinary(binaryPath, currentSalt, found.salt);
  p.log.success(`Patched ${patchCount} occurrence(s) in binary`);

  if (resignBinary(binaryPath)) {
    p.log.success("Binary re-signed (ad-hoc codesign)");
  }

  clearCompanion(configPath);
  p.log.success("Companion data cleared from config");

  p.log.success("Done! Restart Claude Code and run /buddy to see your new companion.");
}

// Main

async function main() {
  p.intro(chalk.bold("buddy-fixer"));

  const { binaryPath, configPath, userId, currentSalt, currentBuddy } = await setup();

  p.log.info(`Binary: ${binaryPath}`);
  p.log.info(`Config: ${configPath}`);

  const action = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "view", label: "View current buddy", hint: "see your buddy's stats and sprite" },
      { value: "customize", label: "Customize buddy", hint: "choose species, rarity, eyes, hat, shiny" },
      { value: "delete", label: "Delete buddy", hint: "remove buddy data from config (with backup)" },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Bye!");
    process.exit(0);
  }

  switch (action) {
    case "view":
      viewBuddy(currentBuddy);
      break;
    case "customize":
      await customizeBuddy(binaryPath, configPath, userId, currentSalt, currentBuddy);
      break;
    case "delete":
      await deleteBuddy(configPath);
      break;
  }

  p.outro("Thanks for using buddy-fixer!");
}

main();

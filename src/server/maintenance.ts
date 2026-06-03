import { readdirSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_KEEP = 3;

function numEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function rotateLogFiles() {
  const maxBytes = numEnv("LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES);
  const keep = Math.max(1, Math.floor(numEnv("LOG_KEEP_FILES", DEFAULT_LOG_KEEP)));
  const roots = [resolve("."), resolve("./data")];

  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".log")) continue;
      const file = join(root, entry);
      try {
        const stats = statSync(file);
        if (!stats.isFile() || stats.size <= maxBytes) continue;
        rotateOne(file, keep);
      } catch {
        continue;
      }
    }
  }
}

function rotateOne(file: string, keep: number) {
  for (let index = keep; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    const to = `${file}.${index}`;
    try {
      if (index === keep) unlinkSync(to);
    } catch {
      // Old rotation may not exist.
    }
    try {
      renameSync(from, to);
    } catch {
      // Active log files can be locked on Windows. Truncating is safer than filling disk.
      if (index === 1) {
        try {
          truncateSync(file, 0);
        } catch {
          // Nothing else to do without risking the running process.
        }
      }
    }
  }
}

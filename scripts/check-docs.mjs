import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
]);

function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(absolute));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(absolute);
    }
  }
  return files;
}

function githubSlug(source) {
  return source
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/[\x60*_~]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Mark}\p{Number}\p{Connector_Punctuation}\s-]/gu, "")
    .replace(/\s/gu, "-");
}

const anchorCache = new Map();

function anchorsFor(file) {
  const cached = anchorCache.get(file);
  if (cached !== undefined) return cached;

  const anchors = new Set();
  const occurrences = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/gu)) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading === null) continue;
    const base = githubSlug(heading[1]);
    if (base.length === 0) continue;
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    anchors.add(seen === 0 ? base : base + "-" + seen);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function decode(value, file, line, failures) {
  try {
    return decodeURIComponent(value);
  } catch {
    failures.push(file + ":" + line + " contains invalid URL encoding: " + value);
    return undefined;
  }
}

function checkFences(file, text, failures) {
  let open;
  const lines = text.split(/\r?\n/gu);
  for (const [index, line] of lines.entries()) {
    const fence = /^ {0,3}(\x60{3,}|~{3,})/u.exec(line);
    if (fence === null) continue;
    if (open === undefined) {
      open = { character: fence[1][0], length: fence[1].length, line: index + 1 };
    } else if (
      fence[1][0] === open.character &&
      fence[1].length >= open.length
    ) {
      open = undefined;
    }
  }
  if (open !== undefined) {
    failures.push(file + ":" + open.line + " has an unclosed Markdown fence");
  }
}

const markdownFiles = collectMarkdownFiles(root).sort();
const failures = [];
let checkedLinks = 0;

for (const absoluteFile of markdownFiles) {
  const file = relative(root, absoluteFile);
  const text = readFileSync(absoluteFile, "utf8");
  checkFences(file, text, failures);

  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const line = lineNumberAt(text, match.index);
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.replace(/\s+["'][^"']*["']\s*$/u, "");
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    checkedLinks += 1;

    const hash = target.indexOf("#");
    const rawPath = hash === -1 ? target : target.slice(0, hash);
    const rawFragment = hash === -1 ? undefined : target.slice(hash + 1);
    const decodedPath = decode(rawPath, file, line, failures);
    if (decodedPath === undefined) continue;
    const destination = decodedPath.length === 0
      ? absoluteFile
      : resolve(dirname(absoluteFile), decodedPath);

    if (!existsSync(destination)) {
      failures.push(file + ":" + line + " points to missing path: " + target);
      continue;
    }
    if (
      rawFragment === undefined ||
      rawFragment.length === 0 ||
      !statSync(destination).isFile() ||
      extname(destination) !== ".md"
    ) {
      continue;
    }

    const fragment = decode(rawFragment, file, line, failures);
    if (
      fragment !== undefined &&
      !anchorsFor(destination).has(fragment.toLowerCase())
    ) {
      failures.push(file + ":" + line + " points to missing heading: " + target);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    "docs ok: " + markdownFiles.length + " Markdown files, " + checkedLinks + " local links\n",
  );
}

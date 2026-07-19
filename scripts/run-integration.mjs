import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabaseUrl =
  "postgres://akep:akep-local-only@localhost:5432/akep";
const suppliedDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
let databaseUrl = suppliedDatabaseUrl || defaultDatabaseUrl;
const manageComposeDatabase = suppliedDatabaseUrl === undefined || suppliedDatabaseUrl.length === 0;
const keepDatabase = process.env.AKEP_KEEP_TEST_DATABASE === "true";
let startedPostgres = false;
let disposableDatabaseName = null;

try {
  if (manageComposeDatabase) {
    const runningServices = await capture("docker", [
      "compose",
      "ps",
      "--status",
      "running",
      "--services",
    ]);
    startedPostgres = !runningServices.split(/\r?\n/u).includes("postgres");
    await run("docker", ["compose", "up", "-d", "postgres", "--wait"]);
    disposableDatabaseName = `akep_test_${randomUUID().replaceAll("-", "")}`;
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "createdb",
      "--username",
      "akep",
      disposableDatabaseName,
    ]);
    const isolatedUrl = new URL(defaultDatabaseUrl);
    isolatedUrl.pathname = `/${disposableDatabaseName}`;
    databaseUrl = isolatedUrl.toString();
  }

  await run(
    packageManagerCommand(),
    ["--filter", "@akep/core", "db:migrate"],
    { DATABASE_URL: databaseUrl },
  );
  await run(
    packageManagerCommand(),
    ["--filter", "@akep/core", "test"],
    { TEST_DATABASE_URL: databaseUrl },
  );
} finally {
  if (disposableDatabaseName !== null && !keepDatabase) {
    await run("docker", [
      "compose",
      "exec",
      "-T",
      "postgres",
      "dropdb",
      "--force",
      "--username",
      "akep",
      disposableDatabaseName,
    ], {}, false);
  } else if (disposableDatabaseName !== null) {
    process.stderr.write(`[integration] retained isolated database ${disposableDatabaseName}\n`);
  }
  if (startedPostgres && !keepDatabase) {
    await run("docker", ["compose", "stop", "postgres"], {}, false);
  }
}

function packageManagerCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else reject(commandError(command, args, code, signal));
    });
  });
}

async function run(command, args, extraEnvironment = {}, required = true) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    child.on("error", (error) => {
      if (required) reject(error);
      else resolvePromise();
    });
    child.on("exit", (code, signal) => {
      if (code === 0 || !required) resolvePromise();
      else reject(commandError(command, args, code, signal));
    });
  });
}

function commandError(command, args, code, signal) {
  const reason = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
  return new Error(`${command} ${args.join(" ")} failed with ${reason}`);
}

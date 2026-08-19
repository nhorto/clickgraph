/**
 * Shared plumbing for the eval harnesses: start an app server, wait for it,
 * run the clickgraph CLI, and kill process trees without leaking servers.
 *
 * Plain Node, no dependencies, cross-platform (the long runs happen on
 * whatever machine is free, not necessarily the one this was written on).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const evalDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(evalDir, '..');
export const cliPath = join(repoRoot, 'dist', 'cli.js');
export const resultsDir = join(evalDir, 'results');

export function requireCli() {
  if (!existsSync(cliPath)) {
    console.error('error: dist/cli.js not found — run `npm run build` first');
    process.exit(2);
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a shell command as a long-lived server process. */
export function startServer(command, cwd, env = {}) {
  const child = spawn(command, {
    shell: true,
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group on POSIX so the whole tree can be killed. On Windows
    // taskkill /T does the same job without a group.
    detached: process.platform !== 'win32',
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, output: () => output };
}

/** Kill a server and everything it spawned. Safe to call twice. */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Poll until the URL answers at all. Any HTTP response counts as up. */
export async function waitReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual' });
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

/**
 * Run the clickgraph CLI synchronously and parse its --json verdict.
 * A run that printed no JSON (crash, usage error) returns verdict: null.
 */
export function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 20 * 60 * 1000,
  });
  let verdict = null;
  try { verdict = JSON.parse(res.stdout); } catch { /* not JSON — recorded raw */ }
  return { status: res.status, verdict, stdout: res.stdout, stderr: res.stderr };
}

/** Run a setup command (install, build, seed) to completion, streaming nothing. */
export function runStep(command, cwd, env = {}) {
  const res = spawnSync(command, {
    shell: true,
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  return { ok: res.status === 0, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout.trim();
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

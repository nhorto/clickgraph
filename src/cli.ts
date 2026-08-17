#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { walk } from './walker.js';
import { DEFAULT_GRAPH_PATH, diffGraphs, loadGraph, saveGraph } from './graph.js';
import { reportDiff, reportWalk } from './report.js';
import { diffVerdict, walkVerdict } from './verdict.js';
import { captureLogin } from './login.js';
import type { WalkConfig } from './types.js';
import type { WalkOptions } from './walker.js';
import { CLICKGRAPH_VERSION, clickgraphVersionWarning } from './version.js';
import { normalizeRoute } from './fingerprint.js';
import { warnIfStaleLocalBuild } from './build.js';

/** Beside the graph, and gitignored for the same reason the graph is not. */
const DEFAULT_SESSION_PATH = '.uigraph/session.json';

interface Args {
  command: string;
  url?: string;
  out: string;
  json: boolean;
  quiet: boolean;
  maxStates?: number;
  maxActions?: number;
  maxDepth?: number;
  settleMs?: number;
  allowDangerous?: boolean;
  fillForms?: boolean;
  pre?: string;
  storageState?: string;
  expectRoutesPath?: string;
  expectedRoutes?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    out: DEFAULT_GRAPH_PATH,
    json: false,
    quiet: false,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--allow-dangerous') args.allowDangerous = true;
    else if (arg === '--no-allow-dangerous') args.allowDangerous = false;
    else if (arg === '--fill-forms') args.fillForms = true;
    else if (arg === '--no-fill-forms') args.fillForms = false;
    else if (arg === '--pre') args.pre = rest[++i];
    else if (arg === '--out' || arg === '--baseline') args.out = rest[++i];
    else if (arg === '--max-states') args.maxStates = Number(rest[++i]);
    else if (arg === '--max-actions') args.maxActions = Number(rest[++i]);
    else if (arg === '--max-depth') args.maxDepth = Number(rest[++i]);
    else if (arg === '--settle') args.settleMs = Number(rest[++i]);
    else if (arg === '--storage-state') args.storageState = rest[++i];
    else if (arg === '--expect-routes') {
      const path = rest[++i];
      if (!path || path.startsWith('-')) throw new Error('--expect-routes needs a file path');
      args.expectRoutesPath = path;
      args.expectedRoutes = undefined;
    } else if (arg === '--no-expect-routes') {
      args.expectRoutesPath = undefined;
      args.expectedRoutes = [];
    }
    else if (!arg.startsWith('-')) args.url = arg;
  }
  return args;
}

const HELP = `
clickgraph — walk a running web app, graph what its controls actually do

  clickgraph --version        print the running clickgraph build version

  clickgraph walk <url>     explore the app and write the baseline graph
  clickgraph diff <url>     re-walk and compare against the baseline
  clickgraph show           print the stored graph
  clickgraph login <url>    open a browser, wait while you sign in, and save
                            the session for --storage-state to reuse

Options
  --out <path>          graph file (default ${DEFAULT_GRAPH_PATH})
  --baseline <path>     alias of --out, for diff
  --max-states <n>      stop after n distinct states (default 40)
  --max-actions <n>     stop after n clicks (default 200)
  --max-depth <n>       how many clicks deep to explore (default 4)
  --settle <ms>         quiet period with no DOM changes that counts as
                        settled (default 250; raise if your app updates late
                        and working controls look dead)
  --storage-state <p>   session file to walk signed in, or where login should
                        save one (default ${DEFAULT_SESSION_PATH}). It holds
                        live cookies — keep it out of git
  --allow-dangerous     also click delete / logout / pay controls (off by default)
  --no-allow-dangerous  explicitly keep dangerous controls disabled for a diff
  --fill-forms          fill each form with obviously synthetic values and
                        submit it. Off by default: a form that submits
                        successfully writes real data. Without it a form is
                        reported as skipped, never as working
  --no-fill-forms       override a diff baseline that enabled form filling
  --pre <command>       run a shell command before opening the browser; a
                        non-zero exit aborts the walk. Recorded in the graph,
                        but must be repeated explicitly for diff
  --expect-routes <p>   require every route listed in this file (one path per
                        line) to be discovered; missing routes fail the run
  --no-expect-routes    explicitly clear a diff baseline's route expectations
  --json                machine-readable output. walk and diff print a compact
                        verdict built for an agent to read; show prints the
                        whole graph
  --quiet               suppress progress lines
  --version, -v         print the running clickgraph build version

Exit codes
  0  healthy: no regressions, and the app loaded cleanly
  1  regressions found (diff), or the app errored on load / offered
     nothing to walk (walk)
  2  usage or runtime error
`;

const inherited = <T>(explicit: T | undefined, baseline: T | undefined): T | undefined =>
  explicit === undefined ? baseline : explicit;

function readExpectedRoutes(path: string): string[] {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(`expected-routes file ${JSON.stringify(path)} contains no routes`);
  }
  for (const route of lines) {
    if (!route.startsWith('/')) {
      throw new Error(
        `invalid expected route ${JSON.stringify(route)} in ${JSON.stringify(path)} — paths must start with /`,
      );
    }
  }
  return [...new Set(lines.map((route) =>
    normalizeRoute(new URL(route, 'http://clickgraph.invalid').href),
  ))];
}

/**
 * A diff should replay the baseline's coverage settings unless the caller says
 * otherwise. `pre` and `allowDangerous` are intentionally excluded: graph files
 * are data, and merely loading one must never execute a stored command or grant
 * permission to click destructive controls.
 */
function optionsFor(args: Args, baseline?: WalkConfig): WalkOptions {
  return {
    maxStates: inherited(args.maxStates, baseline?.maxStates),
    maxActions: inherited(args.maxActions, baseline?.maxActions),
    maxDepth: inherited(args.maxDepth, baseline?.maxDepth),
    settleMs: inherited(args.settleMs, baseline?.settleMs),
    allowDangerous: args.allowDangerous,
    fillForms: inherited(args.fillForms, baseline?.fillForms),
    storageState: inherited(args.storageState, baseline?.storageState),
    expectedRoutes: inherited(args.expectedRoutes, baseline?.expectedRoutes),
    expectedRoutesFile: args.expectRoutesPath ?? (
      args.expectedRoutes === undefined ? baseline?.expectedRoutesFile : undefined
    ),
    pre: args.pre,
    onProgress: args.quiet || args.json ? undefined : (m: string) => console.error(`  ${m}`),
  };
}

function configWarnings(args: Args, baseline: WalkConfig, url: string): string[] {
  const warnings: string[] = [];
  const compareExplicit = (
    flag: string,
    explicit: string | number | boolean | undefined,
    recorded: string | number | boolean | undefined,
    consequence: string,
  ) => {
    if (explicit !== undefined && explicit !== recorded) {
      warnings.push(
        `${flag} is ${JSON.stringify(explicit)}, but the baseline recorded ` +
        `${JSON.stringify(recorded)} — ${consequence}`,
      );
    }
  };

  if (url !== baseline.baseUrl) {
    warnings.push(
      `URL is ${JSON.stringify(url)}, but the baseline recorded ` +
      `${JSON.stringify(baseline.baseUrl)} — states from different entry points may not be comparable`,
    );
  }
  compareExplicit('--max-states', args.maxStates, baseline.maxStates, 'states may appear or disappear');
  compareExplicit('--max-actions', args.maxActions, baseline.maxActions, 'edges may appear or disappear');
  compareExplicit('--max-depth', args.maxDepth, baseline.maxDepth, 'deeper states may appear or disappear');
  compareExplicit('--settle', args.settleMs, baseline.settleMs, 'late UI changes may be classified differently');
  const effectiveAllowDangerous = args.allowDangerous ?? false;
  if (effectiveAllowDangerous !== baseline.allowDangerous) {
    warnings.push(
      baseline.allowDangerous && args.allowDangerous === undefined
        ? 'the baseline enabled --allow-dangerous, but this diff will keep dangerous controls ' +
          'disabled — repeat --allow-dangerous explicitly if the environment is disposable'
        : `--allow-dangerous is ${effectiveAllowDangerous}, but the baseline recorded ` +
          `${baseline.allowDangerous} — the two runs exercise different controls`,
    );
  }
  compareExplicit(
    '--fill-forms',
    args.fillForms,
    baseline.fillForms,
    'form flows may appear or disappear',
  );
  if (args.expectedRoutes !== undefined) {
    const explicit = JSON.stringify([...args.expectedRoutes].sort());
    const recorded = JSON.stringify([...(baseline.expectedRoutes ?? [])].sort());
    if (explicit !== recorded) {
      warnings.push(
        `--expect-routes resolves to ${explicit}, but the baseline recorded ${recorded} — ` +
        'the two runs assert different route coverage',
      );
    }
  }
  compareExplicit(
    '--storage-state',
    args.storageState,
    baseline.storageState,
    'the two runs may see different authenticated UI',
  );

  if (args.pre !== baseline.pre) {
    if (baseline.pre && args.pre === undefined) {
      warnings.push(
        `the baseline used --pre ${JSON.stringify(baseline.pre)}, but this diff will not run it — ` +
        'repeat --pre explicitly after reviewing the command; stored commands are never auto-executed',
      );
    } else {
      warnings.push(
        `--pre is ${JSON.stringify(args.pre)}, but the baseline recorded ` +
        `${JSON.stringify(baseline.pre)} — persistent app state may make the diff non-deterministic`,
      );
    }
  }
  return warnings;
}

function printConfigWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.error('\nWARNING: diff walk configuration differs from its baseline');
  for (const warning of warnings) console.error(`  - ${warning}`);
  console.error(
    '  Unspecified non-destructive settings inherit the baseline automatically.\n',
  );
}

async function main(): Promise<number> {
  warnIfStaleLocalBuild();
  const args = parseArgs(process.argv.slice(2));

  if (args.command === '--version' || args.command === '-v') {
    console.log(`clickgraph ${CLICKGRAPH_VERSION}`);
    return 0;
  }

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(HELP);
    return 0;
  }

  if ((args.command === 'walk' || args.command === 'diff') && args.expectRoutesPath) {
    args.expectedRoutes = readExpectedRoutes(args.expectRoutesPath);
  }

  if (args.command === 'walk') {
    if (!args.url) {
      console.error('error: walk needs a url\n' + HELP);
      return 2;
    }
    const graph = await walk(args.url, optionsFor(args));
    saveGraph(graph, args.out);
    // A baseline taken from an app that errors on load, or that offered nothing
    // to walk, is not a baseline worth trusting — say so in the exit code.
    // `ok` on the verdict carries the same judgment, so the two cannot drift.
    const verdict = walkVerdict(graph, args.out);
    if (args.json) console.log(JSON.stringify(verdict, null, 2));
    else {
      console.log(reportWalk(graph));
      console.log(`  baseline written to ${args.out}\n`);
    }
    return verdict.ok ? 0 : 1;
  }

  if (args.command === 'diff') {
    if (!args.url) {
      console.error('error: diff needs a url\n' + HELP);
      return 2;
    }
    const baseline = loadGraph(args.out);
    if (!baseline) {
      console.error(`error: no baseline at ${args.out} — run 'clickgraph walk <url>' first`);
      return 2;
    }
    // The resolved list in the graph explains the old run; the manifest is the
    // live expectation. Re-read inert text safely so a newly declared screen
    // cannot be ignored forever by a diff that inherits a frozen old list.
    if (args.expectedRoutes === undefined && baseline.config.expectedRoutesFile) {
      args.expectRoutesPath = baseline.config.expectedRoutesFile;
      args.expectedRoutes = readExpectedRoutes(baseline.config.expectedRoutesFile);
    }
    const warnings = configWarnings(args, baseline.config, args.url);
    printConfigWarnings(warnings);
    const producerWarning = clickgraphVersionWarning(
      baseline.clickgraphVersion,
      CLICKGRAPH_VERSION,
    );
    if (producerWarning) console.error(`NOTE: ${producerWarning}\n`);
    const current = await walk(args.url, optionsFor(args, baseline.config));
    const diff = diffGraphs(baseline, current);
    const verdict = diffVerdict(diff, current, warnings);
    if (args.json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(reportDiff(diff, current, { showVersionWarning: false }));
    return verdict.ok ? 0 : 1;
  }

  if (args.command === 'login') {
    if (!args.url) {
      console.error('error: login needs a url\n' + HELP);
      return 2;
    }
    const out = args.storageState ?? DEFAULT_SESSION_PATH;
    await captureLogin({ url: args.url, out, onMessage: (m) => console.error(`  ${m}`) });
    return 0;
  }

  if (args.command === 'show') {
    const graph = loadGraph(args.out);
    if (!graph) {
      console.error(`error: no graph at ${args.out}`);
      return 2;
    }
    if (args.json) console.log(JSON.stringify(graph, null, 2));
    else console.log(reportWalk(graph));
    return 0;
  }

  console.error(`error: unknown command '${args.command}'\n` + HELP);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });

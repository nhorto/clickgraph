#!/usr/bin/env node
import { walk } from './walker.js';
import { DEFAULT_GRAPH_PATH, diffGraphs, loadGraph, saveGraph } from './graph.js';
import { reportDiff, reportWalk } from './report.js';
import { diffVerdict, walkVerdict } from './verdict.js';
import { captureLogin } from './login.js';

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
  allowDangerous: boolean;
  storageState?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help',
    out: DEFAULT_GRAPH_PATH,
    json: false,
    quiet: false,
    allowDangerous: false,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--allow-dangerous') args.allowDangerous = true;
    else if (arg === '--out' || arg === '--baseline') args.out = rest[++i];
    else if (arg === '--max-states') args.maxStates = Number(rest[++i]);
    else if (arg === '--max-actions') args.maxActions = Number(rest[++i]);
    else if (arg === '--max-depth') args.maxDepth = Number(rest[++i]);
    else if (arg === '--settle') args.settleMs = Number(rest[++i]);
    else if (arg === '--storage-state') args.storageState = rest[++i];
    else if (!arg.startsWith('-')) args.url = arg;
  }
  return args;
}

const HELP = `
clickgraph — walk a running web app, graph what its controls actually do

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
  --json                machine-readable output. walk and diff print a compact
                        verdict built for an agent to read; show prints the
                        whole graph
  --quiet               suppress progress lines

Exit codes
  0  healthy: no regressions, and the app loaded cleanly
  1  regressions found (diff), or the app errored on load / offered
     nothing to walk (walk)
  2  usage or runtime error
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(HELP);
    return 0;
  }

  const walkOptions = {
    maxStates: args.maxStates,
    maxActions: args.maxActions,
    maxDepth: args.maxDepth,
    settleMs: args.settleMs,
    allowDangerous: args.allowDangerous,
    storageState: args.storageState,
    onProgress: args.quiet || args.json ? undefined : (m: string) => console.error(`  ${m}`),
  };

  if (args.command === 'walk') {
    if (!args.url) {
      console.error('error: walk needs a url\n' + HELP);
      return 2;
    }
    const graph = await walk(args.url, walkOptions);
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
    const current = await walk(args.url, walkOptions);
    const diff = diffGraphs(baseline, current);
    const verdict = diffVerdict(diff, current);
    if (args.json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(reportDiff(diff));
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

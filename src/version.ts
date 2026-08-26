import { CLICKGRAPH_BUILD } from './build-stamp.js';

/**
 * The clickgraph build version.
 *
 * Keep this compiled into dist rather than reading package.json at runtime. If
 * source/package.json moves ahead of a stale dist directory, `--version` must
 * report the version of the code that will actually run. The verification
 * script keeps this value in sync with package.json for fresh builds.
 */
export const CLICKGRAPH_VERSION = '0.1.0';

/**
 * The commit that produced the running build, `-dirty` when the tree had
 * uncommitted edits, or `unknown` when the build was not made from a checkout
 * of this package. Written by `scripts/stamp-build.mjs` at build time.
 */
export { CLICKGRAPH_BUILD };

/** @see scripts/stamp-build.mjs — kept in step with the generator. */
export const UNIDENTIFIED_BUILD = 'unknown';

/** Who produced a graph: the released version, and the build within it. */
export interface ClickgraphProducer {
  /** Absent on graphs written before producer provenance existed. */
  version?: string;
  /** Absent on graphs written before build stamping existed. */
  build?: string;
}

/** The running build, as the thing a baseline gets compared against. */
export const runningProducer = (): ClickgraphProducer => ({
  version: CLICKGRAPH_VERSION,
  build: CLICKGRAPH_BUILD,
});

const CAVEAT = 'detection differences may be tooling, not app changes; re-baseline to be sure';

/**
 * What to say when a baseline and the running build may not be the same tool.
 *
 * Never an error — upgrading on purpose is the normal case, and a diff that
 * failed on it would make every upgrade read as a regression. It is also never
 * a *change*: the producer is metadata, and `diffGraphs` must not derive a
 * single finding from it, or the same thing would happen by another route.
 *
 * The version is the coarse answer and the build is the fine one. Within a
 * single released version — which is every version, for anyone running the CLI
 * out of a checkout — the commit is the whole question (issue #41), so a
 * matching version is where this starts asking rather than where it stops.
 */
export function clickgraphProvenanceWarning(
  baseline: ClickgraphProducer,
  current: ClickgraphProducer,
): string | null {
  const currentVersion = current.version ?? 'an unknown version';
  const currentBuild = current.build ?? UNIDENTIFIED_BUILD;

  if (!baseline.version) {
    return `the baseline does not record which clickgraph version produced it; this diff uses ` +
      `${currentVersion} — ${CAVEAT}`;
  }
  if (baseline.version !== current.version) {
    return `the baseline was walked with clickgraph ${baseline.version}; this diff uses ` +
      `${currentVersion} — ${CAVEAT}`;
  }
  if (baseline.build === undefined) {
    return `the baseline records clickgraph ${currentVersion} but predates build stamping, so it ` +
      `cannot say which build walked it; this diff is build ${currentBuild} — ${CAVEAT}`;
  }
  if (baseline.build === UNIDENTIFIED_BUILD) {
    return `the baseline was walked by a clickgraph ${currentVersion} build that could not name ` +
      `its commit; this diff is build ${currentBuild} — ${CAVEAT}`;
  }
  if (currentBuild === UNIDENTIFIED_BUILD) {
    return `this diff runs a clickgraph ${currentVersion} build that cannot name its commit, so ` +
      `it cannot be matched against the baseline build ${baseline.build} — ${CAVEAT}`;
  }
  if (baseline.build === currentBuild) return null;
  return `the baseline was walked by clickgraph ${currentVersion} build ${baseline.build}; this ` +
    `diff is build ${currentBuild} — same released version, different builds, so ${CAVEAT}`;
}

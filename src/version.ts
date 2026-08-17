/**
 * The clickgraph build version.
 *
 * Keep this compiled into dist rather than reading package.json at runtime. If
 * source/package.json moves ahead of a stale dist directory, `--version` must
 * report the version of the code that will actually run. The verification
 * script keeps this value in sync with package.json for fresh builds.
 */
export const CLICKGRAPH_VERSION = '0.1.0';

export function clickgraphVersionWarning(
  baselineVersion: string | undefined,
  currentVersion?: string,
): string | null {
  const currentLabel = currentVersion ?? 'an unknown version';
  if (!baselineVersion) {
    return `the baseline does not record which clickgraph version produced it; this diff uses ` +
      `${currentLabel} — detection differences may be tooling, not app changes; re-baseline to be sure`;
  }
  if (baselineVersion === currentVersion) return null;
  return `the baseline was walked with clickgraph ${baselineVersion}; this diff uses ` +
    `${currentLabel} — detection differences may be tooling, not app changes; re-baseline to be sure`;
}

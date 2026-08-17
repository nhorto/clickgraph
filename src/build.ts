import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function filesBelow(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

/**
 * Source files newer than the JavaScript this local checkout will execute.
 * Published packages need not include src/, in which case freshness is unknown
 * and no warning is invented.
 */
export function staleLocalBuildFiles(
  root: string = fileURLToPath(new URL('../', import.meta.url)),
): string[] {
  const sourceRoot = join(root, 'src');
  const distRoot = join(root, 'dist');
  if (!existsSync(sourceRoot) || !existsSync(distRoot)) return [];

  return filesBelow(sourceRoot)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .filter((source) => {
      const output = join(distRoot, relative(sourceRoot, source).replace(/\.ts$/, '.js'));
      return !existsSync(output) || statSync(source).mtimeMs > statSync(output).mtimeMs;
    })
    .map((path) => relative(root, path));
}

export function warnIfStaleLocalBuild(): void {
  const stale = staleLocalBuildFiles();
  if (stale.length === 0) return;
  const examples = stale.slice(0, 3).join(', ');
  const more = stale.length > 3 ? ` and ${stale.length - 3} more` : '';
  console.error(
    `WARNING: running stale dist output; ${examples}${more} are newer than their compiled files. ` +
    'Run npm run build before trusting this walk.\n',
  );
}

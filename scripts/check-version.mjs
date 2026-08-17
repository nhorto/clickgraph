import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .version;
const versionSource = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
const compiledVersion = versionSource.match(/CLICKGRAPH_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];

if (compiledVersion !== packageVersion) {
  console.error(
    `error: src/version.ts records ${JSON.stringify(compiledVersion)}, but package.json records ` +
    `${JSON.stringify(packageVersion)} — update both before building`,
  );
  process.exit(1);
}

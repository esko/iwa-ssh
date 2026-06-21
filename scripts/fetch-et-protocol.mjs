import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const commit = '636858444906e24e9a4271403bd909c64eeb1527';
const files = ['ET.proto', 'ETerminal.proto'];
for (const file of files) {
  const url = `https://raw.githubusercontent.com/MisterTea/EternalTerminal/${commit}/proto/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  await writeFile(new URL(`../app/src/et/proto/${file}`, import.meta.url), await response.text());
}

const result = spawnSync('npm', ['run', 'generate:et-proto'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

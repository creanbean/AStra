import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Install Node.js 24 LTS, then run this launcher again.'); process.exit(1); }
console.log('\nAStra setup — your resume, profile and browser run locally.\n');
if (!existsSync('node_modules')) run(npm, ['ci']);
if (!existsSync('.env')) {
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log('Automatic discovery requires a paid OpenAI API key (separate from ChatGPT).');
  console.log('This terminal entry is visible. Keep the terminal private. The key is saved only in your ignored local .env.');
  const key = (await terminal.question('API key (or leave blank to configure .env later): ')).trim();
  const model = (await terminal.question('Model [gpt-6.1-sol]: ')).trim() || 'gpt-6.1-sol';
  terminal.close();
  if (/[\r\n]/.test(key + model)) throw new Error('Invalid configuration.');
  let env = readFileSync('.env.example', 'utf8').replace(/^AI_API_KEY=.*$/m, `AI_API_KEY=${JSON.stringify(key)}`).replace(/^AI_MODEL=.*$/m, `AI_MODEL=${JSON.stringify(model)}`);
  writeFileSync('.env', env, { mode: 0o600 });
}
run(npx, ['playwright', 'install', 'chromium']);
run(npm, ['run', 'build']);
console.log('\nOpen http://127.0.0.1:3000 in your browser. Keep this terminal open.\n');
run(npm, ['start']);

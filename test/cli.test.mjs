import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { agentTools, runStudioCommand } from '../src/agent-tools.mjs';
import { parseArguments } from '../cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('help lists every studio tool', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'help'], {
    encoding: 'utf8',
    env: { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') },
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(item => item.startsWith('Agent/editor interface:'));
  assert.ok(line, 'help must print the studio interface line');
  const listed = line.slice(line.indexOf('studio ') + 'studio '.length).split(' ')[0].split('|');
  for (const { name } of agentTools) {
    assert.ok(listed.includes(name.replace(/^studio_/, '')), `${name} is missing from help`);
  }
});

test('version aliases print only the installed package version', async () => {
  const { name, version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const alias of ['--version', '-v', 'version']) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), alias], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || alias);
    assert.equal(result.stdout, name + ' ' + version + '\n', alias);
    assert.equal(result.stderr, '', alias);
  }
});

test('-h prints the same top-level help as --help', () => {
  const run = alias => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), alias], { encoding: 'utf8' });
  const help = run('--help');
  const short = run('-h');
  assert.equal(help.status, 0, help.stderr);
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.stdout, help.stdout);
  assert.equal(short.stderr, '');
});

test('parseArguments keeps everything after the first = in a flag value', () => {
  const { flags, positional } = parseArguments([
    '--title=Score=100',
    '--query=a=b=c',
    '--x', 'v',
    '--y=z',
    '--no-cache',
    '--empty=',
    'tail',
  ]);
  assert.equal(flags.title, 'Score=100');
  assert.equal(flags.query, 'a=b=c');
  assert.equal(flags.x, 'v');
  assert.equal(flags.y, 'z');
  assert.equal(flags.cache, false);
  assert.equal(flags.empty, '');
  assert.deepEqual(positional, ['tail']);
});

const okApi = async route => (route === '/health'
  ? { service: 'AI Edit Studio', version: '0.11.0' }
  : { project: { id: '00000000-0000-0000-0000-000000000001', revision: 1 } });

async function requestFile(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aes-request-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'request.json');
  await fs.writeFile(file, body);
  return file;
}

test('a request file that is not a JSON object is refused with INVALID_JSON', async t => {
  for (const body of ['null', '[1, 2]', '"text"', '42']) {
    const request = await requestFile(t, body);
    for (const flags of [{ request }, { request, project: 'abc' }]) {
      await assert.rejects(
        runStudioCommand('get', flags, okApi),
        error => error.code === 'INVALID_JSON' && /Request must be a JSON object\./.test(error.message),
        `${body} must answer INVALID_JSON`,
      );
    }
  }
});

test('a request file holding an object still reaches the tool', async t => {
  const request = await requestFile(t, '{"projectId": "00000000-0000-0000-0000-000000000001"}');
  const calls = [];
  const api = async (route, req) => { calls.push(route); return okApi(route, req); };
  await runStudioCommand('get', { request }, api);
  assert.deepEqual(calls, ['/health', '/studio/projects/00000000-0000-0000-0000-000000000001']);
});

const ID = '00000000-0000-0000-0000-000000000001';

function capture() {
  const calls = [];
  const api = async (route, req) => { calls.push({ route, body: req?.body }); return okApi(route, req); };
  return { calls, api };
}

test('studio <tool> --help prints the flags of that tool', () => {
  const env = { ...process.env, GAME_TRAILER_STUDIO_DATA_ROOT: path.join(ROOT, '.studio-data', 'cli-test') };
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { encoding: 'utf8', env });
  const edit = run(['studio', 'edit', '--help']);
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stdout, /studio_edit/);
  assert.match(edit.stdout, /--revision/);
  assert.match(edit.stdout, /--operations/);
  assert.match(edit.stdout, /--project-id[^\n]*required/);
  const unknown = run(['studio', 'nope', '--help']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /UNKNOWN_TOOL/);
});

test('studio wait and qc take their arguments as flags', async () => {
  const { calls, api } = capture();
  await runStudioCommand('wait', { project: ID, until: 'idle', 'timeout-seconds': '30' }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/wait`);
  assert.deepEqual(calls.at(-1).body, { until: 'idle', timeoutSeconds: 30 });
  await runStudioCommand('qc', { 'project-id': ID, 'export-id': ID }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/qc`);
  assert.deepEqual(calls.at(-1).body, { exportId: ID });
});

test('flags override the request file, including --no-<flag> for booleans', async t => {
  const request = await requestFile(t, JSON.stringify({ projectId: ID, revision: 1, preview: true, formats: ['hd'] }));
  const { calls, api } = capture();
  await runStudioCommand('render', { request, preview: false }, api);
  assert.deepEqual(calls.at(-1).body, { revision: 1, preview: false, formats: ['hd'] });
});

test('the flags that worked before still produce the same arguments', async () => {
  const { calls, api } = capture();
  await runStudioCommand('render', { project: ID, revision: '3', formats: 'landscape,vertical', preview: true }, api);
  assert.equal(calls.at(-1).route, `/studio/projects/${ID}/export`);
  assert.deepEqual(calls.at(-1).body, { revision: 3, formats: ['landscape', 'vertical'], preview: true });
});

test('bad flags fail with a clear error before reaching the tool', async () => {
  await assert.rejects(
    runStudioCommand('qc', { project: ID, 'nope-flag': '1' }, okApi),
    error => error.code === 'UNKNOWN_FLAG' && /--nope-flag/.test(error.message) && /--export-id/.test(error.message),
  );
  await assert.rejects(
    runStudioCommand('wait', { project: ID, 'timeout-seconds': 'soon' }, okApi),
    error => error.code === 'INVALID_ARGUMENTS' && /--timeout-seconds/.test(error.message),
  );
  await assert.rejects(
    runStudioCommand('edit', { project: ID, revision: '1', operations: 'not json' }, okApi),
    error => error.code === 'INVALID_ARGUMENTS' && /not valid JSON/.test(error.message),
  );
});

test('hyphen and mixed-case tool names reach the same tool (#101)', async () => {
  for (const name of ['auto-edit', 'Auto_Edit', 'auto_edit']) {
    await assert.rejects(
      runStudioCommand(name, {}, okApi),
      err => err.code === 'INVALID_ARGUMENTS',
    );
  }
});

test('an unknown tool lists the tools and suggests a close name (#101)', async () => {
  await assert.rejects(
    runStudioCommand('auto-edt', {}, okApi),
    err => err.code === 'UNKNOWN_TOOL'
      && /Did you mean auto_edit\?/.test(err.message)
      && /Tools: /.test(err.message),
  );
});

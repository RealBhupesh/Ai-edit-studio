#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { agentTools, runStudioCommand, studioHelp } from './src/agent-tools.mjs';
import { isMainModule } from './src/main-module.mjs';
import { inspectFfmpeg } from './src/ffmpeg.mjs';
import { DATA_ROOT, PROJECT_ROOT, StudioError, ensureDataRoot, safeResolveWithin } from './src/paths.mjs';

const DEFAULT_PORT = 32146;
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new StudioError('INVALID_PORT', `Invalid local server port: ${value}.`);
  }
  return port;
}
const API_TIMEOUT_MS = 35_000;
const TERMINAL_JOB_STATUSES = new Set(['complete', 'failed', 'cancelled', 'canceled']);

function serverPort() {
  return validatePort(process.env.GAME_TRAILER_STUDIO_PORT || DEFAULT_PORT);
}

function apiRoot() {
  return `http://127.0.0.1:${serverPort()}/api`;
}

export function parseArguments(values) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const body = value.slice(2);
    const equals = body.indexOf('=');
    const rawKey = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    if (rawKey.startsWith('no-')) {
      flags[rawKey.slice(3)] = false;
    } else if (inline !== undefined) {
      flags[rawKey] = inline;
    } else if (values[index + 1] && !values[index + 1].startsWith('--')) {
      flags[rawKey] = values[++index];
    } else {
      flags[rawKey] = true;
    }
  }
  return { positional, flags };
}

function boolFlag(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'nee', 'no', 'off'].includes(String(value).toLowerCase());
}

export async function api(pathname, { method = 'GET', body, start = true } = {}) {
  if (start) await ensureDaemon();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiRoot()}${pathname}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Studio-Client': 'cli',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new StudioError(
        payload?.error?.code || 'API_ERROR',
        payload?.error?.message || `Local API error ${response.status}.`,
        { details: payload?.error?.details ?? {} },
      );
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new StudioError('API_TIMEOUT', `The local Studio API did not respond within ${API_TIMEOUT_MS / 1000} seconds.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function health() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${apiRoot()}/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.ok === true
      && ['AI Edit Studio', 'Game Trailer Studio'].includes(payload.service)
      && payload.schemaVersion >= 2;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

let daemonStart = null;
async function ensureDaemon() {
  if (!daemonStart) daemonStart = startDaemon().finally(() => { daemonStart = null; });
  return daemonStart;
}
async function startDaemon() {
  if (await health()) return;
  await ensureDataRoot(0);
  const logRoot = safeResolveWithin(DATA_ROOT, 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  const logPath = safeResolveWithin(logRoot, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const serverPath = path.join(PROJECT_ROOT, 'server.mjs');
  let spawnError = null;
  let earlyExit = null;
  try {
    const child = spawn(process.execPath, [serverPath], {
      cwd: PROJECT_ROOT,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', (code, signal) => {
      earlyExit = { code, signal };
    });
    child.unref();
  } catch (error) {
    throw new StudioError('SERVER_START_FAILED', `The local Studio server could not be started. Check ${logPath}.`, {
      cause: error,
      details: { logPath },
    });
  } finally {
    fs.closeSync(logFd);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (spawnError) {
      throw new StudioError('SERVER_START_FAILED', `The local Studio server could not be started. Check ${logPath}.`, {
        cause: spawnError,
        details: { logPath },
      });
    }
    if (await health()) return;
    if (earlyExit) {
      throw new StudioError('SERVER_START_FAILED', `The local Studio server exited during startup. Check ${logPath}.`, {
        details: { logPath, ...earlyExit },
      });
    }
  }
  throw new StudioError('SERVER_START_FAILED', `The local Studio server did not start. Check ${logPath}.`);
}

function absolutePathFlag(value) {
  const text = String(value ?? '').trim();
  return text ? path.resolve(text) : '';
}

// Pass the raw string on: Number('abc') here would turn the bad value into NaN
// and the error would name the wrong thing. The server validates every request (#134).
const numericFlag = value => (value === undefined || value === '' || value === null ? undefined : String(value));

export function requestFromFlags(flags, inputOverride = '') {
  return {
    project: flags.project || 'Game trailer',
    input: absolutePathFlag(inputOverride || flags.input),
    duration: numericFlag(flags.duration),
    style: flags.style || 'action',
    title: flags.title || '',
    music: absolutePathFlag(flags.music),
    output: absolutePathFlag(flags.output),
    resolution: flags.resolution || '2560x1440',
    fps: numericFlag(flags.fps),
    preview: boolFlag(flags.preview, true),
    previewOnly: boolFlag(flags['preview-only'], false),
    seed: numericFlag(flags.seed),
  };
}

async function waitForJob(jobId) {
  while (true) {
    const payload = await api(`/jobs/${encodeURIComponent(jobId)}`);
    if (TERMINAL_JOB_STATUSES.has(payload.job?.status)) return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

async function createAndWaitForJob(request, jsonMode, extra = {}) {
  const payload = await api('/jobs', { method: 'POST', body: request });
  const created = payload.job;
  print({ id: created.id, status: created.status, ...extra }, jsonMode);
  const finished = await waitForJob(created.id);
  print(finished, jsonMode);
  if (finished.status !== 'complete') process.exitCode = 1;
}

function print(value, jsonMode) {
  if (jsonMode) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function help() {
  const studioCommands = agentTools.map(tool => tool.name.replace(/^studio_/, '')).join('|');
  console.log(`Agent/editor interface: node cli.mjs studio ${studioCommands} [--project ID] [--revision N] [--request file.json|-] [--wait]\nMCP stdio: node mcp.mjs\nSpeech engine (optional, local): node cli.mjs speech-setup [--model base|small|large-v3-turbo-q5_0]\nInstall for every agent on this computer: node cli.mjs install [--data-root <folder>] [--no-claude] [--no-codex] [--no-desktop] [--no-cursor] [--dry-run] [--json] | node cli.mjs uninstall\nOpenAI Codex only: node cli.mjs codex-setup [--data-root <folder>] [--plugin] [--uninstall] [--dry-run]\nSee AGENTS.md for workflows and examples.`);
  console.log(`AI Edit Studio\n\nUsage:\n  node cli.mjs doctor [--json]\n  node cli.mjs serve\n  node cli.mjs mcp   (MCP server over stdio, for agents)\n  node cli.mjs processes [query] [--json]\n  node cli.mjs capture start --process bf6.exe --project BF6 --fps 120\n  node cli.mjs capture stop\n  node cli.mjs capture status\n  node cli.mjs run --input <file|folder> [--output D:\\...\\trailer.mp4]\n  node cli.mjs from-last-capture [same trailer options]\n  node cli.mjs jobs [--json]\n  node cli.mjs job <id> [--json]\n\nTrailer options:\n  --duration 60 --style action|cinematic|gameplay|showcase|air-combat\n  --title "My trailer" --music D:\\Music\\track.wav\n  --resolution 2560x1440 --fps 60 --no-preview --preview-only\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1) {
    const [arg] = args;
    if (arg === '-h') return help();
    if (arg === '--version' || arg === '-v' || arg === 'version') {
      const { name, version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
      return console.log(name + ' ' + version);
    }
  }
  const { positional, flags } = parseArguments(args);
  const [command, subcommand, third] = positional;
  const jsonMode = boolFlag(flags.json, false);
  if (command === 'studio' && subcommand && flags.help) return console.log(studioHelp(subcommand));
  if (!command || command === 'help' || flags.help) return help();
  // MCP over stdio for `npx -y ai-edit-studio mcp` (the registry entry uses this). Print nothing before it starts.
  if (command === 'mcp') { await import('./mcp.mjs'); return; }
  if (command === 'studio') return print(await runStudioCommand(subcommand, flags, api), true);

  if (command === 'doctor') {
    const info = await inspectFfmpeg({ smokeTest: true });
    const storage = await ensureDataRoot(2 * 1024 ** 3);
    const { speechStatus } = await import('./src/transcribe.mjs');
    return print({ ok: info.capabilities.nvencReady || info.capabilities.libx264, ...info, storage, speech: await speechStatus().catch(e => ({ ready: false, error: e.message })) }, jsonMode);
  }
  if (command === 'install' || command === 'uninstall') {
    const { install, formatReport } = await import('./src/install.mjs');
    const clients = Object.fromEntries(['claude', 'codex', 'desktop', 'cursor'].map(id => [id, flags[id] !== false]));
    const report = await install({ uninstall: command === 'uninstall', clients, dryRun: Boolean(flags['dry-run']), dataRoot: typeof flags['data-root'] === 'string' ? flags['data-root'] : undefined });
    if (!report.ok) process.exitCode = 1;
    return jsonMode ? print(report, true) : process.stdout.write(formatReport(report));
  }
  if (command === 'codex-setup') {
    const { codexSetup } = await import('./src/integrations.mjs');
    const mode = flags.uninstall ? 'uninstall' : flags.plugin ? 'plugin' : 'full';
    return print(await codexSetup({ mode, dataRoot: typeof flags['data-root'] === 'string' ? flags['data-root'] : undefined, dryRun: Boolean(flags['dry-run']) }), true);
  }
  if (command === 'speech-setup') {
    const { setupSpeech, MODEL_SIZES } = await import('./src/transcribe.mjs');
    const model = String(flags.model ?? 'base');
    console.error(`Installing the local speech engine (whisper.cpp) and model "${model}" (${MODEL_SIZES[model] ?? 'size unknown'}) into the data folder…`);
    return print(await setupSpeech({ model, onLog: line => console.error(line) }), true);
  }
  if (command === 'serve') {
    const { installShutdownHandlers, startServer } = await import('./server.mjs');
    const server = await startServer({ port: serverPort() });
    installShutdownHandlers(server);
    return;
  }
  if (command === 'processes') {
    const query = subcommand || flags.query || '';
    const payload = await api(`/processes?query=${encodeURIComponent(query)}`);
    return print(payload.processes, jsonMode);
  }
  if (command === 'capture') {
    if (subcommand === 'start') {
      if (!flags.process) throw new StudioError('PROCESS_REQUIRED', 'Use --process <name.exe|PID>.');
      const payload = await api('/capture/start', {
        method: 'POST',
        body: {
          process: flags.process,
          project: flags.project || 'Game capture',
          fps: Number(flags.fps || 60),
          audioDevice: flags['audio-device'] || '',
        },
      });
      return print(payload.capture, jsonMode);
    }
    if (subcommand === 'stop') {
      const payload = await api('/capture/stop', { method: 'POST', body: {} });
      return print(payload.capture, jsonMode);
    }
    if (subcommand === 'status') {
      const payload = await api('/capture/status');
      return print(payload.capture, jsonMode);
    }
    throw new StudioError('INVALID_COMMAND', 'Use capture start, capture stop or capture status.');
  }
  if (command === 'run') {
    if (!flags.input) throw new StudioError('INPUT_REQUIRED', 'Use --input <video file|folder>.');
    return createAndWaitForJob(requestFromFlags(flags), jsonMode);
  }
  if (command === 'from-last-capture') {
    const payload = await api('/capture/status');
    const capture = payload.capture;
    if (!capture?.output || capture.active) {
      throw new StudioError('CAPTURE_NOT_READY', 'There is no finished recording yet to use as a trailer source.');
    }
    return createAndWaitForJob(
      requestFromFlags(flags, capture.output),
      jsonMode,
      { input: path.resolve(capture.output) },
    );
  }
  if (command === 'jobs') {
    return print((await api('/jobs')).jobs, jsonMode);
  }
  if (command === 'job') {
    if (!subcommand) throw new StudioError('JOB_REQUIRED', 'Provide the production ID.');
    return print((await api(`/jobs/${encodeURIComponent(subcommand)}`)).job, jsonMode);
  }
  throw new StudioError('INVALID_COMMAND', `Unknown command: ${command}.`);
}

if (isMainModule(import.meta.url)) main().catch((error) => {
  const record = {
    ok: false,
    error: {
      code: error?.code || 'CLI_FAILED',
      message: error?.message || String(error),
      details: error?.details ?? {},
    },
  };
  console.error(JSON.stringify(record, null, 2));
  process.exitCode = 1;
});

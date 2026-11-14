import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  DATA_ROOT,
  StudioError,
  createJobLayout,
  ensureDataRoot,
  listMediaFiles,
  readJson,
  safeResolveWithin,
  writeJsonAtomic,
} from './paths.mjs';
import { analyzeFiles } from './analyze.mjs';
import { findFfmpegTools } from './ffmpeg.mjs';
import { buildTrailerPlan, STYLE_PRESETS } from './planner.mjs';
import { renderTrailer } from './render.mjs';

const MIN_JOB_FREE_BYTES = 5 * 1024 ** 3;
const MAX_LOG_LINES = 200;
const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled', 'canceled']);

function cleanText(value, maximum = 160) {
  return String(value ?? '').replace(/[\r\n\t\0]+/g, ' ').trim().slice(0, maximum);
}

/** A supplied number must be usable and in range; an omitted or empty one keeps
 *  the default (the legacy editor page sends empty fields, the API may omit them).
 *  Clamping a bad value silently used to render a whole trailer with the wrong
 *  length or frame rate, so refuse it with a stable code instead (#134). */
function numberOption(value, { name, code, minimum, maximum, fallback, unit = '' }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new StudioError(code, `Invalid ${name}: ${value}. Use ${minimum} to ${maximum}${unit ? ` ${unit}` : ''}.`);
  }
  return parsed;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function booleanOption(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'ja', 'on'].includes(normalized)) return true;
    if (['false', 'no', 'nee', 'off'].includes(normalized)) return false;
  }
  throw new StudioError('INVALID_BOOLEAN', `${name} must be true or false.`);
}

export function normalizeRequest(request = {}) {
  if (!isPlainObject(request)) {
    throw new StudioError('INVALID_REQUEST', 'The production request must be a JSON object.');
  }
  const input = String(request.input ?? '').trim();
  if (!input) throw new StudioError('INPUT_REQUIRED', 'Provide a video file or footage folder.');
  const project = cleanText(request.project || 'Game trailer', 120);
  const style = cleanText(request.style || 'action', 40);
  if (!Object.hasOwn(STYLE_PRESETS, style)) {
    throw new StudioError('INVALID_STYLE', `Unknown trailer style: ${style}.`);
  }
  const resolution = cleanText(request.resolution || '2560x1440', 20);
  if (!/^\d{3,5}x\d{3,5}$/.test(resolution)) {
    throw new StudioError('INVALID_RESOLUTION', `Invalid resolution: ${resolution}.`);
  }
  const output = String(request.output ?? '').trim();
  if (output) {
    const absoluteOutput = path.resolve(output);
    safeResolveWithin(DATA_ROOT, path.relative(DATA_ROOT, absoluteOutput));
    if (path.extname(absoluteOutput).toLowerCase() !== '.mp4') {
      throw new StudioError('INVALID_OUTPUT', 'The output file must be an .mp4 file.');
    }
  }
  const previewOnly = booleanOption(request.previewOnly, 'previewOnly', false);
  return {
    project,
    input: path.resolve(input),
    duration: numberOption(request.duration, { name: 'duration', code: 'INVALID_DURATION', minimum: 5, maximum: 300, fallback: 60, unit: 'seconds' }),
    style,
    title: cleanText(request.title, 140),
    music: String(request.music ?? '').trim(),
    output: output ? path.resolve(output) : '',
    resolution,
    fps: Math.round(numberOption(request.fps, { name: 'fps', code: 'INVALID_FPS', minimum: 24, maximum: 120, fallback: 60, unit: 'frames per second' })),
    preview: previewOnly || booleanOption(request.preview, 'preview', true),
    previewOnly,
    seed: Math.round(numberOption(request.seed, { name: 'seed', code: 'INVALID_SEED', minimum: 0, maximum: 2_147_483_647, fallback: 42 })),
  };
}

function errorRecord(error) {
  return {
    code: error?.code || 'JOB_FAILED',
    message: error?.message || String(error),
    details: error?.details && typeof error.details === 'object' ? error.details : {},
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function logMessage(job, message) {
  const text = cleanText(message, 500);
  if (!text) return;
  job.logs.push(`${new Date().toISOString()}  ${text}`);
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}

function publicJob(job) {
  const snapshot = clone(job);
  delete snapshot.layout;
  return snapshot;
}

async function safeDirectoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export class JobManager {
  constructor() {
    this.jobs = new Map();
    this.runs = new Map();
    this.persistQueues = new Map();
    this.queue = [];
    this.processing = false;
  }

  async persist(job) {
    const prior = this.persistQueues.get(job.id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => writeJsonAtomic(job.layout.config, publicJob(job)));
    this.persistQueues.set(job.id, next);
    await next;
  }

  update(job, patch = {}, message = '') {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (message) logMessage(job, message);
    void this.persist(job).catch(() => {});
  }

  async create(request) {
    const normalized = normalizeRequest(request);
    await ensureDataRoot(MIN_JOB_FREE_BYTES);
    const files = await listMediaFiles(normalized.input);
    if (!files.length) {
      throw new StudioError('NO_MEDIA', 'No supported video files found in the given footage path.');
    }
    const layout = await createJobLayout(normalized.project);
    const createdAt = new Date().toISOString();
    const job = {
      schemaVersion: 1,
      id: layout.id,
      project: normalized.project,
      title: normalized.title || normalized.project,
      status: 'queued',
      stage: 'queued',
      stageLabel: 'Production queued',
      progress: 1,
      duration: normalized.duration,
      resolution: normalized.resolution,
      fps: normalized.fps,
      style: normalized.style,
      input: normalized.input,
      output: normalized.output || path.join(layout.output, 'trailer.mp4'),
      preview: normalized.preview,
      sourceCount: files.length,
      createdAt,
      updatedAt: createdAt,
      warnings: [],
      artifacts: [],
      logs: [],
      error: null,
      request: normalized,
      layout,
    };
    logMessage(job, `${files.length} source file(s) found; sources remain unchanged.`);
    this.jobs.set(job.id, job);
    await this.persist(job);
    let resolveRun;
    const run = new Promise((resolve) => {
      resolveRun = resolve;
    });
    this.runs.set(job.id, run);
    this.queue.push({ job, files, resolve: resolveRun });
    void this.drainQueue();
    return publicJob(job);
  }

  async drainQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const queued = this.queue.shift();
        let result;
        try {
          result = await this.execute(queued.job, queued.files);
        } catch (error) {
          queued.job.error = errorRecord(error);
          this.update(queued.job, {
            status: 'failed',
            stage: 'failed',
            stageLabel: queued.job.error.message,
          }, `Production failed: ${queued.job.error.message}`);
          await this.persist(queued.job).catch(() => {});
          result = publicJob(queued.job);
        }
        queued.resolve(result);
        this.runs.delete(queued.job.id);
      }
    } finally {
      this.processing = false;
      if (this.queue.length) void this.drainQueue();
    }
  }

  async execute(job, files) {
    try {
      const tools = findFfmpegTools();
      this.update(job, {
        status: 'analyzing', stage: 'analyzing', stageLabel: 'Analyzing footage', progress: 4,
      }, 'Analysis started.');
      const analysis = await analyzeFiles(files, {
        tools,
        onProgress: (event) => {
          const fileFraction = Number.isFinite(event.progress) ? event.progress : 0;
          const progress = Math.max(job.progress, Math.round(4 + fileFraction * 43));
          this.update(job, {
            progress,
            stageLabel: event.file ? `Analysis: ${path.basename(event.file)} (${event.phase})` : 'Analyzing footage',
          });
        },
      });
      const analysisPath = safeResolveWithin(job.layout.work, 'analysis.json');
      await writeJsonAtomic(analysisPath, analysis);
      job.warnings.push(...analysis.warnings);
      job.artifacts.push({ type: 'analysis', name: 'Analysis', path: analysisPath });

      this.update(job, {
        status: 'planning', stage: 'planning', stageLabel: 'Selecting the best moments', progress: 52,
      }, 'Determining selection and order.');
      const plan = buildTrailerPlan(analysis, {
        duration: job.request.duration,
        style: job.request.style,
        seed: job.request.seed,
        title: job.request.title,
      });
      const planPath = safeResolveWithin(job.layout.work, 'trailer-plan.json');
      await writeJsonAtomic(planPath, plan);
      job.warnings.push(...plan.warnings);
      job.artifacts.push({ type: 'plan', name: 'Trailer plan', path: planPath });
      job.actualDuration = plan.actualDuration;
      job.clipCount = plan.clipCount;

      if (job.request.preview) {
        this.update(job, {
          status: 'previewing', stage: 'previewing', stageLabel: 'Rendering quick preview', progress: 58,
        }, 'Preview render started.');
        const preview = await renderTrailer(plan, {
          jobRoot: job.layout.root,
          output: safeResolveWithin(job.layout.output, 'preview.mp4'),
          resolution: job.request.resolution,
          fps: job.request.fps,
          preview: true,
          title: job.request.title,
          music: job.request.music,
          tools,
          onProgress: (event) => this.update(job, {
            progress: Math.max(job.progress, Math.round(58 + (event.progress ?? 0) * 17)),
            stageLabel: event.phase === 'verify' ? 'Verifying preview' : 'Rendering quick preview',
          }),
        });
        job.artifacts.push({ type: 'preview', name: 'Preview', path: preview.output });
        job.warnings.push(...preview.warnings);
        if (job.request.previewOnly) {
          this.update(job, {
            status: 'complete', stage: 'complete', stageLabel: 'Preview ready', progress: 100,
          }, 'Preview production complete.');
          await this.finish(job);
          return publicJob(job);
        }
      }

      this.update(job, {
        status: 'rendering', stage: 'rendering', stageLabel: 'Rendering final trailer',
        progress: job.request.preview ? 76 : 58,
      }, 'Final render started.');
      const rendered = await renderTrailer(plan, {
        jobRoot: job.layout.root,
        output: job.output,
        resolution: job.request.resolution,
        fps: job.request.fps,
        preview: false,
        title: job.request.title,
        music: job.request.music,
        tools,
        onProgress: (event) => {
          const start = job.request.preview ? 76 : 58;
          this.update(job, {
            progress: Math.max(job.progress, Math.round(start + (event.progress ?? 0) * (98 - start))),
            stageLabel: event.phase === 'verify' ? 'Fully verifying final trailer' : 'Rendering final trailer',
          });
        },
      });
      job.artifacts.push({ type: 'trailer', name: 'Final trailer', path: rendered.output });
      job.warnings.push(...rendered.warnings);
      this.update(job, {
        status: 'complete', stage: 'complete', stageLabel: 'Trailer ready', progress: 100,
      }, 'Production complete and video decode verified.');
      await this.finish(job);
      return publicJob(job);
    } catch (error) {
      job.error = errorRecord(error);
      this.update(job, {
        status: 'failed', stage: 'failed', stageLabel: job.error.message, progress: job.progress,
      }, `Production failed: ${job.error.message}`);
      await this.persist(job).catch(() => {});
      return publicJob(job);
    }
  }

  async finish(job) {
    const manifest = {
      schemaVersion: 1,
      id: job.id,
      project: job.project,
      source: job.input,
      sourceCount: job.sourceCount,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: new Date().toISOString(),
      artifacts: job.artifacts,
      warnings: job.warnings,
    };
    await writeJsonAtomic(job.layout.manifest, manifest);
    await this.persist(job);
  }

  async wait(id) {
    const run = this.runs.get(id);
    if (run) await run;
    return this.get(id);
  }

  async get(id) {
    if (this.jobs.has(id)) return publicJob(this.jobs.get(id));
    await this.loadPersisted();
    const job = this.jobs.get(id);
    if (!job) throw new StudioError('JOB_NOT_FOUND', `Production ${id} was not found.`);
    return publicJob(job);
  }

  async list() {
    await this.loadPersisted();
    return [...this.jobs.values()]
      .map(publicJob)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async loadPersisted() {
    await ensureDataRoot(0);
    const jobsRoot = safeResolveWithin(DATA_ROOT, 'jobs');
    const projects = await safeDirectoryEntries(jobsRoot);
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectPath = safeResolveWithin(jobsRoot, project.name);
      for (const entry of await safeDirectoryEntries(projectPath)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const root = safeResolveWithin(projectPath, entry.name);
        const config = safeResolveWithin(root, 'job.json');
        if (!fsSync.existsSync(config) || this.jobs.has(entry.name)) continue;
        try {
          const stored = await readJson(config);
          if (!stored?.id || stored.id !== entry.name) continue;
          const layout = {
            id: stored.id,
            project: stored.project,
            slug: project.name,
            root,
            input: safeResolveWithin(root, 'input'),
            work: safeResolveWithin(root, 'work'),
            output: safeResolveWithin(root, 'output'),
            logs: safeResolveWithin(root, 'logs'),
            manifest: safeResolveWithin(root, 'manifest.json'),
            config,
          };
          const restored = { ...stored, layout };
          if (!TERMINAL_STATUSES.has(restored.status)) {
            restored.status = 'failed';
            restored.stage = 'interrupted';
            restored.stageLabel = 'Production interrupted by server restart';
            restored.updatedAt = new Date().toISOString();
            restored.error = {
              code: 'DAEMON_RESTARTED',
              message: 'This production was interrupted because the local Studio server restarted.',
              details: {},
            };
            if (!Array.isArray(restored.logs)) restored.logs = [];
            logMessage(restored, 'Production marked as interrupted after server restart.');
          }
          this.jobs.set(stored.id, restored);
          if (restored.error?.code === 'DAEMON_RESTARTED') await this.persist(restored);
        } catch {
          // A corrupt historic record must not take down the local API.
        }
      }
    }
  }
}

export const jobManager = new JobManager();

// The caption cap has to be visible on the path the issue's repro actually takes:
// importTranscript({captions:true}) -> editProject() -> studio_edit / studio_review.
// Before this, editProject() passed the {captions, dropped} object straight into
// normalizeCaptions() and every import failed with INVALID_CAPTIONS (#105, review on #131).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reviewEdit } from '../public/insights.js';
import { LIMITS } from '../public/edit-ops.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-caption-import-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { importTranscript, editProject, reviewProject, getProject } = await import('../src/studio.mjs');
const { validateClips } = await import('../src/editing.mjs');

const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SECONDS = LIMITS.editSeconds;
const sources = [{ name: 'talk.mp4', file: path.join(root, 'talk.mp4'), duration: SOURCE_SECONDS,
  hasAudio: true, audio: [], black: [], motion: [], scenes: [] }];

// 1300 single-word sentences, one every 0.9 s. The 0.7 s gap between words is
// longer than wordsToCaptions()'s 0.6 s pause, so each word becomes one cue:
// 1300 cues > LIMITS.captions, all inside the 1200 s edit the tool allows.
function denseTranscript(count = LIMITS.captions + 100) {
  return Array.from({ length: count }, (_, i) => {
    const start = +(i * 0.9).toFixed(3);
    return { start, end: +(start + 0.2).toFixed(3), text: `word${i}.` };
  });
}

async function seedProject() {
  const dir = path.join(root, 'studio', 'projects', ID);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 2, id: ID, revision: 1, name: 'long talk',
    options: { captions: [], autoCaptions: false },
    sources,
    plan: { ...validateClips([{ id: 'a', sourceIndex: 0, start: 0, end: SOURCE_SECONDS - 1 }], sources), style: 'flight' },
    status: 'draft', progress: 0, message: 'Sources linked.', warnings: [], exports: [],
    createdAt: now, updatedAt: now,
  };
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(project));
  return project;
}

test('reviewEdit reports CAPTIONS_LIMIT and names the sources that lost lines', () => {
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 30 }];
  const srcs = [{ duration: 30, hasAudio: false }];
  const clean = reviewEdit({ clips, sources: srcs, options: {}, analyzed: false });
  assert.equal(clean.issues.some(i => i.code === 'CAPTIONS_LIMIT'), false, 'no warning when nothing was dropped');

  const cut = reviewEdit({ clips, sources: srcs, options: {}, analyzed: false,
    captionsDropped: 100, captionsDroppedSources: [0, 2] });
  const issue = cut.issues.find(i => i.code === 'CAPTIONS_LIMIT');
  assert.ok(issue, 'studio_review must surface the cut even when nothing else is wrong');
  assert.equal(issue.severity, 'warning');
  assert.match(issue.message, /100 caption\(s\) were not added: at most 1200 lines/);
  assert.match(issue.message, /Sources that lost lines: #0, #2/);
  assert.equal(cut.counts.warning, clean.counts.warning + 1);
  assert.equal(cut.score, clean.score - 7, 'a warning costs the same as any other warning');
});

test('importTranscript({captions:true}) succeeds, keeps 1200 cues and reports the cut (#105)', async () => {
  await seedProject();
  const words = denseTranscript();
  // Before the fix this threw INVALID_CAPTIONS ("At most 1200 caption lines.")
  // because editProject() handed normalizeCaptions() the whole {captions, dropped} object.
  const result = await importTranscript(ID, { sourceIndex: 0, words, captions: true, revision: 1 });
  assert.equal(result.words, words.length);
  assert.deepEqual(result.warnings, [`${words.length - LIMITS.captions} caption(s) were not added: at most ${LIMITS.captions} lines.`]);
  assert.equal(result.project.options.captions.length, LIMITS.captions, 'the cap still holds');
  assert.equal(result.project.captionsDropped, words.length - LIMITS.captions);
  assert.deepEqual(result.project.captionsDroppedSources, [0]);
  assert.ok(result.project.options.captions.at(-1).end > 1000, 'captions reach the end of the kept range');

  const stored = await getProject(ID);
  assert.equal(stored.captionsDropped, words.length - LIMITS.captions, 'the count is persisted, not just returned');

  // An agent that only calls studio_review still sees it.
  const review = await reviewProject(ID);
  const issue = review.issues.find(i => i.code === 'CAPTIONS_LIMIT');
  assert.ok(issue, 'studio_review must not stay silent about the lost captions');
  assert.match(issue.message, /Sources that lost lines: #0/);
});

test('a later studio_edit keeps reporting the cut, and clearing it removes the note', async () => {
  const project = await getProject(ID);
  const again = await editProject(ID, { revision: project.revision, operations: [{ op: 'set_options', options: { captionOffset: 0 } }] });
  assert.deepEqual(again.warnings, [`${denseTranscript().length - LIMITS.captions} caption(s) were not added: at most ${LIMITS.captions} lines.`],
    'the autoCaptions rebuild in editProject() reports the cut too');

  const cleared = await editProject(ID, { revision: again.project.revision, operations: [{ op: 'set_options', options: { autoCaptions: false } }] });
  assert.equal('warnings' in cleared, false, 'no stale warning once autoCaptions is off');
  assert.equal(cleared.project.captionsDropped, 0);
  const review = await reviewProject(ID);
  assert.equal(review.issues.some(i => i.code === 'CAPTIONS_LIMIT'), false, 'the review note clears with the cut');
});

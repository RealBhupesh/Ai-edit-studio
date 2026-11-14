// Two sections on one shot (#138): the suggestions never propose it, studio_sections and
// studio_edit refuse to save it, and a project that already holds such a pair still opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-sections-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { sectionsProject, editProject, getProject, timelineProject } = await import('../src/studio.mjs');
const { validateClips } = await import('../src/editing.mjs');
const { exportTimeline } = await import('../src/longform.mjs');

const sources = [{ name: 'a.mp4', file: path.join(root, 'a.mp4'), duration: 20, hasAudio: true, audio: [], black: [], motion: [], scenes: [] }];
const shots = [{ id: 'a', sourceIndex: 0, start: 0, end: 10 }, { id: 'b', sourceIndex: 0, start: 10, end: 20 }];
const pair = [{ name: 'Part 1 · a.mp4', clip: 'a' }, { name: 'Part 2', clip: 'a' }];

async function seed(id, sections = []) {
  const dir = path.join(root, 'studio', 'projects', id);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 2, id, revision: 2, name: 'Sec', options: { sections }, sources,
    plan: { ...validateClips(shots, sources), style: 'flight' },
    status: 'draft', progress: 0, message: 'Analyzed.', warnings: [], exports: [], createdAt: now, updatedAt: now,
  }));
}

test('one recording: suggest gives one section per shot, and adding the suggestions works', async () => {
  const id = '22222222-2222-4222-8222-222222222221';
  await seed(id);
  const { suggestions } = await sectionsProject(id, { action: 'suggest' });
  assert.deepEqual(suggestions, [{ name: 'Part 1 · a.mp4', clip: 'a', at: 0 }]);
  // What the editor's "Suggest sections" button sends.
  const added = await sectionsProject(id, { action: 'add', revision: 2, sections: suggestions.map(s => ({ name: s.name, clip: s.clip })) });
  assert.deepEqual(added.sections.map(s => [s.name, s.start, s.end]), [['Part 1 · a.mp4', 0, 20]]);
  assert.equal((await sectionsProject(id)).sections.length, 1);
});

test('two sections on one shot are refused by studio_sections and studio_edit, and nothing is saved', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  await seed(id);
  const refused = e => e.code === 'INVALID_SECTION' && /"Part 1 · a\.mp4" and "Part 2" both start at shot a/.test(e.message);
  await assert.rejects(sectionsProject(id, { action: 'add', revision: 2, sections: pair }), refused);
  await assert.rejects(editProject(id, { revision: 2, operations: [{ op: 'set_options', options: { sections: pair } }] }), refused);
  const project = await getProject(id);
  assert.equal(project.revision, 2, 'the refused add must not save a revision');
  assert.deepEqual(project.options.sections, []);
  // A second section on a shot that already has one replaces it, as before.
  await sectionsProject(id, { action: 'add', revision: 2, name: 'Intro', clip: 'a' });
  const replaced = await sectionsProject(id, { action: 'add', revision: 3, name: 'Opening', clip: 'a' });
  assert.deepEqual(replaced.sections.map(s => s.name), ['Opening']);
});

test('a project saved with such a pair still opens: list, timeline and chapters answer', async () => {
  const id = '22222222-2222-4222-8222-222222222223';
  await seed(id, pair);
  const listed = await sectionsProject(id);
  assert.deepEqual(listed.sections.map(s => [s.name, s.start, s.end, s.clips]), [['Part 2', 0, 20, 2]], 'the last section on the shot wins');
  await timelineProject(id);
  const project = await getProject(id);
  const chapters = exportTimeline({ clips: project.plan.clips, sources: project.sources, options: project.options, format: 'chapters', name: project.name });
  assert.match(JSON.stringify(chapters), /Part 2/);
  // The next edit saves it clean.
  const edited = await editProject(id, { revision: 2, operations: [{ op: 'set_options', options: { captionOffset: 0 } }] });
  assert.deepEqual(edited.project.options.sections, [{ name: 'Part 2', clip: 'a' }]);
});

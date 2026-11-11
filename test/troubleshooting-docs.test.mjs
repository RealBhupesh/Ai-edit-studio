import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('tool-error guidance includes the expected common codes', async () => {
  const [docs, support] = await Promise.all(['TROUBLESHOOTING.md', 'SUPPORT.md'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  const section = docs.split(/^## Errors from tools and agents\r?$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, 'tool-error section exists');
  const codes = [
    'REVISION_CONFLICT', 'PROJECT_BUSY', 'PLAN_REQUIRED', 'NOT_ANALYZED', 'TRANSCRIPT_MISSING', 'ASR_MODEL_MISSING',
    'ASR_SETUP_MANUAL', 'MUSIC_NOT_FOUND', 'INVALID_AUDIO', 'INVALID_MEDIA', 'UNSUPPORTED_MEDIA', 'INVALID_ARGUMENTS',
  ];
  for (const code of codes) assert.ok(section.includes(`\`${code}\``), code);
  assert.doesNotMatch(support, /\bevery\s+error\s+codes?\b/i);
});

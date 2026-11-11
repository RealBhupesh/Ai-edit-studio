import test from 'node:test';
import assert from 'node:assert/strict';
import { callAgentTool, validateArguments, agentTools, STUDIO_VERSION } from '../src/agent-tools.mjs';

const projectId = '00000000-0000-0000-0000-000000000000';
const schema = name => agentTools.find(t => t.name === `studio_${name}`).inputSchema;
const errorFor = (value, definition, location = 'arguments') => {
  let error;
  try { validateArguments(value, definition, location); } catch (caught) { error = caught; }
  assert.ok(error, 'expected validation error');
  assert.equal(error.code, 'INVALID_ARGUMENTS');
  return error.message;
};

test('schema-invalid tool calls explain constraints before any API call', async () => {
  let calls = 0;
  const api = async () => { calls++; throw new Error('unexpected API call'); };
  const cases = [
    ['studio_get', { projectId: 'x' }, 'arguments.projectId: invalid identifier; expected pattern "^[0-9a-f-]{36}$"'],
    ['studio_render', { projectId, revision: -1 }, 'arguments.revision: invalid numeric value; expected finite integer >= 1; received type number'],
    ['studio_render', { projectId, revision: 1, previewFormat: 'wide' }, 'arguments.previewFormat: unsupported choice; allowed choices: "landscape", "vertical", "square", "portrait"'],
  ];
  for (const [name, args, expected] of cases) {
    await assert.rejects(callAgentTool(name, args, api), error => {
      assert.equal(error.code, 'INVALID_ARGUMENTS'); assert.equal(error.message, expected); return true;
    });
    assert.equal(calls, 0);
  }
});

test('numeric diagnostics preserve finite integer and inclusive bound checks', () => {
  const revision = schema('render').properties.revision;
  for (const [value, type] of [[0, 'number'], [1.5, 'number'], [NaN, 'number'], [Infinity, 'number'], ['1', 'string']]) {
    assert.equal(errorFor(value, revision), `arguments: invalid numeric value; expected finite integer >= 1; received type ${type}`);
  }
  for (const value of [1, Number.MAX_SAFE_INTEGER]) assert.doesNotThrow(() => validateArguments(value, revision));
  const timeout = schema('wait').properties.timeoutSeconds;
  for (const value of [0, 281]) assert.equal(errorFor(value, timeout), 'arguments: invalid numeric value; expected finite number >= 1 <= 280; received type number');
  for (const value of [1, 280]) assert.doesNotThrow(() => validateArguments(value, timeout));
  assert.equal(errorFor(3, { type: 'number', maximum: 2 }), 'arguments: invalid numeric value; expected finite number <= 2; received type number');
  assert.equal(errorFor(Infinity, { type: 'number' }), 'arguments: invalid numeric value; expected finite number; received type number');
});

test('enum details preserve numeric and false choices', () => {
  const hum = schema('audio_repair').properties.hum;
  for (const value of [0, 50, 60]) assert.doesNotThrow(() => validateArguments(value, hum));
  assert.equal(errorFor(55, hum), 'arguments: unsupported choice; allowed choices: 0, 50, 60');
  const falsy = schema('auto_edit').properties.reframe.anyOf[1];
  assert.doesNotThrow(() => validateArguments(false, falsy));
  assert.equal(errorFor(true, falsy), 'arguments: unsupported choice; allowed choices: false');
});

test('enum diagnostics list every real operation, master format and platform choice', () => {
  const submitted = 'SYNTHETIC_PRIVATE_ENUM_91_ONLY';
  const definitions = [
    schema('edit').properties.operations.items.properties.op,
    schema('update').properties.options.properties.masterFormat,
    schema('auto_edit').properties.platform,
  ];
  for (const definition of definitions) {
    assert.ok(definition.enum.length > 4 && definition.enum.length <= 32);
    const message = errorFor(submitted, definition);
    assert.equal(message, `arguments: unsupported choice; allowed choices: ${definition.enum.map(item => JSON.stringify(item)).join(', ')}`);
    assert.ok(!message.includes(submitted));
    for (const value of definition.enum) assert.doesNotThrow(() => validateArguments(value, definition));
  }
});

test('pattern details describe the actual accepted shape without tightening it', () => {
  const definitions = [
    [schema('get').properties.projectId, 'x', '-'.repeat(36), '^[0-9a-f-]{36}$'],
    [schema('sections').properties.clip, 'UPPER', 'abc123', '^[a-z0-9]{1,24}$'],
    [schema('comments').properties.id, 'G0000000', 'abc012ef', '^[0-9a-f]{8}$'],
    [schema('music').properties.key, 'Hm', 'F#m', '^[A-G](#|b)?m?$'],
  ];
  for (const [definition, invalid, valid, pattern] of definitions) {
    assert.equal(errorFor(invalid, definition), `arguments: invalid identifier; expected pattern ${JSON.stringify(pattern)}`);
    assert.doesNotThrow(() => validateArguments(valid, definition));
  }
});

test('length details use UTF-16 units and retain nested argument prefixes', async () => {
  const definition = { type: 'string', maxLength: 2 };
  assert.doesNotThrow(() => validateArguments('😀', definition));
  assert.equal(errorFor('😀x', definition), 'arguments: text too long; maximum 2 UTF-16 code units; actual UTF-16 length 3');
  let calls = 0;
  await assert.rejects(callAgentTool('studio_create', {
    name: 'Synthetic', inputs: ['synthetic-only.mp4'], options: { texts: [{ start: 0, text: 'x'.repeat(121) }] },
  }, async () => { calls++; throw new Error('unexpected API call'); }), error => {
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.equal(error.message, 'arguments.options.texts[0].text: text too long; maximum 120 UTF-16 code units; actual UTF-16 length 121');
    return true;
  });
  assert.equal(calls, 0);
});

test('anyOf keeps first-variant errors and compatibility wording', () => {
  const any = { anyOf: [{ type: 'string', enum: ['first'] }, { type: 'integer', minimum: 1 }] };
  assert.equal(errorFor('other', any), 'arguments: no allowed form matched (arguments: unsupported choice; allowed choices: "first")');
  assert.doesNotThrow(() => validateArguments('first', any));
  assert.doesNotThrow(() => validateArguments(1, any));
  const audio = schema('update').properties.options.properties.audioRepair;
  assert.equal(errorFor({ hum: 55 }, audio), 'arguments: no allowed form matched (arguments: expected null)');
  assert.doesNotThrow(() => validateArguments(null, audio));
  assert.doesNotThrow(() => validateArguments({ hum: 0 }, audio));
  assert.equal(errorFor({ unknown: true }, schema('get')), 'arguments: missing projectId');
  assert.equal(errorFor({ projectId, unknown: true }, schema('get')), 'arguments: unknown field unknown');
});

test('new diagnostic details do not echo submitted synthetic private values', () => {
  const privateValues = ['SYNTHETIC_TOKEN_91_ONLY', '/synthetic/private/file', 'Synthetic transcript contents'];
  for (const value of privateValues) {
    const messages = [
      errorFor(value, { type: 'string', enum: ['allowed'] }),
      errorFor(value.repeat(20), { type: 'string', maxLength: 1 }),
      errorFor(value, { type: 'string', pattern: '^allowed$' }),
      errorFor(value, { type: 'integer', minimum: 1 }),
    ];
    for (const message of messages) assert.ok(!message.includes(value));
  }
  const object = { toString() { throw new Error('must not stringify submitted object'); }, toJSON() { throw new Error('must not serialize submitted object'); } };
  assert.equal(errorFor(object, { type: 'integer' }), 'arguments: invalid numeric value; expected finite integer; received type object');
});

test('schema metadata is escaped and bounded before rendering', () => {
  const definition = { type: 'string', enum: [
    'quote"\n\\', '\u0000'.repeat(1000), 'x'.repeat(1000),
    ...Array.from({ length: 28 }, (_, i) => `choice-${i + 4}`), 'last-visible', 'omitted',
  ] };
  const submitted = 'SYNTHETIC_PRIVATE_ENUM_91_ONLY';
  const message = errorFor(submitted, definition);
  assert.ok(message.includes(JSON.stringify('quote"\n\\')));
  assert.ok(!message.includes('\n'));
  assert.ok(!message.includes('\u0000'));
  assert.ok(message.includes(JSON.stringify('\u0000'.repeat(16)) + '…'));
  assert.ok(message.includes(JSON.stringify('x'.repeat(16)) + '…'));
  for (const item of definition.enum.slice(3, 32)) assert.ok(message.includes(JSON.stringify(item)));
  assert.ok(message.endsWith('"last-visible", … (see schema)'));
  assert.ok(!message.includes('omitted'));
  assert.ok(!message.includes(submitted));
  assert.ok(message.length <= 'arguments: unsupported choice; allowed choices: '.length + 3246);
  assert.ok(errorFor(submitted, { ...definition, enum: definition.enum.slice(0, 32) }).endsWith('"last-visible"'));
  assert.doesNotThrow(() => validateArguments('omitted', definition));
  const pattern = '^' + 'x'.repeat(1000) + '$';
  const patternMessage = errorFor('submitted', { type: 'string', pattern });
  assert.equal(patternMessage, `arguments: invalid identifier; expected pattern ${JSON.stringify(pattern.slice(0, 64))}…`);
  assert.ok(patternMessage.length <= 'arguments: invalid identifier; expected pattern '.length + 387);
  const hostile = { toJSON() { throw new Error('must not serialize schema object'); }, toString() { throw new Error('must not stringify schema object'); } };
  assert.equal(errorFor('submitted', { type: 'string', enum: [hostile] }), 'arguments: unsupported choice; allowed choices: [non-scalar schema value]');
});

test('direct valid tools keep prehealth returns and routed local stub wiring', async () => {
  let unexpected = 0;
  const noApi = async () => { unexpected++; throw new Error('unexpected API call'); };
  assert.equal((await callAgentTool('studio_schema', {}, noApi)).version, STUDIO_VERSION);
  assert.equal((await callAgentTool('studio_guide', { topic: 'story' }, noApi)).version, 'aes.story/1');
  assert.equal(unexpected, 0);
  const calls = [];
  const sentinel = new Error('synthetic-route-sentinel');
  const api = async (...args) => { calls.push(args); if (calls.length === 1) return { service: 'AI Edit Studio', version: '0.12.0' }; throw sentinel; };
  await assert.rejects(callAgentTool('studio_get', { projectId }, api), error => error === sentinel);
  assert.deepEqual(calls, [['/health'], [`/studio/projects/${projectId}`]]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hashSourceTreeFiles,
  parseTapResults,
  RISK_CONTROLS,
} from '../scripts/run-risk-proofs.mjs';

test('native TAP results preserve exact titles and distinguish skipped tests', () => {
  const results = parseTapResults(
    [
      'TAP version 13',
      'ok 1 - compatibility contract: API v1 accepts the published 10,000 USD claim limit 1.247ms',
      'not ok 2 - API v2 caps claims at 5,000 USD while API v1 keeps its 10,000 USD contract',
      'ok 3 - removed detector # SKIP test name does not match pattern',
    ].join('\n'),
  );

  assert.equal(
    results.get(
      'compatibility contract: API v1 accepts the published 10,000 USD claim limit',
    ),
    'passed',
  );
  assert.equal(
    results.get(
      'API v2 caps claims at 5,000 USD while API v1 keeps its 10,000 USD contract',
    ),
    'failed',
  );
  assert.equal(results.get('removed detector'), 'skipped');
});

test('mutated target digest covers a deterministic, path-bound source tree', () => {
  const first = hashSourceTreeFiles([
    { path: 'src/server.js', content: 'mutated server' },
    { path: 'src/domain.js', content: 'unchanged domain' },
  ]);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    first,
    hashSourceTreeFiles([
      { path: 'src/domain.js', content: 'unchanged domain' },
      { path: 'src/server.js', content: 'mutated server' },
    ]),
  );
  assert.notEqual(
    first,
    hashSourceTreeFiles([
      { path: 'src/server.js', content: 'clean server' },
      { path: 'src/domain.js', content: 'unchanged domain' },
    ]),
  );
  assert.notEqual(
    first,
    hashSourceTreeFiles([
      { path: 'src/renamed.js', content: 'mutated server' },
      { path: 'src/domain.js', content: 'unchanged domain' },
    ]),
  );
  assert.throws(() => hashSourceTreeFiles([]), /tracked files/);
  assert.throws(
    () => hashSourceTreeFiles([{ path: '/unsafe', content: 'x' }]),
    /unsafe path/,
  );
});

test('every declared business-risk control has one exact source mutation anchor', () => {
  for (const control of RISK_CONTROLS) {
    const source = readFileSync(control.path, 'utf8');
    assert.equal(
      source.split(control.before).length - 1,
      1,
      `${control.controlId} mutation anchor`,
    );
    assert.ok(
      control.expectedNativeTestIds.length > 0,
      `${control.controlId} native tests`,
    );
    assert.ok(
      control.expectedNativeTestIds.includes(control.detectingTestId),
      `${control.controlId} detector test`,
    );
  }
});

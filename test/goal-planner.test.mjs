import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidatesFromDiscovery, selectOffline, selectWithOpenAI,
  verifySelection, goalPlanFromSelection, createGoalGuide,
} from '../src/goal-planner.mjs';
import { Plan } from '../src/plan.mjs';

const discovery = {
  report: {
    pages: [{
      finalUrl: 'https://example.com', title: 'Tutorial example',
      candidates: [
        { text: 'Pricing and plans', css: '#plans' },
        { text: 'Premium hosting', css: '#premium' },
        { text: 'Create an account', css: '#signup' },
        { text: 'Password', css: '#password' },
      ],
    }],
  },
};
const source = candidatesFromDiscovery(discovery);

test('Goal candidate extraction preserves observed CSS and skips sensitive form labels', () => {
  assert.deepEqual(source.candidates.map(x => x.css), ['#plans', '#premium', '#signup']);
  assert.equal(source.candidates[1].id, 'candidate-2');
});

test('Offline goal selection is relevant and fails if evidence is absent', () => {
  const selected = selectOffline('Giới thiệu gói Premium hosting', source.candidates);
  assert.deepEqual(selected.selectedIds, ['candidate-2']);
  assert.throws(() => selectOffline('Thiết lập server Kubernetes', source.candidates), /Insufficient evidence/);
  assert.throws(() => selectOffline('giúp tôi', source.candidates), /too vague|Insufficient/);
});

test('Model cannot add selectors, IDs, steps or actions absent from evidence', async () => {
  let payload;
  const fakeFetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    assert.match(options.headers.Authorization, /^Bearer fake-key$/);
    return {
      ok: true, status: 200,
      json: async () => ({ status: 'completed', output: [
        { type: 'message', content: [
          { type: 'output_text', text: JSON.stringify({ selectedIds: ['candidate-2'], reason: 'Matches premium' }) },
        ] },
      ] }),
    };
  };
  const result = await selectWithOpenAI('Giới thiệu Premium', source.candidates, {
    apiKey: 'fake-key', model: 'gpt-6-luna', fetchImpl: fakeFetch,
  });
  assert.deepEqual(result.selectedIds, ['candidate-2']);
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.store, false);
  assert.ok(!optionsHasSelector(payload));
  assert.throws(() => verifySelection(['fake-id'], source.candidates), /not in observed/);
  assert.throws(() => verifySelection(['candidate-2', 'candidate-2'], source.candidates), /duplicate/);
  await assert.rejects(
    selectWithOpenAI('Premium', source.candidates, {
      apiKey: 'fake-key',
      fetchImpl: async () => ({
        ok: true, json: async () => ({
          status: 'completed', output: [{ content: [
            { type: 'output_text', text: JSON.stringify({ selectedIds: ['hallucinated'], reason: 'fake' }) },
          ] }],
        }),
      }),
    }),
    /not in observed/,
  );
});

function optionsHasSelector(payload) {
  const text = JSON.stringify(payload.input);
  return text.includes('#premium') || text.includes('#plans');
}

test('Goal plan contains only read-only verified highlight steps plus terminal stop', () => {
  const plan = goalPlanFromSelection({
    ...source, goal: 'Giới thiệu Premium hosting',
    language: 'vi', selection: { selectedIds: ['candidate-2'], reason: 'test' },
  });
  assert.equal(Plan.safeParse(plan).success, true);
  assert.equal(plan.steps[0].target.css, '#premium');
  assert.deepEqual(plan.steps.map(s => s.action), ['highlight', 'stop']);
  assert.ok(plan.steps.every(s => !s.reviewed && !s.url && !s.value));
});

test('Goal job persists evidence and refuses invented candidates from AI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-planner-'));
  const response = await createGoalGuide('https://example.com', {
    goal: 'Giới thiệu Premium hosting', outDir: root,
    exploreImpl: async () => discovery,
  });
  assert.equal(response.report.status, 'completed');
  assert.equal(response.plan.steps[0].target.css, '#premium');
  const evidence = JSON.parse(await readFile(path.join(root, 'goal-evidence.json'), 'utf8'));
  assert.deepEqual(evidence.selectedIds, ['candidate-2']);
  const parsed = Plan.parse(JSON.parse(await readFile(path.join(root, 'plan.json'), 'utf8')));
  assert.equal(parsed.steps.at(-1).action, 'stop');

  await assert.rejects(createGoalGuide('https://example.com', {
    goal: 'Giới thiệu Premium hosting', ai: true, outDir: path.join(root, 'failed'),
    exploreImpl: async () => discovery,
    selectImpl: async () => ({ selectedIds: ['unknown-id'], reason: 'injected' }),
  }), /not in observed/);
});

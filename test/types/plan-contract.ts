import type { TutorialPlanInput } from '../../types/generated/tutorial-plan.input.js';
import type { TutorialPlan } from '../../types/generated/tutorial-plan.js';

// Input accepts omitted defaults. Parsed output requires them.
const input = {
  schemaVersion: 1, title: 'Example', url: 'https://example.com',
  steps: [{ id: 'intro', title: 'Intro', description: '', target: { css: 'h1' } }],
} satisfies TutorialPlanInput;
const output: TutorialPlan = {
  ...input, language: 'vi', mode: 'overview', viewport: { width: 1280, height: 720 },
  steps: [{ ...input.steps[0], action: 'highlight', holdMs: 3000, reviewed: false }],
};

// @ts-expect-error Parsed plans must include defaulted fields.
const incompleteOutput: TutorialPlan = input;
// @ts-expect-error Actions are a closed contract.
const badAction: TutorialPlan['steps'][number]['action'] = 'purchase';
// @ts-expect-error Schema versions are literals.
const badVersion: TutorialPlanInput['schemaVersion'] = 2;
void [output, incompleteOutput, badAction, badVersion];

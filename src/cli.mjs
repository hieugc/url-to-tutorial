#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import path from 'node:path';
import { explore } from './discover.mjs';
import { createGoalGuide } from './goal-planner.mjs';
import { createHostingerGuide } from './adapters/hostinger.mjs';
import { assembleDiscovery } from './assemble.mjs';
import { render } from './render.mjs';
import { renderNarrated } from './narration.mjs';
import { Plan, validatePlanForExecution } from './plan.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string' }, headed: { type: 'boolean', default: false }, language: { type: 'string', default: 'vi' },
  'max-pages': { type: 'string', default: '1' },
  goal: { type: 'string' }, ai: { type: 'boolean', default: false },
  narrate: { type: 'boolean', default: false },
} });
const [action, input] = positionals;
const outDir = values.out || 'output/' + new Date().toISOString().replace(/[:.]/g, '-');
try {
  if (action === 'discover' || action === 'run') {
    const maxPages = Number(values['max-pages']);
    const { plan, plans } = await explore(input, { ...values, maxPages, outDir });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
    if (plans.length > 1) {
      const pagesDir = path.join(outDir, 'pages');
      await mkdir(pagesDir, { recursive: true });
      for (const [i, pagePlan] of plans.entries()) {
        await writeFile(path.join(pagesDir, 'page-' + (i + 1) + '.plan.json'), JSON.stringify(pagePlan, null, 2));
      }
      console.log('Found ' + plans.length + ' page plans. Run "assemble ' + outDir + '" to create one continuous multi-page plan.');
    }
    console.log('Discovery evidence: ' + path.join(outDir, 'discovery-report.json'));
    console.log('Plan: ' + outDir + '/plan.json (overview; no automatic clicks)');
    if (action === 'run') console.log(JSON.stringify(await (values.narrate ? renderNarrated : render)(plan, { outDir, headed: values.headed }), null, 2));
  } else if (action === 'goal') {
    const { plan, report } = await createGoalGuide(input, {
      goal: values.goal, language: values.language, ai: values.ai, outDir,
    });
    console.log('Goal-based draft created: ' + plan.steps.length + ' steps');
    console.log('Provider: ' + report.provider);
    console.log('Plan: ' + path.join(outDir, 'plan.json'));
    console.log('Grounding evidence: ' + path.join(outDir, 'goal-evidence.json'));
    console.log('Read-only highlight/stop only. No task execution is approved.');
  } else if (action === 'hostinger') {
    const { plan, evidence, report } = await createHostingerGuide(input, {
      outDir, headed: values.headed, language: values.language,
    });
    await writeFile(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
    await writeFile(path.join(outDir, 'hostinger-evidence.json'), JSON.stringify({ ...report, evidence }, null, 2));
    console.log('Read-only Hostinger guide: ' + plan.steps.length + ' steps');
    console.log('Verified DOM evidence: ' + path.join(outDir, 'hostinger-evidence.json'));
    console.log('Editable plan: ' + path.join(outDir, 'plan.json'));
    console.log('This does not click any purchase or checkout button.');
  } else if (action === 'assemble') {
    const plan = await assembleDiscovery(input);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
    const reviewIssues = validatePlanForExecution(plan);
    console.log('Assembled ' + plan.steps.length + ' steps into ' + path.join(outDir, 'plan.json'));
    console.log('Review required before preview/render:');
    for (const issue of reviewIssues) console.log('- ' + issue);
    console.log('Set reviewed: true only after checking each navigation URL and its effect.');
  } else if (['render', 'preview', 'validate'].includes(action)) {
    const plan = Plan.parse(JSON.parse(await readFile(input, 'utf8')));
    if (action === 'validate') {
      const issues = validatePlanForExecution(plan);
      if (issues.length) throw new Error('Plan is structurally valid but not ready to execute:\n- ' + issues.join('\n- '));
      console.log('Valid and reviewed plan: ' + plan.steps.length + ' steps');
    } else {
      const runner = values.narrate && action === 'render' ? renderNarrated : render;
      console.log(JSON.stringify(await runner(plan, { outDir, headed: values.headed, preview: action === 'preview' }), null, 2));
    }
  } else if (action === 'demo') {
    const html = await readFile(new URL('../examples/demo.html', import.meta.url));
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const plan = JSON.parse(await readFile(new URL('../examples/demo.plan.json', import.meta.url), 'utf8'));
      plan.url = 'http://127.0.0.1:' + server.address().port;
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
      console.log(JSON.stringify(await (values.narrate ? renderNarrated : render)(plan, { outDir, headed: values.headed }), null, 2));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } else {
    console.log('Commands: goal <url> --goal <text> [--ai] | hostinger <https://www.hostinger.com/vn#pricing> | discover <url> | assemble <discovery-dir> | run <url> | validate <plan.json> | preview <plan.json> | render <plan.json> | demo\nOptions: --out output/name --headed --language vi|en --max-pages 1..5 --narrate');
    if (action) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

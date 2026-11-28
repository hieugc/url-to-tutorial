import { existsSync } from 'node:fs';
import path from 'node:path';

export default function (plop) {
  plop.setGenerator('adapter', {
    description: 'Create an observed-data plan adapter and its unit tests',
    prompts: [{
      type: 'input', name: 'name', message: 'Adapter name (kebab-case):',
      validate: value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) || 'Use lowercase kebab-case',
    }],
    actions(data) {
      // Validate again: non-interactive CLI bypasses prompt validation.
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(data.name || '')) {
        throw new Error('Adapter name must use lowercase kebab-case');
      }
      const outputs = [`src/adapters/${data.name}.mjs`, `test/${data.name}.test.mjs`];
      for (const output of outputs) {
        if (existsSync(path.join(plop.getDestBasePath(), output))) {
          throw new Error(`Refusing to overwrite ${output}`);
        }
      }
      return outputs.map((output, index) => ({
        type: 'add', path: output,
        templateFile: `templates/adapter/${index ? 'test' : 'adapter'}.mjs.hbs`,
        abortOnFail: true,
      }));
    },
  });
}

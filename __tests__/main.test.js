const childProcess = require('child_process');

test('missing project', () => {
  const [stdout, stderr] = run();
  expect(stdout).toMatchSnapshot();
  expect(stderr).toMatchSnapshot();
});

test('missing destination', () => {
  const [stdout, stderr] = run('project');
  expect(stdout).toMatchSnapshot();
  expect(stderr).toMatchSnapshot();
});

function run(args = '') {
  try {
    const result = childProcess.execSync(`node main.js ${args}`, { stdio: 'pipe' });
    return [result.stdout.toString(), result.stderr.toString()];
  } catch (err) {
    return [err.stdout.toString(), err.stderr.toString()];
  }
}

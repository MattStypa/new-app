const childProcess = require('child_process');

test('missing project', () => {
  runAndMatchSnapshot();
});

test('missing directory', () => {
  runAndMatchSnapshot('test');
});

function runAndMatchSnapshot(...args) {
  const result = childProcess.spawnSync(`node`, ['main.js', ...args]);
  expect(result.stdout.toString()).toMatchSnapshot();
}

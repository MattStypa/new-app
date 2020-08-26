const nock = require('nock');
const zlib = require('zlib');

let counter = 0;
const githubApi = nock('https://api.github.com');
const githubCdn = nock('https://raw.githubusercontent.com');

const tree = [
  { type: 'blob', path: 'a.ext' },
  { type: 'blob', path: 'b/a.ext' },
  { type: 'blob', path: 'b/b/a.ext' },
  { type: 'blob', path: 'b/b/b.ext' },
];

beforeEach(async () => {
  githubCdn.get('/new/app/master/a.ext').reply(200, await gzip());
  githubCdn.get('/new/app/master/b/a.ext').reply(200, await gzip('ba'));
  githubCdn.get('/new/app/master/b/b/a.ext').reply(200, await gzip('bba'));
  githubCdn.get('/new/app/master/b/b/b.ext').reply(200, await gzip('bbb'));
});

validate('missing project', async () => {
  return await run();
});

validate('missing directory', async () => {
  return await run('mattstypa/new-app');
});

validate('directory exists', async () => {
  return await run('mattstypa/new-app', '__tests__');
});

validate('github network error', async () => {
  githubApi.get('/repos/new/app/releases/latest').replyWithError({});
  return await run('new/app', 'test');
});

validate('github server error', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(500);
  return await run('new/app', 'test');
});

validate('repository not found', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(404);
  githubApi.get('/repos/new/app/git/trees/master?recursive=1').reply(404);
  return await run('new/app', 'test');
});

validate('github bad response', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(200, await gzip('Not JSON'));
  return await run('new/app', 'test');
});

validate('truncated repository', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(404);
  githubApi.get('/repos/new/app/git/trees/master?recursive=1').reply(200, await gzipJson({ truncated: true }));
  return await run('new/app', 'test');
});

validate('empty repository', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(404);
  githubApi.get('/repos/new/app/git/trees/master?recursive=1').reply(200, await gzipJson({ truncated: false, tree: [] }));
  return await run('new/app', 'test');
});

validate('repository path not found', async () => {
  githubApi.get('/repos/new/app/releases/latest').reply(404);
  githubApi.get('/repos/new/app/git/trees/master?recursive=1').reply(200, await gzipJson({ truncated: false, tree }));
  return await run('new/app/d', 'path');
});

function validate(name, fn) {
  const id = `${++counter}`.padStart(3, 0);

  test(`${id}: ${name}`, async () => {
    expect(await fn()).toMatchSnapshot();
  });
}

async function gzipJson(data) {
  return await gzip(JSON.stringify(data));
}

async function gzip(data) {
  return await new Promise((resolve) => zlib.gzip(data, (error, result) => resolve(result)));
}

async function run(...args) {
  const originals = {write: process.stdout.write, isTTY: process.stdout.isTTY};
  const mocks = {write: jest.fn(), isTTY: false};

  process.argv = ['npx', 'new-app', ...args];
  process.exit = jest.fn();
  Object.assign(process.stdout, mocks);

  jest.resetModules();
  await require('../main.js');

  Object.assign(process.stdout, originals);

  return mocks.write.mock.calls.map((args) => args.join(' ')).join('');
}

#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const nodePath = require('path');
const nodeUrl = require('url');
const nodeUtil = require('util');
const zlib = require('zlib');
const pkg = require('./package.json');

const maxSimultaneouslyDownloads = 6; // Default for most browsers
const userAgent = `${pkg.name}/${pkg.version} (+${pkg.homepage})`;
const stdout = process.stdout;

const [progressShow, progressClear, progressSet] = progressBar(30);

const errors = {
  projectNameRequired: () => newError('Project name is required.', [], true),
  desitnationRequired: () => newError('Destination directory is required.', [], true),
  destinationExists: (path) => newError('Directory already exists.', [path]),
  networkError: (url) => newError('Network error.', [url]),
  serverError: (url, error) => newError('Server error.', [url, error]),
  badData: () => newError('Unable to read data.'),
  repoNotFound: (repo, hash) => newError('Repository, branch, or tag not found.', [`${repo}#${hash}`]),
  repoPathNotFound: (repo, path) => newError('Repository path not found.', [`${repo}/${path}`]),
  repoTooBig: (repo) => newError('Repository is too large.', [repo]),
  fileSystem: (path) => newError('Unable to access path.', [path]),
  cantMakeDir: (path) => newError('Unable to create a directory.', [path]),
  cantWriteFile: (path) => newError('Unable to write a file.', [path]),
};

main().catch(errorHandler);

function errorHandler(error) {
  progressClear();

  log(red(error.message));
  error.data && error.data.forEach((line) => log(line));
  log();

  if (error.withHelp) {
    log('Usage:');
    log(white('npx new-app'), magenta('<project> <directory>'));
    log();
  }

  log('For help resolving this problem please visit:');
  log(white(pkg.bugs.url));
  log();

  process.exit(1);
}

async function main() {
  log();
  log(white(pkg.name), pkg.version);
  log();

  const sourceArg = process.argv[2];
  const destArg = process.argv[3];

  if (!sourceArg) throw errors.projectNameRequired();
  if (!destArg) throw errors.desitnationRequired();

  const dest = nodePath.resolve(destArg);

  if (await exists(dest)) throw errors.destinationExists(dest);

  const sourceParts = sourceArg.split('#').filter((part) => part);
  const repoParts = sourceParts[0].split('/').filter((part) => part);
  const repo = repoParts.slice(0, 2).join('/');
  const repoPath = repoParts.slice(2).join('/');
  const sourceHash = sourceParts[1];

  const hash = sourceHash || await getLatestRelease(repo) || 'master';
  const repoFiles = await getRepoFiles(repo, hash);
  const files = filterFilesByPath(repoFiles, repoPath);

  if (!files.length) throw errors.repoPathNotFound(repo, repoPath);

  await downloadFiles(files, dest);

  log(cyan(repo) + '#' + white(hash), 'has been set up in', magenta(dest));
  log();
}

async function getLatestRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  const latestRelease = parseJson(response);
  return latestRelease && latestRelease.tag_name;
}

async function getRepoFiles(repo, hash) {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${hash}?recursive=1`);

  if (!response) throw errors.repoNotFound(repo, hash);

  const repoFiles = parseJson(response);

  if (repoFiles.truncated) throw errors.repoTooBig();

  return repoFiles.tree.filter((node) => node.type === 'blob').map((file) => ({
    path: file.path,
    url: `https://raw.githubusercontent.com/${repo}/${hash}/${file.path}`,
  }));
}

async function downloadFiles(files, dest) {
  const queue = [...files];
  const total = queue.length;
  progressShow(total);

  const worker = async () => {
    let file;

    while(file = queue.pop()) {
      await download(file.url, nodePath.resolve(dest, file.path));
      progressSet(1 - queue.length / total);
    }
  };

  await Promise.all(Array(maxSimultaneouslyDownloads).fill(null).map(worker));

  progressClear();
}

async function fetch(url) {
  const [found, stream] = await request(url);
  const data = [];

  if (!found || !stream) return null;

  stream.setEncoding('utf8')
  stream.on('data', (chunk) => data.push(chunk));

  await stream.promise;
  return data.join('');
}

async function download(url, filePath) {
  await makeDirectory(nodePath.dirname(filePath));
  const [found, stream] = await request(url);

  if (!found) throw errors.serverError(url, 'NotFound');

  const writeStream = fs.createWriteStream(filePath);

  if (stream) {
    writeStream.on('error', () => stream.reject(errors.cantWriteFile(filePath)));
    stream.pipe(writeStream);
    await stream.promise;
  } else {
    writeStream.end();
  }
}

async function request(url) {
  const response = await httpsGet(url);

  if (response.statusCode === 200 && response.headers['content-length'] !== '0') {
    const [resolve, reject, promise] = defer();
    const gunzipStream = zlib.createGunzip();
    const stream = response.pipe(gunzipStream);

    response.on('error', () => reject(errors.networkError(url)));
    gunzipStream.on('error', () => reject(errors.networkError(url)));
    stream.on('end', resolve);
    Object.assign(stream, { promise, resolve, reject });

    return [true, stream];
  }

  response.resume();

  if (response.statusCode === 200) return [true, null];
  if (response.statusCode === 404) return [false, null];

  throw errors.serverError(url, response.statusMessage);
}

async function httpsGet(url) {
  const [resolve, reject, promise] = defer();
  const options = Object.assign(nodeUrl.parse(url), { headers: {
    'User-Agent': userAgent,
    'Accept-Encoding': 'gzip',
  }});

  https.get(options, resolve).on('error', () => reject(errors.networkError(url)));

  return await promise;
}

async function makeDirectory(path) {
  const paths = nodePath
    .resolve(path)
    .split(nodePath.sep)
    .map((path, index, paths) => paths.slice(0, paths.length - index).join(nodePath.sep))
    .filter((path) => path);

  let depth;

  for (let i = 0; i < paths.length; i++) {
    depth = i;
    if (await exists(paths[i])) break;
  }

  if (!depth) return;

  for (let i = depth; i > 0; i--) {
    try {
      await nodeUtil.promisify(fs.mkdir)(paths[i - 1]);
    } catch(error) {
      if (error.code !== 'EEXIST') throw errors.cantMakeDir(path);
    }
  }
}

async function exists(path) {
  try {
    await nodeUtil.promisify(fs.stat)(nodePath.resolve(path));
    return true;
  } catch(error) {
    if (error.code !== 'ENOENT') throw errors.fileSystem(path);
    return false;
  }
}

function filterFilesByPath(files, path) {
  const prefix = path ? `${path}/` : '';
  return files.filter((file) => file.path.startsWith(prefix)).map((file) => Object.assign(file, {
    path: file.path.slice(prefix.length),
  }));
}

function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch(error) {
    throw errors.badData();
  }
}

function defer() {
  const control = [];
  const promise = new Promise((...args) => control.push(...args));
  return [...control, promise];
}

function progressBar(size) {
  let current = 0;

  const show = () => {
    if (stdout.isTTY) {
      stdout.write('\x1B[?25l'); // Hide cursor
      stdout.write('   (' + ' '.repeat(size) + ')');
    } else {
      log('Please wait ...');
      log();
    }
  };

  const clear = () => {
    if (stdout.isTTY) {
      stdout.clearLine();
      stdout.cursorTo(0);
      stdout.write('\x1B[?25h'); // Show cursor
    }
  };

  const set = (value) => {
    if (stdout.isTTY) {
      const next = Math.min(Math.round(value * size), size);
      stdout.cursorTo(current + 4);
      stdout.write('•'.repeat(next - current));
      current = next;
    }
  };

  return [show, clear, set];
}

function white(str) {
  return color('\x1B[1;37m', str);
}

function red(str) {
  return color('\x1B[1;31m', str);
}

function magenta(str) {
  return color('\x1B[1;35m', str);
}

function cyan(str) {
  return color('\x1B[1;36m', str);
}

function color(code, str) {
  return stdout.isTTY ? code + str + '\x1B[0m' : str;
}

function log(...args) {
  console.log('  ', ...args);
}

function newError(message, data = [], withHelp = false) {
  const error = new Error(message);
  return Object.assign(error, { data, withHelp });
}

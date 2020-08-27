#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
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

const projectNameRequired = () => newError('Project name is required.', [], true);
const desitnationRequired = () => newError('Destination directory is required.', [], true);
const destinationExists = (path) => newError('Directory already exists.', [path]);
const networkError = (url) => newError('Network error.', [url]);
const serverError = (url, error) => newError('Server error.', [url, error]);
const badData = (url) => newError('Unable to read data.', [url]);
const repoNotFound = (repo) => newError('Repository not found.', [repo]);
const repoHashNotFound = (repo, hash) => newError('Repository branch, or tag not found.', [`${repo}#${hash}`]);
const repoPathNotFound = (path) => newError('Repository path not found.', [path]);
const repoEmpty = (repo, hash) => newError('Repository is empty.', [`${repo}#${hash}`]);
const repoTooBig = (repo, hash) => newError('Repository is too large.', [`${repo}#${hash}`]);
const fileSystem = (path) => newError('Unable to access path.', [path]);
const cantMakeDir = (path) => newError('Unable to create a directory.', [path]);
const cantWriteFile = (path) => newError('Unable to write a file.', [path]);

const color = (code, str) => stdout.isTTY ? `\x1B[1;${code}m${str}\x1B[0m` : str;
const white = (str) => color(37, str);
const red = (str) => color(31, str);
const magenta = (str) => color(35, str);
const cyan = (str) => color(36, str);

const statusText = (code) => http.STATUS_CODES[code] || 'Unknown';
const log = (...args) => stdout.write(['  ', ...args, '\n'].join(' '));

module.exports = main().catch(errorHandler);

function errorHandler(error) {
  progressClear();

  log(red(error.message));

  if (error.data) error.data.forEach((line) => log(line));

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

  if (!sourceArg) throwError(projectNameRequired());
  if (!destArg) throwError(desitnationRequired());

  const dest = nodePath.resolve(destArg);

  if (await exists(dest)) throwError(destinationExists(dest));

  const sourceParts = sourceArg.split('#').filter((part) => part);
  const repoParts = sourceParts[0].split('/').filter((part) => part);
  const repo = repoParts.slice(0, 2).join('/');
  const repoPath = repoParts.slice(2).join('/');
  const sourceHash = sourceParts[1];

  const hash = sourceHash
    || await getLatestRelease(repo)
    || await getDefaultBranch(repo);

  const repoFiles = await getRepoFiles(repo, hash);
  const files = filterFilesByPath(repoFiles, repoPath);

  if (!repoFiles.length) throwError(repoEmpty(repo, hash));
  if (!files.length) throwError(repoPathNotFound(repoPath));

  await downloadFiles(files, dest);

  log(cyan(repo) + '#' + white(hash), 'has been set up in', magenta(dest));
  log();
}

async function getLatestRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const response = await fetch(url);
  const latestRelease = parseJsonResponse(response, url);

  return latestRelease && latestRelease.tag_name;
}

async function getDefaultBranch(repo) {
  const url = `https://api.github.com/repos/${repo}`;
  const response = await fetch(url);

  if (!response) throwError(repoNotFound(repo));

  const repoProps = parseJsonResponse(response, url);

  return repoProps && repoProps.default_branch;
}

async function getRepoFiles(repo, hash) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${hash}?recursive=1`
  const response = await fetch(url);

  if (!response) throwError(repoHashNotFound(repo, hash));

  const repoFiles = parseJsonResponse(response, url);

  if (repoFiles.truncated) throwError(repoTooBig(repo, hash));

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

  if (!found) throwError(serverError(url, statusText(404)));

  const writeStream = fs.createWriteStream(filePath);

  if (stream) {
    writeStream.on('error', () => stream.reject(cantWriteFile(filePath)));
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

    response.on('error', () => reject(networkError(url)));
    gunzipStream.on('error', () => reject(networkError(url)));
    stream.on('end', resolve);
    Object.assign(stream, { promise, resolve, reject });

    return [true, stream];
  }

  response.resume();

  if (response.statusCode === 200) return [true, null];
  if (response.statusCode === 404) return [false, null];

  throwError(serverError(url, statusText(response.statusCode)));
}

async function httpsGet(url) {
  const [resolve, reject, promise] = defer();
  const options = Object.assign(nodeUrl.parse(url), { headers: {
    'User-Agent': userAgent,
    'Accept-Encoding': 'gzip',
  }});

  https.get(options, resolve).on('error', () => reject(networkError(url)));

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
      if (error.code !== 'EEXIST') throwError(cantMakeDir(path));
    }
  }
}

async function exists(path) {
  try {
    await nodeUtil.promisify(fs.stat)(nodePath.resolve(path));
    return true;
  } catch(error) {
    if (error.code !== 'ENOENT') throwError(fileSystem(path));
    return false;
  }
}

/* istanbul ignore next */
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

function filterFilesByPath(files, path) {
  const prefix = path ? `${path}/` : '';
  return files.filter((file) => file.path.startsWith(prefix)).map((file) => Object.assign(file, {
    path: file.path.slice(prefix.length),
  }));
}

function parseJsonResponse(str, url) {
  try {
    return JSON.parse(str);
  } catch (error) {
    throw badData(url);
  }
}

function defer() {
  const control = [];
  const promise = new Promise((...args) => control.push(...args));
  return [...control, promise];
}

function throwError(error) {
  throw error;
}

function newError(message, data = [], withHelp = false) {
  const error = new Error(message);
  return Object.assign(error, { data, withHelp });
}

#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const nodePath = require('path');
const nodeUrl = require('url');
const nodeUtil = require('util');
const zlib = require('zlib');
const package = require('./package.json');

const mkdir = nodeUtil.promisify(fs.mkdir);
const stat = nodeUtil.promisify(fs.stat);

const maxSimultaneouslyDownloads = 6; // Default for most browsers
const userAgent = `${package.name}/${package.version} (+${package.homepage})`;

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
  cantMakeDir: (path) => newError('Unable to create directory.', [path]),
  cantWriteFile: (path) => newError('Unable to write file.', [path]),
};

main().catch(errorHandler);

function errorHandler(error) {
  logError(red(error.message));
  error.data && error.data.forEach((line) => logError(line));
  log();

  if (error.withHelp) {
    log('Usage:');
    log(white('  npx new-app'), magenta('<project> <directory>'));
    log();
  }

  log('For help resolving this problem please visit:');
  log(white(package.bugs.url));
  log();

  process.exit(1);
}

async function main() {
  log();
  log(white(package.name), cyan(package.version));
  log();

  const sourceArg = process.argv[2];
  const destArg = process.argv[3];

  sourceArg || throwError(errors.projectNameRequired());
  destArg || throwError(errors.desitnationRequired());

  const dest = nodePath.resolve(destArg);

  await exists(dest) && throwError(errors.destinationExists(dest));

  log('Please wait...');
  log();

  const sourceParts = sourceArg.split('#').filter((part) => part);
  const repoParts = sourceParts[0].split('/').filter((part) => part);
  const repo = repoParts.slice(0, 2).join('/');
  const repoPath = repoParts.slice(2).join('/');
  const repoHash = sourceParts.slice(1).join('#');

  const hash = repoHash || await getLatestRelease(repo) || 'master';
  const files = await getRepoFiles(repo, hash);
  const filteredFiles = filterFilesByPath(files, repoPath);

  filteredFiles.length || throwError(errors.repoPathNotFound(repo, repoPath));

  await downloadFiles(filteredFiles, dest);

  log(cyan(repo), 'has been created in', magenta(dest));
  log();
}

async function getLatestRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  const latestRelease = parseJson(response);
  return latestRelease && latestRelease.tag_name;
}

async function getRepoFiles(repo, hash) {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${hash}?recursive=1`);

  response || throwError(errors.repoNotFound(repo, hash));

  const repoFiles = parseJson(response);

  repoFiles.truncated && throwError(errors.repoTooBig());

  return repoFiles.tree.filter((node) => node.type === 'blob').map((node) => ({
    path: node.path,
    url: `https://raw.githubusercontent.com/${repo}/${hash}/${node.path}`,
  }));
}

async function downloadFiles(files, dest) {
  const queue = [...files];
  let file;

  const worker = async () => {
    while(file = queue.pop()) {
      await download(file.url, nodePath.resolve(dest, file.path));
    }
  };

  await Promise.all(Array(maxSimultaneouslyDownloads).fill(null).map(worker));
}

async function fetch(url) {
  const response = await request(url);

  if (!response.found || !response.stream) return null;

  let data = [];

  response.stream.setEncoding('utf8')
  response.stream.on('data', (chunk) => data.push(chunk));

  await response.promise;
  return data.join('');
}

async function download(url, filePath) {
  await makeDirectory(nodePath.dirname(filePath));
  const response = await request(url);

  response.found || throwError(errors.serverError(url, 'NotFound'));

  const writeStream = fs.createWriteStream(filePath);
  writeStream.on('error', () => throwError(errors.cantWriteFile(filePath)));

  if (response.stream) {
    response.stream.pipe(writeStream);
    await response.promise;
  } else {
    writeStream.end('');
  }
}

async function request(url) {
  const options = Object.assign({}, nodeUrl.parse(url), { headers: {
    'User-Agent': userAgent,
    'Accept-Encoding': 'gzip',
  }});

  const response = await new Promise((resolve, reject) => {
    return https.get(options, resolve).on('error', () => reject(errors.networkError(url)));
  });

  if (response.statusCode === 200 && response.headers['content-length'] !== '0') {
    const gunzipStream = zlib.createGunzip();
    const stream = response.pipe(gunzipStream);

    const promise = new Promise((resolve, reject) => {
      response.on('error', () => reject(errors.networkError(url)));
      gunzipStream.on('error', () => reject(errors.networkError(url)));
      stream.on('end', () => resolve(true));
    });

    return { found: true, stream, promise };
  }

  response.resume();

  if (response.statusCode === 200) return { found: true };
  if (response.statusCode === 404) return { found: false };

  throwError(errors.serverError(url, response.statusMessage));
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
      await mkdir(paths[i - 1]);
    } catch(error) {
      error.code !== 'EEXIST' && throwError(errors.cantMakeDir(path));
    }
  }
}

async function exists(path) {
  try {
    await stat(nodePath.resolve(path));
    return true;
  } catch(error) {
    error.code !== 'ENOENT' && throwError(errors.fileSystem(path));
    return false;
  }
}

function filterFilesByPath(files, path) {
  const prefix = path ? `${path}/` : '';
  return files.filter((file) => file.path.startsWith(prefix)).map((file) => ({
    path: file.path.slice(prefix.length),
    url: file.url
  }));
}

function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch(error) {
    throwError(errors.badData());
  }
}

function white(str) {
  return '\033[1;37m' + str + '\033[0m';
}

function red(str) {
  return '\033[1;31m' + str + '\033[0m';
}

function magenta(str) {
  return '\033[1;35m' + str + '\033[0m';
}

function cyan(str) {
  return '\033[1;36m' + str + '\033[0m';
}

function log() {
  console.log('  ', ...arguments);
}

function logError() {
  console.error('  ', ...arguments);
}

function newError(message, data = [], withHelp = false) {
  const error = new Error(message);
  error.data = data;
  error.withHelp = withHelp;
  return error;
}

function throwError(error) {
  throw error;
}

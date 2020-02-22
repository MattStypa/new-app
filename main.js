#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const nodePath = require('path');
const nodeUrl = require('url');
const nodeUtil = require('util');
const package = require('./package.json');

const mkdir = nodeUtil.promisify(fs.mkdir);
const stat = nodeUtil.promisify(fs.stat);

const maxSimultaneouslyDownloads = 6;
const userAgent = `${package.name}/${package.version} (+${package.homepage})`;

const errors = {
  projectNameRequired: () => ['Project name is required.', null, true],
  desitnationRequired: () => ['Destination directory is required.', null, true],
  destinationExists: (path) => ['Directory already exists.', [path]],
  networkError: (url) => ['Network error.', [url]],
  serverError: (url, error) => ['Server error.', [url, error]],
  badData: () => ['Unable to read data.'],
  repoNotFound: (repo) => ['Repository not found.', [repo]],
  repoPathNotFound: (repo, path) => ['Repository path not found.', [`${repo}/${path}`]],
  repoTooBig: (repo) => ['Repository is too large.', [repo]],
  fileSystem: (path) => ['Unable to access path.', [path]],
  cantMakeDir: (path) => ['Unable to create directory.', [path]],
  cantWriteFile: (path) => ['Unable to write file.', [path]],
};

main().catch(errorHandler);

function errorHandler(error) {
  const [message, info, withHelp] = error.data || ['Unexpected error.', [error.message], false];

  logError(red(message));
  info && info.forEach((line) => logError(line));
  log();

  if (withHelp) {
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

  if (!sourceArg) throwError(errors.projectNameRequired());
  if (!destArg) throwError(errors.desitnationRequired());

  const dest = nodePath.resolve(destArg);

  if (await exists(dest)) throwError(errors.destinationExists(dest));

  log('Please wait...');
  log();

  const sourceParts = sourceArg.split('#').filter((part) => part);
  const repoParts = sourceParts[0].split('/').filter((part) => part);
  const repo = repoParts.slice(0, 2).join('/');
  const repoPath = repoParts.slice(2).join('/');
  const repoHash = sourceParts.slice(1).join('#');

  let hash = 'master';

  if (!repoHash) {
    hash = await getLatestRelease(repo) || hash;
  }

  const files = await getRepoFiles(repo, hash);
  const filteredFiles = filterFilesByPath(files, repoPath);

  filteredFiles.length || throwError(errors.repoPathNotFound(repo, repoPath));

  await downloadFiles(files, dest);

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

  response || throwError(errors.repoNotFound(repo));

  const repoFiles = parseJson(response);

  repoFiles.truncated && throwError(errors.repoTooBig());

  return repoFiles.tree.filter((node) => node.type === 'blob').map((node) => ({
    path: node.path,
    url: `https://raw.githubusercontent.com/${repo}/${hash}/${node.path}`,
  }));
}

async function downloadFiles(files, dest) {
  const queue = [...files];

  const work = async () => {
    const file = queue.pop();

    if (!file) return;

    await download(file.url, nodePath.resolve(dest, file.path));
    await work();
  };

  await Promise.all(Array(maxSimultaneouslyDownloads).fill(null).map(work));
}

async function download(url, filePath) {
  await makeDirectory(nodePath.dirname(filePath));

  const promise = new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);

    request(url)
      .then((result) => {
        if (result.statusCode === 200) {
          result.pipe(writeStream);
          result.on('end', () => resolve());
        } else {
          result.resume();
          reject(newError(errors.serverError(url, result.statusMessage)));
        }
      })
      .catch(reject);

    writeStream.on('error', (error) => reject(newError(errors.cantWriteFile(filePath))));
  });

  return await promise;
}

async function fetch(url) {
  const promise = new Promise((resolve, reject) => {
    request(url)
      .then((result) => {
        if (result.statusCode === 200) {
          const data = [];
          result.setEncoding('utf8');
          result.on('data', (chunk) => data.push(chunk));
          result.on('end', () => resolve(data.join('')));
        } else if (result.statusCode === 404){
          result.resume();
          resolve(null);
        } else {
          result.resume();
          reject(newError(errors.serverError(url, result.statusMessage)));
        }
      })
      .catch(reject);
  });

  return await promise;
}

async function request(url) {
  const promise = new Promise((resolve, reject) => {
    const options = nodeUrl.parse(url);
    options.headers = { 'User-Agent': userAgent };
    https.get(options, resolve).on('error', () => reject(newError(errors.networkError(url))));
  });

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

function newError(data) {
  const error = new Error();
  error.data = data;
  return error;
}

function throwError(data) {
  throw newError(data);
}

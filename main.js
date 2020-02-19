const fs = require('fs');
const https = require('https');
const nodePath = require('path');
const package = require('./package.json');

const maxSimultaneouslyDownloads = 6; // This is adopted from Chrome's limit as a sane value.
const userAgent = `${package.name}/${package.version} (+${package.homepage})`;

main().catch((error) => {
  console.error('ERROR:', error.message);
  process.exit(1);
});

function main() {
  const repo = process.argv[2];
  const dest = process.argv[3];

  let files = [];

  return Promise.resolve()
    .then(() => !repo && rejectWithError('Project name is required.'))
    .then(() => !dest && rejectWithError('Destination directory is required.'))
    .then(() => exists(dest))
    .then((destinationExists) => destinationExists && rejectWithError('Destination directory already exists.'))
    .then(() => console.log('Reading repository...'))
    .then(() => getRepoFiles(repo, 'master'))
    .then((result) => files = result)
    .then(() => console.log('Creating destination directory...'))
    .then(() => makeDirectory(dest))
    .then(() => console.log('Downloading repository...'))
    .then(() => downloadFilesFromGithub(dest, files, repo, 'master'))
    .then(() => console.log('Done.'));
}

// function getLatestRelease(repo) {
//   return fetch(`https://apiasdfasfadsf.github.com/repos/${repo}/releases/latest`)
//     .catch((error) => error instanceof NotFound ? null : Promise.reject(error))
//     .catch(() => Promise.reject(new ApplicationError('Unable to reach GitHub')));
// }

function getRepoFiles(repo, sha) {
  return fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`)
    .then((data) => data ? data : rejectWithError('Repository was not found.'))
    .then((data) => parseJson(data))
    .then((data) => !data.truncated ? data : rejectWithError('Repository is too large.'))
    .then((data) => data.tree.filter((node) => node.type === 'blob'))
    .then((data) => data.map((node) => node.path));
}

function downloadFilesFromGithub(dest, files, repo, sha) {
  const queue = [].concat(files);

  const work = () => {
    const file = queue.pop();

    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(file);

    return file
      ? downloadFile(`https://raw.githubusercontent.com/${repo}/${sha}/${file}`, nodePath.resolve(dest, file)).then(work)
      : Promise.resolve();
  };

  return Promise.all(Array(maxSimultaneouslyDownloads).fill(null).map(work))
    .then(() => {
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
    });
}

function downloadFile(url, filePath) {
  return makeDirectory(nodePath.dirname(filePath))
    .then(() => new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);

      request(url)
        .then((result) => {
          if (result.statusCode === 200) {
            result.pipe(writeStream);
            result.on('end', () => resolve());
          } else {
            result.resume();
            reject(new Error(`Server error: ${result.statusMessage}`));
          }
        })
        .catch(reject);

      writeStream.on('error', (error) => reject(new Error('Unable to write file.')));
    }));
}

function fetch(url) {
  return new Promise((resolve, reject) => {
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
          reject(new Error(`Server error: ${result.statusMessage}`));
        }
      })
      .catch(reject);
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {'User-Agent': userAgent}}, resolve)
      .on('error', () => reject(new Error('Network error.')));
  });
}

function parseJson(str) {
  try {
    return Promise.resolve(JSON.parse(str));
  } catch(e) {
    return rejectWithError('Unable to parse response.');
  }
}

function exists(path) {
  return new Promise((resolve, reject) => {
    fs.stat(path, (error, stats) => !error || error.code === 'ENOENT' ? resolve(!error) : reject(new Error('Unable to access file system.')));
  });
}

function makeDirectory(path) {
  return new Promise((resolve, reject) => {
    fs.mkdir(path, { recursive: true }, (error) => !error ? resolve() : reject(new Error('Unable to create directory.')));
  });
}

function rejectWithError(message) {
  return Promise.reject(new Error(message));
}

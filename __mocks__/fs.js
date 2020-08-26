const stream = require('stream');

let fileSystem = {};

function createWriteStream(path) {
  const mockStream = new stream.PassThrough();
  fileSystem[path] = '';
  mockStream.on('data', (chunk) => fileSystem[path] += chunk);

  return mockStream;
}

function mkdir(path, callback) {
  fileSystem[path] = [];
  callback();
}

function stat(path, callback) {
  callback(fileSystem.hasOwnProperty(path) ? false : {code: 'ENOENT'});
}

function reset() {
  fileSystem = {};
}

function getFileSystem() {
  return fileSystem;
}

function getPath(path) {

}

module.exports = {
  createWriteStream,
  mkdir,
  stat,
  reset,
  getFileSystem,
};

var cp = require('child_process');
var fs = require('fs');
var path = require('path');
var async = require('async');
var driver = require('./driver');

// Configuration.
var sandboxName = 'buildroot';  // Name of chroot directory.
var userName = 'myself';  // Name of user in chroot.
var shell = 'bash';  // Shell program to use.
var sandboxTimeout = 60 * 1000;  // Kill sandbox after 60s.

// This function checks that the sandbox exists.
// It returns true in a callback if the sandbox exists.
function validSandbox(cb) {
  fs.stat(sandboxName, function(err, value) { cb(!err); });
}

function createHome() {
  return '/home/' + userName;
}

function createUlimit() {
  // In case we run into a harsher hard limit,
  // we don't care about the stderr output.
  return 'ulimit -S -t ' + (sandboxTimeout / 1000)
             + ' -f ' + (1048576 * 32)  // 32 GB files
             + ' -d ' + (1048576 * 32)  // 32 GB data segment
             + ' -s ' + (1024 * 8)  // 8 MB stack size
             + ' -c ' + 0  // No core file
             + ' -m ' + (1048576 * 32)  // 32 GB resident set size
             + ' -u ' + 1024  // 1024 forked processes
             + ' -n ' + 1024  // 1024 file descriptors
             + ' -l ' + 64  // 64 KB locked-in-memory size
             + ' -v ' + (1048576 * 32)  // 32 GB virtual memory
             + ' -i ' + 62756  // pending signals
             + ' -q ' + (1024 * 800)  // 800 KB message queues
             + ' -e 0 -r 0 2>/dev/null';
}

// This function runs a program in the sandbox.
// The command is a string of shell code (see variable `shell`).
// options:
// - stdout, stderr: function(data: Buffer).
// - stdin: a Buffer.
// cb: takes the return code.
function run(command, options, cb) {
  var sandbox = cp.spawn('chroot',
      ['--userspec=' + userName, sandboxName, shell, '-c',
       'cd ' + createHome() + ' && '
       + '( ' + createUlimit() + '; '
       + command + ' )'
      ]);

  // Ready to kill it.
  var killSandbox = function() {
    // Kill the whole process subtree.
    cp.spawn(shell, ['-c',
        'killtree() { '
      +   'local pid=$1; '
      // Prevent existing processes from forking.
      +   'kill -stop ${pid}; '
      +   'for child in $(pgrep -P ${pid}); do '
      +     'killtree ${child}; '
      +   'done; '
      +   'kill -9 ${pid}; '
      + '}; '
      + 'killtree ' + sandbox.pid]);
  };
  var killTimeout = setTimeout(killSandbox, sandboxTimeout);

  // Set up I/O.
  var stdoutput = new Buffer(0);
  sandbox.stdout.on('data', function(data) {
    stdoutput = Buffer.concat([stdoutput, data]);
  });
  var stderrput = new Buffer(0);
  sandbox.stderr.on('data', function(data) {
    stderrput = Buffer.concat([stderrput, data]);
  });
  sandbox.on('close', function(code, signal) {
    clearTimeout(killTimeout);
    if (options.stdout) { options.stdout(stdoutput); }
    if (options.stderr) { options.stderr(stderrput); }
    cb(code);
  });
  if (options.stdin !== undefined) {
    sandbox.stdin.write(options.stdin);
  }
}

// Copy a directory to the sandbox.
// The directory is a String rooted in the virtual tree.
// Returns in a callback, as null or an error.
function copyToSandbox(directory, cb) {
  // FIXME: chmod the files such that files not authorized for edition
  // cannot be modified.
  var chmodFiles = function chmodFiles(cb) {
    // The userName's group has the same name.
    var chmod = cp.spawn('chroot',
        [sandboxName, 'chown', userName + ':' + userName, '-R', createHome()]);
    chmod.on('close', function(code, signal) {
      if (code === 0) {
        cb(null);
      } else {
        cb(new Error('Setting files\' ownership to ' + userName + ' failed.'));
      }
    });
  };

  var copy = cp.spawn('cp',
      ['-a', path.join(driver.absolute(directory)) + '/.'
           , path.join(sandboxName, 'home', userName)]);
  copy.on('close', function(code, signal) {
    if (code === 0) {
      chmodFiles(cb);
    } else {
      cb(new Error('Copying to the sandbox failed.'));
    }
  });
}

// Copy a list of files (as Strings) from the sandbox to the tree.
// The directory is a String rooted in the virtual tree.
// Returns in a callback, as null or an error.
function copyFromSandbox(directory, files, cb) {
  async.each(files, function(filename, cb) {
    var copy = cp.spawn('cp',
      ['-a', path.join(sandboxName, 'home', userName, filename),
             path.join(driver.absolute(directory))]);
    copy.on('close', function(code, signal) {
      if (code === 0) {
        cb(null);  // Everything went well.
      } else {
        cb(new Error('Copying to the sandbox failed.'));
      }
    });
  }, cb);
  // FIXME: chmod the files.
}

// Remove all files in the home directory of the sandbox.
// Returns in a callback, as null or an error.
function clearSandbox(cb) {
  var deletion = cp.spawn('find',
      [path.join(sandboxName, 'home', userName),
      // Don't go across file systems, don't delete the directory itself.
      '-xdev', '-mindepth', '1', '-delete']);
  deletion.on('close', function sandboxCleared(code, signal) {
    // Clear /tmp/ as well.
    var tmpDeletion = cp.spawn('find',
        [path.join(sandboxName, 'tmp'),
        // Don't go across file systems, don't delete the directory itself.
        '-xdev', '-mindepth', '1', '-delete']);
    tmpDeletion.on('close', function sandboxCleared(tmpcode, tmpsignal) {
      if (code !== 0) {
        cb(new Error('Clearing the sandbox failed.')); return;
      }
      if (tmpcode !== 0) {
        cb(new Error('Clearing the sandbox\'s /tmp/ failed.')); return;
      }
      cb(null);
    });
  });
}

// Removes a list of `files` in the sandbox.
function rmFiles(files, cb) {
  var locations = files.map(function(file) {
    return path.join(sandboxName, 'home', userName, file);
  });
  try {
    async.each(locations, function(location, cb) {
      var deletion = cp.spawn('rm', ['-r', location]);
      deletion.stderr.on('data', function(d) { console.error('err:'+d); });
      deletion.on('close', function deleted(code, signal) {
        if (code === 0) { cb(null);
        } else { cb(new Error('Deleting sandbox files for setup failed.')); }
      });
    }, cb);
  } catch(e) { cb(e); return; }
}

// Prevent having more than one at a time.
var sandboxInUse = false;

// Ensure that calls are sequential.
// The directory is a String rooted in the virtual tree.
// The command is a string of shell code (see variable `shell`).
// options:
// - stdout, stderr: function(data: Buffer).
// - stdin: a Buffer.
// - rmFiles: list of files to remove, rooted at the directory picked.
// - fileOutput: list of files to keep, and put back in the main file tree.
// cb: takes the return value, either null or an error.
function runOnDirectory(directory, command, options, cb) {
  if (sandboxInUse) { cb(new Error('Sandbox currently in use')); return; }
  sandboxInUse = true;
  // Options
  options.rmFiles = options.rmFiles || [];

  // How to clean up the sandbox.
  var end = function(enderr) {
    // Whatever the outcome, we assume the sandbox wasn't corrupted.
    // That avoids having to build it again every time,
    // and it is a reasonable assumption.
    clearSandbox(function(err) {
      // The error should not occur but isn't critical. Log it.
      if (err != null) { console.error(err); }
      sandboxInUse = false;
      cb(enderr);
    });
  };

  // How to copy file outputs.
  var saveFileOutput = function(enderr) {
    if (enderr != null) { return end(enderr); }
    if (options.fileOutput && options.fileOutput.length > 0) {
      copyFromSandbox(directory, options.fileOutput, end);
    } else { end(); }
  };

  // How to use the sandbox.
  var filesRemoved = function(err) {
    if (err != null) { end(err); return; }
    run(command, options, function(code) {
      if (code === 0) { saveFileOutput(null);
      } else { end(new Error('Error while running command in the sandbox,'
          + ' process code: ' + code));
      }
    });
  };

  // How to start up the sandbox.
  copyToSandbox(directory, function(err) {
    if (err != null) { end(err); return; }
    // If the copy of data happened without issue:
    rmFiles(options.rmFiles, filesRemoved);
  });
}

exports.validSandbox = validSandbox;
exports.copyToSandbox = copyToSandbox;
exports.run = run;
exports.runOnDirectory = runOnDirectory;

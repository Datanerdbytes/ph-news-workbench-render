"""Exec the runner lifecycle shell while holding an exclusive POSIX lock."""

import fcntl
import os
import sys


lock_path, script, *args = sys.argv[1:]
lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
fcntl.lockf(lock_fd, fcntl.LOCK_EX)
# POSIX record locks survive exec and aren't inherited by forked children.
# The caller's PID becomes the shell, so terminating it cannot leave a
# separate startup shell running after releasing the lock.
os.set_inheritable(lock_fd, True)
os.execv('/bin/sh', ['sh', script, '--locked', *args])

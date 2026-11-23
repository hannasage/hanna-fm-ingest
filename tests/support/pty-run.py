"""Runs a command with a pseudo terminal as its stdin, stdout and stderr, so the command sees a TTY.
Test support only. Usage: python3 -I pty-run.py <command> [args...]. Exits with the command's status."""
import os
import pty
import sys

status = pty.spawn(sys.argv[1:])
sys.exit(os.waitstatus_to_exitcode(status))

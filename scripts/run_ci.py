"""Expose a bounded synthetic-test failure tail in CI without changing its exit code."""

import subprocess
import sys
from collections import deque


def main():
    tail = deque(maxlen=100)
    with subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as run:
        for line in run.stdout:
            print(line, end="", flush=True)
            tail.append(line)
        status = run.wait()
    if status:
        message = "".join(tail)[-3500:].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error::{message}")
    return status


if __name__ == "__main__":
    sys.exit(main())

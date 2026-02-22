---
name: dependencies
description: How to install packages persistently in the container. Use when you need to install system packages, pip packages, or npm tools.
---

# Installing Dependencies

You run inside a Docker container. Packages installed at runtime are lost on container restart.
To make installations persistent, use the `user-extensions.sh` script.

## Persistent Installation

Edit `workspace/user-extensions.sh` to add your install commands:

```bash
#!/bin/bash
# Runs on every container start

apt-get update && apt-get install -y signal-cli jq
pip install some-package
npm install -g some-tool
```

This script runs during container init (Phase 7), before services start.

## Runtime (Temporary) Installation

For quick testing, install directly:
```bash
apt-get update && apt-get install -y <package>
pip install <package>
bun add <package>          # in the relevant project directory
```

These installs vanish on restart. If you confirm the package is needed, add it to `user-extensions.sh`.

## Bun Packages

For JavaScript/TypeScript dependencies:
- Project-local: `cd /some/project && bun add <package>`
- The workspace itself uses Bun — `bun add` works for scripts you write

## Python Packages

```bash
pip install <package>
```

## System Packages

```bash
apt-get update && apt-get install -y <package>
```

## Important

- Always add persistent installs to `user-extensions.sh`, not just install them at runtime
- Configuration files outside the persisted volumes (`/atlas/workspace/` and `/root/`) are lost on restart — e.g. changes to `/etc/`, `/opt/`, or other system paths. If you need persistent config changes, add the corresponding commands to `user-extensions.sh`
- The container has no Docker daemon — you cannot run `docker` commands
- Pre-installed: Bun, Node.js, Python, git, sqlite3, curl, jq

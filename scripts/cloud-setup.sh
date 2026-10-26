#!/usr/bin/env bash
# Setup script for the Claude Code cloud environment (paste into the environment's "Setup script" field).
# Installs the Homey CLI so `homey app validate` and `homey app build` work in a session.
# The app itself has no npm dependencies, so there is no `npm install` for the repo.
set -euo pipefail

# Set HOMEY_CLI_VERSION (e.g. 4.6.1) to pin the CLI; the default tracks the newest release.
HOMEY_CLI_VERSION="${HOMEY_CLI_VERSION:-latest}"

npm install -g "homey@${HOMEY_CLI_VERSION}"

homey --version

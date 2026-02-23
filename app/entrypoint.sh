#!/bin/bash
# Entrypoint: fix volume mount permissions, then drop to atlas user.
# Runs as root (container default) to chown mounted volumes, then
# execs supervisord as the atlas user.
set -e

# Fix ownership on mounted volumes (may be root from previous deploy)
chown -R atlas:atlas /atlas/workspace /atlas/logs /home/atlas

# Drop to atlas user and start supervisord
exec sudo -u atlas -E /usr/bin/supervisord -c /etc/supervisor/conf.d/atlas.conf

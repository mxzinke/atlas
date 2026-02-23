#!/bin/bash
# Entrypoint: fix volume mount permissions, then drop to atlas user.
# Runs as root (container default) to chown mounted volumes, then
# execs supervisord as the atlas user.
set -e

# Fix ownership on mounted volumes (may be root from previous deploy)
chown -R atlas:atlas /atlas/workspace /atlas/logs /home/atlas

# Fix runtime directories (tmpfs, reset on container start)
chown atlas:atlas /var/run
mkdir -p /var/log/nginx /var/lib/nginx/body
chown -R atlas:atlas /var/log/nginx /var/lib/nginx

# Clean up stale QMD PID files from previous runs
rm -f /home/atlas/.cache/qmd/*.pid /tmp/qmd*.pid 2>/dev/null || true

# Drop to atlas user and start supervisord
exec sudo -u atlas -E /usr/bin/supervisord -c /etc/supervisor/conf.d/atlas.conf

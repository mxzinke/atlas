FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Berlin

# System packages (without nodejs - installed separately below)
RUN apt-get update && apt-get install -y \
  curl wget git jq ripgrep \
  inotify-tools \
  supervisor \
  nginx \
  sqlite3 \
  python3 python3-pip \
  chromium-browser \
  openssh-client \
  ca-certificates \
  unzip sudo \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user with sudo access
RUN useradd -m -s /bin/bash -G sudo atlas \
  && echo "atlas ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/atlas

# Install Node.js 22 (required by QMD)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (to /usr/local so it survives /root volume mount)
RUN ARCH=$(dpkg --print-architecture) && \
  if [ "$ARCH" = "arm64" ]; then BUN_ARCH="aarch64"; else BUN_ARCH="x64"; fi && \
  curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-${BUN_ARCH}.zip" -o /tmp/bun.zip && \
  unzip -o /tmp/bun.zip -d /tmp/bun-extract && \
  mv /tmp/bun-extract/*/bun /usr/local/bin/bun && \
  chmod +x /usr/local/bin/bun && \
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
  rm -rf /tmp/bun.zip /tmp/bun-extract
ENV PATH="/atlas/app/bin:/atlas/workspace/bin:${PATH}"
ENV HOME=/home/atlas

# Install supercronic (cron replacement)
RUN ARCH=$(dpkg --print-architecture) && \
  SUPERCRONIC_URL="https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-${ARCH}" && \
  curl -fsSL "$SUPERCRONIC_URL" -o /usr/local/bin/supercronic && \
  chmod +x /usr/local/bin/supercronic

# Install Claude Code (native binary)
# Use temp HOME to avoid installing into /root which gets volume-mounted
RUN HOME=/tmp/claude-install curl -fsSL https://claude.ai/install.sh | HOME=/tmp/claude-install bash \
  && cp /tmp/claude-install/.local/bin/claude /usr/local/bin/claude \
  && chmod +x /usr/local/bin/claude \
  && rm -rf /tmp/claude-install

# Install Playwright + MCP
RUN npx playwright install --with-deps chromium 2>/dev/null || true

# Install Playwright MCP server globally
RUN npm install -g @playwright/mcp

# Install QMD globally (use npm so binary goes to /usr/local/bin, surviving /root volume mount)
RUN npm install -g @tobilu/qmd || true

# Create directory structure
RUN mkdir -p /atlas/app/hooks \
  /atlas/app/prompts \
  /atlas/app/triggers/cron \
  /atlas/app/inbox-mcp \
  /atlas/app/web-ui \
  /atlas/workspace/memory/projects \
  /atlas/workspace/inbox \
  /atlas/workspace/skills \
  /atlas/workspace/agents \
  /atlas/workspace/mcps \
  /atlas/workspace/triggers \
  /atlas/workspace/secrets \
  /atlas/workspace/bin \
  /atlas/workspace/.qmd-cache \
  /atlas/logs

# Copy application code
COPY app/ /atlas/app/
COPY .claude/settings.json /atlas/app/.claude/settings.json

# Set execute permissions
RUN chmod +x /atlas/app/entrypoint.sh \
  && chmod +x /atlas/app/init.sh \
  && chmod +x /atlas/app/hooks/*.sh \
  && chmod +x /atlas/app/watcher.sh \
  && chmod +x /atlas/app/triggers/cron/*.sh \
  && chmod +x /atlas/app/bin/*

# Install Inbox-MCP dependencies
WORKDIR /atlas/app/inbox-mcp
RUN bun install

# Install Web-UI dependencies
WORKDIR /atlas/app/web-ui
RUN bun install

# Copy supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/atlas.conf

# Nginx config
COPY app/nginx.conf /etc/nginx/sites-available/atlas
RUN ln -sf /etc/nginx/sites-available/atlas /etc/nginx/sites-enabled/atlas \
  && rm -f /etc/nginx/sites-enabled/default

# Grant atlas user write access to image-layer directories.
# Volume mounts are fixed at runtime by entrypoint.sh.
RUN chown -R atlas:atlas /atlas /home/atlas \
  && chown -R atlas:atlas /var/run /var/log/nginx /var/lib/nginx \
  && chown -R atlas:atlas /etc/supervisor

WORKDIR /atlas/workspace

EXPOSE 8080

# Entrypoint runs as root to fix volume permissions, then drops to atlas
ENTRYPOINT ["/atlas/app/entrypoint.sh"]

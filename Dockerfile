FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Berlin

# System packages
RUN apt-get update && apt-get install -y \
    curl wget git jq ripgrep \
    inotify-tools \
    supervisor \
    nginx \
    sqlite3 \
    python3 python3-pip \
    nodejs npm \
    chromium-browser \
    openssh-client \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/atlas/app/bin:/atlas/workspace/bin:/root/.bun/bin:${PATH}"

# Install supercronic (cron replacement)
RUN ARCH=$(dpkg --print-architecture) && \
    SUPERCRONIC_URL="https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-${ARCH}" && \
    curl -fsSL "$SUPERCRONIC_URL" -o /usr/local/bin/supercronic && \
    chmod +x /usr/local/bin/supercronic

# Install Claude Code (native binary)
RUN curl -fsSL https://claude.ai/install.sh | sh

# Install Playwright + MCP
RUN npx playwright install --with-deps chromium 2>/dev/null || true

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
RUN chmod +x /atlas/app/init.sh \
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

# Install QMD globally
RUN bun install -g @tobilu/qmd || npm install -g @tobilu/qmd || true

# Copy supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/atlas.conf

# Nginx config
COPY app/nginx.conf /etc/nginx/sites-available/atlas
RUN ln -sf /etc/nginx/sites-available/atlas /etc/nginx/sites-enabled/atlas \
    && rm -f /etc/nginx/sites-enabled/default

WORKDIR /atlas/workspace

EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/atlas.conf"]

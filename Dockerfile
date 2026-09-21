FROM node:22-bookworm-slim

# ffmpeg: video frames and image conversion. git: Claude Code works better inside repos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, for the Claude Code provider
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data CLAUDE_CWD=/workspace NODE_ENV=production
RUN mkdir -p /data /workspace /home/node/.claude && chown -R node:node /data /workspace /home/node /app
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "server.js"]

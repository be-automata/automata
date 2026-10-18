# Spike 018 box: the real Claude Code CLI + a local Messages-API stub. No credentials anywhere.
FROM node:22-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code@2.1.302 && npm cache clean --force
RUN mkdir -p /home/agent && chown node:node /home/agent
COPY app/ /app/
USER node
ENV HOME=/home/agent \
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
    ANTHROPIC_API_KEY=spike-018-stub-not-a-key \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1
CMD ["node", "/app/stub.mjs"]

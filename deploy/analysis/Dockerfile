FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-audit --no-fund @openai/codex@0.156.1
WORKDIR /opt/analysis
COPY protocol/analysis-contract.mjs ./analysis-contract.mjs
COPY deploy/analysis/server.mjs ./server.mjs
ENV CODEX_HOME=/data/codex
USER 1000:1000
CMD ["node", "server.mjs"]

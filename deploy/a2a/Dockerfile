FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 unzip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund \
      @okxweb3/a2a-node@0.2.16 \
      @openai/codex@0.156.1 \
    && npx -y @okxweb3/onchainos-installer@0.0.1-beta-4af28c368a-260910124122 install --stable \
    && install -m 0755 /root/.local/bin/onchainos /usr/local/bin/onchainos \
    && install -d /opt/onchainos-skills \
    && cp -a /root/.agents/skills/okx-* /opt/onchainos-skills/ \
    && for skill in okx-agent-payments-protocol okx-agentic-wallet okx-ai okx-dapp-discovery okx-defi okx-dex-market okx-guide; do \
         test -f "/opt/onchainos-skills/$skill/SKILL.md" || exit 1; \
       done \
    && onchainos --version \
    && okx-a2a --version \
    && codex --version

RUN npm install --prefix /opt/holon-verifier --save-exact --no-audit --no-fund \
      ethers@6.17.0 multiformats@14.0.5 zod@4.6.5
COPY protocol/verification.mjs /opt/holon-verifier/protocol/verification.mjs
COPY config/verification.json /opt/holon-verifier/config/verification.json
COPY deploy/a2a/verify-evidence.mjs /opt/holon-verifier/verify-evidence.mjs
COPY deploy/a2a/ASP_AGENTS.md /opt/okx-a2a/AGENTS.md
COPY deploy/a2a/entrypoint.sh /usr/local/bin/okx-a2a-entrypoint
RUN chmod 0755 /usr/local/bin/okx-a2a-entrypoint

ENV HOME=/data \
    ONCHAINOS_HOME=/data/onchainos \
    OKX_AGENT_TASK_HOME=/data/a2a \
    OKX_A2A_HOME_DIR=/data/a2a \
    OKX_A2A_AI_CWD=/workspace \
    CODEX_HOME=/data/codex
WORKDIR /workspace
ENTRYPOINT ["okx-a2a-entrypoint"]
CMD ["okx-a2a", "run"]

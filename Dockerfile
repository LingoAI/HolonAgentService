FROM node:22-bookworm-slim AS protocol-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY config config
COPY contracts contracts
COPY protocol protocol
RUN npm run compile && npm run build:wallet && npm prune --omit=dev

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=protocol-build /usr/local/bin/node /usr/local/bin/node
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY backend backend
COPY frontend frontend
COPY evidence/xlayer/mainnet-native-usdc-proof-2026-09-22.json evidence/xlayer/mainnet-native-usdc-proof-2026-09-22.json
COPY config config
COPY protocol protocol
COPY scripts/start-services.mjs scripts/start-services.mjs
COPY scripts/mvp-backup.py scripts/mvp-backup.py
COPY scripts/restore-mvp-ipfs.py scripts/restore-mvp-ipfs.py
COPY --from=protocol-build /app/node_modules node_modules
COPY --from=protocol-build /app/contracts contracts
COPY --from=protocol-build /app/frontend/vendor/x402-wallet.js frontend/vendor/x402-wallet.js
ENV HIRE_NETWORK=xlayer-testnet HOLON_INDEX_ON_BOOT=0 ANONYMIZED_TELEMETRY=False PORT=8765
ARG REVISION=local
LABEL org.opencontainers.image.revision=$REVISION
ENV HOLON_REVISION=$REVISION
EXPOSE 8765
CMD ["node", "scripts/start-services.mjs"]

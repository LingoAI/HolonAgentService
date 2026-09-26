# Evidence interpretation runtime

The private analysis container uses the existing operator-authorized Codex login to explain structured public verification evidence. It has no wallet state, payment API credentials, published port, shell tools, browsing tools, plugins or project instructions. Its filesystem is read-only apart from temporary runtime files. Requests require a separate random token and are limited to one model call at a time with a 30-second deadline.

Set `VERIFICATION_CODEX_AUTH_DIR` to the existing Codex login directory and `VERIFICATION_AI_TOKEN` to a random value of at least 32 characters in the server's private environment file. Never commit either credentials or authentication files. Compose passes only this token to the analysis container and mounts the login directory read-only. Inference copies the current login into temporary storage so authentication refresh cannot change the ASP runtime's files.

The application sends code-produced facts, expectations, checks and scope. It excludes document bytes and payment signatures. The returned JSON is validated against the report's evidence references, and every failed check must be covered. The model cannot alter `status`, checks, balances, transaction data or hashes. Interpretation is explicitly advisory; it is not a new chain observation or a security audit.

Production Compose requires the AI report before a new payment is settled. If inference is unavailable or ungrounded, the request fails without initiating settlement. A previously settled request still returns its original cached report without another model call or charge. The optional local mode exposes `analysis.available: false` when no inference service is configured.

Deploy both `analysis` and `holon`; the existing A2A process continues using the deterministic evidence helper and its own model runtime. `/api/xlayer/official-evidence` holds recorded public receipts and directs users to OKX.AI for current listing status.

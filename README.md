# Everlore

Private family stories, original illustrated books, and a guarded purchase-to-print pilot. This source package contains application code, three explicitly approved public animal illustrations, and synthetic development fixtures. It contains no private manuscript, names, family recordings, saved editions, database, provider keys, local logs, or previous Git history.

## Run and verify

Use Node.js 24 and pnpm 11.19.0. Run `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Install Chromium with `pnpm exec playwright install --with-deps chromium` before `pnpm test:e2e`. Run `pnpm start` and open http://127.0.0.1:4317. Local offline development starts with generation and checkout disabled. Environment files are templates; the app does not automatically load them.

## Hosted private pilot

Deploy the provided Render blueprint as one Docker web service with its 10 GB persistent disk. The assigned HTTPS origin is read from RENDER_EXTERNAL_URL; set PUBLIC_ORIGIN only to override it. Keep CHECKOUT_ENABLED=false and DISABLE_WORKER=1 until private configuration and recovery verification are complete. No local family data should be copied to the public repository.

Provision the operator in the Render service shell: temporarily configure EVERLORE_OPERATOR_PASSWORD as a private environment secret, then run `node --import tsx scripts/operator.ts create Operator`. Remove the temporary password environment variable after provisioning. For an existing private shelf use `node --import tsx scripts/operator.ts set SHELF_NAME`. Do not let public registration select the operator. Sign in at /#/login, then use /#/operator/access to issue single-use invitations using the existing authorized generation budget.

Private runtime settings include OPENAI_API_KEY and explicitly authorized EVERMORE_BUDGET_USD / request reserves; Stripe Secret key and webhook signing secret; Prodigi key; PRINT_ASSET_SECRET; and a verified print product SKU. Use provider test/sandbox credentials for the hosted integration test. Keys belong in private hosting environment settings, never source control. Stripe webhooks use /api/payments/stripe/webhook. The pilot merchandise price is USD 149, including standard US shipping; tax is calculated separately by Stripe. Do not enable live checkout until the selected product, tax configuration, provider billing, generated print assets and physical proof have passed review.

The mounted data directory is /var/data/everlore. The container entrypoint prepares that directory and drops to the node user. /healthz is liveness; /readyz requires storage, a configured operator and a non-draining server. Keep a single instance: its SQLite and worker share one disk.

## Offline quality sessions

The private operator Creative Lab at /#/lab compares guided-memory policies, retains source citations and resumes checkpoints. The production interview guide remains unchanged until a separately qualifying release. Synthetic findings are not evidence of family comfort or child engagement.

For the foreground CLI, use a separate synthetic directory. The container prepares /var/data/everlore-quality alongside family storage on the persistent disk. Run these commands from /app as the node user:

`sh scripts/quality-loop.sh preflight --data-dir=/var/data/everlore-quality`

`sh scripts/quality-loop.sh offline --lane=memory --iterations=1 --data-dir=/var/data/everlore-quality`

`sh scripts/quality-loop.sh resume SESSION_ID --data-dir=/var/data/everlore-quality`

`sh scripts/quality-loop.sh report SESSION_ID --data-dir=/var/data/everlore-quality`

Use the session ID returned by the offline command. Local development can use an empty directory such as work/quality. The helper defaults to one iteration, caps sessions at five, loads no provider credentials and performs no paid generation, Git operations or scheduled execution. Keep synthetic evidence separate from family archives; family backup commands do not include this sibling directory.

## Recovery and evidence

Run `node --import tsx scripts/backup.ts create DATA_DIR NEW_BACKUP_DIR` to create a full private backup; verify it and test restoration into a new empty directory with the same command's verify/restore actions. Backups include secrets and family records: store them privately with encryption and restricted access. Restored services have a persistent recovery lock. Keep DISABLE_WORKER=1 while reconciling paid outcomes, then record evidence with the operator release-recovery command before enabling workers. Never run two services against copied active order state.

Operator commerce recovery is at /#/operator/orders. Unknown paid outcomes must be reconciled before retrying; no automatic duplicate print order or refund should be issued. Existing edition and order hashes remain immutable. Model evaluations are provisional and never stand in for observed child engagement.

## Source provenance

The three stories in fixtures/stories are synthetic development inputs, not customer memories. The three public animal illustrations were approved for display by the family whose book contains them. That permission covers these illustrations only; their story text, names, recording and private records are excluded. The font's license accompanies it. This package does not grant an additional open-source license to the application; repository publication and licensing are owner decisions.

GitHub Actions runs engineering, browser, sanitized-package and Docker-mounted-storage checks with no provider secrets. Passing those checks is not a live payment, printing, physical-proof or audience-quality result.

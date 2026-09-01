# dsh-vault

English | [中文](README.zh.md)

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that backs up your dsh home config — **encrypted** — to your own private GitHub repo, and pulls it flat onto a new machine with one command: restore the config, reinstall plugins from the manifest. Cross-machine restore doubles as migration.

**Requires dsh >= 0.1.2-alpha.3** — the plugin targets the 0.1.2-alpha host line only; the rc line is no longer supported.

Zero npm dependencies: encryption uses only Node's built-in `crypto` (scrypt + AES-256-GCM); GitHub transfer goes through the REST API.

## Commands

```
/vault backup [passphrase]        Back up and push (creates the private repo if missing)
/vault list                       Table of every machine's backup in the vault
                                  (machine / description / snapshot time / file count / size, ← this machine)
/vault restore [machine] [--yes] [passphrase]
                                  No machine name = list snapshots
                                  Picking another machine = migration; --yes actually executes
/vault config                     Show current settings
/vault set repo <owner/name>      Override the default vault repo name
/vault set machine-desc <desc>    Machine description (recorded in the snapshot manifest,
                                  for identification when picking across machines)
/vault set remember-passphrase on|off
                                  When on, the next backup with a passphrase stores it in
                                  the macOS keychain for automatic reuse
```

## Backup set

**In**: `settings.yaml`, `.credentials.yaml` (API keys), `APPEND_SYSTEM.md`, `agents/`, each profile's manifest four-pack (`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.patch.yml`), the home-level `cordis.patch.yml`, and `models-store.json`.

**Out**: `sessions/`, `storages/`, every `node_modules` (reinstalled from the manifest), `cordis.yml` (unconditionally rewritten by the host at startup), `.anonymous-user-id`, usage stats.

## Security model

- Snapshots are encrypted whole before leaving the machine: passphrase → scrypt-derived key → AES-256-GCM (vault format v1; the header carries its KDF parameters and a version).
- The private repo is only the first door (token leakage); encryption is the data door. **A lost passphrase means the snapshot is unrecoverable — the plugin offers no recovery.**
- Three ways to supply the passphrase: inline in the command (`recordInput: false`, never lands in session logs) → the `$DSH_VAULT_PASSPHRASE` env var → the macOS keychain (stored automatically when `remember-passphrase on`).
- Before backup, an encrypt-then-decrypt self-check ensures a bad snapshot never replaces a good one; before restore, the current config is stashed to `~/.dsh/vault/stash/` (last 3 kept).
- GitHub credentials: reuses `$GITHUB_TOKEN` or a logged-in `gh` CLI; login is not this plugin's job.

## Vault layout

```
dsh-backup-<github username>/          ← private; override with /vault set repo
└── machines/<hostname>/
    ├── snapshot.enc               ← encrypted snapshot (latest only, overwrite by design)
    └── manifest.json              ← plaintext metadata (machine / description / time / file
                                       list — no key material)
```

## Known limitations

- `file:` absolute-path deps in a profile manifest (locally linked plugins) are invalid on another machine; restore warns about them and you handle those manually.
- `.env` and `storages/` (machine-absolute paths) don't migrate; session history doesn't migrate.
- Only the latest snapshot per machine is kept (deliberate, see ADR 0003) — adding history would be a format-level change.
- Restore's plugin reinstall needs the `dsh` CLI and `pnpm` on PATH.

## Development

```bash
pnpm install && pnpm build && pnpm test   # unit tests (24)
node scripts/smoke-boot.mjs               # real-host boot smoke (scratch profile)
node scripts/e2e-host.mjs                 # real GitHub round-trip (sandbox home + scratch repo)
./e2e/run-e2e.sh                          # podman container e2e (isolated ~/.dsh)
```

Design docs: [CONTEXT.md](./CONTEXT.md) (glossary) and [docs/adr/](./docs/adr/) (backup-set boundary, encryption scheme, overwrite snapshots, single-repo multi-machine layout).

# Setup snapshot format (version 1)

`code-tycoon snapshot <folder | git url>` saves the AI working setup of this machine;
`code-tycoon restore <folder | git url>` rebuilds it on another one, any OS.
`code-tycoon audit` shows what would be lost today without a snapshot. Code: `server/setup/`.

## What is in it

Each tool has an adapter (`server/setup/adapters/`) that classes every file in its folder:

| class | examples | in the snapshot |
|---|---|---|
| config | `settings.json`, MCP servers in `~/.claude.json`, `~/.codex/config.toml`, `.gitconfig` | copied, secrets cut out |
| memory | `CLAUDE.md`, `AGENTS.md`, `~/.claude/projects/*/memory/` | copied |
| skill | `~/.claude/skills`, `~/.codex/skills` | copied |
| other | files no adapter knows (your own scripts, an MCP gateway) | copied, secrets cut out |
| autostart | launchers in the Windows Startup folder | copied, restored only on the same OS |
| secret | SSH private keys, token files, a project's ignored `.env` | whole file in the vault |
| repo | a git checkout inside a tool folder | cloned again from its remote |
| deps | `node_modules`, venvs | reinstalled (`npm install`) |
| login | `.credentials.json`, `~/.codex/auth.json` | never copied: sign in again |
| history | transcripts, databases, anything over 5 MB | not included; use a backup tool |
| state, junk | caches, logs, backups | not included |

Projects are recorded by remote, branch and head and cloned on restore. A project that was
never pushed cannot be restored; the audit says so first.

## Layout

    manifest.json        what goes where
    files/ab/ab12…       file contents, named by SHA-256
    vault.json           the secrets, encrypted
    README.md

## Placeholders

- `@@ct-home@@` the home folder; `@@ct-project:<n>@@` the folder of `manifest.projects[n]`.
  Either may end in `:b` or `:bb` (`@@ct-home:b@@`): the path used single or escaped
  backslashes, which a Windows restore writes back the same way; elsewhere every separator becomes `/`.
- `@@ct-slug@@` in a path: the folder name Claude Code derives from a project path
  (`C--Users-me-code-app`); the entry's `slug` field holds the placeholder it is made from.
- `@@ct-secret:<id>@@` a secret, `id` = first 16 hex of SHA-256 over `"ct-secret\0" + value`.

## Secrets

Detected by setting name (words like token, secret, password, auth, `api_key`), by shape
(`sk-ant-…`, `ghp_…`, `AKIA…`, JWTs, private keys, credentials in URLs, `Bearer …`), and then
cut everywhere: a value found once is replaced in every other file too. The detector errs
toward secret; a false hit is harmless because restore puts the same text back.

## vault.json

    { "format": "code-tycoon-vault", "version": 1, "cipher": "aes-256-gcm",
      "keys": [ { "kind": "passphrase", "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt" }, "iv", "tag", "ct" },
                { "kind": "recovery", "kdf": { "name": "sha256" }, "iv", "tag", "ct" } ],
      "data": { "iv", "tag", "ct" } }

A random 256-bit data key encrypts `data` (a JSON object `id -> value`; whole files as
`f:<sha256> -> base64`) with AES-256-GCM, AAD `code-tycoon-vault-v1`. The data key is stored
wrapped twice: by `scrypt(passphrase)` and by `SHA-256("code-tycoon-recovery\0" + recovery key)`.
The recovery key (160 random bits, shown once) is for a lost passphrase. Neither is ever
written or sent. A later snapshot to the same target reuses the data key, so the recovery
key stays valid. Implementation: `server/setup/vault.mjs`, Node's built-in crypto only.

## Restore

Restore prints a plan first and writes only after `y` (or `--yes`). It installs missing
tools, clones projects (`--projects <dir>` to put them in one folder), writes files (an
existing file that differs is backed up to `~/.codetycoon/restore-backup-<time>/`), merges
the MCP servers into `~/.claude.json` without touching the account in it, reinstalls
packages, re-registers Code Tycoon's hooks and autostart, and lists the sign-ins to redo.
`--recovery-key` opens the vault with the recovery key, `--no-clone` / `--no-install` skip those steps.
`CODETYCOON_PASSPHRASE` (or `CODETYCOON_RECOVERY_KEY`) answers the prompt without a terminal.

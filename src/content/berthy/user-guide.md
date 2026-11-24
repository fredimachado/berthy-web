# Berthy user guide

Berthy deploys and runs apps on Docker servers. This guide teaches it by doing: you deploy and manage one small app, a todo list, from an empty server to a rebuilt one.

Read it from top to bottom once. Every command, flag and manifest key appears at the point in the story where you need it. A complete reference follows the story, so you can come back and look things up.

The files the guide uses are in [`examples/todo/`](../examples/todo/). They pass `berthy config validate` for both environments.

## Contents

1. [What Berthy is](#1-what-berthy-is)
2. [Words you will see](#2-words-you-will-see)
3. [The todo app](#3-the-todo-app)
4. [Step by step](#4-step-by-step)
   1. [Prepare a server and set it up](#step-1-prepare-a-server-and-set-it-up)
   2. [Write the manifest](#step-2-write-the-manifest)
   3. [Registry credentials and secrets](#step-3-registry-credentials-and-secrets)
   4. [The first deploy](#step-4-the-first-deploy)
   5. [Look at it](#step-5-look-at-it)
   6. [Ship a new version of the API](#step-6-ship-a-new-version-of-the-api)
   7. [Put it on the internet](#step-7-put-it-on-the-internet)
   8. [Keep it healthy](#step-8-keep-it-healthy)
   9. [Scheduled commands](#step-9-scheduled-commands)
   10. [Backups and restore](#step-10-backups-and-restore)
   11. [Protected environments and AI agents](#step-11-protected-environments-and-ai-agents)
   12. [The terminal UI](#step-12-the-terminal-ui)
   13. [Update the database or the cache](#step-13-update-the-database-or-the-cache)
   14. [Clean up](#step-14-clean-up)
   15. [Rebuild a server](#step-15-rebuild-a-server)
5. [Reference](#5-reference)
6. [Limits and what is not there yet](#6-limits-and-what-is-not-there-yet)

## How to read the commands

- `prod` is the environment in the story, of the project `todo`. The server is `10.0.0.5`, and its agent listens on `10.0.0.5:7710`.
- Commands that talk to the agent need `-e prod`, which names the environment. Without `-e`, they read `BERTHY_ENV` from the shell (for example `export BERTHY_ENV=prod`). A given `-e` wins, including an empty one. `BERTHY_ENV` lives in the shell only; it is never written to the CLI configuration. `context add` and `context remove`, `agent token`, `state-restore` and `mcp` do not read it. The project comes from `--project`, else the `project` of `berthy.yml` in the directory you run from, else the only project that has that environment. They find the CLI configuration file on their own, from the first of these that is set:

  1. `--config <file>`
  2. the `BERTHY_CONFIG` environment variable
  3. `berthy/config.json` in your user configuration directory: `~/.config/berthy/config.json` on Linux (or `$XDG_CONFIG_HOME/berthy/config.json` when that is set), `~/Library/Application Support/berthy/config.json` on macOS, and `%AppData%\berthy\config.json` on Windows

  The file maps each project and environment to its agent and names the variable that holds its token. It never holds a token. Commands use the variable first, then look in the OS credential store when it is empty. A stored token belongs to that agent, project, environment and token variable, so another entry with a different variable cannot use it. Set `BERTHY_TOKEN_STORE=none` to disable the store. When none of the three is set, or the file is missing, the error names the path it looked for.

- `<token>`, `<password>` and similar in angle brackets are placeholders. The guide never prints a real token or secret. A secret is typed at a hidden prompt or piped in, so it never appears in a command line or in your shell history.
- Flags can come in any order, before or after the app name. The one exception is `exec` and `run`: everything after `--` is the command to run.
- The exit code matters. `0` means done. `1` means failed. `2` means you typed the command wrong. `3` means an AI agent's change is held for approval. Scripts and CI should check it.
- On a terminal, a changing remote command or `setup` prints one line to stderr before it does anything, dry runs included: `berthy: todo/prod at http://10.0.0.5:7710` for a remote command, or `berthy: todo/prod on ops@10.0.0.5` (or `on this server` with `--local`) for `setup`. When `BERTHY_ENV` chose the environment, the line ends with ` (environment from BERTHY_ENV)`. With stderr redirected, or under `--json` on stdout, nothing is added.
- Longer preflights, setup steps and pending operations show a delayed interactive spinner on the stream being animated. Short waits stay quiet. Interactive deploy and rollback followers also show real role rollout milestones. `NO_COLOR` turns colour off. Status words stay readable when the terminal is dumb or unsupported. A redirected stream keeps plain event text and never receives a progress frame. `--json` prints exactly one JSON object for that command shape. Ctrl+C stops following an already-admitted operation, prints its id with human-readable `diagnostics` and `cancel` scope for that environment, and the operation may continue on the agent.

---

## 1. What Berthy is

Berthy is one program with four jobs. It runs on a server as the **agent**. On your laptop and in CI it is the **CLI**. It also has a full-screen **terminal UI** and an **MCP server** for AI agents.

The agent lives on the server, next to Docker. It deploys apps, checks their health, runs scheduled commands, backs up volumes, and sends alerts. The CLI, the UI and the MCP server only talk to the agent. There is no central server.

```text
   Your laptop                CI runner
   CLI, UI, MCP               CLI in the pipeline
        |                          |
        |   private network (VPN)  |        plain HTTP, scoped token
        +-------------+------------+
                      v
  +------------------ Server ------------------------------------------+
  |  Berthy agent  (systemd service, API on a private address)         |
  |     |                                                              |
  |     +--> hosted environments (project/environment), each with      |
  |     |    its own state, key, tokens, network and Docker names      |
  |     +--> Docker Swarm: image apps (api)                            |
  |     +--> Docker Compose: postgres, redis, ...                      |
  +-----|-------------|---------------|---------------|----------------+
        |             |               |               |
        v             v               v               v
   Image registry  Object storage  Telegram       Cloudflare API
   (pulls)         (S3 backups)    (alerts)       (tunnel, DNS)
                                                      |
   OTLP backend  <--- metrics export                  v
                                         Public traffic via the tunnel
```

A few decisions shape everything else:

- **One agent per server.** That agent hosts any number of (project, environment) pairs. `todo/prod` and `shop/prod` can share a server; so can `todo/prod` and `todo/stage`. Each hosted environment has its own secrets and tokens.
- **Private network only.** The agent listens on one private address and speaks plain HTTP. The private network (a VPN such as WireGuard or Tailscale) encrypts it. Every request carries a token.
- **Swarm is always on.** Image apps run as Docker Swarm services, even on one server. That gives rolling updates and rollback.
- **Git is the source of truth.** What you want lives in a manifest in your repository. Every deploy sends the manifest of the commit you deploy. Nothing is configured by hand on the server.
- **Berthy does not build images.** CI builds and pushes them. Berthy deploys images that already exist.

## 2. Words you will see

| Word | Meaning |
| --- | --- |
| **Project** | One application and what supports it, described by one manifest (`berthy.yml`, key `project`). Unrelated to every other project. |
| **Environment** | One named target of a project, such as `prod` or `dev`, with its overlay file. Every command names one with `-e`. There is no default. Two projects may both have `prod`. |
| **Hosted environment** | A (project, environment) pair as an agent runs it, written `project/environment`. It owns its state, key, tokens, network, Docker objects and claimed names. It is the unit of isolation, of the deploy lock, of the state backup and of `destroy`. |
| **Context** | One entry of the CLI configuration: a project's environment, the URL of its agent, and the variable that holds its token. `berthy setup` writes it on the machine that runs it; `berthy context add` writes it on any other. |
| **App** | One thing Berthy runs, named in the manifest: `api`, `postgres`, `redis`. |
| **Kind** | How an app runs. `image` apps are Swarm services made from a registry image. `compose` apps are `docker compose` projects made from a Compose file in your repository. |
| **Role** | A part of an image app that runs the same image with its own replica count, command, health check and resources. The API has one role, `web`. You could add a `worker` role later. |
| **Replica** | One running copy of a role. |
| **Release** | One recorded deploy of an app: the image digest (or Compose file), the commit, and the manifest at that time. Rollback goes back to a release. |
| **Operation** | One change run by the agent: a deploy, a rollback, a restart, a restore. It has an id, a state (`running`, `succeeded`, `failed`, `rolled_back`, `interrupted`, `recovery_required`), and events you can follow. |
| **Digest** | A `sha256:` hash that names one exact image. A tag such as `1.4.2` can move. A digest cannot. Berthy pins every deploy to a digest. |
| **Stateful** | A Compose app marked `stateful: true`. It holds data, so Berthy never recreates or removes it unless the command says so with `--allow-recreate`. |
| **Protected** | An environment marked `protected: true`. The agent admits only an image digest, never a mutable tag. A human admin can still pick a tag in the CLI. The CLI resolves it and submits the digest. Changes that AI agents ask for are held until a person approves them. |
| **Token** | The secret a client sends to the agent. Each token has one hosted environment and one scope: `read`, `deploy` or `admin`. Setup makes the first `admin` token; every other token is made with `berthy token create`, kept as a digest in that environment's state, and can expire. |
| **Agent token** | A token marked as belonging to an AI agent. On a protected environment its changes are held. It can never approve anything, and it can never make or revoke a token. |
| **Approval** | A change that an agent token asked for on a protected environment. It waits for a person to approve or reject it, and expires after 15 minutes. |
| **Lock** | The environment's deploy lock. A deploy takes it for its length. You can also take it by hand to freeze deploys. |
| **Manifest** | The YAML that says what you want: `berthy.yml` plus one overlay per environment. |
| **Overlay** | `berthy.<environment>.yml`. It changes the base manifest for one environment. |
| **Secret** | A value the agent stores encrypted on the server, set with `berthy secret set`. The manifest names it. It never holds the value. |
| **Agent state** | One hosted environment's SQLite file: secrets, releases, history, audit log, claimed Docker names. Secrets are sealed with that environment's key file on the server. |

**Token scopes** in one table (the full list is in the [reference](#token-scopes)):

| Scope | You can |
| --- | --- |
| `read` | Look: `ps`, `describe`, `logs`, `stats`, `df`, `history`, `doctor`, `audit`, `checks`, `jobs`, `backup list`, `ingress status`, `approvals`. |
| `deploy` | Everything in `read`, plus deploy, promote, roll back, restart, scale, run jobs and backups, take the lock, apply ingress, read diagnostics. |
| `admin` | Everything in `deploy`, plus secrets, `versions`, `exec`, `run`, `prune`, `restore`, `remove`, `destroy`, recreating stateful apps, `approve`, `reject` and `token`. A human admin token may list and resolve registry tags. An agent token cannot. |

## 3. The todo app

The todo app has three parts. They run in one project, `todo`. Each environment has its own overlay network (`todo-dev`, `todo-prod` by default).

| App | Kind | What it is |
| --- | --- | --- |
| `api` | `image` | The web service. The image is `ghcr.io/acme/todo-api`, in a **private** registry. It runs as the `web` role: two replicas in prod, one in dev. |
| `postgres` | `compose`, `stateful: true` | The database. It has its own Compose file, a named volume for its data, and a second volume for database dumps. |
| `redis` | `compose` | The cache. It holds nothing worth keeping, so it is not stateful. |

Replace `acme` with your own registry user or organisation wherever you see it.

The API finds the database at the name `todo-db` and the cache at `todo-redis`. Those are **network aliases**: each Compose file gives its service an alias on the environment's network. Swarm and Compose containers on that network can reach each other by name.

### The repository

```text
todo/
├── berthy.yml              # the base manifest
├── berthy.dev.yml          # what changes in dev
├── berthy.prod.yml         # what changes in prod
└── deploy/
    ├── postgres.yml        # the Compose file of the postgres app
    └── redis.yml           # the Compose file of the redis app
```

The finished files are in [`examples/todo/`](../examples/todo/). Your API source code, its Dockerfile and its CI workflow live in the same repository or another one. Berthy does not care.

### Why three apps and not one Compose file

You could put all three in one Compose file. Berthy keeps them apart on purpose:

- **`stateful` is per app.** The database is protected from being recreated. The cache and the API are not.
- **Each app has its own history and rollback.** A bad API deploy rolls back without touching the database.
- **Backups and restarts are scoped.** You can restart `redis` without touching `postgres`.
- **Image apps get zero-downtime rollouts.** Swarm starts the new API version first, checks its health, then stops the old one. A Compose app cannot do that.

### What each environment looks like

- **dev** has one replica, debug logs, no backups and no alerts. You can deploy any tag to it.
- **prod** is `protected`, has two replicas and resource limits, nightly backups, alerts, probes and a public hostname. The agent runs a digest there. At a terminal you pick a tag or give a digest.

---

## 4. Step by step

### Step 1. Prepare a server and set it up

`berthy setup` takes a bare Linux server to a running agent in one command. It deploys nothing.

#### Before you run it

You need:

- A Linux server with **systemd**, on a supported CPU architecture (amd64 or arm64). Docker Engine 25 or newer is fine; if Docker is missing, setup installs it.
- A **private address** on that server. This guide uses `10.0.0.5`. Setup does not create the server, its firewall or its VPN.
- An account that is `root` or can run `sudo` **without a password prompt**. Setup runs `sudo -n` and never asks for a password.
- Over SSH, a working `ssh` on your laptop. Setup uses the `ssh` on your `PATH`, so your keys, SSH agent, jump hosts and host-key checks apply as usual. Setup never takes a password and never stores a key. If ssh refuses an unknown or changed host key, setup adds a hint to connect once with `ssh ops@10.0.0.5` to check and accept the key.
- The repository checked out, so setup can read `network` and `protected` from the manifest. Run it from the repository root.

#### Look first with a dry run

```bash
berthy setup -e prod --host ops@10.0.0.5 --listen 10.0.0.5:7710 --dry-run
```

`--dry-run` connects and runs every check. It prints what would change and changes nothing on the server: no package, no service, no setting, no temporary file. A step that would change something reports `would_change`. The last line says how many steps would change.

To see the commands behind each step, add `--verbose`. Setup prints the commands it runs on standard error, each with its exit status, and in a dry run it also prints the commands a real run would send for each step that would change something, marked `not run: dry run`. The token and the encryption key never appear in that output.

#### Run it

Make the folder for the CLI configuration first, since setup writes the file into it:

```bash
mkdir -p ~/.config/berthy
berthy setup -e prod --host ops@10.0.0.5 --listen 10.0.0.5:7710 \
  --config ~/.config/berthy/config.json
```

On the server itself (for provisioning tools and images that already carry the binary) use `--local` instead of `--host`:

```bash
sudo berthy setup -e prod --local --listen 10.0.0.5:7710
```

`--listen` is needed on the **first** run only. After that the server's own agent configuration has the address, and a run with a **different** `--listen` is refused (`the agent listens on …; setup does not move it`).

The steps run in this order. Each one checks first and only acts when something is missing, and a failed step stops the run:

| Step | What it does |
| --- | --- |
| `connect` | Connects over SSH, or locally, and finds out whether it is root or can `sudo`. |
| `check` | Linux with systemd, a supported CPU, and `--listen` is an address assigned to this server. The desired configuration must not conflict with another hosted environment. |
| `docker` | Confirms Docker Engine is installed (version 25 or newer), enabled at boot and running. Installs it with Docker's official script when it is missing (unless `--no-install-docker`), and starts it when it is stopped. A Docker you did not install is never upgraded or reconfigured. |
| `swarm` | Turns on Swarm with your private address as the advertise address, with the management port on that address only. A server that already is a manager keeps its Swarm. A worker in another Swarm stops the run. |
| `network` | Creates the attachable overlay network for this hosted environment (`todo-prod` by default, or the name in the manifest), unless it exists. An existing network that is not an attachable overlay stops the run. |
| `user` | Creates the `berthy` system user and adds it to the `docker` group. |
| `binary` | Installs the Berthy binary as `/usr/local/bin/berthy` (see "Where the binary comes from"). |
| `key` | Prepares `/var/lib/berthy/environments/todo/prod/state` and makes the encryption key `/var/lib/berthy/environments/todo/prod/key`. It never replaces an existing key. |
| `token` | Creates the first `admin` token. The agent keeps only its digest. |
| `config` | Writes `/etc/berthy/agent.json`. It sets the environment, the listen address, `docker_socket` (`/var/run/docker.sock`), the state directory and key file, `protected` and `network`, and the tokens. |
| `service` | Installs, enables and starts `berthy.service`, and waits until the agent answers. |
| `cli_config` | Adds the environment to the CLI configuration file: the one `--config` names, or else the one the CLI finds (see [How to read the commands](#how-to-read-the-commands)). Without any location it is skipped, with a hint of the entry to add yourself. |
| `cli_token` | Saves the new admin token in this machine's credential store, or shows it when the save is unavailable or unconfirmed. |
| `verify` | Runs `doctor` on the new agent (see below). |
| `cli_key` | Saves a copy of the encryption key on this machine, in `~/.berthy/keys` (see [Save three things](#save-three-things)). With `--local` it is skipped. |

Every step ends with one status, shown as a glyph: `✓` for `ok` (nothing to change) and `changed`, `·` for `would_change` (dry run), `–` for `skipped` and `✖` for `failed`. This is a real first run, on a test server with another environment name and address. The names are the guide's (`prod`, `ops@10.0.0.5`, `10.0.0.5:7710`, network `todo-prod`), and the details are what setup prints:

```text
✓ connect     ops@10.0.0.5 (sudo)
✓ check       linux amd64, systemd, 10.0.0.5 assigned
✓ docker      installed 29.10.0 with the official script
✓ swarm       turned on Swarm advertising 10.0.0.5
✓ network     created network todo-prod
✓ user        created the berthy user, added it to the docker group
✓ binary      uploaded this CLI (v0.1.0-me), sha256 58eb0c5853b3
✓ key         prepared /var/lib/berthy, prepared /var/lib/berthy/environments, prepared /var/lib/berthy/environments/todo, prepared /var/lib/berthy/environments/todo/prod, prepared /var/lib/berthy/environments/todo/prod/state, generated an encryption key on the server
✓ token       created an admin token named admin
✓ config      created /etc/berthy/agent.json (listen 10.0.0.5:7710, 1 environment)
✓ service     installed, enabled and started berthy.service
✓ cli_config  wrote prod at http://10.0.0.5:7710 to config.json (token in $BERTHY_TODO_PROD_TOKEN)
– cli_token   no credential store on this machine: the token is shown below; set it in $BERTHY_TODO_PROD_TOKEN
✓ verify      agent v0.1.0-me, 9 of 9 checks ok
✓ cli_key     saved a copy of the encryption key in /home/me/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key
setup of todo/prod on ops@10.0.0.5: done

admin token for todo/prod (shown once, store it now): <token>

next steps:
  1. keep the copy of the encryption key that setup saved in /home/me/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key, and store another in a password manager or vault: without the key, the secrets of a lost server are gone
  2. store the admin token above, and set it in $BERTHY_TODO_PROD_TOKEN when you run berthy
  3. set the secrets the manifest names: berthy secret set NAME -e prod --config /home/me/.config/berthy/config.json
  4. apply the managed ingress: berthy ingress apply -e prod --config /home/me/.config/berthy/config.json
  5. deploy every app in depends_on order, with --version APP=REF for each image app: berthy deploy -e prod --config /home/me/.config/berthy/config.json --version APP=REF (or one app: berthy deploy APP -e prod --config /home/me/.config/berthy/config.json --version REF)
```

This sample is a non-terminal run with no credential store, so the token comes **after** the step lines. When the store confirms the save, setup prints the token only if you pass `--show-token`. An unconfirmed save may still finish later, so setup shows the token to avoid losing it. Setup prints the next steps only after a successful run that is not a dry run. The ingress item appears only when the manifest declares managed ingress. The next steps name `--config` only when you gave it to setup. Without it, the commands find the CLI configuration on their own. The post-setup secret, ingress and deploy commands name `--project` only when setup ran without a manifest. With one, each of those commands reads the project from `berthy.yml` in the directory you run it from, or in `--manifest-dir`. A `--local` key-copy handoff still names `--project` even when a manifest supplied the project. Relative `--manifest-dir` and `--config` resolve from the directory where you ran setup, so return there before the other commands. When the key copy could not be saved, `cli_key` says `not saved` with the reason and the first next step says what to do instead. The exit code stays 0. (The sample above is from a run on a test server, shortened where its details differ.)

After a successful text-mode setup with a loaded manifest, terminal input and an available admin token, setup runs the secrets guide after the summary and any token, before printing next steps. It generates declared secrets and asks for the remaining values without echoing them; Enter skips a value. When the guide finishes, next steps name any secrets still missing. If it cannot finish, setup keeps the manual secret commands. A pipe or `--json` skips the guide and prints those commands. A dry run also skips the guide. The guide does not change the setup exit status.

A **second run** keeps the existing token and shows no new token. With a stored token it reports:

```text
✓ binary      this CLI (v0.1.0-me) is installed
✓ token       the tokens of /etc/berthy/agent.json are kept
✓ cli_token   the admin token is in the Secret Service
✓ verify      agent v0.1.0-me, 9 of 9 checks ok
✓ cli_key     the copy of the encryption key is in /home/me/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key
```

If you want a machine-readable result, add `--json`. It prints one object and nothing else. An unstored token is in it as `"token"`, and the next steps as `"next_steps"`. A confirmed save adds `"token_stored": true` and omits `token` unless `--show-token` was given. `key_copy` is the path of the key copy on this machine. It is absent when none was saved:

```json
{"project": "todo", "environment": "prod", "target": "ops@10.0.0.5", "dry_run": false, "ok": true,
 "steps": [{"step": "docker", "status": "ok", "detail": "Docker 29.9.3, running, enabled"}],
 "token": "<token>", "key_copy": "/home/me/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key", "next_steps": ["..."]}
```

Exit codes: `0` all steps fine, `1` a step failed (the output names it), `2` the command line is wrong. If a later step fails after the configuration holding the token went live, setup prints the token if the save was not confirmed or `--show-token` was given. If activation is interrupted while installing or rolling back the configuration and setup cannot tell which configuration remains, the failed run also shows the token in case the server kept it. The token is not saved or treated as live in that case. A key copy that could not be saved does not change the exit code.

#### Where the binary comes from

Setup installs the version of Berthy that runs it. It picks the source in this order:

1. `--binary <path>`, a Linux build for the server's architecture. Setup checks that it is an ELF executable of that architecture.
2. **This CLI**, when it is a Linux build for the server's architecture. It uploads itself.
3. **The release download.** The server downloads `berthy-linux-<arch>` and `checksums.txt` for the CLI's version from the release site, and verifies the checksum. The base URL is GitHub's releases unless `BERTHY_RELEASE_URL` says otherwise (`https`, or `http` on a loopback or private address).

A development build on macOS or Windows has no release to download, so give it `--binary`.

#### The `verify` step

`verify` asks the new agent for its `doctor`. It sends the request **from your machine**, with the token this run made, or else the token in the variable the CLI configuration names (`BERTHY_TODO_PROD_TOKEN`), or the token saved for that entry in the credential store. If your machine cannot reach the private address, setup says so and runs the same check **on the server**. With no token at all, it only checks that the agent answers on `/healthz`, and tells you to run `berthy doctor` yourself. Any critical check that fails fails the step.

#### Save three things

1. **The first admin token.** Setup saves it in this machine's credential store when available. Pass `--show-token` to print it as well. If the save is unavailable or unconfirmed, setup prints it after the step lines. Save it privately and set it in your shell:

   ```bash
   export BERTHY_TODO_PROD_TOKEN=<token>
   ```

   Setup writes the token's digest into `/etc/berthy/agent.json`. Every other token you make through the agent (step 6). Lost it? Run setup again with `--new-token`. It adds another `admin` token to the file and leaves the others alone.

2. **The encryption key.** It lives on the server at `/var/lib/berthy/environments/todo/prod/key` (32 bytes). It seals every secret in the agent's state. The agent never uploads it. If the server dies and you do not have it, the secrets are gone.

   After a successful remote setup (`--host`), setup saves a copy as `~/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key`. On Windows that is `%USERPROFILE%\.berthy\keys\`. Only your account can use the folder and the file. The last part of the name before `.key` is the key's ID. `berthy key rotate` and `state-restore` name keys by that ID. Setup never replaces a copy. After a key rotation, the next setup run saves the new key beside the old one. Keep each copy as long as you keep a state snapshot made with that key. The copy is on one machine. Store another in a password manager or your provisioning tool's vault.

   With `--local`, setup saves none. It tells you to run setup for that same project and environment over SSH from your own machine, with `--project` and the same build that is installed on the server: the same released version of the CLI, or the same custom Linux binary given with `--binary`. First resolve any interrupted key rotation on that server. If you are not sure about the build or the rotation, check before you copy.

   If `cli_key` says `not saved`, do what the first next step says: fix the reason, then run the same `berthy setup` command again, from this same directory and with the same environment; leave out `--new-token` if that run used it, because this run already added that admin token. If it says a folder is not private, look at it first with `ls -ld ~/.berthy ~/.berthy/keys` (Windows: `icacls`). Only when it is a real directory that you own, and not a link, make it private on POSIX with `chmod 700 <that directory>`, or move that owned folder aside and let setup create a new one. On macOS an extra access entry shows as `+` in `ls -le`.

   If `cli_key` says the server did not hand over the key, no copy was saved. A server running an older `--binary` cannot hand it over. Upgrading that agent is an ordinary upgrade that you plan on its own, and only when no hosted environment on the server has an unresolved key rotation failure. If one is known, diagnose and fix it before any restart.

   If the copy leaks, or someone who had it leaves, replace the key with [`berthy key rotate`](#rotate-the-encryption-key).

3. **The CLI configuration file.** The `cli_config` step writes it for you, to the file `--config` names or else to the default file (see [How to read the commands](#how-to-read-the-commands)). It maps each environment to an agent address and **the name of the environment variable that holds the token**. It never contains a token:

   ```json
   {
     "projects": {
       "todo": { "environments": {
         "prod": { "url": "http://10.0.0.5:7710", "token_env": "BERTHY_TODO_PROD_TOKEN" }
       } }
     }
   }
   ```

   The default variable name is `BERTHY_<PROJECT>_<ENVIRONMENT>_TOKEN`. An environment that already has a `token_env` keeps it, and other environments in the file are kept as they are. You can edit this file by hand: unknown keys are refused. The commands find this file on their own, so `--config` is only needed for another file.

#### Copying by hand

Setup never prints a command that copies the key file. When you still need one (for example after `key rotate`, or when you prefer a second off-machine copy), use a POSIX shell. Two things first: `<key>.next` must not exist beside the key on the server, and a sudo that records command output will record the key.

```bash
(umask 077; set -C; ssh 'ops@10.0.0.5' 'sudo cat /var/lib/berthy/environments/todo/prod/key' > ~/todo.prod.key.20261122T153012Z)
chmod 600 ~/todo.prod.key.20261122T153012Z
```

Keep the file in a password manager or your provisioning tool's vault as well.

#### Setup is safe to run again

A second run repairs what is missing and changes nothing else. It never replaces the encryption key, the tokens or the agent's state, it never replaces a key copy on your machine, and it never touches a running app. Run one `berthy setup` at a time against a server: two runs that add different environments can read the same `agent.json` and lose one entry. (A setup lock is planned: #53.)

Running it with a **newer CLI**, or with `--binary`, **upgrades the agent**. Only the agent restarts. Apps keep running. The previous binary and configuration are kept for one generation, and **if the new agent does not answer, setup puts the previous binary and configuration back** and restarts the old one, with the agent's last log lines in the error. On a first install there is nothing to put back, so setup stops the service and leaves it stopped.

#### The other setup options

| Option | Meaning |
| --- | --- |
| `-e <env>` | The environment to set up. |
| `--host <user>@<server>` | Set up a remote server over SSH. |
| `--local` | Set up the server the command runs on. Use exactly one of `--host` and `--local`. |
| `--listen <address>:<port>` | The private address the agent's API listens on. Required on the first run. A later run keeps the agent's own address, and a different one is refused. It must be one specific address of the server, not `0.0.0.0` or `::`. |
| `--config <file>` | The CLI configuration file to add the environment to. Without it, `cli_config` uses `BERTHY_CONFIG`, or else the default file. |
| `--manifest-dir <dir>` | Where to read the manifest from. Default: the current directory. |
| `--project <name>` | The project, required when the directory has no manifest. |
| `--network <name>` | The shared network, when the directory has no manifest. |
| `--protected` | Mark the environment as protected, when the directory has no manifest. |
| `--no-install-docker` | Stop if Docker is missing instead of installing it. |
| `--dry-run` | Check and report what would change, without changing anything. |
| `--json` | Report as JSON. |
| `--verbose` | Print each command setup sends, and its exit status, on standard error. With `--dry-run`, also the commands a real run would send. Standard output does not change. |
| `--binary <path>` | Install this Linux build of Berthy instead of this CLI or the release. |
| `--key-file <path>` | Install a saved encryption key (exactly 32 bytes) instead of generating one. Used when you [rebuild a server](#step-15-rebuild-a-server). It never replaces a different key that is already on the server. |
| `--new-token` | Add another `admin` token, when the first one is lost. |
| `--show-token` | Print the newly created admin token as well as saving it. |

If the directory has a manifest, setup reads the project, `network` and `protected` from the merged manifest of the environment. A `--project` or `--network` flag that disagrees with the manifest is an error. With no `berthy.yml` and no `--project`, setup stops and asks for `--project NAME`. Without a manifest or `--network`, the network defaults to `<project>-<environment>`.

#### What setup leaves on the server

| Item | Location and owner |
| --- | --- |
| Binary | `/usr/local/bin/berthy` |
| Agent configuration | `/etc/berthy/agent.json`, owner `berthy:berthy`, mode `0600`. The folder `/etc/berthy` is `root:berthy`, mode `0750`. |
| State of one hosted environment | `/var/lib/berthy/environments/<project>/<environment>/state`, `berthy:berthy`, mode `0700` |
| Encryption key of one hosted environment | `/var/lib/berthy/environments/<project>/<environment>/key`, `berthy:berthy`, mode `0600` |
| Service | `/etc/systemd/system/berthy.service`, running as the `berthy` user in the `docker` group, with `StateDirectoryMode=0700` |

The agent's configuration is plain JSON. Its keys are listed in the [reference](#agent-configuration).

> **Setup does not do these.** It does not create the server, its users, its firewall or your private network. It does not install the VPN. It does not change Docker's storage driver, its default log driver or its daemon options. Each role's log rotation is set on its service instead, in step 2. It does not write a manifest: that is step 2. It deploys nothing.

#### More than one project or environment on a server

`berthy setup` on a server that already runs an agent adds another hosted environment: its own state, key, admin token and network. Other hosted environments on the agent are unchanged. Setup rewrites `agent.json` and restarts the shared agent for everyone on the server. It saves the new admin token for the entry, or prints it if the save is unavailable or unconfirmed.

```bash
# Another project on the same server (no berthy.yml in this directory):
berthy setup -e prod --project shop --host ops@10.0.0.5

# Or, from that project's repository (reads project and network from the manifest):
berthy setup -e prod --host ops@10.0.0.5
```

`--listen` is only needed on the first run for that server. Later runs keep the agent's address.

**Network.** With a manifest, the network comes from it when set, otherwise from the environment's default `<project>-<environment>`. Without a manifest, `--network` is optional and defaults the same way. Two hosted environments cannot share one network name. The todo example leaves `network` unset, so `todo/dev` uses `todo-dev` and `todo/prod` uses `todo-prod`. A Compose app joins that network with `name: ${BERTHY_NETWORK}`; Berthy writes the value into the Compose project's `.env`. To add another environment such as `stage` on the same agent:

```bash
berthy setup -e stage --host ops@10.0.0.5
```

Two projects with the same environment name are fine: `todo/prod` and `shop/prod` both work on one agent. So do two environments of one project, such as `todo/prod` and `todo/stage`, once each has its own network. Docker names carry both project and environment (`todo-prod-api-web`, `shop-prod-api-web`), so they do not collide. The CLI picks the project with `--project`, or from the manifest directory you run in.

There is no command that removes a hosted environment from a server. After `destroy`, stop the agent, remove that entry from `agent.json` and its directory under `/var/lib/berthy/environments/`, then start the agent again only if at least one hosted environment remains. An `agent.json` with no environments is refused.

#### Alerts about the server

Host checks (disk, memory, Docker, public ports, reboot) still run inside every hosted environment's monitor. Each environment evaluates them independently and sends any resulting alerts to all of its configured channels (Telegram, webhook, or both). An environment with no channel configured sends none. Alerts, deploy reports, the webhook body and telemetry name the environment only, not the project. Server-level alert channels, and naming the project in those messages, are planned: #55, #56.

#### Another laptop

`berthy setup` writes the CLI configuration on the machine that runs it. On a second laptop, add the same hosted environment without SSH:

```bash
berthy context add --project todo -e prod --url "http://10.0.0.5:7710" --token-env BERTHY_TODO_PROD_TOKEN --save-token
```

That prints `added todo/prod at http://10.0.0.5:7710 to … (token in $BERTHY_TODO_PROD_TOKEN)`. With `--save-token`, it reads the token (hidden at a terminal, or from a pipe) and, when the save succeeds, prints `saved the token of todo/prod in the …`. An unavailable or unconfirmed save keeps the entry, so you can set `$BERTHY_TODO_PROD_TOKEN` without adding it again. Without `--save-token`, set the variable to a token you saved privately. The first machine's credential store is local to it; use `--show-token` when making a new token if you also need a copy. `berthy context list` shows each context, whether its variable is set (`yes` or `no`), and whether a token is `stored`, `not stored`, or `unknown` if the store is unavailable. It never shows the token. `berthy context remove --project todo -e prod` removes the entry and keeps any stored token. Add `--delete-token` to delete the stored token first. `berthy agent token --project todo -e prod --config /etc/berthy/agent.json` prints a `context add` line for another machine; without `--config` the URL is `http://ADDRESS:PORT` for you to fill in.

#### A server set up before projects

An `agent.json` of a release before projects cannot be upgraded in place. Setup refuses it and prints the commands that move the old install aside. A CLI configuration of that earlier layout is also refused before setup connects. Do the steps in this order, while the old agent still answers where you need it:

1. **Optional:** remove the old apps with the old CLI's `destroy`, while the old agent and its CLI configuration are both still available.
2. **Move the old CLI configuration aside**, or pass `--config` with a new path for the rest of this procedure. The default file is `~/.config/berthy/config.json` on Linux.
3. **On the server**, stop the agent and move the old install aside (these commands delete nothing):

```bash
sudo systemctl stop berthy
sudo mv /etc/berthy /etc/berthy.pre-projects
sudo mv /var/lib/berthy /var/lib/berthy.pre-projects
sudo chmod 0700 /var/lib/berthy.pre-projects
```

4. Run `berthy setup` again (with the new CLI configuration path if you chose one). The old state and key stay in `/var/lib/berthy.pre-projects`. If you skipped step 1, the old apps keep running under their old names; remove them by hand.

#### Check that it works

```bash
berthy version
berthy doctor -e prod
berthy agent-info -e prod
```

`berthy version` needs no agent. It prints the CLI's version and platform (`berthy dev linux/amd64` for a development build). `--json` prints an object with `version`, `release`, `os` and `arch`.

`berthy doctor` asks the agent to check itself, and prints the CLI's and the agent's versions first. If they differ, it adds a note that `berthy setup` upgrades the agent. It exits `1` when a critical check fails. The checks are:

| Check | What it looks at |
| --- | --- |
| `agent` | The agent runs, and its version. |
| `host` | The host name. |
| `disk` | The root disk has more than 10 percent free. |
| `docker`, `docker_api` | Docker answers, and its API version is compatible. |
| `swarm_manager` | This server is a Swarm manager. |
| `network` | The shared network exists and is an attachable overlay. It checks the network in the agent configuration, or else the one in the environment's settings. |
| `ingress_tunnel` | The Cloudflare tunnel, once managed ingress is set up. |
| `compose` | The Compose plugin answers. |
| `registry:<host>` | The registry password of each registry that a deployed image app pulls from: whether the registry still accepts it. See [step 8](#step-8-keep-it-healthy). |
| `cloudflare_token` | The Cloudflare API token, once managed ingress is set up: whether Cloudflare still accepts it, and when it expires. See [step 8](#step-8-keep-it-healthy). |
| `lock` | The deploy lock (`free` or who holds it). |
| `peer:<name>`, `telegram`, `webhook`, `heartbeat`, `backup:<name>`, `probe_helper`, ... | One check each for the peers, the secrets of the Telegram and webhook channels, the heartbeat (when its last ping was accepted), every backup, and the probe helper, once the manifest uses them. |
| `orphan_apps` | Apps that are deployed but no longer in the manifest. |
| `drift:<app>` | A warning, not a failure: what an app runs differs from its applied release. See **Drift** in step 8. |
| `compose_log_limit` | A warning, not a failure: services of deployed Compose apps whose logs grow without a size limit. See **Log rotation** in step 2. |
| `public_ports` | A warning, not a failure: TCP ports that listen on an address that is not loopback, private or VPN, and the ports that containers publish on one. Each port says what it is where Berthy knows it, such as `2375 Docker API without TLS` or `5432 PostgreSQL`. Ports 22, 80 and 443 are listed without a warning. A listening port is not proof that it is reachable, because a firewall may sit in front. |
| `reboot_required` | A warning, not a failure: the host has a reboot pending, and the packages that asked for it when the host lists them. A host without the update notifier has no such check. |
| telemetry | The OTLP exporter, when configured. |

A backup, a credential, an alert or a host warning in trouble does not make `doctor` exit non-zero: that is an alert, not a fault of the agent. The two host checks change nothing on the server. The firewall and the packages stay with your provisioning.

`berthy agent-info` prints the environment, the host name, whether the agent is protected, and its version. A capable agent also reports `effective_protected` (configured or sticky protection). A legacy agent omits that field.

---

### Step 2. Write the manifest

The manifest is the YAML in your repository that says what you want. There is a base file and one overlay per environment.

- `berthy.yml` holds what every environment shares.
- `berthy.<environment>.yml` changes it for one environment. It is optional.

The agent never reads your repository. Instead, the CLI **reads the files from the commit you are deploying** and sends the merged manifest in the deploy request.

#### How the merge works

- A **map** is merged key by key. A key in the overlay replaces the same key in the base, and keys that only one file has are all kept.
- A **list** or a plain value in the overlay **replaces** the base's. If the overlay has `hooks.pre_deploy`, it replaces the whole base list. When the overlay's list leaves out an entry of the base list, `config validate` warns, for example `apps.api.env.secret replaces the base list and drops JWT_SIGNING_KEY`. The list is still replaced. A command line is the exception: a role's `command` or `entrypoint`, a health check's `test`, and a migration's `version`, `apply` and `revert` are replaced without a note, since their order is their meaning.
- In an overlay, **`null` removes the key**, so this environment does not have it. `LEGACY_MODE: null` under `env.plain` takes that variable out of the manifest of the environment, and the other environments keep it. A `null` for a key that the base does not set does nothing, and `config validate` warns about it. Write `null` or `~`: an empty value is refused, so a key is never removed by mistake.
- The file must be one YAML document. **Anchors and aliases are refused**, and so is `null` in `berthy.yml` or in a list. So are duplicate keys, and keys Berthy does not know (a typo is an error, not a silent no-op). A file is at most 1 MiB.
- **Quote numbers and booleans that you mean as text.** `DB_PORT: "5432"` is right. `DB_PORT: 5432` is refused, because environment values are strings.
- Names of apps, roles, jobs, backups and so on use lowercase letters, digits, `-` and `_` (up to 63 characters, starting with a letter or digit). Environment variable and secret names use letters, digits and `_`.
- Durations are Go-style: `15s`, `2m`, `1h30m`. There is no `d` for days.

#### The top of `berthy.yml`

```yaml
project: todo

registries:
  ghcr.io:
    username: acme
    password_secret: GHCR_TOKEN
```

| Key | Meaning |
| --- | --- |
| `project` | The project name. It prefixes Swarm service names and Compose project names. |
| `network` | Override the environment network to adopt an existing overlay network. Default `<project>-<environment>`. Setup creates it when it does not exist. |
| `protected` | `true` for a protected environment. Usually set in an overlay. Default `false`. |
| `registries.<host>` | A credential for a private registry. `username` is the user, `password_secret` names the secret that holds the token. A registry with no entry is pulled from anonymously. |
| `aliases` | Short names for command lines, for people at a terminal. See [Aliases](#aliases). |
| `min_version` | The oldest Berthy release this manifest works with, such as `0.9.0`. Set it when the manifest uses a key that an older release does not know. See the paragraph below. Default: none. |
| `timezone` | The IANA time zone every `schedule` is read in, such as `Europe/Lisbon`. Default: `UTC`. See [the time zone of schedules](#the-time-zone-of-schedules). |

**`min_version`** makes an old release say so, instead of refusing the manifest with `invalid request`. Three checks use it:

- The CLI refuses to load a manifest whose `min_version` is above its own release: `this manifest needs Berthy 0.9.0 or newer; this CLI is v0.8.2`. `config validate` makes this check too, without contacting a server.
- Before the CLI sends a manifest, it asks the agent for its version and refuses an older agent: `this manifest needs Berthy 0.9.0 or newer; the agent of prod runs v0.8.2: upgrade it with berthy setup`. Upgrade that environment's agent with `berthy setup`.
- The agent refuses a request whose manifest needs a newer release than the agent's, so a request from another client is refused too. A rollback is not checked, since it runs the manifest the agent stored.

A development build of Berthy has no release version, so it skips every check: a development CLI does not check itself or the agent, and a development agent is not checked. A release CLI does not check a development agent. When an agent refuses a request as invalid and runs an older release than the CLI, the CLI adds the line `the agent runs an older release than this CLI; upgrade it with berthy setup`.

#### Aliases

An alias gives a short name to a command line. It is for people; the MCP server does not offer aliases.

```yaml
aliases:
  console: exec api --role web -- bin/console
  weblogs: logs api --role web --follow
```

`berthy console -e prod` runs `berthy exec api --role web -e prod -- bin/console`. The CLI expands the alias before it checks any flag, so the agent gets an ordinary request, and the scope, the approval and the audit log are those of the command it stands for. Anything else you type after the name is added at the end: `berthy console -e prod ls` runs `bin/console ls`. The aliases are read for the environment you name with `-e`, or else `$BERTHY_ENV` when `-e` is omitted, so an overlay such as `berthy.prod.yml` can hold them. A given `-e` wins. The `-e`, `--config` and `--manifest-dir` given with an alias are used to find it, and `--manifest-dir` is passed on only to commands that take it.

- The words are separated by spaces. Quotes are not interpreted, so a value with a quote is refused.
- `-e` and `--config` cannot be in an alias. You give the environment on the command line or with `$BERTHY_ENV`.
- An alias cannot take the name of a built-in command, such as `deploy` or `ps`. Its first word must be a command that talks to the agent, not another alias, `mcp`, `ui` or `setup`.
- `berthy config validate` checks the aliases and names the one that is wrong. A manifest holds at most 64.
- An overlay's alias replaces the base alias of the same name.

#### The API: an image app

```yaml
apps:
  api:
    kind: image
    image: ghcr.io/acme/todo-api
    depends_on: [postgres, redis]
    roles:
      web:
        replicas: 1
        port: 8080
        health:
          test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
          interval: 15s
          timeout: 5s
          start_period: 30s
          retries: 3
    env:
      plain:
        DB_HOST: todo-db
        DB_PORT: "5432"
        DB_NAME: todo
        DB_USER: todo
        REDIS_HOST: todo-redis
        LOG_LEVEL: info
      secret:
        - POSTGRES_PASSWORD
        - REDIS_PASSWORD
    deploy:
      deploy_timeout: 120s
      drain_timeout: 30s
      start_attempts: 3
      verify: true
      retain: 5
```

`image` is the repository only, with no tag and no digest. You choose the version at deploy time. `roles` is required for an image app.

`depends_on` names the apps that must be deployed before this one: the database and the cache here. It does one thing: it sets the order of `berthy deploy` run without an app ([step 4](#all-the-apps-in-one-command)). Deploying the API on its own does not deploy or check them. `config validate` refuses a name that is not an app, an app that depends on itself, a name listed twice and a cycle (`depends_on cycle: api -> worker -> api`). An overlay that sets `depends_on` replaces the whole list.

**Roles.** Each role has:

| Key | Meaning | Default |
| --- | --- | --- |
| `replicas` | How many copies. At least 1. | `1` |
| `port` | The port the role serves on. Needed for public `hostnames`. | none |
| `command` | Replaces the image's command. A list. | the image's |
| `health` | The health check, below. | the image's own `HEALTHCHECK`, if any |
| `volumes` | Named volumes to mount, as `name:/path`, or `name:/path:ro`. | none |
| `resources.cpu` | CPU limit in cores, such as `"1.0"` or `"0.5"`. | no limit |
| `resources.memory` | Memory limit, such as `512M`, `1G`, `256MiB`. | no limit |
| `hostnames` | Public hostnames for managed ingress. See [step 7](#step-7-put-it-on-the-internet). | none |
| `service` | The name of an existing Swarm service to adopt. See [adoption](#adopting-an-app-that-already-runs). | `<project>-<environment>-<app>-<role>` |
| `logging` | The log driver and options of the role's containers. See **Log rotation** below. | `json-file` or `local` with `max-size: 10m`, `max-file: 3` |

Berthy names the Swarm service `<project>-<environment>-<app>-<role>`. The API's web role is `todo-prod-api-web`. Other containers on the network can reach it at that name.

**Log rotation.** Docker keeps a container's logs in files. Berthy gives each role's containers a limit, so a chatty app cannot fill the disk: at most 3 files of 10 MB each. This applies when the role sets no `logging` and the server's default log driver is `json-file` or `local`. To choose the driver or the limits, set `logging`:

```yaml
        logging:
          driver: json-file
          options:
            max-size: 50m
            max-file: "5"
```

Quote the number in `max-file`, as the example does. A role with `logging` gets exactly those options, and no default is added to them. Any other driver, such as `journald`, gets nothing from Berthy unless the role sets `logging`. Compose apps keep their own logging settings: set `logging` in the Compose file. Berthy does not rewrite that file, so `doctor` warns (`compose_log_limit`) about each service of a deployed Compose app that logs as json-file with no `max-size`. When the service's driver is the server's default driver, the server's `log-opts` `max-size` counts too, even if the service sets other options.

**The health check** is a command that runs *inside* the container, with the same fields Docker uses:

| Field | Meaning | Default |
| --- | --- | --- |
| `test` | The command. It starts with `CMD` or `CMD-SHELL`. Exit code 0 means healthy. | required |
| `interval` | Time between checks. | `30s` |
| `timeout` | Longest one check may take. | `30s` |
| `start_period` | Grace time after start. Failures in it do not count. | `0s` |
| `start_interval` | Check more often during the start period. Check that your Docker version supports it for Swarm services. | Docker's |
| `retries` | Failures in a row before the container is unhealthy. | `3` |

The image must contain the command (`curl` here). A new version is first noticed healthy about one `interval` after it starts, so every deploy takes at least that long.

**Environment.** `env.plain` values live in the manifest and are reviewed like code. `env.secret` lists secrets, and the values live in the agent. Each entry is either a secret's name, which is also the variable the container gets, or a one-key map from the variable to the secret's name:

```yaml
env:
  secret:
    - JWT_SIGNING_KEY                  # the variable JWT_SIGNING_KEY gets the secret JWT_SIGNING_KEY
    - DATABASE_URL: API_DATABASE_URL   # the variable DATABASE_URL gets the secret API_DATABASE_URL
```

So two apps of one environment can each have their own `DATABASE_URL`, each mapped to its own secret. A variable can be listed once, and it cannot also be in `plain`. Two variables may take the value of the same secret. Both kinds of app take the same `env` block. For a Compose app, Berthy writes each variable and its value into the project's `.env` file, where the Compose file reads it as `${NAME}`.

**A value built from secrets.** `env.template` makes a variable out of text that refers to secrets by name, so an app that wants one `DATABASE_URL` does not need a second secret kept in step with the password:

```yaml
env:
  plain:
    LOG_LEVEL: info
  secret:
    - JWT_SIGNING_KEY
  template:
    DATABASE_URL: "postgres://todo:${POSTGRES_PASSWORD}@todo-db:5432/todo"
```

- A reference is `${NAME}`, where NAME is the name of a secret of the environment, written as a secret name is (letters, digits and `_`, not starting with a digit). `$$` writes one `$`. Any other `$` is an error. There are no defaults, no nesting and no references to other variables.
- The agent fills the template in when it deploys. The manifest and the release keep the template, and never the result.
- The filled value is a secret. `config show` prints the template, which holds no secret value. Plans, diagnostics, `exec` output and logs show the filled value as `[redacted]`, as they show any secret's value, and the secret inside it is redacted too.
- `config validate` refuses a malformed reference and names its file and line. `secret list --manifest-dir` lists a secret that only a template reads when it is not stored, and a deploy stops before it changes anything when one is missing: `secret POSTGRES_PASSWORD is not set`.
- A variable is in one of `plain`, `secret` and `template`.
- A reference cannot ask for URL encoding. A value from `berthy secret generate`, which is hex unless you ask for another format, needs none. A password with `@`, `/` or `:` in it does, so do not use one in a URL template.
- Setting a secret again does not change the apps that read it. Deploy them again to pick up the new value.

Berthy also sets these variables in every container of an image app, so the app can tag its error reports, traces and metrics:

| Variable | Value |
| --- | --- |
| `BERTHY_ENVIRONMENT` | The environment name. |
| `BERTHY_PROJECT` | The manifest's `project`. |
| `BERTHY_APP` | The app's name. |
| `BERTHY_ROLE` | The role's name. Empty in the containers of `run:` hooks and migrations, which belong to the app and not to a role. |
| `BERTHY_VERSION` | The tag the deploy asked for. Empty for a digest deploy. |
| `BERTHY_IMAGE_DIGEST` | The digest that runs, as `sha256:…`. |

They change only with the image, so a deploy that keeps the version gives its containers the same variables and replaces none of them for that reason. A rollback sets the tag and digest of the release it returns to. An app deployed before these variables existed gets them at its next deploy, which replaces its tasks once. The containers of a schema revert record no tag, so `BERTHY_VERSION` is empty in them.

A variable whose name starts with `BERTHY_` cannot be used in `env.plain`, `env.secret` or `env.template`. A Compose app does not get the role, version or digest. Berthy writes `BERTHY_ENVIRONMENT`, `BERTHY_PROJECT`, `BERTHY_APP` and `BERTHY_NETWORK` into the project's `.env` file, so the Compose file can pass them on:

```yaml
services:
  web:
    environment:
      APP_ENVIRONMENT: ${BERTHY_ENVIRONMENT}
```

**Deploy settings.**

| Key | Meaning | Default |
| --- | --- | --- |
| `deploy_timeout` | The longest the new version may take to become healthy. | `120s` |
| `drain_timeout` | How long the old version has to finish requests in flight. It is also the Swarm stop grace period. | `30s` |
| `start_attempts` | How many failed task starts a rollout tolerates before it gives up (1 to 10). | `3` |
| `retain` | How many deploys' images are kept, so a rollback needs no pull. At least 1. | `5` |
| `verify` | Whether the deploy checks, at its end, that each role's port and hostnames answer. A failed check warns and never fails the deploy. | `true` |

With the example values, a container that never becomes healthy is marked unhealthy after about 75 to 90 seconds, inside the 120-second `deploy_timeout`.

#### Hooks and migrations

```yaml
    migrations:
      version: ["/app/bin/migrate", "version"]
      apply: ["/app/bin/migrate", "up"]
      revert: ["/app/bin/migrate", "down-to", "{target}"]
      timeout: 5m
      retries: 0
    hooks:
      post_deploy:
        - run: ["/app/bin/warm-cache"]
          timeout: 2m
          retries: 2
```

These run during a deploy. [Step 6](#step-6-ship-a-new-version-of-the-api) explains them. In short:

- `migrations` runs your migration tool as its own deploy step, never at app start. `version` prints the schema state, `apply` upgrades, `revert` goes back to `{target}`. Berthy knows nothing about your tool. These commands must run from the image.
- `hooks.pre_deploy` and `hooks.post_deploy` are lists of steps. A step is either `run: [command]` (run in a container of the new image, with the app's environment) or `backup: <name>` (run a volume backup and wait).
- `timeout` (from `1s` to `24h`, default `5m`) limits each attempt. `retries` (0 to 5, default `0`) runs a command that exited non-zero again. Only retry a command that is safe to run twice.

#### The database and the cache: Compose apps

```yaml
  postgres:
    kind: compose
    file: deploy/postgres.yml
    stateful: true
    env:
      plain:
        POSTGRES_DB: todo
        POSTGRES_USER: todo
      secret:
        - POSTGRES_PASSWORD

  redis:
    kind: compose
    file: deploy/redis.yml
    env:
      secret:
        - REDIS_PASSWORD
```

| Key | Meaning |
| --- | --- |
| `file` | The Compose file, relative to the manifest directory. It must be a regular file inside it, not larger than 512 KiB. The CLI reads it and sends it with the deploy. |
| `stateful` | `true` means a command that would recreate or remove this app is refused unless it carries `--allow-recreate` and an admin token. |
| `project_name` | The Compose project name. Default `<project>-<environment>-<app>`, so `todo-prod-postgres`. Compose names volumes after it, so **never change it** once the app holds data. Set it to the existing name when you adopt a running project. |

Compose rules to remember:

- **Join the shared network yourself.** Berthy does not add it. Each environment defaults to `<project>-<environment>`; set `network` in the manifest to adopt an existing network. Declare it as an external network with `name: ${BERTHY_NETWORK}` in the Compose file, and give each service the alias the API uses. Image roles have the alias `<app>-<role>` on the same network.
- **Do not publish ports** on all interfaces. A deploy that publishes one is refused with `service … publishes port … on all interfaces; bind it to a private address`. Here nothing is published.
- A `build:` section is refused. Compose apps deploy images only.
- Settings that reach into the host (privileged mode, host namespaces, extra capabilities, devices, host bind mounts, `env_file`, secrets or configs read from host files) are accepted only from an `admin` token.
- A Compose deploy has no automatic rollback and takes no `--version`. The next deploy brings the project to its file.

`examples/todo/deploy/postgres.yml`:

```yaml
services:
  postgres:
    image: postgres:17.2-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - db-dumps:/backups
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    networks:
      todo:
        aliases:
          - todo-db

volumes:
  pgdata:
  db-dumps:

networks:
  todo:
    external: true
    name: ${BERTHY_NETWORK}
```

Three details matter:

- `networks.todo.external: true` with `name: ${BERTHY_NETWORK}` joins the environment network setup created. `aliases: [todo-db]` is the name the API's `DB_HOST` uses.
- `${POSTGRES_PASSWORD}` comes from the manifest's secrets. Postgres reads its password **only when it first initialises an empty data volume**. Changing the secret later does not change the database's password: you must also run `ALTER USER` (see [step 13](#step-13-update-the-database-or-the-cache)).
- The `db-dumps` volume is where the dump job writes. [Step 10](#step-10-backups-and-restore) backs it up. `$$` in a Compose file is a literal `$`.

`examples/todo/deploy/redis.yml` follows the same pattern, with the alias `todo-redis`, `--requirepass` set from `REDIS_PASSWORD`, and nothing saved to disk.

> **An app that wants one `DATABASE_URL`.** The todo API takes `DB_HOST`, `DB_NAME`, `DB_USER` and `POSTGRES_PASSWORD` separately and builds its connection string itself. If your app insists on a single `DATABASE_URL`, build it from the password with a template, and keep no second secret in step with it:
>
> ```yaml
> env:
>   template:
>     DATABASE_URL: "postgres://todo:${POSTGRES_PASSWORD}@todo-db:5432/todo"
> ```
>
> The agent fills in `${POSTGRES_PASSWORD}` when it deploys. See [Environment](#step-2-write-the-manifest) above.

#### The overlays

`berthy.dev.yml`:

```yaml
apps:
  api:
    env:
      plain:
        LOG_LEVEL: debug
```

`berthy.prod.yml` begins like this. The rest (hooks, backups, ingress, alerts) is added in later steps:

```yaml
protected: true

apps:
  api:
    roles:
      web:
        replicas: 2
        resources:
          cpu: "1.0"
          memory: 512M
```

#### Check it without a server

```bash
berthy config validate -e prod
berthy config validate -e dev
```

```text
manifest valid
```

Validation reads the files and checks the merged result. It needs no agent and no `--config`. Add `--manifest-dir <dir>` to read another directory. It exits `1` with the reason when something is wrong.

It reports every problem it can find, not only the first, and says where each one is: the file (`berthy.yml` for the base manifest, `berthy.prod.yml` for the overlay), the line and column, the path in the manifest, and what is wrong. Where an overlay sets a key, the problem is placed in the overlay.

```text
berthy.yml:9:9: apps.api.roles.web.port: app api role web: invalid settings
berthy.prod.yml:3:5: backups.data.destination: backup data: unknown destination
2 problems
```

A problem about something that is missing, such as a required key, is placed at the nearest key that exists. A value of the wrong type, such as `replicas: "two"`, is reported without checking the rest of the manifest, which cannot be trusted until it is fixed. Every other command that loads the manifest stops at the first problem and prints only its message.

To see the merged result, with secret values hidden (the manifest only holds secret names), run:

```bash
berthy config show -e prod
berthy config show -e prod --json
```

Defaults are filled in, so the output shows `deploy_timeout: 120s`, `retain: 5` and so on.

To see where each value comes from, add `--origin`. It prints one line per value, with the file and line that set it, or `default` for a value that no file sets:

```bash
berthy config show -e prod --origin
```

```text
apps.api.deploy.drain_timeout: 30s                            berthy.yml:44
apps.api.deploy.retain: 5                                     berthy.yml:46
apps.api.hooks.pre_deploy: [{"backup":"main-db"}]             berthy.prod.yml:17
apps.api.roles.web.replicas: 2                                berthy.prod.yml:9
apps.postgres.deploy.drain_timeout: 30s                       default
```

A list is one value, printed in one line. `--origin --json` prints the same as a list of `{path, value, file, line}` objects, where a default has no `file` and no `line`.

Run `config validate` in CI too. It is the cheapest check there is. It also prints warnings for a manifest that is valid but risky: a role that mounts a read-write volume with `deploy.order: start-first`, or with more than one replica, and an overlay list that drops entries of the base list. Each warning is a `warning:` line with its file and line, and the check still passes.

A role that mounts a read-write volume is updated stop-first by default, so the old version stops before the new one starts. The role is down for the time the new version takes to become healthy, and the deploy plan says so: `role web: stop-first, because it mounts volume uploads`. Set `deploy.order` to override it for the app.

#### Look up a key, and check it in your editor

`berthy docs` prints every manifest key with its type, default and meaning, and `berthy docs backups` prints one section. It needs no agent and no manifest. Section names are listed when you give one that does not exist.

`berthy config schema` prints a JSON Schema (draft-07) of the manifest, and `berthy config schema --overlay` one for an overlay such as `berthy.prod.yml`, where no key is required and every key may be `null` to remove it. An editor with a YAML language server can use it to complete keys and flag a typo:

```bash
berthy config schema > berthy.schema.json
berthy config schema --overlay > berthy.overlay.schema.json
```

Point the editor at the files: with the Red Hat YAML extension for VS Code, put `# yaml-language-server: $schema=berthy.schema.json` on the first line of `berthy.yml`, and the overlay schema on the first line of each overlay. The schema checks the shape of each key. `config validate` is still the check that counts, because it also checks what a schema cannot, such as that a backup names a destination that exists.

#### The finished example

`examples/todo/berthy.prod.yml` is the finished prod overlay: it has everything this guide adds, in one file. Each later step shows the part it adds. If you copy the finished file as it is, set every secret in the next step's table before you deploy.

---

### Step 3. Registry credentials and secrets

A **secret** is a value the agent keeps encrypted. You set it with the CLI, and the manifest refers to it by name. Values are write-only: you can set, list (names only) and remove them, but nothing ever prints a value.

Secrets belong to one environment. `secret` commands need an `admin` token.

#### Set the secrets the first deploy needs

Setup runs this guide at a terminal when it has an admin token. Run `berthy secret set -e prod` at a terminal to generate the declared secrets and enter each remaining value in turn. Enter skips a value; the command exits 1 while anything remains unmet. Add `--manifest-dir DIR` to choose the manifest.

`berthy secret set` takes the value in one of two ways. Typed at a terminal, Berthy asks for the value without showing it, and for some secrets checks it first. Piped, the value is read from standard input, with one trailing newline stripped, and nothing else happens. Type the value yourself; pipe it in CI and scripts. [What Berthy does at a terminal](#what-berthy-does-at-a-terminal) lists each step.

```bash
# The registry token: a GitHub token that can read packages. Note --registry.
berthy secret set GHCR_TOKEN --registry ghcr.io -e prod

# Passwords you make up. They never appear on screen.
openssl rand -hex 24 | berthy secret set POSTGRES_PASSWORD -e prod
openssl rand -hex 24 | berthy secret set REDIS_PASSWORD -e prod
```

Two rules about `--registry`:

- A secret that a manifest's `registries.<host>.password_secret` names **must** be set with `--registry <host>` (`ghcr.io` here) when it is first set. A deploy that finds it set without, or for a different host, refuses to use it. Setting it again later needs no `--registry`: Berthy keeps the registry the stored secret has ([rotating a secret](#rotating-a-secret)).
- A secret listed in an app's `env.secret` **must not** have `--registry`. A secret is one or the other. To turn a registry password into a plain secret, remove it with `berthy secret rm` first, then set it.

Secrets are limited to 64 KiB. For a Compose app, a value cannot contain a line break.

#### Generate a random secret

`berthy secret generate` makes a random secret on the server, so the value never passes through your terminal or a shell:

```bash
berthy secret generate POSTGRES_PASSWORD -e prod
# generated POSTGRES_PASSWORD (32 bytes, hex)
```

The agent makes the value from a cryptographic random source and stores it. It is never printed, logged, or shown in a plan or the audit log, and like every secret it cannot be read back. A deploy gives the app the value.

Declare secrets the manifest may generate under `secrets`, and set `min_version` to the release that ships that key so an older agent is refused before the request:

```yaml
secrets:
  POSTGRES_PASSWORD:
    generate:
      format: hex
  REDIS_PASSWORD:
    generate:
      format: alnum
      bytes: 20
```

Without a name, `berthy secret generate -e ENV` generates every declared secret the agent will accept:

```bash
berthy secret generate -e prod --manifest-dir .
# generated POSTGRES_PASSWORD (32 bytes, hex)
# generated REDIS_PASSWORD (20 characters, alnum)
```

A second run keeps what is already stored (`kept NAME: it is already stored`). Generation runs only for a secret that is not stored and whose apps were never deployed here and whose fixed-name volumes do not already exist; otherwise the line names the app or volume (`not generated NAME: app db was deployed here…`). `--dry-run` prints the same outcomes with `would`. With `--json` the command prints the agent's document (or `{"action":"secret generate declared","secrets":[]}` when nothing is declared), never the sentence.

- `--bytes N` sets the length of a **named** generate, from 16 to 256. The default is 32. A declared secret takes its length from the manifest.
- `--format` sets the characters of a **named** generate. `hex` is the default and is safe inside a URL. `base64` is URL-safe, without padding. `alnum` is letters and digits, and for `alnum` `--bytes` counts characters.
- A secret that is already stored is **refused** by the named form, because replacing a password that is in use breaks the app. Pass `--replace` to replace it on purpose. Then read [rotating a secret](#rotating-a-secret) first: a database keeps its old password until you change it there too.
- An unstored secret is also refused if an app that reads it was deployed here, or if a volume it may use already exists. Set the original value with `secret set`, or use `--replace` on the named form to generate a new one deliberately. From the manifest directory, the command checks its readers and Compose files as well as recorded releases; use `--manifest-dir` to choose that directory.
- A registry password cannot be generated. Set it with `secret set --registry`.
- `--dry-run` shows what would happen. For a named generate, it also says when a real run would be refused without `--replace`.

On a protected environment an AI agent's generate is held for approval, as a `secret set` is. Its plan names the secret and no value.

Check what is stored (names only):

```bash
berthy secret list -e prod
```

Remove one with `berthy secret rm <NAME> -e prod` (`delete` also works). Add `--dry-run` to `secret set NAME` or `secret rm NAME` to see the plan without changing anything. For a registry password, the plan also shows the registry that is kept and the running services that would get the new password ([rotating a secret](#rotating-a-secret)).

#### Set many secrets at once

`berthy secret import` reads `NAME=value` lines from standard input and stores each line as a secret. Berthy has no password-manager integration: anything that prints `NAME=value` lines can feed it, so one command sets twenty secrets as easily as one:

```bash
<a command that prints NAME=value lines> | berthy secret import -e prod
```

Each line is `NAME=value`. The value is everything after the first `=`, so a value may contain `=`. A blank line, and a line that starts with `#`, is skipped.

The import is **all or nothing**. A line without `=`, a name that is not a secret name, a value over 64 KiB, a name that appears twice, or a name the manifest cannot have (`TUNNEL_TOKEN`) stops the whole import before anything is stored. The error names the line, or the secret, and never its value.

Check an import with `--dry-run` first. It prints the names the import would create and the names it would replace, and it never prints a value:

```bash
<a command that prints NAME=value lines> | berthy secret import -e prod --dry-run
# would create: API_KEY, DATABASE_URL
# would replace: REDIS_PASSWORD
```

- A registry password is not imported. A name that is stored as a registry password is refused, so set that one with `berthy secret set NAME --registry HOST`.
- One import is one request of at most 1 MiB. A bigger file is refused before anything is sent: split it into two imports.
- On a protected environment an AI agent's import is held for approval, as a `secret set` is. The plan lists the names and no value.

To see what a deploy will need before you run it, list the secrets the manifest names and mark the ones with no value:

```bash
berthy secret list -e prod --manifest-dir ./deploy/prod
# missing: DATABASE_URL (needed by app api)
```

Each `missing:` line identifies a secret the manifest needs that is absent or stored with the wrong registry association. Registry mismatches name the stored and needed registries. A `conflict:` line names registries that share a password secret, or a registry and plain readers that share a name; give them separate secret names. With `--json` the output is one object, with the stored secrets under `secrets` and the missing ones under `missing`.

#### What Berthy does at a terminal

With no name, `berthy secret set -e prod` first generates declared secrets, then asks for each unmet secret with `Value of NAME (hidden, Enter skips):`. It checks registry passwords and Cloudflare tokens before storing them. A refused value is asked for again; an empty line prints `skipped NAME`. A held request stops the guide. If the agent redacted a required display field of a held secret store, the guide prints the approval ID and expiry with `plan details were redacted`; a held declared generation can still show a plan with masked values. A password stored for the wrong registry is replaced in one set; a registry password needed as a plain secret must first be removed.

When given a name and standard input is a terminal, `berthy secret set` does the steps below in this order. A piped value skips all of them: it makes one request, with no guide, no prompt and no check, and the agent keeps the stored registry.

- **Agent.** First, Berthy asks the agent which secrets it holds. If the agent cannot be reached (`agent connection failed`) or refuses the agent token (for example `agent returned HTTP 401: unauthorized`), the command stops with exit code `1` before the prompt, so you never type a value for nothing.
- **Replaces.** If NAME is already stored, Berthy says so before the guide. For a registry password it prints `NAME is stored as the password for ghcr.io. The new value replaces it.` For any other secret it prints `NAME is already stored. The new value replaces it.` When `--registry` is omitted, Berthy uses the stored registry for the guide and the check.
- **Manifest.** Berthy reads the manifest in the current directory to recognise the secret. `--manifest-dir DIR` reads another directory instead. With no manifest there, it still asks for the value. If `berthy.yml` is there but does not load, Berthy prints `manifest not loaded: <reason>`, still asks for the value, and skips the check, which needs the manifest.
- **Guide.** For `--registry ghcr.io`, Berthy says the secret is the password it uses to pull images from ghcr.io, and prints a link to GitHub's form for a classic token with only `read:packages` selected and the note `berthy-<project>-<env>`. GitHub's container registry accepts only classic tokens, not fine-grained ones. For any other `--registry HOST` it prints one line saying what the secret is, with no link. For the secret that `ingress.cloudflare.api_token_secret` names, it prints a link to Cloudflare's token form with the permissions filled in ([step 7](#step-7-put-it-on-the-internet)).
- **Hidden prompt.** It prints `Value of NAME (hidden):` and reads the value without showing it. Ctrl-C at the prompt cancels the command with exit code `130` and stores nothing. An empty value is refused with `no value entered`.
- **Check.** Before it stores the value, Berthy tries the value against the service, from your machine:
  - A registry password, for a registry the manifest lists under `registries`: for each image app that pulls from that host, Berthy asks the registry whether the credential can read that app's repository. A line such as `checked: ghcr.io lets this credential pull acme/todo-api` says what it found.
  - The Cloudflare token: Berthy checks that Cloudflare accepts it, that it can read tunnels in the account and, when DNS is on, that it sees the zone of each hostname in the manifest. The lines look like `checked: Cloudflare accepts the token, and it can read tunnels in account …` and `checked: the token sees the zone of todo.example.com`. The check only reads, so it cannot prove the edit rights. `ingress apply --dry-run` is still the next test.
  - If the service **refuses** the value, Berthy prints `not stored: <reason>`, exits with status `1` and sends nothing to the agent.
  - If the service **cannot be reached** from this machine (a registry on a private network, or no internet), Berthy prints a `not checked: …` line and stores the value anyway.
  - Other secrets, such as database passwords, are not checked.

Unless it refuses the value, Berthy then stores it on the agent. Everything the prompt prints goes to standard error, so the command's result still goes to standard output. For the GHCR token, the terminal shows this:

```text
$ berthy secret set GHCR_TOKEN --registry ghcr.io -e prod
GHCR_TOKEN is the password Berthy uses to pull images from ghcr.io.
Create a GitHub token (classic) that can only read packages:
  https://github.com/settings/tokens/new?description=berthy-todo-prod&scopes=read%3Apackages
Value of GHCR_TOKEN (hidden):
checked: ghcr.io lets this credential pull acme/todo-api
ok: true
```

On Windows the prompt needs a real console: PowerShell, Windows Terminal or cmd. Git Bash's default window (mintty) does not give standard input a console, so Berthy reads the value as piped input there. Pipe the value in that window instead: `printf '%s' "$VALUE" | berthy secret set NAME -e prod`.

#### Which secret is needed when

| Secret | Named by | Needed when |
| --- | --- | --- |
| `GHCR_TOKEN` | `registries.ghcr.io` | Every deploy of `api`, and **every Compose deploy** in an environment whose manifest lists a registry. |
| `POSTGRES_PASSWORD` | `api` and `postgres` `env.secret` | Deploying `api` and `postgres`. |
| `REDIS_PASSWORD` | `api` and `redis` `env.secret` | Deploying `api` and `redis`. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `destinations.offsite` | A backup runs, including the pre-deploy backup hook ([step 10](#step-10-backups-and-restore)). |
| `CLOUDFLARE_API_TOKEN` | `ingress.cloudflare.api_token_secret` | `ingress apply`, and deploying an app that has `hostnames` ([step 7](#step-7-put-it-on-the-internet)). |
| `TELEGRAM_BOT_TOKEN` | `alerts.telegram.bot_token_secret` | Sending alerts to Telegram ([step 8](#step-8-keep-it-healthy)). |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_HEADERS` | `alerts.webhook.url_secret`, `alerts.webhook.headers_secret` | Sending alerts to a webhook. The headers are optional. |
| `HEARTBEAT_URL` | `alerts.heartbeat.url_secret` | Pinging a dead man's switch service. |
| `OTLP_HEADERS` | `telemetry.headers_secret` | Exporting metrics and operation records to a backend that needs authorization. |

**A deploy stops before changing anything if a secret it lists has no value.** You find out at once, not halfway through a rollout.

The name `TUNNEL_TOKEN` is reserved for managed ingress. You cannot use it for your own secrets.

#### How the values reach the app

- For `api`, Berthy passes plain and secret values as container environment variables, so `POSTGRES_PASSWORD` is an environment variable of the `web` containers.
- For `postgres` and `redis`, Berthy writes them into the project's `.env` file (readable only by the agent). The Compose file reads them as `${POSTGRES_PASSWORD}` and passes them on in `environment:`.
- Secret values are replaced by `[redacted]` in logs the agent returns, in deploy records, in diagnostics and in plans.

#### Rotating a secret

Rotate a secret by running `berthy secret set` again with the new value. At a terminal, Berthy first says that the new value replaces the stored one. What else happens depends on the kind of secret.

Berthy tells you first when a credential is refused or about to expire. `berthy doctor` and a Telegram alert name the check, such as `registry:ghcr.io` or `cloudflare_token`, and the command that replaces the value. The checks and their messages are explained in [step 8](#step-8-keep-it-healthy). After you run `secret set` with a working value, `doctor` shows `accepted` at once, and the recovery alert follows within 10 minutes. The failures below are what happens when a check is missed.

**A registry password.** Replace the token when `berthy doctor` or an alert reports `registry:ghcr.io` as refused. If you miss that, a deploy fails with `image resolution failed` or `image pull failed`, or the service's tasks are rejected, which the restart-loop check of `berthy doctor` reports. Then run the command again. You do not need `--registry`: Berthy keeps `ghcr.io`. The command in the alert names it, which does the same.

```bash
berthy secret set GHCR_TOKEN -e prod
```

At a terminal, the output looks like this:

```text
$ berthy secret set GHCR_TOKEN -e prod
GHCR_TOKEN is stored as the password for ghcr.io. The new value replaces it.
GHCR_TOKEN is the password Berthy uses to pull images from ghcr.io.
Create a GitHub token (classic) that can only read packages:
  https://github.com/settings/tokens/new?description=berthy-todo-prod&scopes=read%3Apackages
Value of GHCR_TOKEN (hidden):
checked: ghcr.io lets this credential pull acme/todo-api
ok: true
todo-prod-api-web: now pulls from ghcr.io with the new password
```

Berthy gives the new password to each running service that pulls from ghcr.io. Swarm keeps its own copy of the pull password with each service, and uses it whenever a server has to pull the image, for example when a second server starts a replica. Berthy updates that copy and restarts nothing: the tasks keep running. A service whose tasks were failing to pull with the old password recovers by itself within seconds. Compose apps are not touched. Nothing runs with their copy of the password, so they get the new one at their next deploy.

The service lines say:

- `NAME: now pulls from ghcr.io with the new password`: the service has the new password.
- `NAME: not updated (REASON)`: the service still has the old one. The reason is `service update failed`, `bound service unavailable` or `registry credential unavailable`.
- `services not updated: REASON`: the agent could not look at the services at all.
- `no running service pulls from ghcr.io yet`: nothing is deployed from that registry yet, so there is nothing to update.

When a service is not updated, or the services could not be looked at, the last line reads `Run the command again to retry the services that were not updated.` The secret is stored in every case, and the command exits with `0`. Running the command again is safe. With `--json`, the command prints the agent's answer instead, such as `{"ok":true,"registry":"ghcr.io","services":[{"name":"todo-prod-api-web","updated":true}]}`.

**The Cloudflare API token.** Set the new token under the same name:

```bash
berthy secret set CLOUDFLARE_API_TOKEN -e prod
```

Nothing else needs to change. The agent reads the token from its store on every Cloudflare call and keeps no copy, so `ingress apply`, a deploy of an app with `hostnames`, `ingress status` and the tunnel health check use the new token from their next call. At a terminal, Berthy checks the new token with Cloudflare before it stores it. A token that Cloudflare refuses is not stored: `not stored: Cloudflare does not accept this token: it is wrong, expired or disabled`. If Cloudflare cannot be reached from your machine, Berthy prints a `not checked: …` line and stores the token anyway. Replace the token when `berthy doctor` or an alert reports `cloudflare_token` as refused, or as about to expire. If you miss that, `ingress apply` or a deploy of an app with `hostnames` fails with `Cloudflare token check failed`, or `ingress status` shows Cloudflare as `unavailable`.

The running connector is not affected. It runs with the tunnel's own token (`TUNNEL_TOKEN`), not the API token. To replace the tunnel's token, rotate it in Cloudflare's dashboard, then run `berthy ingress apply` to pick up the new one.

**An app secret, such as `POSTGRES_PASSWORD`.** Set the new value with `berthy secret set`, then redeploy the apps that use it so they pick it up. For `POSTGRES_PASSWORD` that is not enough: the database keeps its old password. You must change it in the database too, with `berthy exec` into the Compose service:

```bash
berthy secret set POSTGRES_PASSWORD -e prod
berthy exec postgres -e prod --service postgres -- psql -U todo -d todo -c "ALTER USER todo PASSWORD '<new password>'"
berthy deploy api -e prod --version <version>
```

Set the secret, change the password, then redeploy `api`, in a quiet moment: from the `ALTER USER` until `api` is redeployed, `api` cannot connect to the database.

---
### Step 4. The first deploy

Deploy in this order: **redis, postgres, then the API.** The API reads from both, and its migrations need the database to exist. (The API's `depends_on` says the same, and [one command](#all-the-apps-in-one-command) can deploy all three.)

Every deploy starts the same way: look at the plan first.

```bash
berthy deploy redis -e prod --dry-run
```

`--dry-run` prints the plan and acts on nothing. Many commands that change something accept it (the [reference](#commands) lists which). For a Compose app the plan lists the Compose project (`todo-prod-redis`), each service with its action (`create`, `keep`, `recreate` or `remove`) and each volume with `create` or `keep`.

Then run it for real:

```bash
berthy deploy redis    -e prod
berthy deploy postgres -e prod
```

A Compose app takes **no** `--version`: the version is whatever its Compose file says. (`berthy deploy redis --version 7` is refused with `--version does not apply to a compose app`.)

The CLI reads the Compose file from `--manifest-dir` (default: the current directory), sends it with the deploy, and follows the operation until it ends. On an interactive terminal a delayed spinner covers the wait. Redirected output keeps the plain event names, then the operation's record:

```text
app: redis
commit:
id: <operation id>
kind: deploy
started: 2026-11-16T10:21:07Z
state: succeeded
```

`--json` prints that record as one object. Exit code `0` means `succeeded`. Anything else (`failed`, `rolled_back`, `recovery_required`, `interrupted`) exits `1`. Ctrl+C stops only the local follower. The admitted operation may continue. The CLI prints the operation id with human-readable `diagnostics` and `cancel` scope for that environment.

#### What a Compose deploy does

1. Takes the environment's deploy lock and checks the manifest.
2. Works out which services would be recreated and which volumes created, and prints that plan.
3. **Stops if a `stateful` service would be recreated**, unless the command carries `--allow-recreate` (and an `admin` token). A first deploy creates things, so it needs neither.
4. Writes the Compose file and the `.env` file, then runs `docker compose up -d --remove-orphans`.
5. Waits until every container runs (and is healthy when it has a health check) or has exited with code 0, which is a finished one-shot, then records the release and releases the lock.

A container that exits with any other code, or turns unhealthy, fails the deploy at once and the message names the service, for example `service job exited with code 3` or `service web is unhealthy`. `deploy_timeout` bounds the wait: a service that is not ready by then fails the deploy with `service web not ready after 120s`. So a Compose file can have a one-shot service, such as a migration or a seed, that runs and exits. Berthy reads the containers twice, half a second apart, before it calls the project ready, so a one-shot that fails a moment after it starts is caught. A standalone one-shot that is still running when everything else is ready does not hold the deploy. To make the deploy wait for it to finish, make a service depend on it with `condition: service_completed_successfully`, which Compose waits for during `up`.

A failed `up` is reported. There is no automatic rollback for Compose apps: the next deploy brings the project to its file again.

#### The API: a digest, not a tag

The prod overlay says `protected: true`. The agent admits only a digest for that environment. A tag never reaches admission, even a unique one such as a git SHA, because a tag can move.

**At a terminal, with a human admin token,** list the tags the registry knows, then deploy one. The project still comes from `--project`, else `berthy.yml` in the directory you run from, else the only project that has that environment. The CLI captures checkout identity before it reads deploy files. That capture compares the frozen identity, not a later working-tree status. A revision or worktree change during the capture is refused before any registry lookup or mutation. It freezes the checkout and Compose attribution, then asks the agent to resolve each protected mutable tag once, shows the destination, the tag, the full repository-qualified digest and the plan, and asks you to confirm. The default answer is no. Cancel, blank, EOF or interrupt admit nothing.

```bash
berthy versions api -e prod
berthy deploy api -e prod --version 1.4.2 --dry-run
berthy deploy api -e prod --version 1.4.2
```

`versions` prints one tag per line. Add `--json` for one document with `repository` and `tags`. A denied lookup asks for a human admin token. The CLI never falls back to local Docker credentials. For a private registry the agent also needs the named password secret bound with `--registry` to that image host. Listing and resolution share one registry trust policy. They talk to the registry over HTTPS, or loopback HTTP, with no redirects. A Bearer realm must match that exact origin, except Docker Hub's documented `https://auth.docker.io/token` for the standard Hub hostnames. Resolution uses a manifest HEAD, accepts the usual OCI and Docker manifest and index types, and needs one canonical `sha256:` digest. That scoped lookup does not hand credentials to Docker. Ordinary pulls stay on the deploy path.

`--dry-run` and `--dry-run --json` return the pinned preview and admit nothing. The preview may already have called the agent for a plan. `--json` alone, a redirected preview or piped consent cannot authorize admission. After you confirm, moving the tag leaves the plan, the admitted request, Swarm and the applied release on the digest you saw.

**In CI and scripts,** give the digest yourself. Get it from the build step (`docker/build-push-action` outputs it as `digest`), or look it up:

```bash
docker buildx imagetools inspect ghcr.io/acme/todo-api:1.4.2
berthy deploy api -e prod --dry-run \
  --version sha256:<64 hex characters>
```

Send a raw tag to the protected agent without that resolution and you still see:

```text
protected environment requires a digest
```

An **agent token** on a protected environment still submits a digest. A held request keeps that digest for approval. Tools and the raw deploy API take the same shape.

In **dev**, which is not protected, `--version 1.4.2` (a tag) works without confirmation or a new lookup when the capable agent reports the environment unprotected. A new CLI can still deploy an ordinary tag to a working v0.5.0 agent that way. A protected old agent stops before mutation and points at an upgrade or an explicit digest. An old CLI can still send a digest or a dev tag to a new agent. `--version` also accepts a full reference such as `ghcr.io/acme/todo-api:1.4.2` as long as the repository matches the app's `image`. An image app without `--version` is refused with `deploy requires --version`.

The same digest with a different label can change `BERTHY_VERSION` in the task spec. The image and `BERTHY_IMAGE_DIGEST` stay the digest. The plan shows that difference.

The dry run says what the deploy changes compared with the release the app runs now:

```text
api
  image    sha256:41ab1c2d3e4f… -> sha256:9f2c0d1e2f3a…   (v1.4.2 -> v1.4.3)
  web      replicas 2 -> 3
  web      health.start_period 30s -> 60s
  env      + FEATURE_X (plain)
  env      - LEGACY_MODE (plain)
  env      ~ DATABASE_URL now from secret API_DATABASE_URL
  hooks    + pre_deploy: backup main-db
  ingress  + api.example.com
```

Each line is one difference. What is compared is the image (digest and tag), each role's settings, the names of the variables and where each value comes from, the hooks, the migrations, the hostnames, and the app's jobs, backups and service probes. A first deploy says `new app`. A deploy that changes nothing says `no changes: the same release would be recorded`. A Compose app also lists the services the deploy would `create`, `recreate` or `remove`.

**A secret value is never in it.** A plain variable shows by name, and its value only when it changes. A variable from a secret shows by its name and the name of its secret. A template variable shows by name and its template text, which holds secret names and no value. A change of the value stored under a secret name is not a difference of the manifest, so the diff does not show it.

`berthy rollback <app> --dry-run` shows the same lines for the release that runs now and the one it returns to. An `--adopt` dry run keeps its own list of differences.

The dry run for an image app prints the plan as JSON when you add `--json`. The diff is its `diff` key, as a list of `{"area", "change"}` entries:

```json
{
  "app": "api",
  "diff": {
    "changes": [
      {
        "area": "image",
        "change": "sha256:41ab1c2d3e4f… -> sha256:9f2c0d1e2f3a…   (v1.4.2 -> v1.4.3)"
      }
    ]
  },
  "image": "ghcr.io/acme/todo-api@sha256:<64 hex characters>",
  "roles": [
    "web"
  ]
}
```

The plan shows the image **pinned by digest**. A CI or scripted deploy names that digest with the commit:

```bash
berthy deploy api -e prod \
  --version sha256:<64 hex characters> \
  --commit "$(git rev-parse HEAD)"
```

`--commit` is recorded with the release. It shows in `history`, and it is how you find which code a release was. Without `--commit`, the CLI records `HEAD` of the manifest directory's git checkout, so a deploy from a clean checkout needs no flag. A `--commit` that is not `HEAD` is kept, with a warning.

**Local changes.** When the manifest directory is inside a git work tree, the CLI asks git whether `berthy.yml`, the overlay for the environment (`berthy.prod.yml`) and the app's Compose file are modified, staged, deleted or untracked. Files that git ignores do not count. If one of them has changes, the CLI prints a warning that names it:

```text
warning: the manifest has local changes: berthy.prod.yml
```

The release is recorded as not clean, and `history` shows it next to the commit: `commit: <sha> (modified)`. A **protected** environment refuses such a deploy before anything is sent, and names the files: `the manifest has local changes: commit them first: berthy.prod.yml`. Commit the files and deploy again. Outside a git work tree, and where git is not installed, nothing changes.

#### All the apps in one command

Deploying app by app shows what each deploy does. Once the project is set up, one command deploys every app of the manifest, in the order `depends_on` gives: an app after the apps it depends on, and among the apps that are ready, the first by name. Here that is `postgres`, `redis`, then `api`. The todo manifest has one image app, so a plain `--version` names its version. Checkout identity is captured first. That capture compares the frozen identity, not a later working-tree status. A revision or worktree change during the capture is refused before resolution or mutation. Compose files are frozen with it. Only protected mutable tags are resolved. For an interactive protected selection, including `--dry-run`, every plan is fetched and checked before admission, then one default-no confirmation covers the batch. A plain or digest batch still submits in dependency order after local and kept-version preflight.

```bash
berthy deploy -e prod --version 1.4.2 --dry-run
berthy deploy -e prod --version sha256:<64 hex characters> --dry-run
berthy deploy -e prod --version sha256:<64 hex characters> \
  --commit "$(git rev-parse HEAD)"
```

Each app is deployed exactly as `berthy deploy <app>` would, and the output has a header before each one and a summary at the end:

```text
==> deploy postgres
...
==> deploy redis
...
==> deploy api (sha256:<64 hex characters>)
...
postgres  succeeded
redis  succeeded
api  succeeded
```

- **Everything is prepared first.** The CLI captures checkout identity, freezes the manifest and Compose bytes, and refuses a switched checkout before any registry lookup. That capture compares the frozen identity, not a later working-tree status. Protected mutable tags are resolved next. An interactive protected selection, including `--dry-run`, fetches and checks every plan before admission. A plain or digest batch submits in dependency order after local and kept-version preflight. A missing Compose file or a bad version for the last app leaves the first apps undeployed.
- **It stops at the first failure.** The command exits with that app's code, prints `deploy stopped at <app>; not run: <the apps after it>` and runs nothing more. With `--dry-run` it plans every app, goes on past a plan that fails, and exits `1` if any failed.
- **Versions.** A plain `--version` is for a manifest with exactly one image app. With several, name each one: `--version api=sha256:...`, once for each app. A plain version together with `app=version`, an `app=` that names an unknown app or a Compose app, and a repeated app are refused with exit `2` before anything is sent.
- **An image app given no version keeps the one it runs now.** Berthy deploys the digest of its last release, and the tag it was deployed with, and applies the new manifest, migrations and hooks as in any deploy. This is how a change to the manifest alone reaches every app. An app that was never deployed has no version to keep: the command refuses it with `image app api is not deployed yet: give --version api=REF` and exit `2`, before anything is deployed. A first deploy names a version for every image app. The command reads each version before it deploys anything. On a plain or digest-only batch it sends that reading along as a keep, so a digest that changed since it was read is refused with `app api changed since its version was read: it runs sha256:… now, not sha256:…; deploy it again`, and that app is not deployed. On an interactive protected batch that also names a tag, a kept image is pinned to the release id, digest and tag already read. A change of that release id, including only the tag while the digest stays the same, conflicts at that app's preview or admission. Earlier apps in the batch may already have run.
- **Flags that need an app** (`--adopt`, `--replace-existing`, `--allow-recreate`, `--request-id`) are refused with exit `2`.
- **`--json`** prints one document, `{"apps": [...]}`, with an entry for each app in order: its `app`, its `exit` code and its `result`, which is what `berthy deploy <app> --json` prints. An app that did not run has `"state": "not_run"`.

`depends_on` is a manifest key like the others: an agent that does not know it refuses the manifest. Upgrade the agent with `berthy setup` before you deploy a manifest that uses it. Set `min_version` in the manifest too, to the release that added the key, so that an old agent is named instead of refusing the manifest with `invalid request` (see [the top of `berthy.yml`](#the-top-of-berthyyml)).

#### What an image deploy does

A deploy either finishes healthy or leaves the previous version running. It never leaves an app half-updated.

1. **Lock.** Takes the deploy lock. If someone holds it, the deploy stops and says who and why.
2. **Check.** Validates the manifest. Confirms every secret has a value. Pulls the image by digest. On a protected path the request already carries a digest. On an unprotected path the agent may still resolve a tag here.
3. **Pre-deploy hooks.** Runs them in order. A failure stops the deploy with nothing changed.
4. **Migrations.** Runs `version`, then `apply`, then `version` again (see step 6).
5. **Start new.** Starts the new version *beside* the old one, or after the old one has stopped for a role that mounts a read-write volume, so two versions never write the volume at once. It must pass its health check within `deploy_timeout`. Failures during the check's `start_period` do not count. If the new version's tasks fail to start `start_attempts` times (3 by default), Berthy gives up at once instead of waiting out the timeout.
6. **Switch and drain.** Sends traffic to the new version. The old one gets a stop signal and `drain_timeout` to finish requests in flight.
7. **Publish.** With managed ingress, updates the app's routes and DNS records. A failure here is reported and the command exits non-zero, but the new version stays running.
8. **Post-deploy hooks.** Runs them in order. A failure is reported, but does not undo the deploy.
9. **Reachability.** For each role with a `port`, checks that the port answers on the shared network, and for each of its `hostnames` that the hostname answers from outside. A check that fails only warns. See "Reachability checks" below.
10. **Record and tidy.** Writes the release, removes old images beyond `retain`, releases the lock.

If step 5 fails, the agent **rolls back to the previous digest**, records the deploy as failed, and sends an alert. A failed *first* deploy has nothing to roll back to, so the service it created is removed.

Swarm's service defaults for an image app:

| Setting | Value |
| --- | --- |
| Update order | Start the new version first, one task at a time |
| Restart policy | Restart on any exit, after 5 seconds, without limit |
| Placement | No constraints |
| Resource limits | None unless set on the role |
| Stop grace period | `drain_timeout` (30 seconds) |

Thirty seconds lets a web framework finish its requests. Docker alone would stop the container after ten. The start-attempts limit applies only to a rollout: once a version serves, Swarm keeps restarting a crashing task without limit, so a service that dies at 3 a.m. comes back by itself.

#### Reachability checks

A role's health check runs inside its container, usually against `localhost`. It can pass while nothing else can reach the role: the app listens on `127.0.0.1` only, the `port` in the manifest is not the port the app listens on, or the public hostname does not lead to the app. So once the new version serves, the deploy makes two more checks. Both only warn. The new version is already running, so neither can fail the deploy or change its result.

- **On the shared network.** For each role with a `port`, the overlay helper opens a TCP connection to `<service>:<port>`. If it answers, the deploy prints `role web: port 8080 answers on the network`. If not, it prints `role web: healthy, but port 8080 does not answer on the network; is the app listening on 127.0.0.1?`. If the helper cannot run (the agent is not a static Linux binary, or Docker does not answer), the line says the port could not be checked. A role scaled to zero is not checked.
- **From outside.** For each hostname of a role that managed ingress published, the agent makes one HTTPS request to `https://<hostname>/`, with up to four tries about five seconds apart while DNS and the route settle. A status below 500 counts as an answer, and the deploy prints it: `role web: https://app.example.com answers with status 200 from outside`. If the last try got a 5xx status or nothing at all, it prints a warning that says so.

The lines are events of the operation. `berthy deploy` and `berthy rollback` print them as they arrive, `--json` carries them as `checks` in its one document, the terminal UI shows them, and the MCP `execute_resource_command` result lists them as `checks`. The overlay helper that the network check starts stays for five minutes after the last check, and longer while a service probe needs it.

To turn both checks off for an app, set `deploy.verify: false`.

#### Flags of `deploy`

| Flag | Meaning |
| --- | --- |
| `--version <ref>` | Image apps only. A tag, a digest (`sha256:...`) or a full reference. Required for image apps, refused for Compose apps. On a protected environment a human admin may give a tag. After checkout is frozen the CLI resolves that protected mutable tag before admission. Without an app, `--version <app>=<ref>` for each image app (repeatable), or a plain `<ref>` when the manifest has one image app. |
| `--commit <sha>` | The commit the manifest and the image come from. Recorded with the release. Default: `HEAD` of the manifest directory's git checkout, when there is one. |
| `--manifest-dir <dir>` | Where `berthy.yml`, the overlay and the Compose files are. Default `.`. |
| `--dry-run` | Print the plan. Change nothing. |
| `--allow-recreate` | Allow a `stateful` Compose app's services to be recreated. Needs an `admin` token. |
| `--adopt` | Take over a service or Compose project that already runs, instead of creating one. Needs an `admin` token. |
| `--replace-existing` | With managed ingress, take over a route or DNS record that Berthy did not create. Needs an `admin` token. |
| `--request-id <id>` | A retry key. The CLI makes a random one; pass the same one to retry the same request safely. |
| `--json` | Print JSON. |

#### Adopting an app that already runs

If a server already runs an app another tool deployed, Berthy can take it over without recreating it. Name the Swarm service in the role (`service: <existing name>`), or for Compose set `project_name` to the name it already runs under. Then run `berthy deploy <app> --adopt --dry-run`. Berthy compares what runs with the manifest and prints the differences or a refusal before it changes anything. Adopt the least critical environment first.

An image service whose existing named volume differs from the manifest's scoped Docker name is refused: `adoption would change volume <name>; align the manifest first`. For a mount `data:/data`, the scoped name is `<project>-<environment>_data`. Stop writes, back up the old volume with your existing backup tool, restore it into a new volume with the scoped name, and verify the data before deploying. To adopt the existing service, switch it to the scoped volume and confirm it is healthy first; alternatively, stop the old service and deploy a new one without the `service` override.

For a Swarm service, the first deploy replaces the service's settings with the ones the manifest describes. A setting the service has and the manifest does not produce, such as a user, an entrypoint, a hostname, a working directory or a placement constraint, is dropped, and the plan says so on one line each:

```
role web: user "1000" is not in the manifest; the first deploy drops it (set roles.web.user to keep it)
role web: hostname "handmade" is not in the manifest; the first deploy drops it
role web: env LEGACY_FLAG is not in the manifest; the first deploy drops it
```

Read these lines before you deploy. To keep a setting, put it in the manifest (`user` and `entrypoint` are role keys). Environment variables are listed by name, never by value. The same is true of every later deploy: a change made by hand to a running service, such as `docker service update --user`, does not survive the next deploy. A service with added capabilities, privileges, a host mount, a published port or another network is refused.

The spec's [adoption checklist](spec-v1.md#adopting-an-existing-deployment) lists the steps.

#### If the deploy fails

Read [Step 6](#step-6-ship-a-new-version-of-the-api): `history` and `diagnostics` tell you why. The usual first-deploy causes are a missing secret (`workload secret unavailable`), a wrong registry credential (`registry credential unavailable for image host`), a missing shared network (`overlay network unavailable`), and a health check command that is not in the image.

---

### Step 5. Look at it

All of these are read-only, and work with a `read` token.

```bash
berthy ps       -e prod
berthy describe api -e prod
```

`ps` lists every app: its kind, roles, desired and running replicas, health and the running image, plus how old each backup is. `describe <app>` shows one app in full: roles, tasks, the last deploys, the last job results, and what differs from the applied release, as the `drift` and `scaled` lines (see **Drift** in step 8). When a name is ambiguous (a Swarm service and a Compose project with the same name), write `image:api`, `swarm:api` or `compose:api`.

The text output is `key: value` lines. Add `--json` for JSON that scripts and AI agents can parse. It is the same for every command.

#### Logs

```bash
berthy logs api -e prod --follow
berthy logs api -e prod --since 10m --grep 'ERROR|panic' --role web --tail 500
```

Each line is the time in UTC, the source and the message. The source is the role and the first 12 characters of the container's id, the ones `docker ps` shows, so you can tell replicas apart. A line from stderr is marked `[stderr]`:

```text
2026-11-17T02:07:50Z web.f77449eeec32 GET /version 200
2026-11-17T02:07:51Z web.f77449eeec32 [stderr] panic: something
```

`--json` prints the records as JSON instead.

| Flag | Meaning |
| --- | --- |
| `--follow`, `-f` | Keep streaming new lines until you press Ctrl-C. |
| `--tail <n>` | Last `n` lines first. Default 100, at most 1000. |
| `--since <when>` | A duration (`10m`, `2h`) or an RFC 3339 time. |
| `--grep <regex>` | Only lines that match this regular expression. |
| `--role <name>` | Only one role of an image app. |
| `--replica <id>` | Only one replica. Use the task id or the container id that `ps` or `describe` shows, or a prefix of at least 6 characters of either, such as the 12 characters a log line shows. A prefix that matches more than one replica is refused: give more characters. |

Berthy reads logs straight from Docker and stores none. Anything that looks like a managed secret value is shown as `[redacted]`. For history and search, send logs to a log backend from your apps.

#### Server and Docker numbers

```bash
berthy stats -e prod            # one sample
berthy stats -e prod --watch    # a live stream, Ctrl-C to stop
berthy stats -e prod --since 5m # the last 5 minutes (at most 1h)
berthy df    -e prod
```

`stats` shows CPU, memory, swap, load, network and disk I/O for the server, and CPU, memory against limit, block and network I/O and restarts for each container. The agent samples every 10 seconds and keeps the last hour in memory. `df` shows disk space per mount and what Docker's images, containers, volumes and build cache use.

#### History

```bash
berthy history api -e prod
```

`history` lists the app's releases newest first. Each row has an `id` (the release id you can roll back to), the digest, the commit and the time. A release deployed with `--version v1.0.2` also shows its `tag` (`tag: v1.0.2`), so you can tell which version it is without matching digests. A deploy by digest has no `tag` line, and a rollback shows the tag of the release it returns to. **Failed** deploys appear too, with their `operation_id`, `state` and a one-line `reason` such as `role web: container never became healthy (last check: exit 1)`. A release or a failed deploy from a checkout with local changes shows `(modified)` after its commit.

To see what a release changed, compare it with another:

```bash
berthy history api -e prod --diff <release id>
berthy history api -e prod --diff <release id> <other release id>
```

The first form compares the release with the one before it, and the first release of an app is `new app`. The second compares it with the other one, whichever is older. The answer is the same lines a dry run prints: what the first release changes compared with the second. Both ids must be releases of the app, from the `id` column of `history`. A secret value is never in it. `--json` prints `{"changes": [{"area", "change"}]}`.

#### Wait for health

```bash
berthy wait api --healthy -e prod --timeout 5m
```

It blocks until the app (or one `--role`) is healthy, or the timeout passes. The default is 2 minutes, the most is 10. Exit `0` means healthy. A role scaled to 0 has nothing to wait for, so it counts as ready at once. CI uses it after a restart or a scale.

#### Who did what

```bash
berthy audit -e prod
```

`audit` prints the last 100 entries: time, who (the token's name and the caller's address), the action, and the outcome. Scheduled jobs and backups appear with themselves as the caller (`job:cleanup`, `backup:main-db`).

#### Other reads

| Command | Shows |
| --- | --- |
| `berthy checks` | The stored state of every probe and built-in condition, and since when. |
| `berthy jobs` | Every scheduled or on-demand job and its last run. |
| `berthy lock status` | Whether the deploy lock is held, by whom and why. |
| `berthy backup list` | The backups in object storage. |
| `berthy ingress status` | The tunnel, its connectors, hostnames and DNS records. |
| `berthy approvals` | Changes waiting for a person. |
| `berthy agent-info` | Environment, host, protected flag and version. |
| `berthy doctor` | The agent's own health checks. |

---

### Step 6. Ship a new version of the API

This is the daily loop. CI builds the image, pushes it, and deploys a digest. At a terminal a human admin can list tags, deploy one with confirmation, or promote what another environment already runs.

```bash
berthy versions api -e prod
berthy deploy api -e prod --version 1.4.3
berthy promote api --from dev -e prod
```

`promote` reads the same project's applied source release with the source token. That applied pointer can name a verified release even when a later source operation ended differently. It shows the release id and full digest, captures destination checkout identity the same way a protected tag deploy does, and after confirmation submits an ordinary destination deploy of that snapshot. Admission matches the destination's applied release id observed at preview. Each environment keeps its own URL, token and store. A later move of the source tag cannot retarget it. An incompatible repository, a Compose app, a missing source, an equal destination digest or a stale destination preview admits nothing. `--dry-run` and `--dry-run --json` preview without admission. Scripts can take the image from that JSON and deploy the digest under normal CI semantics.

#### A token for CI

CI needs a `deploy` token for `prod`. It can deploy, roll back and restart, but it cannot touch secrets, run `exec` or `run`, restore backups or approve anything.

Make it from your laptop, with your `admin` token. There is no shell on the server and no restart:

```bash
berthy token create ci -e prod --scope deploy --expires 90d
```

```text
token ci (deploy, expires 2027-02-16), shown once, store it now: bty.<project>.prod.<64 hex characters>
```

- The token is the secret. It is printed once. Put it in your CI's secret store. The agent keeps only its digest, in its state, so a [state snapshot](#step-15-rebuild-a-server) carries it too.
- The token works at once. A token that is revoked or has expired is refused at its next request.
- `NAME` is a label shown in the audit log and in the list (letters, digits, `.`, `-`, `_`). It is unique in the environment.
- `--scope` is `read`, `deploy` or `admin` (default `read`). `--agent` marks an AI agent's token (step 11).
- `--expires` is optional: `90d` (days), `36h` (any Go duration) or a date such as `2027-02-16`, which is the start of that day in UTC. Without it the token never expires. A check named `token:<name>` warns 14 days before the expiry, so you can make a new token first. `--dry-run` shows what would be made and makes nothing. With `--json` the answer holds the token in its `token` field, for a script to read.

See who has access, and revoke a token you no longer want:

```bash
berthy token list -e prod
berthy token revoke ci -e prod
```

```text
NAME    SCOPE   AGENT  ORIGIN  CREATED     EXPIRES     LAST USED
admin   admin   no     config  -           never       2m ago
ci      deploy  no     api     2026-11-18  2027-02-16  1h ago
```

`ORIGIN` says where the token is defined. `api` tokens are the ones `berthy token create` made. `config` tokens are in `/etc/berthy/agent.json`: the first `admin` token that setup wrote. A `config` token cannot be revoked through the API; the agent says which file to edit. `LAST USED` is kept to the minute.

Rules that keep access safe:

- `create` and `revoke` need an `admin` token that is **not** an agent token. An agent token is refused at once, on any environment, and its request is never held for approval. `list` needs `admin`; an agent's admin token may list.
- Revoking the last `admin` token is refused. If every admin token is lost, `berthy setup --new-token` is the way back.
- The audit log records `token_create:<name>` and `token_revoke:<name>` with the name of the token that asked.

`berthy agent token` still exists. It makes a token offline and prints the object for the `tokens` list of `agent.json`, for a token you want written there by hand.

#### The CI script

`examples/ci/deploy.sh` is the deploy step. It checks that `IMAGE_DIGEST` is a `sha256:` digest, validates the manifest, and deploys:

```sh
commit=$(git rev-parse --verify HEAD)
"$BERTHY_BIN" config validate -e "$BERTHY_ENV" --manifest-dir "$PWD"
"$BERTHY_BIN" deploy "$APP" -e "$BERTHY_ENV" --config "$BERTHY_CONFIG" \
  --manifest-dir "$PWD" --version "$IMAGE_DIGEST" --commit "$commit"
```

A clean CI checkout needs no `--commit`: without one, the deploy records `HEAD` of the checkout, which the script passes anyway. If the checkout has local changes to the manifest or the app's Compose file (a generated file, say), the release is recorded as modified, and a protected environment refuses the deploy.

Its inputs are environment variables: `BERTHY_ENV` (`prod`), `BERTHY_CONFIG` (a CLI configuration file), `IMAGE_DIGEST`, `BERTHY_TOKEN`, and optionally `APP` (default `api`) and `BERTHY_BIN`. The script still passes `-e "$BERTHY_ENV"`; the CLI now reads the same variable when `-e` is omitted, so a shell that exports `BERTHY_ENV` can drop the flag. The CLI configuration in CI names the variable that holds the token:

```json
{ "projects": { "todo": { "environments": { "prod": { "url": "http://10.0.0.5:7710", "token_env": "BERTHY_TOKEN" } } } } }
```

The command waits for the result and exits non-zero if the deploy fails or rolls back. Steps after it, such as tagging a release, run only after a deploy that succeeded.

The agent is on a private network and a CI runner usually is not. The deploy job has to join the private network for its length, for example as a short-lived tagged node (with Tailscale, its official GitHub Action does this). Give that node access to the agent's port and nothing else, with a separate network credential per environment. The Berthy token is still required: reaching the agent grants nothing by itself. In outline:

```yaml
# .github/workflows/deploy.yml (an outline, not run here)
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # 1. Build and push ghcr.io/acme/todo-api; keep the digest it prints.
      # 2. Join the private network (for example with the Tailscale GitHub Action).
      # 3. Install the berthy binary on the runner.
      - run: sh examples/ci/deploy.sh
        env:
          BERTHY_ENV: prod
          BERTHY_CONFIG: ci-config.json
          IMAGE_DIGEST: ${{ steps.build.outputs.digest }}
          BERTHY_TOKEN: ${{ secrets.BERTHY_PROD_DEPLOY_TOKEN }}
```

CI deploys **only the API**, on every push. The database and the cache change rarely, and you deploy them by hand (step 13).

#### Migrations

Migrations run as their own deploy step, **not** when your app starts. An app that migrates at startup can leave the schema ahead of the running code after a failed deploy, with no defined way back.

One rule makes a failed deploy safe: **every migration must work with the previous version of the app.** A rolling deploy already runs old and new versions against the same database for a moment, so this is needed anyway. Then a failed deploy needs no schema rollback: the old version keeps running on the new schema. Add columns and tables in one release, and remove or rename them in a later one.

Berthy does not know your migration tool. You give it three commands, which run in one-off containers of the image, with the app's environment:

| Command | What it does | Runs from |
| --- | --- | --- |
| `version` | Prints one line that identifies the schema state, such as the last migration's name. Berthy stores it and never interprets it. | the new image |
| `apply` | Brings the schema to the latest state the image knows. | the new image |
| `revert` | Brings the schema back to the state passed as `{target}`. Optional. | the image you roll back **from** |

During a deploy: the pre-deploy hooks run, then `version` (the state before), then `apply`, then `version` (the state after). If `apply` fails, the deploy stops and the old version keeps running. If `apply` works but the new version fails its health check, the image rolls back and the schema stays where it is. `timeout` (default `5m`) limits each command. `retries` re-runs a failed `apply` only. Retry only a migration that is safe to run again.

To undo a schema on purpose, with an `admin` token:

```bash
berthy rollback api -e prod --revert-schema
```

It runs `revert` with `{target}` set to the state recorded before the failed deploy. It is never automatic, because reverting a migration can delete data.

#### Hooks

`run` hooks are one-off commands in a container of the new image with the app's environment. `backup` hooks run a named volume backup and wait. In the todo app:

- The prod overlay has `pre_deploy: - backup: main-db`: a fresh database dump is taken and uploaded before every API deploy. If it fails, the deploy stops before the migrations, and the old version keeps serving. (A backup whose app has no release yet, as on a first deploy, is skipped.)
- The base manifest has a `post_deploy` `run` hook that warms the cache, with `timeout: 2m` and `retries: 2`. A failure there is reported but does not undo the deploy.

`backup:` steps take neither `timeout` nor `retries`.

#### The deploy lock

A deploy takes the environment's lock automatically. You can also take it by hand to freeze deploys, for example during a database maintenance window:

```bash
berthy lock acquire -m "postgres maintenance until 14:00" -e prod
berthy lock status -e prod
berthy lock release -e prod
```

`acquire` needs `-m` (a message). While the lock is held, every deploy, from CI or an AI agent, is refused with the holder and the message. `lock status` is a read; `acquire` and `release` need a `deploy` token.

If the agent crashes in the middle of an operation, the lock stays and the operation goes to `recovery_required`. The agent tries to finish it by itself at start. If it cannot, look first, then resolve it:

```bash
berthy recovery resolve <operation id> -m "checked: nothing half-done" --dry-run -e prod
berthy recovery resolve <operation id> -m "checked: nothing half-done" -e prod
```

`recovery resolve` needs an `admin` token. It ends the operation as failed and releases the lock; `--dry-run` shows the journaled steps first.

#### Cancel a running operation

A deploy with a slow pre-deploy command, or a new version that will never become healthy, holds the lock until its own time limit. `cancel` stops it sooner, while it can still be undone cleanly:

```bash
berthy cancel <operation id> -e prod --dry-run
berthy cancel <operation id> -e prod
```

The operation id of the one that holds the lock is in `berthy lock status`. `cancel` needs a `deploy` token. It waits until the operation has ended, and prints how: `operation <id> ended: rolled_back (cancelled by ci)`. `--dry-run` says whether the cancel would be accepted, and if not why, and changes nothing.

| Where a deploy is | What a cancel does |
| --- | --- |
| Checking, pulling the image | Stops. Nothing was changed. The deploy ends `failed`. |
| Running a pre-deploy command | Stops the command's container, then stops. The deploy ends `failed`. |
| Running a migration | Refused: `a migration is running`. The schema may be half changed. Try again when the migration is over. |
| Waiting for the new version to become healthy | Puts the previous version back, as a failed rollout does. The deploy ends `rolled_back`. A migration that already ran stays applied. |
| After traffic switched (publishing routes, post-deploy commands) | Refused: `the deploy already switched traffic`. The deploy is done in every way that matters. |

Every operation has one **point of no return**. Before it, a cancel wins; after it, the cancel is refused with the reason, and nothing changes. Berthy records the point with the operation, so the answer never depends on timing: if a cancel and the point meet, one of them comes first and the other sees it.

- The operation ends as `failed` or `rolled_back`, with the reason `cancelled by <token name>`, and the lock is released. A cancelled deploy is alerted like a failed one.
- A Compose deploy can be cancelled until it starts changing the project (before `compose up`). Compose cannot take a change back, so after that the cancel is refused with `the Compose project is being changed`.
- `run` can be cancelled at any time before it ends: its container is stopped and removed, and the output so far is kept.
- `restore`, `remove`, `destroy`, `exec`, `restart`, `scale`, `prune` and `ingress apply` cannot be cancelled, and `rollback --revert-schema` is refused as a migration. The answer says so: `a restore cannot be cancelled`.
- On a protected environment, an AI agent's cancel is held until a person approves it, like any change, and the plan says whether it would be accepted. The cancel is audited as `cancel:<operation id>`, with the outcome `accepted` or `refused`.

A run of a job is not an operation, and a job has one run at a time, so `berthy job cancel <name> -e prod` names it. It stops the job's container and records the run as failed with `cancelled by <token name>`; `berthy job logs <name>` shows the last lines it wrote. The command of a Compose app's job runs as an exec, which Docker cannot stop, so the cancel only ends the wait there, as a time limit does. `job cancel` is for jobs only: a backup that takes the output of a command, and `restore --exec`, cannot be cancelled.

#### When a deploy fails

A new version can fail for reasons only its own output explains: a missing setting, a migration that did not apply, a health check that never passed. The old version keeps serving. The evidence is kept before anything is cleaned up.

1. The deploy command prints a one-line reason and where to look:

   ```text
   ...
   state: rolled_back
   reason: role web: task exited with code 1 (gave up after 3 failed starts)
   diagnostics: berthy diagnostics <operation id> -e prod --project <project>
   ```

   Other reasons read `role web: container never became healthy (last check: exit 1)`, `pre-deploy command 1 exited with code 3`, `migration apply exited with code 2 (after 3 attempts)` and `pre-deploy backup main-db failed: upload failed`. A reason never carries the app's output, so it is safe in history.

2. `history` shows the same reason next to the failed operation.

3. `diagnostics` shows the evidence:

   ```bash
   berthy diagnostics <operation id> -e prod
   berthy diagnostics <operation id> -e prod --json
   ```

   For each role of the new version it shows the newest tasks (at most 5 per role): Swarm state and error, exit code, whether the container was killed for lack of memory, the health state and the last five health-check results, and the last 200 lines of its output. A failed hook or migration leaves the same for its container. Secret values are replaced by `[redacted]`. The evidence of the newest 50 operations is kept, at most 1 MiB each. It needs a `deploy` token, not `read`, because application output can hold personal data.

#### Roll back

```bash
berthy rollback api -e prod --dry-run
berthy rollback api -e prod
berthy rollback api -e prod --to <release id>
```

`rollback` redeploys the **previous** recorded digest with the manifest saved at that deploy. `--to` picks an older release: use the `id` column of `history`. **Secrets stay at their current values.** The images of the last `retain` deploys are kept on the server, so a rollback needs no pull.

A rollback takes back the app, with its jobs, its backups and its service probes, and nothing else. The environment's settings (the alerts, the peers, the other probes, the destinations, telemetry and the rest, see [Apply environment settings](#apply-environment-settings)) stay as the last deploy or `apply` left them, and so does every other app.

`--revert-schema` also reverts the database (see above). Rollback takes the lock like a deploy and exits non-zero if it does not finish healthy.

Rollback works for Compose apps too: it redeploys the Compose file stored with the earlier release. If that would recreate a `stateful` app's service, it needs `--allow-recreate` and an `admin` token, like a deploy does.

#### Apply environment settings

Some settings belong to the environment, not to an app: `registries`, `destinations`, `state_backup`, `telemetry`, `peers`, `alerts`, and the probes that name no app. A deploy of any app applies them from its manifest. To change one without deploying an app, run:

```bash
berthy apply -e prod --dry-run
berthy apply -e prod
```

```text
changed the environment settings:
  probes: + public-site
  alerts: changed
```

`apply` reads the manifest in `--manifest-dir` (the current directory by default) and stores its environment settings. It deploys nothing and records no release, and the agent starts using the new settings within a minute. The dry run prints what would change in the same lines, and `no changes` when the settings are already what the manifest says. A secret shows by name, never by value. `--json` prints `{"changes": [...]}`.

What an app owns is not applied: its own `apps` entry, the `jobs` and `backups` that name it, and the probes whose `service` is that app change with its next deploy. A rollback of an app does not change the environment's settings, and it takes back only that app's own part.

`apply` needs the `deploy` scope and is refused while the deploy lock is held. On a protected environment an agent token's `apply` is held for approval like any change.

The project of a hosted environment is fixed when setup creates it. When the CLI has resolved a target and that project's name differs from the manifest, `deploy` and `apply` stop before they send anything, with `the manifest in <dir> is for project <have>, not <want>`. If `--project` names a project/environment that is not in the CLI configuration, resolution fails first with `no environment <env> for project <project> in the CLI configuration`. Without `--project`, the manifest selects the project. An overlay cannot set `project`. To run another project, set up another hosted environment.

#### Restart and scale

```bash
berthy restart api -e prod
berthy restart api -e prod --role web
berthy scale api  -e prod --replicas 3 --role web
berthy scale api -e prod --replicas 0 --role web
```

- `restart` restarts the tasks of an image app, one role at a time (pass `--role` when the app has several). It restarts a Compose app's containers without recreating them (`--role` does not apply to a Compose app).
- A `restart` of a role at zero is refused. Scale it up first, or deploy.
- `scale` sets the replica count. It needs `--replicas`, which can be 0 or more, and works only on image apps. `--replicas 0` stops the role: the command returns once its containers have stopped. `scale --replicas N`, or a `deploy`, brings it back. A `deploy` applies the manifest's `replicas`, so the manifest stays the source of truth: change it too if the count should change for good. While a role is at zero, its health checks keep running and fail like any outage, and its alerts are not muted. `ps` shows it at 0 running and 0 desired, and `wait` succeeds at once.

Both need a `deploy` token and accept `--dry-run`.

#### Run a command in a container

```bash
berthy exec api -e prod -- /app/bin/migrate version
berthy exec api -e prod --role web -- sh -c 'echo "$LOG_LEVEL"'
```

Everything after `--` is the command. `exec` runs it in a running container, prints its output, and exits non-zero when the command did. It needs an **`admin`** token. On a protected environment, an AI agent's `exec` is held like any other change.

For a Compose app, name the service with `--service`. The command runs in one of that service's running containers. An app with one service does not need the name. A Compose app with a database, for example:

```bash
berthy exec postgres -e prod --service postgres -- psql -U todo -d todo -c "select 1"
```

`--role` is for image apps, and `--service` is refused for them. `--dry-run` prints where the command would run, the Swarm service of the role or the Compose project and service, and runs nothing.

**An interactive command.** Add `-i` (`--interactive`) to connect standard input, so a prompt works from your laptop with no shell on the server: an application console, a database shell, a restore.

```bash
berthy exec api -e prod -i -- /app/bin/console
berthy exec postgres -e prod --service postgres -i -- psql -U todo -d todo
berthy exec postgres -e prod --service postgres -i -- pg_restore -U todo -d todo --clean --if-exists --no-owner < latest.dump
```

- **With a terminal.** When your own standard input and standard output are both terminals, Berthy gives the command a terminal too, puts yours in raw mode (and restores it when the command ends), and sends its size and every change of it. Ctrl-C and the other control keys reach the command.
- **Piped.** When either is not a terminal, there is no terminal: standard input streams to the command and ends when yours does, and the command's standard output and standard error arrive on yours, apart. `< latest.dump` and `| berthy exec ... -i` are this case.
- **Exit code.** An `-i` command ends with the command's own exit code, so `exit 5` in the shell gives 5. (Without `-i`, `exec` exits 1 when the command failed.) If the agent cannot start the command, or the connection is lost, the message is on standard error and the exit code is 1.
- **Leaving.** The session ends when the command does. If your connection drops first, the session ends, but the command may keep running in the container, as it does with `docker exec`.
- **Not an operation.** A session takes no deploy lock and is not journaled, so it never blocks a deploy, and it can last as long as you need. It needs an **`admin`** token. The audit log records its start with the command, and its end with the exit code (`berthy audit`); never what you typed or what it printed. The command is shortened to about 200 characters and managed secret values in it are replaced by `[redacted]`.
- **No approval.** A session cannot wait for a person, so on a protected environment an AI agent's token is refused one: `an interactive session cannot be held for approval; use a person's token`. On an unprotected environment an agent token with `admin` scope may open one. An agent has no interactive session through MCP.
- An agent holds at most 16 sessions at once; the 17th is refused with `too many interactive sessions`.
- `--dry-run` ignores `-i` and prints the plan of the command.

#### Run a one-off command

```bash
berthy run api -e prod -- /app/bin/rake db:seed
berthy run api -e prod --role worker --timeout 30m -- /app/bin/reindex
```

`exec` runs a command in a serving replica, so it shares that replica's memory. `run` is for a one-off task that should not: it starts a **new container** from the image of the app's applied release (by digest), runs the command in it, prints the output, and exits non-zero when the command did. It is what a `run:` hook or a migration does during a deploy, without a deploy around it.

The container gets the app's environment (`env.plain`, `env.secret` and `env.template`) and the `BERTHY_*` variables of the role, the shared overlay network, the role's `resources` limits (`cpu` and `memory`) and the role's named `volumes`. An app with several roles needs `--role`; an app with one does not. The output is redacted of managed secret values, as `exec`'s is, and is kept with the operation.

- `--timeout` is the time limit of the command, from `1s` to `24h`, `1h` by default. A command that runs past it is stopped and removed, and the run fails with `run timed out after <timeout>`.
- A run is an operation. It holds the environment's deploy lock while it runs, so no deploy starts under it, and it needs an **`admin`** token. On a protected environment, an AI agent's `run` is held until a person approves it, and the plan shows the command, the image digest and the role.
- The container is removed once its output is recorded, whatever the exit code. If the agent restarts in the middle of a run, recovery stops the container and `prune` removes what is left.
- `--dry-run` prints the image (digest) and role the command would run in, and runs nothing.
- `run` is for image apps. For a Compose app it is refused with `run is for image apps; use exec --service`.

**An interactive one-off.** `run -i` starts the same new container and connects standard input, with a terminal when yours is one, as `exec -i` does above:

```bash
berthy run api -e prod -i -- /app/bin/rails console
berthy run api -e prod --role worker -i -- sh
```

- A session is not an operation. It does not take the deploy lock, so a deploy can start while it is open, and it is not journaled. It needs an **`admin`** token, an agent token is refused on a protected environment, and the audit log records its start and end only ([see `exec -i`](#run-a-command-in-a-container)).
- With no `--timeout`, an interactive run has no time limit: it ends when the command does, or when you leave. With `--timeout`, a session past it is stopped and the run fails with `run timed out after <timeout>`.
- The CLI exits with the command's own exit code.
- When your connection drops, or the agent stops, the container is stopped and removed. So is it when the command ends. If the agent itself dies, the next agent removes the container at its start.
- The container is labelled `berthy.session`, and not `berthy.operation`, so `prune` and recovery do not touch it.

---

### Step 7. Put it on the internet

Without ingress the API is reachable only by name, from inside the Docker network. **Managed ingress** makes Berthy own the whole path from a public hostname to the API, through a Cloudflare Tunnel: the tunnel, the connector that runs on the server, the hostname routes and the DNS records. It is optional, and it uses Cloudflare's API throughout.

Without it, publishing an app means creating a tunnel in a dashboard, copying a token command to the server, and pointing a hostname at a Docker service by hand. With it, the hostname is one line in the manifest.

#### What you need

- A Cloudflare account, with the domain (`example.com`) already in it. Berthy finds the zone from the hostname and does not add domains.
- A Cloudflare **API token** with two permissions: *Cloudflare Tunnel: Edit* on the account, and *DNS: Edit* on the zones with your hostnames. Limit it to those zones. When you set the secret, Berthy prints a link that opens Cloudflare's token form with both permissions filled in.
- The server must reach Cloudflare's API over HTTPS (outbound). The connector makes outbound connections to Cloudflare on port 7844, and publishes no port.

#### Configure it

In `berthy.prod.yml`:

```yaml
ingress:
  cloudflare:
    account_id: 0123456789abcdef0123456789abcdef
    api_token_secret: CLOUDFLARE_API_TOKEN
    image: cloudflare/cloudflared:2026.11.0
    replicas: 1
    tunnel: todo-prod
    dns: true

apps:
  api:
    roles:
      web:
        hostnames:
          - todo.example.com
```

| Key | Meaning | Default |
| --- | --- | --- |
| `account_id` | The Cloudflare account that owns the tunnel. | required |
| `api_token_secret` | The name of the secret that holds the API token. | required |
| `image` | The connector image. It needs a tag or digest, and is pinned by digest at deploy like any image. | required |
| `replicas` | How many connectors. Two let an update start the new one before the old one stops. | `1` |
| `tunnel` | The tunnel's name in Cloudflare. | `<project>-<environment>` |
| `dns` | Whether Berthy creates DNS records. | `true` |
| `hostnames` (on a role) | Public hostnames that route to that role's `port`. Only on image apps, and the role needs a `port`. | none |

Store the token, then apply:

```bash
berthy secret set CLOUDFLARE_API_TOKEN -e prod
berthy ingress apply -e prod --dry-run
berthy ingress apply -e prod
berthy ingress status -e prod
```

When you set the token, Berthy prints a link to Cloudflare's form for an account-owned token, with both permissions filled in and the name `berthy-<project>-<env>`, and reminds you to limit the token to the zones that hold your hostnames. The form needs the Super Administrator role on the account; without that role, create a user token by hand with the same two permissions. Before it stores the token, Berthy checks that Cloudflare accepts it, that it can read tunnels in the account and, when `dns` is on, that it sees the zone of each hostname. That check only reads, so `ingress apply --dry-run` is still the test of the edit rights. To replace the token later, see [rotating a secret](#rotating-a-secret).

`ingress apply` creates or repairs the tunnel, deploys the connector, and brings every route and DNS record in line with the manifest. Run it once per environment, and again to change the connector's image or replicas. It needs a `deploy` token. `ingress status` shows the tunnel's health as Cloudflare reports it, the connectors, and each hostname with its target and DNS record.

After that, **`berthy deploy api` keeps the routes in step**: as the last step of a deploy, once the new version is healthy, it updates that app's routes and DNS records. A new hostname goes live only after the app can answer it. Before it changes anything, the deploy checks that the API token works, each hostname's zone is in the account, and no hostname is taken.

#### What Berthy creates

| Item | How |
| --- | --- |
| Tunnel | Found by name, or created as a remotely managed tunnel. |
| Connector | A Swarm service on the shared network, with the tunnel's token as a secret. It shows in `ps` as `ingress`, and `logs` and `restart` work on it. |
| Routes | One rule per hostname in the tunnel's configuration. A hostname routes to `http://<project>-<environment>-<app>-<role>:<port>`, here `http://todo-prod-api-web:8080`. Swarm spreads requests across healthy replicas. |
| DNS | One proxied `CNAME` per hostname, pointing at the tunnel. |

The name `ingress` is reserved: you cannot name an app that.

#### What Berthy removes, and what it leaves alone

- **Berthy only touches what it created.** It reads the tunnel's route document, changes its own rules, and writes it back with every other rule kept. It marks the DNS records it creates and never edits or deletes one without the mark.
- **A conflict stops the run.** If a hostname is already routed elsewhere, or its DNS name is used by a record Berthy did not create, the run stops and reports it. `--replace-existing` takes it over (it needs an `admin` token). A route or record that already matches is **adopted** with no change. Berthy remembers the old comment on an adopted record and puts it back when the route goes away.
- **Remove a hostname** from the manifest, and its route and DNS record are removed at the next `ingress apply` or deploy of that app.
- **An app dropped from the manifest keeps its routes** while it is still deployed. The plan says `app <name> is deployed but not in the manifest; run berthy remove <name>`, and `doctor` lists it as `orphan_apps`.
- **Remove the `ingress` block** and Berthy removes its routes and records and stops the connector. The tunnel stays; only `berthy destroy --tunnel` deletes it (step 14).
- Edit managed hostnames in the manifest, **not** in the dashboard. A dashboard edit to a managed route is overwritten at the next apply, and the dry run shows it first.

#### Adopting a tunnel you already have

Set `tunnel` to its name and run `berthy ingress apply --dry-run`. Routes and records that already match the manifest are adopted as they are. Only a **remotely managed** tunnel (created in the dashboard and run with a token) can be adopted. A connector you started by hand keeps working beside Berthy's. Remove it once `ingress status` shows Berthy's connector as healthy, so traffic never drops.

To avoid granting DNS edit, create one wildcard record by hand that points at the tunnel, set `dns: false`, and Berthy manages routes only.

Cloudflare's standard certificate covers one level of subdomain, such as `todo.example.com`. A name like `api.dev.example.com` needs an advanced certificate, which Berthy does not order. Compose services cannot have `hostnames`; publish them with a rule you add in Cloudflare, which Berthy keeps.

---

### Step 8. Keep it healthy

Berthy checks three kinds of things.

| Kind | What it checks | What happens |
| --- | --- | --- |
| **Container health check** | The `health` of a role. | Gates deploys. Swarm replaces an unhealthy container. |
| **Probe** | An HTTP, TCP or service check the agent runs on a schedule. | Alert. |
| **Built-in condition** | Disk space, Docker disk, memory, restart loops, apps that are down, overdue backups, silent peers, an unhealthy tunnel, a credential that is refused or about to expire. | Alert. |

A check changes state after it fails the configured number of times in a row. One success recovers it at once. Unknown results never alert.

#### Probes

In `berthy.prod.yml`:

```yaml
probes:
  api-health:
    service:
      app: api
      role: web
      port: 8080
      path: /health
    interval: 30s
    timeout: 5s
    failures: 3
  public-site:
    http: https://todo.example.com/health
    expect_status: [200, 204]
```

A probe that names no app is an environment setting: a deploy of any app applies it, and so does [`berthy apply`](#apply-environment-settings), which deploys nothing. A `service` probe belongs to its app and comes with that app's deploy.

Exactly one of `http`, `tcp` and `service` per probe:

| Key | Meaning | Default |
| --- | --- | --- |
| `http` | A URL (`http` or `https`, with a host). | |
| `tcp` | `host:port` (port 1 to 65535). | |
| `service` | A role or Compose service on the shared network: `app`, `role` (optional when the app has one role), `port`, `path` (starts with `/`). | |
| `expect_status` | The status codes that count as healthy (100 to 599). | any 200 to 399 |
| `interval` | Time between runs. At least `5s`. | `30s` |
| `timeout` | Longest one run may take. Shorter than `interval`. A `service` probe: 1s to 25s. | `5s` |
| `failures` | Failed runs in a row before the state changes. At least 1. | `3` |

The agent runs on the host, where Docker service names do not resolve. It runs `http` and `tcp` probes itself. A `service` probe runs in the **overlay helper**: one small container per environment, built by the agent from its own binary (no registry, no internet), attached to the shared network and published on `127.0.0.1` only. A Compose service must join the shared network to be probed. If the helper is not running, the probe's state is `unknown` with the reason, and `doctor` shows a `probe_helper` check.

#### Alerts

Alerts go to Telegram, to an HTTP webhook, or to both. Both channels follow the same rules, and `reminder` and `deploys` are set once, for every channel.

```yaml
alerts:
  reminder: 4h
  deploys: failed
  telegram:
    bot_token_secret: TELEGRAM_BOT_TOKEN
    chat_id: "-1001234567890"
  webhook:
    url_secret: ALERT_WEBHOOK_URL            # the URL is often the credential, so it is a secret
    headers_secret: ALERT_WEBHOOK_HEADERS    # optional: name=value,name=value
```

| Key | Meaning | Default |
| --- | --- | --- |
| `reminder` | How often to repeat while a check keeps failing. `0s` turns reminders off. | `4h` |
| `deploys` | Which deploys and rollbacks send a message when they end: `failed`, `all` or `none` (see below). | `failed` |
| `telegram.bot_token_secret` | The name of the secret that holds the bot token. | required |
| `telegram.chat_id` | A numeric chat id, or `@channel_name`. Quote it. | required |
| `webhook.url_secret` | The name of the secret that holds the URL, `http` or `https`. | required |
| `webhook.headers_secret` | The name of the secret that holds request headers, `name=value,name=value`. A value may be percent-encoded. | none |

```bash
berthy secret set TELEGRAM_BOT_TOKEN -e prod
berthy secret set ALERT_WEBHOOK_URL -e prod
berthy alerts test -e prod
```

`alerts test` sends a test message to every configured channel and prints one line for each, `telegram: ok` or `webhook: failed: webhook returned HTTP 502`. It exits 1 when any channel failed. It needs a `deploy` token and has no dry run: it refuses `--dry-run`. An alert goes out when a check **changes state**. Its first symbol says which way: a red circle for critical, an orange one for warning, a green check for recovered, and a repeat arrow for a reminder ("still failing").

Host checks (disk, memory, Docker, public ports, reboot) are evaluated by this environment's monitor like every other check. Any resulting alerts go to all of this environment's configured channels; with none configured, nothing is sent. Alerts, deploy reports, the webhook body and telemetry name the environment only, not the project. Server-level alert channels, and naming the project, are planned: #55, #56.

##### The webhook

The webhook gets one `POST` of a small JSON document for each alert, with `Content-Type: application/json` and the headers of `headers_secret`. Any status from 200 to 299 counts as delivered. Redirects are not followed.

```json
{
  "environment": "prod",
  "kind": "check",
  "name": "probe:site",
  "state": "critical",
  "detail": "HTTP 503",
  "since": "2026-11-19T10:00:00Z",
  "text": "🔴 prod probe:site: HTTP 503"
}
```

| Field | Meaning |
| --- | --- |
| `environment` | The environment that sent the alert. |
| `kind` | `check` for a check, `deploy` for a deploy or rollback. A test alert says `test`. |
| `name` | The check, such as `probe:site`, or the app of a deploy. |
| `state` | The state of the check (`critical`, `warning`, `ok`), or how the deploy ended (`failed`, `rolled_back`, `interrupted`, `recovery_required`, `succeeded`). |
| `detail` | The detail of the check. For a deploy, the reason it did not succeed, or the version when it did. |
| `since` | When the state began. |
| `text` | The line Telegram would get, ready to show. |

None of them holds output of your application or the value of a secret. A delivery that fails is logged without the URL and is not retried by itself; a check that is still failing sends its next reminder as usual. When a state change reaches one channel and not the other, it counts as delivered, so a channel that is down does not make the other one repeat itself. `doctor` shows a `telegram` and a `webhook` check, which fail while a secret of the channel is not stored or the headers cannot be read.

##### Heartbeat

A server that is completely down cannot report itself. The peer check covers that only when a second environment watches the first. With one server, an outage of the server, of the agent or of its network is silent until someone notices the application is gone. The heartbeat closes that gap: the agent pings a URL, and a dead man's switch service raises the alarm when the pings stop.

```yaml
alerts:
  heartbeat:
    url_secret: HEARTBEAT_URL
    interval: 1m        # default 1m, at least 10s
```

```bash
berthy secret set HEARTBEAT_URL -e prod
```

- The agent sends one `GET` to the URL every `interval` while it runs and Docker answers. Nothing else decides it: the health of your apps has its own checks. When Docker does not answer, no ping is sent.
- A ping has a 5-second timeout and is never retried. A missed ping is simply missed, which is the signal. Any `2xx` answer counts as accepted. A redirect does not.
- `berthy checks` and `berthy doctor` show a `heartbeat` entry with the time of the last ping that was accepted, such as `last ping accepted at 2026-11-19T10:00:00Z`. It is `unknown` when the URL cannot be reached, with the reason (`ping failed: unreachable`, `ping failed: timeout`, `ping not accepted: HTTP 503`, or `Docker unavailable: no ping sent`) and when a ping was last accepted. It never alerts, because the channel it would use may be down for the same reason.
- The URL is a secret. It appears in no log line, check or error. `doctor` fails the `heartbeat` entry while the secret is not stored.
- A change of `interval` applies within a minute, with the next read of the manifest.

##### Deploy messages

A check is not the only thing that sends a message. Nobody hears about a deploy unless they ran it, so every channel hears about deploys and rollbacks too, as `deploys` says:

| `deploys` | A message when a deploy or rollback ends as |
| --- | --- |
| `failed` (default) | `failed`, `rolled_back`, `interrupted` or `recovery_required` |
| `all` | the same, and `succeeded` |
| `none` | never |

A message names the environment, the app, the tag (or the short digest), who asked (the name of the token) and how long it took. A failure also gives the reason Berthy recorded, the same line `berthy history` shows, and the command to run next. It never holds output of your application. A message goes out in the background, so a channel that is down never delays a deploy.

```
✅ prod: api v1.4.2 deployed by ci in 48s

🔴 prod: api v1.4.3 rolled back: role web: container never became healthy (last check: exit 1)
by ci in 48s
berthy diagnostics 4f2c0a8e19b64d37a1c5e90b7d3f6a21 -e prod
```

`rolled back` here means the new version failed and the previous one runs again. A rollback you ask for reads `✅ prod: api rolled back to v1.0.1 by ci in 12s`. Which manifest decides: for a deploy, the one you just sent, so the first deploy of an app can alert too; for a rollback and after an agent restart, the alert settings the environment stores, which a rollback never changes. Only deploys and rollbacks send these messages, once each. An operation that stopped as `recovery_required` and is closed later with `recovery resolve` is not sent again. If a channel cannot be reached, the agent logs it and the deploy is not affected.

#### Built-in conditions

They always run:

- **Disk** and **Docker disk**: warning from 80 percent used, critical from 90 percent. They cover `/`, the mount that holds Docker's data, and every mount of at least 1 GiB.
- **Memory**: warning below 10 percent available, critical below 5 percent.
- **Restart loops** of the apps Berthy manages: three restarts of one replica, or three failed or rejected Swarm tasks, within 10 minutes, or an out-of-memory kill.
- **Down**: each role of an image app and each service of a Compose app, named `down:<app>/<role or service>`. It is critical when fewer replicas run and are healthy than the app should run, for two minutes. An image role should run the replicas its service is set to, so a scale to 0 is fine. A Compose service should run the containers it has, so a container that is stopped by hand is down, and so is a service whose containers are gone. A container that runs and is unhealthy is not healthy. The app is named as its restart checks name it: a Compose app by its Compose project. Nothing is judged while a deploy, rollback, restart, scale, remove or ingress change of that app runs, or for two minutes after it ends. The detail says what was seen, for example `0 of 2 replicas running for 2m`, `1 of 2 replicas healthy (1 unhealthy) for 2m` or `exited with code 137 for 2m`. The exit code is read from the status of an exited Compose container; when the status gives none, the detail says `container exited`. A Compose container that exited with code 0 is a finished job, the same notion a Compose deploy accepts a one-shot by: the service does not want it running, so it is neither wanted nor down. For the first two minutes of a shortfall the check is unknown, with `not yet confirmed` in its detail, so an alert is never undone by a short gap.
- **Backups**: failed, overdue or suspiciously small (step 10), and jobs that fail (step 9).
- **The tunnel**, when managed ingress is set up.
- **Credentials**: the registry password of each registry that a deployed image app pulls from, and the Cloudflare API token when managed ingress is set up. `doctor` asks each time it runs, and the monitor asks every 10 minutes. A check changes state after two answers in a row that are not ok, so an alert comes 10 to 20 minutes after a credential stops working. A refused or missing credential is critical. The Cloudflare token warns when it expires within 14 days. A registry does not say when its password expires, so Berthy finds an expired password only when the registry refuses it. A check that could not be asked is unknown and never alerts: an outage of the registry or of Cloudflare is not a refused credential.

A refused registry password, and a Cloudflare token that expires in five days, look like this in `berthy doctor`:

```text
checks:
  ...
  critical: false
  detail: refused: ghcr.io does not let it pull acme/todo-api: run berthy secret set GHCR_TOKEN --registry ghcr.io -e prod
  name: registry:ghcr.io
  ok: false

  critical: false
  detail: expires in 5d (2026-11-23): replace it with berthy secret set CLOUDFLARE_API_TOKEN -e prod
  name: cloudflare_token
  ok: false
```

Telegram sends these alerts for them, and a recovery alert once the registry password is replaced:

```text
🔴 prod registry:ghcr.io: refused: ghcr.io does not let it pull acme/todo-api: run berthy secret set GHCR_TOKEN --registry ghcr.io -e prod
🟠 prod cloudflare_token: expires in 5d (2026-11-23): replace it with berthy secret set CLOUDFLARE_API_TOKEN -e prod
✅ prod registry:ghcr.io recovered
```

`ingress_tunnel` in `doctor` says `unavailable`, and `ingress status` shows Cloudflare as `unavailable`, both when Cloudflare refuses the token and when Cloudflare cannot be reached. `cloudflare_token` tells the two apart: `refused: ...` means replace the token, and `could not be asked: ...` means Cloudflare could not be reached.

A token with an expiry has a check too, named `token:<name>` (`berthy checks` lists it). It warns 14 days before the token expires, and keeps warning after it has expired, until you revoke it:

```text
🟠 prod token:ci: token ci expires in 13d (2027-02-16): create a new one with berthy token create
```

Make the new token, give it to CI, then `berthy token revoke` the old one.

#### How fast an alert arrives

The agent follows Docker's event feed. A container of your apps that dies, runs out of memory or changes health, and a service that is updated or removed, wake the restart, down and drift checks at once, so their alerts arrive within seconds instead of at the next read. The checks decide as before: for example a down check still waits two minutes before it turns critical. While the feed is open, the agent reads Docker's inventory for these checks every three minutes, and every minute while it is not. If the feed drops, the agent reconnects by itself, from the time of the last event, and reads the inventory once when it is back. A deploy reacts to the same events and ends sooner, and a deploy never depends on them.

#### Drift

Berthy knows what each app should run: its applied release. Every five minutes the check `drift:<app>` compares that with what Docker runs, and raises a warning when they differ. It only reports. `berthy deploy` brings the app back, and nothing else changes it.

- **Image apps.** For each role, the live Swarm service is compared with the service a deploy of the applied release would send: the image, replicas, user, entrypoint and command, volumes, health check, limits, logging, labels and environment. One line says what differs, such as `api/web: replicas 3, release says 2` or `api/web: user "1000", release says none`. A variable is only named, as in `api/web: env DATABASE_URL differs`; a value is never shown.
- **Compose apps.** Berthy runs the plan that a deploy of the stored Compose file runs, and reports the services it would recreate, create or remove, and the volumes it would create, such as `postgres: service postgres would be recreated` or `postgres: volume pgdata would be created`.
- **Scaled roles are not drift.** A role that `berthy scale` set to another count shows as `api/web: scaled to 3 with berthy scale`, and the check stays ok. A deploy puts the count of the manifest back.
- **When it does not judge.** The check is unknown, and never alerts, while an operation runs on the app, and while Docker or the release cannot be read.

A change made by hand, such as `docker service update --replicas 3` on a service, shows in `berthy checks`, in `berthy doctor` (which compares when you ask) and in `berthy describe <app>`:

```text
NAME         STATE    SINCE                 DETAIL
drift:api    warning  2026-11-19T10:21:50Z  api/web: replicas 3, release says 2; api/web: env FEATURE_X differs
```

The next deploy clears it. A warning sends the same alert as the other warnings, and a recovery alert follows once the app matches again.

#### Peers

```yaml
peers:
  dev: http://10.0.0.4:7710
```

Each peer is another agent's base URL (no path). Every 30 seconds the agent asks it for `/healthz` (a request that needs no token, answering `{"ok":true}` and nothing else), and raises an alert after three misses. This is how you notice a server that is completely down and cannot report itself. It does not cover all servers failing together or the private network being down: keep one external check on the app's public URL for that.

#### See the state

```bash
berthy checks -e prod
```

Example output:

```text
NAME             STATE  SINCE                 DETAIL
api-health       ok     2026-11-16T10:21:50Z  ...
backup:main-db   ok     2026-11-16T10:30:00Z  last success 3h ago, 38 MiB
```

`doctor` (step 1) shows the same state for the agent itself.

#### Metrics and deploy events export

The agent shows live metrics and the last hour without any backend. For history, export them over OpenTelemetry:

```yaml
telemetry:
  otlp_endpoint: http://10.0.0.6:4318
  headers_secret: OTLP_HEADERS
```

`headers_secret` names a secret that holds request headers in the standard `OTEL_EXPORTER_OTLP_HEADERS` form (`name=value,name=value`), for backends that need authorization. The agent runs on the host, so the endpoint must be an address the host can reach, such as a port published on a private address. A Docker service name does not resolve there. `doctor` shows a `telemetry` check.

With an endpoint, the agent also sends two log records for every operation, of every kind: one when it starts and one when it ends. They go to `<otlp_endpoint>/v1/logs` with the same headers. A record has the body `deploy started` or `deploy succeeded` (`<kind> <state>`), and the attributes `berthy.environment`, `berthy.app`, `berthy.operation.id`, `berthy.operation.kind`, `berthy.version`, `berthy.image.digest`, `berthy.operation.state` and `berthy.actor`; the end record adds `berthy.operation.duration_ms`. An end that is not a success has the severity WARN. A value that is not known, such as the version of a restart, is left out. Records never wait for the backend: they are queued, and dropped, with a line in the agent's log, when the backend does not answer. The endpoint is read from the environment's settings, so the deploy that first turns telemetry on sends its end record only.

---

### Step 9. Scheduled commands

A **job** is a named command that runs inside an app's container, on a schedule or on demand. The todo app has two, both in `berthy.yml`:

```yaml
jobs:
  dump-db:
    app: postgres
    service: postgres
    timeout: 10m
    command:
      - sh
      - -ec
      - |
        umask 077
        tmp=$(mktemp /backups/.latest.XXXXXX)
        trap 'rm -f "$tmp"' EXIT
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -Fc --no-acl --no-owner \
          -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$tmp"
        mv -f "$tmp" /backups/latest.dump

  cleanup:
    app: api
    role: web
    schedule: "30 2 * * *"
    timeout: 15m
    command: ["/app/bin/cleanup", "--done-older-than", "30d"]
```

| Key | Meaning | Default |
| --- | --- | --- |
| `app` | The app to run in. | required |
| `role` | For an image app: which role. Optional when the app has one role. | |
| `service` | For a Compose app: which service. Optional when it has one. | |
| `schedule` | Five-field cron, read in the manifest's `timezone` (UTC by default). Leave it out for an on-demand job. | on demand |
| `command` | The command, as a list. It is not run through a shell, so write `sh -c` yourself if you need shell syntax. | required |
| `timeout` | Time limit of one run, from `1s` to `24h`. | `1h` |

#### The time zone of schedules

Every `schedule` is read in UTC unless the manifest sets a zone. One top-level key sets it for all of them: the jobs, the backups and the state backup.

```yaml
timezone: Europe/Lisbon   # an IANA name; the default is UTC
```

With that line, `schedule: "0 2 * * *"` runs at 02:00 in Lisbon, in winter and in summer. Its UTC time moves by an hour when the clocks change.

- A time that **does not exist** on a day, because the clocks go forward, is skipped that day. `30 1 * * *` does not run on the day Lisbon goes from 01:00 to 02:00.
- A time that **happens twice**, because the clocks go back, runs **once**, the first time.
- An occurrence is still recorded by its instant in UTC, so "at most once" does not change. Run records, logs and the audit log stay in UTC.
- `berthy config validate` refuses a name that is not a zone, and names the file and line. Write the name as the IANA database does (`Europe/Lisbon`, not `europe/lisbon`); it is refused on every system, whatever the system does with case. The binary carries its own zone data, so the result does not depend on the server.
- A change of `timezone` takes effect within a minute of its `berthy apply` or deploy, and `berthy apply --dry-run` shows it as `timezone: UTC -> Europe/Lisbon`.

`berthy jobs` shows the next occurrence in the zone and in UTC, and `berthy describe` and `--json` give both `next` (UTC) and `next_local`, with the `timezone`.

How a job runs:

- The command runs **once** per occurrence. A job of an **image app** runs in a **new container of its own**, of the app's applied release, the way `berthy run` does. The container has the role's environment, the shared network, the role's resource limits and the role's named volumes, so a job that reads files the replica wrote sees them. It is labelled with the job and removed when the command ends. A job of a **Compose app** runs as an exec in the service's container, and uses that container's environment and mounts. That is why `dump-db` can read `$POSTGRES_PASSWORD`: the Compose file passes it in. There is no way to make an image app's job run inside a replica.
- An image app's job needs no running replica, so it runs while the role is scaled to 0 or restarting. A deploy of the app does not touch it: the job finishes on the release it started with. A job that writes a volume that the role's replica writes shares it with the replica while it runs.
- The agent re-reads the manifest every minute, so a changed schedule takes effect within a minute of its deploy. An occurrence is recorded **before** it runs, so a restart in the same minute cannot run it twice. Occurrences that pass while the agent is down are **not** made up.
- A run that exceeds `timeout` fails with `timed out after <timeout>`. For an image app Berthy stops the job's container and removes it, so nothing of the command is left running. Docker cannot stop an exec, so a Compose job's command may still be running.
- If a run is still going at the next scheduled time, that occurrence is skipped and recorded. A skip never alerts.
- The output of a run that **succeeds** is thrown away. The output of a run that **fails or times out** is kept: its last 200 lines (at most 64 KiB), with every secret value replaced by `[redacted]`, sealed in the agent's state. The record keeps the exit code and a fixed reason such as `exit status 3` or `timed out after 5s`. Read the output with `berthy job logs <name>`.
- A non-zero exit, a missing container, a run that could not start or a timeout **fails the run and raises an alert** through the `job:<name>` check, which stays critical until a later run succeeds. When the run kept output, the alert ends with `berthy job logs <name> shows its output`. A backup's `before` job works the same way.
- Jobs do not take the deploy lock, so they can run during a deploy. Every run is written to the audit log with `job:<name>` as the caller.

#### See and run them

```bash
berthy jobs -e prod
berthy job run dump-db -e prod
berthy job logs dump-db -e prod
berthy job cancel dump-db -e prod
```

Example output:

```text
NAME     TARGET            SCHEDULE   NEXT                           LAST       WHEN
cleanup  api/web           30 2 * * * 2026-11-17 02:30 WET (02:30Z)  succeeded  2026-11-16T02:30:01Z
dump-db  postgres/postgres on demand  -                              -          -
```

With the default zone, NEXT shows only the UTC time, as in `2026-11-17 02:30 UTC`. The example above has `timezone: Europe/Lisbon`.

`jobs` needs a `read` token. `job run <name>` starts the job now, waits until it finishes or its `timeout` plus 30 seconds pass, prints the status, exit code and reason, and **exits 0 only when the run succeeded**. It fails at once if a run of that job is already going. It needs a `deploy` token. `dump-db` has no schedule: it runs on demand, and as the `before` step of the volume backup (step 10).

`job logs <name>` prints the output kept of a failed or timed-out run: the newest run that kept any, or the one named by `--run <id>`. The run's line goes to stderr and the output to stdout, so you can pipe it. `--json` prints the run and its output as JSON. It needs a `deploy` token, because output can hold more than a `read` token should see. It says so when nothing was kept: a run that succeeded, or one that printed nothing, keeps no output.

---
### Step 10. Backups and restore

Berthy backs up **named Docker volumes**, and the **output of a command**, to S3-compatible object storage. A backup of a volume is a compressed archive of it, and a backup of a command is the command's compressed standard output. Either comes with a small description file. Backups are opt-in: you declare each one.

The todo app backs up the database by dumping it and uploading the dump:

1. The `dump-db` job (step 9) writes a consistent dump to `/backups/latest.dump`, a file on the `db-dumps` volume.
2. The volume backup `main-db` uploads that volume.

Archiving the live `pgdata` volume would copy files while the database writes to them. A dump is safe. That is why `dump-db` writes to a dedicated volume.

A database does not need a dump volume. A backup can take the dump command's output instead of a volume, and send it to storage as it is written: see [Back up the output of a command](#back-up-the-output-of-a-command) below, which is the shorter way for PostgreSQL.

#### Configure

In `berthy.prod.yml`:

```yaml
destinations:
  offsite:
    type: s3
    endpoint: https://s3.example.com
    region: eu-central-1
    bucket: acme-todo-backups
    access_key_secret: S3_ACCESS_KEY
    secret_key_secret: S3_SECRET_KEY

backups:
  main-db:
    app: postgres
    volume: db-dumps
    schedule: "0 1 * * *"
    destination: offsite
    prefix: postgres/todo
    before: dump-db
    retention:
      keep: 14
```

| Key | Meaning | Default |
| --- | --- | --- |
| `destinations.<name>.type` | Only `s3`. | required |
| `endpoint` | `https://host[:port]`, with no path. `http://` is accepted only for localhost or a loopback address. Leave it out for AWS. | AWS |
| `region` | The bucket's region. | |
| `bucket` | The bucket name. | required |
| `access_key_secret`, `secret_key_secret` | Names of the secrets that hold the credentials. | required |
| `backups.<name>.app` | The app that mounts the volume, or that the command runs in. | required |
| `volume` | For a Compose app, the key in the Compose file's top-level `volumes` (here `db-dumps`; Berthy works out the real Docker name). For an image app, the name of a volume one of its roles mounts (`volumes: ["uploads:/app/uploads"]`). A backup has exactly one of `volume` and `command`. | one of the two |
| `command`, `service`, `role`, `timeout` | A backup of a command's output instead of a volume: see [below](#back-up-the-output-of-a-command). | |
| `destination` | A key of `destinations`. | required |
| `schedule` | Five-field cron, read in the manifest's `timezone` (UTC by default). Leave it out to run only on demand or from a deploy hook. | on demand |
| `prefix` | Where the backup's objects sit in the bucket, under `<project>/<environment>/`. | `<app>/<volume>` |
| `before` | A job (step 9) to run first. If it fails, the backup fails and nothing is uploaded. | none |
| `retention.keep` | `all`, or a number: keep that many newest successful backups. | `all` |

Create a storage credential limited to the backup bucket, store it, and consider a retention lock on the bucket so a compromised server cannot delete the history:

```bash
berthy secret set S3_ACCESS_KEY -e prod
berthy secret set S3_SECRET_KEY -e prod
```

A backup of a volume the app does not mount is refused, and a backup of an app that is not deployed is not part of the configuration.

#### Back up the output of a command

A database is best backed up with its own dump tool, and the dump is the backup. Name the command instead of a volume:

```yaml
backups:
  main-db:
    app: postgres
    service: postgres
    command: ["sh", "-c", "pg_dump -Fc --no-acl --no-owner -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""]
    schedule: "0 1 * * *"
    destination: offsite
    retention:
      keep: 14
```

There is no dump volume and no `before` job. The agent runs the command, compresses its standard output and sends it to storage as it is written, hashing it on the way. Nothing is written to the server's disk, however large the dump is.

- **Where it runs.** `service` names the Compose service whose running container runs the command, as for a job (it may be left out when the app has one service). For an image app, `role` names the role whose environment, limits and volumes the command takes, and the command runs in a new container of the app's applied release, which needs no running replica and is removed when the command ends. Docker keeps no log of that container's output. `service` and `role` cannot be combined, and neither belongs to a volume backup.
- **Time limit.** `timeout` limits the command, from `1s` to `24h`, `1h` unless you set it. A command past it is stopped, and for an image app its container goes with it.
- **Failure.** A command that exits non-zero, writes nothing, runs out of time, or whose upload fails ends the backup: the upload is aborted, no description file is written, and nothing of it is listed. The run keeps the last lines of the command's standard error, with every secret value in them replaced, so `backup run` and the `backup:<name>` check say why, for example `command failed: exited with code 3: pg_dump: error: ...`.
- **The rest is the same.** Schedules, `retention`, the `backup:<name>` check with its overdue and size rules, `backup run` and the pre-deploy `backup:` hook work as for a volume. Backups of one command backup run one at a time. A command backup has no `before` job.
- **Where the objects sit.** The key is `<project>/<environment>/<prefix>/<backup>/<time>-<run id>.gz`, with `<prefix>` the backup's `prefix` or `<app>/command`. `backup list` shows `command` where a volume backup shows its volume.

#### Run, list, watch

```bash
berthy backup run main-db -e prod
berthy backup list -e prod
berthy backup list --backup main-db -e prod
```

`backup run` (a `deploy` token) runs the backup now, waits for it, prints the run and **exits 0 only when it succeeded**. Backups of the same volume run one at a time: a second is refused with `409`. `backup list` (a `read` token) shows what is in storage:

```text
BACKUP   APP       VOLUME    SIZE     FINISHED              SHA256    KEY
main-db  postgres  db-dumps  38 MiB   2026-11-16T01:00:12Z  <hash>    todo/prod/postgres/todo/main-db/20261116T010000Z-7.tar.gz
```

The **key** is what `restore` takes. A backup is listed only when its description file (`<same name>.json`, with the checksum and size) exists. The agent writes it after the upload finishes, so a backup that is listed is complete. An interrupted upload leaves nothing that looks like a good backup.

How a run goes: the `before` job runs and must succeed; the agent reads the volume through a read-only mount and streams a gzip tar to storage while hashing it; only then it writes the description file, records the run and applies retention (`keep: N` deletes all but the `N` newest backups of this job; objects without a description file are never touched). A failed run is recorded with a detail that starts with its step: `preparation failed`, `archive failed`, `command failed`, `upload failed` or `sidecar failed`. A backup of a command runs the command in place of the first two steps.

A scheduled run happens once per occurrence (read in the manifest's `timezone`, see step 9), even across an agent restart, and occurrences missed while the agent was down are not made up. If a backup of the volume is still running at an occurrence, that occurrence is skipped without an alert.

#### The pre-deploy backup

The prod overlay makes every API deploy take a fresh dump first:

```yaml
apps:
  api:
    hooks:
      pre_deploy:
        - backup: main-db
```

It runs the same code as `backup run`, `before` job included. A failed backup stops the deploy before the migrations, with the reason `pre-deploy backup main-db failed: ...`. Use it where the data warrants it. It is a hook you choose, not a universal rule.

#### Safety checks

Every backup of the deployed manifest has a check, `backup:<name>`, that runs every 60 seconds and alerts on its first non-ok result:

- **Failure:** the newest finished run failed (critical, with its detail).
- **Overdue:** a scheduled backup is late (critical). An hourly backup is overdue after two hours; a daily one an hour after it should have run.
- **Size drop:** the newest backup is under half the size of the one before (warning).

`ps` and `describe` show each backup's `last_success`, `age`, `size` and `last_status`.

#### Restore into a new volume

```bash
berthy restore todo/prod/postgres/todo/main-db/20261116T010000Z-7.tar.gz --into todo-restore \
  -e prod --dry-run
berthy restore todo/prod/postgres/todo/main-db/20261116T010000Z-7.tar.gz --into todo-restore \
  -e prod
```

`restore` needs an **`admin`** token. It streams the archive from storage into a **new** Docker volume, preserving permissions and ownership, and compares the SHA-256 and size to the description file. A mismatch fails the operation with `backup checksum mismatch` and removes the volume. A volume that already exists is refused, and so is a key without a description file. `--dry-run` shows what it would restore: the key, the new volume, the backup, app and volume, when it was taken, its size and checksum.

Restore never overwrites a live volume. It always makes a new one, and you decide what to do with it. `backup list` and `restore` read the backups of every app that was ever deployed, even after `berthy remove`, so backups stay restorable.

If the agent stops during a restore, the operation ends `interrupted`, and at its next start the agent removes the half-built volume (it carries the label `berthy.restore-operation=<operation id>`).

`restore --into` refuses a backup of a command, and `restore --exec` below refuses a backup of a volume, each with a message that names the other.

#### Restore into a command

A backup of a command is restored by giving its output to a command, in a running container, with no download and no recovery volume:

```bash
berthy restore postgres/command/main-db/20261116T010000Z-7.gz -e prod --dry-run \
  --exec postgres --service postgres -- pg_restore -U todo -d todo_check --no-owner
berthy restore postgres/command/main-db/20261116T010000Z-7.gz -e prod \
  --exec postgres --service postgres -- pg_restore -U todo -d todo_check --no-owner
```

`--exec APP` names the app, and `--service` or `--role` says where the command runs, as for `exec` and `run`: the running container of a Compose app's service, or a new container of an image app's applied release, which gets the role's environment and volumes. `--timeout` limits the command (`1h` unless you set it). The command follows `--`. The agent streams the backup, decompressed, into the command's standard input.

`restore --exec` needs an **`admin`** token, is an operation under the deploy lock and is audited, like `restore --into`. `--dry-run` shows the backup, where the command would run and the command, and runs nothing.

- **The checksum is checked first.** Before the command starts, the agent reads the whole backup once to check its size and SHA-256 against the description file. A backup that is not what was stored is refused with `backup checksum mismatch`, and the command never runs. Then it reads the backup a second time and streams it. The backup is read twice on purpose: a restore can change data, so it must not start from a backup that turns out to be damaged. The price is the bandwidth of one more read.
- **A failure shows its cause.** A command that exits non-zero fails the restore with `restore command failed`, the exit code, and the last lines of its output, with secret values replaced.
- **An interrupted restore.** If the agent stops during a restore, the operation ends `interrupted` and says the command may have loaded part of the backup. Look at the target before you run it again.

The command should load into a scratch database first. To load the real one, stop its writers as in the recipe below.

Because the command's output is the backup, `restore --exec` also takes the place of the download and extraction steps of the recipe below when the backup is a command backup.

#### The PostgreSQL recovery recipe

The restored volume holds `latest.dump`. Load it into a **scratch** database first, and look at it, before you touch the real one. Everything below runs from your laptop, through the agent, with an `admin` token; none of it needs a shell on the server.

`restore` has checked the archive against its description file and made the volume, but the dump has to reach the machine you run `berthy` on. Download the same archive from your bucket with your own tool, and take the dump out of it:

```bash
aws s3 cp s3://acme-backups/todo/prod/postgres/todo/main-db/20261116T010000Z-7.tar.gz .
tar -xzf 20261116T010000Z-7.tar.gz latest.dump
```

Then load it into a scratch database of the running Postgres and look at it:

```bash
berthy exec postgres -e prod --service postgres -i -- createdb -U todo todo_check
berthy exec postgres -e prod --service postgres -i -- pg_restore -U todo -d todo_check --no-owner < latest.dump
berthy exec postgres -e prod --service postgres -i -- psql -U todo -d todo_check -c '\dt'
berthy exec postgres -e prod --service postgres -i -- dropdb -U todo todo_check
```

If it looks right, load it into the real database. Stop the writers first, with Berthy:

```bash
berthy scale api -e prod --replicas 0 --role web
berthy exec postgres -e prod --service postgres -i -- \
  pg_restore -U todo -d todo --clean --if-exists --no-owner < latest.dump
berthy scale api -e prod --replicas 2 --role web
```

The last command brings the API back once the restore has finished and you have checked it, and a `deploy` of the app brings it back to the manifest's count.

The dump streams from your laptop to `pg_restore`, and the command's exit code is `pg_restore`'s. If you lose the connection halfway, the session ends but `pg_restore` may keep running in the container: look at the database before you run it again.

Recovery starts from the backup's capture time. Anything written after the last dump is lost, and missed or failed runs make that window longer.

#### Back up the agent's state

The agent's SQLite file holds its releases, history, audit log, checks and **secrets**. The agent can upload a copy of it daily. That upload is a SQLite snapshot that contains sealed secret values, with a separate metadata sidecar. Secret values stay sealed, and the key file is not uploaded, but SQLite metadata such as operation actors and secret names can still be read without the key. Remote setup's `cli_key` reads the configured key under the existing reader rules. Add this to the prod overlay:

```yaml
state_backup:
  destination: offsite
  prefix: berthy-state
  schedule: "17 3 * * *"
  keep: 14
```

| Key | Meaning | Default |
| --- | --- | --- |
| `destination` | A key of `destinations`. | required |
| `prefix` | Object prefix under `<project>/<environment>/`. Each segment may hold letters, digits and `._@+=-`. | `berthy-state` |
| `schedule` | Cron, read in the `timezone`. | `17 3 * * *` |
| `keep` | Snapshots to keep, 1 to 1000. | `14` |

A snapshot is a consistent copy taken while the agent keeps running, stored as `<project>/<environment>/<prefix>/<UTC time>.db` with a description file. The block belongs to the environment, so it stays in force whatever apps are deployed. A `state_backup` check alerts on a failed or overdue snapshot, and shows in `berthy checks`.

Take one now (an `admin` token). It waits and exits 0 only on success:

```bash
berthy state-backup -e prod
```

```text
run: 3
status: succeeded
key: todo/prod/berthy-state/20261116T031700Z.db
size: 412000
sha256: <hash>
```

Restoring a snapshot needs neither the agent nor its server (step 15). The description file names the key the snapshot needs, by ID: after a [key rotation](#rotate-the-encryption-key), a snapshot taken before it needs the old key and one taken after it needs the new one.

#### Rotate the encryption key

Every sealed value in the state says which key sealed it, so the key can be replaced without losing anything. Run, with an `admin` token that is not an agent token:

```bash
berthy key rotate -e prod
```

```text
rotated the state key: 12 values resealed, key 3f2a9c01e4b7d210 replaces 91c0aa11bb22cc33
the previous key is kept on the server until the next state snapshot succeeds
run berthy setup for this environment again from your machine: it saves the new key in its key folder
or, on the server, in a POSIX shell, copy it by hand and then move the file to another machine: (umask 077; set -C; sudo cat /var/lib/berthy/environments/todo/prod/key > ~/todo.prod.key.20261122T153012Z)
```

The agent makes a new key on the server, seals every secret, held request and diagnostic again in one transaction, and records `key_rotate` in the audit log with the token that asked. It never prints a key: the IDs only name keys. Then run `berthy setup` again from your machine: it saves the new key in `~/.berthy/keys`, beside the copy of the old one. The last line is the way to copy it by hand (see [Copying by hand](#copying-by-hand)). Keep the old copy as long as you keep a state snapshot from before the rotation, because that snapshot opens only with the old key.

The old key stays on the server as `/var/lib/berthy/environments/todo/prod/key.prev` until the next state snapshot succeeds with the new key. Then the agent deletes it. Until then `berthy doctor` shows a `state_key` check. Without a `state_backup` block no snapshot runs, so the previous key stays; delete it yourself when you no longer need it.

If the rotation ends with `key_rotation_incomplete`, the agent uses the new key but its key files are not in place yet. Setup then saves no copy. On the server, find and fix what kept the agent from putting its key files in place (for example a leftover `<key>.prev.tmp` it cannot remove, a full disk, or wrong ownership). Do not restart the agent before that: it finishes the rotation when it starts, and it cannot start while the cause remains. Then restart it and run the same `berthy setup` command again, from this same directory and with the same environment; leave out `--new-token` if that run used it, because this run already added that admin token. If that earlier command used `--key-file`, leave `--key-file` out of this retry only: after the agent settles the rotation the saved file can still hold the old key.

Never replace the key file of a running agent: rotate through the agent. Setup copies the key file, and cannot tell that it was swapped underneath a running agent.

The rotation is refused with a conflict while an operation runs or the deploy lock is held. `--dry-run` checks the same and says how many values would be sealed again, and changes nothing. A crash in the middle leaves a state that one of the two keys opens completely, and the agent settles the key files when it starts again. `berthy setup --key-file` never replaces the key of a server: rotate through the agent.

A snapshot taken before the rotation needs the old key. `state-restore` names the key it needs before it downloads anything: `the snapshot needs key 91c0aa11bb22cc33; berthy.todo.prod.3f2a9c01e4b7d210.key is key 3f2a9c01e4b7d210`.

---

### Step 11. Protected environments and AI agents

The agent can control Docker, which is as good as root on the server. You may want an AI agent to **look at** production, and even **ask for** changes, but not to make them unreviewed. A protected environment does that.

#### What `protected: true` does

- It **admits only image digests.** A human admin can pick a tag in the CLI. The agent still receives the resolved digest (step 4).
- It **holds the changes an AI agent asks for** until a person approves them. An agent token cannot list tags or resolve them, and a held deploy still carries a digest.
- It **refuses a deploy from a checkout with local changes** to `berthy.yml`, the overlay or the app's Compose file. The release would not record what was deployed. Commit the files first.

Set it in the overlay (`protected: true` in `berthy.prod.yml`), or in the agent's configuration (`"protected": true`, which setup writes from the manifest). Once a deploy of a protected manifest has succeeded, the agent remembers the environment as protected, even if the line is later removed.

#### Make a token for an AI agent

```bash
berthy token create claude -e prod --agent --scope deploy
```

The `--agent` flag marks it as an agent token. It works at once, as for any token (step 6). Give the token to the AI agent's tool through an environment variable; never write it into a file. An agent token cannot make or revoke tokens, so an AI agent cannot give itself, or anyone, more access.

- `--scope read` lets the AI agent only look. This is the safe default.
- `--scope deploy` lets it ask for deploys, rollbacks, restarts, backups and so on.
- The mark does not change what the scope allows. What changes is that **on a protected environment its changes are held.** On an unprotected environment, an agent token is served like any other token of its scope.
- An agent token can **never approve or reject**, whatever its scope.

#### What is held, and what is not

The agent checks the token and its scope as usual, then **stores the request instead of carrying it out**. Nothing changes: no operation starts and the lock is not taken. The answer is `202` with an approval id.

Held: `deploy`, `apply`, `rollback`, `restart`, `scale`, `exec`, `run`, `prune`, `remove`, `destroy`, `restore`, `ingress apply`, `secret set`, both forms of `secret generate`, `secret import`, `secret rm`, `lock acquire` and `release`, `backup run`, `job run`, `job cancel`, `cancel`, `state-backup`, `recovery resolve` and `alerts test`.

`key rotate` is not held: an agent token is refused with `an agent token cannot rotate the state key`, whatever its scope, on every environment.

Not held: reads; `--dry-run` (it changes nothing, so an agent gets the plan at once); and every request on an unprotected environment. A request the token has no right to make is refused at once, not held.

What an agent token's CLI sees:

```bash
BERTHY_TODO_PROD_TOKEN=<claude's token> \
  berthy deploy api -e prod --version sha256:<digest>
```

```text
held for approval: 5f1c0d2a... (expires 2026-11-16T10:45:12Z)
plan:
  diff:
    image    sha256:41ab1c2d3e4f… -> sha256:9f2c0d1e2f3a…   (v1.4.2 -> v1.4.3)
    web      replicas 2 -> 3
  app: api
  image: ghcr.io/acme/todo-api@sha256:<digest>
  ...
```

A held deploy or rollback carries what it changes, so the person who approves it sees the difference and not only the target: a changed command, a removed health check or a new hostname looks different from a version bump.

The exit code is **`3`**: not done, not failed. With `--json` it prints the answer as JSON.

#### Review and decide

A person with an `admin` token (not an agent token) lists, reviews and decides:

```bash
berthy approvals -e prod
berthy approvals --all -e prod
berthy approve 5f1c0d2a -e prod
berthy reject  5f1c0d2a -m "not during the freeze" -e prod
```

`approvals` lists what is waiting: id, age, time left, who asked, and a one-line summary such as `deploy api sha256:...`, `restart api/web` or `secret set DATABASE_URL`. Under the table, each deploy or rollback that has a diff lists what it changes (`<id>: changes of <app>`, then the lines of a dry run). `--all` adds the decided and expired ones, with their status and who decided. A `read` token sees each request without its plan. The **plan**, which can repeat a command line, shows only to a `deploy` token or above.

The plan is the same object that `--dry-run` of the same request prints. Read it before you approve.

`approve` shows the plan, then runs the request **as the agent that asked**, and follows the operation it starts. Before it runs, the agent plans the stored request again. If the plan is no longer the one that was stored (for example because a release was recorded in between, which changes the diff), nothing runs, the approval is marked `failed`, and you ask for a new request. The audit log shows the agent, with `(approved by <you>)` after its name.

`reject` refuses it; nothing runs. `-m` records a reason (up to 200 characters).

- An approval is decided **once**. Approving or rejecting a decided one is refused.
- A request nobody approves **expires after 15 minutes**. `approve` then refuses with `approval expired`. Change the lifetime with `approval_ttl` in the agent's configuration, for example `"approval_ttl": "30m"` (at least `1m`).
- At most 100 requests wait at once. The next is refused with `429`. The newest 500 decided approvals are kept.
- If the agent's token was removed or lost its scope since the request, `approve` runs nothing and marks it `failed`.
- A secret's value is **never** in a plan. Every managed secret value in a request is replaced by `[redacted]` before it is stored or shown. The request itself, which can hold a value, is stored sealed.

The audit log records `approval_request:<summary>` (by the agent), then `approval_approve` or `approval_reject` (by you) or `approval_expired` (by `berthy`).

#### Connect an AI agent through MCP

`berthy mcp` runs an MCP server over standard input and output. A client such as Claude Code or Claude Desktop starts it itself. It calls the agent API with the token it was given, so an AI agent sees what a person sees, with the same errors and the same holds.

Put this in the client's `.mcp.json` (adjust the paths):

```json
{
  "mcpServers": {
    "berthy": {
      "command": "berthy",
      "args": ["mcp", "-e", "prod", "--manifest-dir", "/home/me/todo"],
      "env": { "BERTHY_TODO_PROD_TOKEN": "${BERTHY_TODO_PROD_TOKEN}" }
    }
  }
}
```

The CLI configuration file is the same one as everywhere (`token_env` names the variable). The token comes only from the environment the client runs in; MCP never reads the credential store. Use an agent token made with `berthy token create --agent` so changes can be held for approval. It is never printed and never in a tool result. `--manifest-dir` (default `.`) is where `deploy` reads the manifest and a Compose app's file. The AI agent's `version` for `api` on prod must be a digest.

The tools:

| Tool | Same as | Inputs |
| --- | --- | --- |
| `list_resources` | `ps` | none |
| `describe_resource` | `describe` | `resource_name` (`image:`, `swarm:` or `compose:` prefix when ambiguous) |
| `list_console_logs` | `logs` (no follow) | `resource_name`; `role`, `since`, `grep`, `tail` (default 200, at most 1000) |
| `get_stats` | `stats` and `df` | none |
| `list_deploys` | `history` | `resource_name` |
| `get_deploy_diagnostics` | `diagnostics` | `operation_id` (needs a `deploy` token) |
| `list_backups` | `backup list` | `backup_name` (optional) |
| `wait_for_resources` | `wait --healthy` | `resource_name`; `role`; `timeout` (at most 10m, default 2m) |
| `doctor` | `doctor` | none |
| `list_approvals` | `approvals --all` | none |
| `execute_resource_command` | `deploy`, `rollback`, `restart`, `backup run`, `restore` | see below |

`execute_resource_command` takes `command` (one of `deploy`, `rollback`, `restart`, `backup_run`, `restore`) and the fields that command needs: `resource_name`, `version`, `to` (a release id), `role`, `backup_name`, `backup_key`, `into_volume`, `dry_run`. A field that does not belong to the command, or a missing one, is a tool error before anything reaches the agent. All tools are read-only except this one, and the tools say so in their MCP annotations.

Its result is one of:

- **Done or failed.** The operation is followed for at most 10 minutes: `{"operation_id", "state", "reason"}`. Any state but `succeeded` is marked as a tool error, with a pointer to `get_deploy_diagnostics`.
- **Held.** On a protected environment: `{"status": "held for approval", "approval_id", "expires", "plan"}`. It is not an error. The AI agent must tell the person to run `berthy approve <id>`, and must not retry. The plan of a deploy or rollback has a `diff`, and the text of the answer lists its lines (`changes of <app>:` and one line each), as the text of a `dry_run` of a deploy or rollback does. `list_approvals` shows later whether it was approved, rejected or expired.
- **Plan.** With `dry_run`: `{"dry_run": true, "plan": ...}`. Never held.
- **Refused.** The wrong scope, a held deploy lock, an unknown app: a tool error with the agent's message.

Some commands have no MCP tool on purpose: `scale`, `exec`, `run`, `prune`, `remove`, `destroy`, `lock`, `ingress apply`, `job run`, `cancel`, `job cancel`, `alerts test`, `state-backup`, `key rotate`, `secret`, `recovery resolve`, `approve` and `reject`. An AI agent can deploy, roll back, restart, back up and restore; the rest stays with people and the CLI.

The server also offers three prompts. A client lists them and a person or an agent picks one. Each is a fixed walk through the tools above, filled in with its argument. A prompt only reads.

| Prompt | Argument | What it walks through |
| --- | --- | --- |
| `explain_failed_deploy` | `resource_name` | `list_deploys`, the newest failed deploy, `get_deploy_diagnostics`; then the reason, the evidence and a suggested fix. It never redeploys. |
| `troubleshoot_resource` | `resource_name` | `describe_resource`, recent `list_console_logs`, `doctor`, `get_stats` |
| `health_report` | none | `list_resources`, `doctor`, `list_backups` and the pending approvals: one summary of the environment |

A fix a prompt suggests is a separate `execute_resource_command` call, with its usual holds. Each prompt says what to do when a tool answers 403: the token's scope is too low, and the person decides whether the token gets the scope. For example, `get_deploy_diagnostics` needs a `deploy` token, so a `read` token gets a 403 there. A prompt with an unknown name or a missing argument is refused with an `invalid params` error.

---

### Step 12. The terminal UI

```bash
berthy ui -e prod
```

A full-screen live view, built for reading first. It needs a real terminal (it refuses to start without one), works at 80×24 and up, and follows your terminal's light or dark colours. `NO_COLOR=1` turns colours off; every state also has a glyph and a word, so nothing depends on colour. It uses the same configuration and token as every other command. A `read` token shows every view. The token is never drawn, logged or written.

The header shows the environment, a badge when it is protected, and the host. Four tabs:

| Tab | What it shows |
| --- | --- |
| **Apps** | A table of apps: kind, roles, replicas (running/desired), health (`●` healthy, `◐` starting, `✖` unhealthy, `○` none), version, and the age of the newest backup (red when the last run failed). `/` filters by name. `enter` opens the app's detail: roles and replicas (state, health, restarts, out-of-memory kills), the last ten deploys with the reason of a failed one, its jobs and backups. `l` follows its logs. |
| **Logs** | A picker of apps, then the followed logs of the chosen one: the last 200 lines and what comes, with time, source (role and the first 6 characters of the container id, such as `web.f77449`) and stream (stderr is tinted). `f` pauses and resumes following. `p` shows one replica's lines, then the next one's, then all of them. `/` greps with a regular expression (smart case) over the last 5,000 lines. A dropped stream reconnects by itself. |
| **Server** | Meters for CPU, memory, swap and every mount, load, network and disk traffic, a CPU sparkline, Docker's disk usage, and containers sorted by CPU. |
| **Approvals** | The changes AI agents asked for, those that wait first, with who asked and the time left. `enter` shows the request and its plan, and a countdown. |

The status line shows the connection (`agent unreachable — retrying in 4s` when the agent cannot be reached, keeping the last data on screen), the deploy lock, the oldest successful backup, the pending approvals and the age of the data. `?` shows every key.

| Key | Action |
| --- | --- |
| `tab`, `shift+tab`, `1`-`4` | Switch tabs |
| `↑` `↓` `j` `k`, `pgup` `pgdn` (or `ctrl+u` `ctrl+d`), `g` `G` (or `home` `end`) | Move and scroll |
| `enter`, `esc` | Open, go back |
| `/` | Filter, grep |
| `f` | Follow logs on or off |
| `p` | In the logs, show one replica's lines, then the next, then all |
| `l` | Logs of the selected app |
| `R` | Restart the selected app (a role picker first when an image app has several roles) |
| `b` | Roll back the selected app (a picker of the earlier successful releases first) |
| `a`, `x` | Approve, reject the selected pending request on the Approvals tab |
| `r` | Refresh now |
| `?` | Help |
| `q`, `ctrl+c` | Quit |

#### Actions

The views only read. A change goes through one overlay, and **nothing is sent until you confirm in it**:

1. **Plan.** A restart or rollback asks the agent for the same plan `--dry-run` prints. A rollback first asks which release, from the earlier successful ones.
2. **Confirm.** The plan is drawn in a scrolling pane: the facts (app, image and its whole digest, roles, what will happen) and the full plan. A confirmation follows, with **Cancel** as the default. On a **protected** environment, a rollback and an approval also ask you to **type the environment's name** (`prod`, exactly, case-sensitive) before the confirmation can be reached. A rejection asks for an optional reason.
3. **Run.** The real request is sent. The answer is an operation (followed live), a held request ("Held for approval <id>", with the command a person runs), a result, or a refusal with the agent's message and the scope it needs (`deploy` to restart and roll back, `admin` to approve and reject).
4. **Follow.** The operation's events stream in with a spinner and the time elapsed. It ends with the result ("Restarted api in 12s"), or for a failure, the reason and the command `berthy diagnostics <operation> -e prod`. `esc` while it runs closes the overlay and leaves a note on the status line, `operation <id> continues on the agent`: closing the view does not cancel the operation. For a roll back, and for an approved deploy, rollback or run, `c` offers to cancel it: a confirmation asks "Cancel operation <id>?" and nothing is sent until you answer "Cancel it". The agent says whether it accepted (the operation then ends as `cancelled by <you>`), held it for approval, or refused it with the reason, such as `the deploy already switched traffic`; a refusal leaves the operation going.

`esc` cancels at any time before the confirmation and sends nothing.

---

### Step 13. Update the database or the cache

CI deploys only the API. The other two apps change when you decide, usually to take a security fix.

#### Redis: a cache can be recreated

A CVE is announced for Redis. Edit `deploy/redis.yml`, bump the tag (for example to `redis:7.4.2-alpine`), commit, and:

```bash
berthy deploy redis -e prod --dry-run
berthy deploy redis -e prod
berthy ps -e prod
```

The dry run shows `redis` as `recreate`. That is fine: `redis` is not `stateful`, and a cache can start empty. The API reconnects when it is back. A `deploy` token is enough.

#### Postgres: back up first, then name the recreation

The same fix for Postgres is a deliberate act, because `postgres` is `stateful`. Edit `deploy/postgres.yml`, bump the **minor** tag (for example `postgres:17.2-alpine` to `postgres:17.4-alpine`), commit, and look:

```bash
berthy deploy postgres -e prod --dry-run
```

The plan shows `postgres` as `recreate` and a **blocker** that says the stateful app would be recreated and needs `--allow-recreate` and an admin token. Berthy refuses to go on without them. Take a backup first, then say you mean it:

```bash
berthy backup run main-db -e prod
berthy deploy postgres -e prod --allow-recreate     # needs an admin token
```

The container is replaced and starts on the same `pgdata` volume, so the data stays. A **major** version change (17 to 18) cannot start on the old data directory. Plan that as a dump and restore instead.

Only an `admin` token can pass `--allow-recreate`. On a protected environment an AI agent cannot even ask for it unreviewed: its deploy is held, and the plan carries the blocker.

---

### Step 14. Clean up

#### Prune

```bash
berthy prune -e prod
```

`prune` removes old images and stopped containers now (it needs an `admin` token). It never removes volumes. A deploy already does this after each success, keeping the images of the last `retain` deploys. Containers of finished migration steps and timed-out commands stay until `prune` removes them; their output is already in the diagnostics.

#### Remove one app

```bash
berthy remove redis -e prod --dry-run
berthy remove redis -e prod
```

`remove <app>` takes an app down and removes what Berthy created for it. It needs an `admin` token, takes the deploy lock, and needs no manifest: it works from the app's recorded release. In order:

1. **Routes and DNS records** for the app are removed. Ones Berthy *adopted* are released, not deleted.
2. **Services.** An image app's services are deleted one by one. A Compose app is brought down (`compose down --remove-orphans`) and its project directory deleted.
3. **Volumes, only with `--volumes`.** An image app's named volumes, or a Compose app's non-external named volumes. A volume another container still uses is kept and reported.
4. **State.** The app's bindings and release are forgotten.

It **keeps** volumes (unless `--volumes`), the release history, the audit log and job and backup history (so `history <app>` still works), and the tunnel. A `stateful` app such as `postgres` needs `--allow-recreate` too. Removing an app that is already gone succeeds and changes nothing. A removal that stops partway is finished by running it again. `--dry-run` lists what would be deleted and what kept. The ingress connector cannot be removed this way: remove the `ingress` block from the manifest and run `ingress apply`.

An app that you delete from the manifest keeps running. `doctor` lists it as `orphan_apps`, and `remove` is how you take it down.

#### Destroy an environment

```bash
berthy destroy --project todo -e prod --confirm todo/prod --allow-recreate --dry-run
berthy destroy --project todo -e prod --confirm todo/prod --allow-recreate
```

`destroy` removes everything Berthy created in the environment, as one operation under the lock (an `admin` token). `--confirm` must name the project and the environment, as `project/environment`, or the CLI refuses before it sends anything. `--allow-recreate` is required when a `stateful` app such as `postgres` is among them; without it the dry run shows a blocker and the real destroy removes nothing. In order: every app (as `remove` does, with the same `--volumes` and `--allow-recreate` rules; if any cannot be removed the whole destroy is refused up front and removes nothing); managed ingress (routes, DNS records, the connector); helper containers (not helper images: those belong to the agent); stopped one-off containers; and images this environment pulled that nothing else on the agent retains.

| Flag | Meaning |
| --- | --- |
| `--confirm <project/environment>` | Required. Must equal the hosted environment. |
| `--volumes` | Also delete volumes. Without it, volumes stay. |
| `--allow-recreate` | Required if a `stateful` app is among them. |
| `--tunnel` | Also delete the Cloudflare tunnel, but only when nothing else uses it (no hostname rules, no DNS record pointing at it, no active connection). The result names each reason it was kept. |
| `--dry-run` | Print the whole plan. Change nothing. |

**What it keeps:** every secret (including the Cloudflare token), the state database and history, the shared network, Docker objects Berthy did not create, routes and records that are not Berthy's, and volumes unless `--volumes`. It does not remove the agent or Docker: stop and remove those yourself.

---

### Step 15. Rebuild a server

A server dies. Because Git holds the manifest, and object storage holds the volume backups and the agent's state snapshots, you can rebuild it. You need three things that never lived only on that server:

- the **encryption key** you saved in step 1,
- the **storage credentials** (an S3 access key and secret),
- the **repository**.

The order:

1. **Provision** a new server with the same private address (or a new one, and change `--listen` and the CLI configuration). Berthy does not do this part: the server, its users, its firewall and its VPN are yours.

2. **Restore the agent's state.** It needs neither an agent nor the old server. Put the Berthy binary and your saved key (`berthy.todo.prod.91c0aa11bb22cc33.key`, from `~/.berthy/keys` in step 1) on the new server (mode `0600`), find a snapshot (`todo/prod/berthy-state/<time>.db` in the bucket), and run, as root:

   ```bash
   install -d -m 0700 /var/lib/berthy
   chmod 600 berthy.todo.prod.91c0aa11bb22cc33.key
   BERTHY_S3_ACCESS_KEY=<access key> BERTHY_S3_SECRET_KEY=<secret key> \
     berthy state-restore --project todo \
       --endpoint https://s3.example.com --bucket acme-todo-backups --region eu-central-1 \
       --object todo/prod/berthy-state/20261116T031700Z.db \
       --out /var/lib/berthy/environments/todo/prod/state --key-file ./berthy.todo.prod.91c0aa11bb22cc33.key
   ```

   | Flag | Meaning |
   | --- | --- |
   | `--project <name>` | The project the snapshot belongs to. May be omitted when the manifest in `--manifest-dir` (default `.`) names it, or when only one project in the bucket has the snapshot's environment. |
   | `--manifest-dir <dir>` | Directory of the manifest, used when `--project` is omitted. |
   | `--endpoint <url>` | The S3-compatible endpoint. |
   | `--bucket <name>` | The bucket. |
   | `--region <r>` | The bucket's region, when the storage needs one. |
   | `--object <key>` | The snapshot's key, ending in `.db`. |
   | `--out <dir>` | Where to write the state. Created (mode `0700`) when missing, otherwise it must be empty. |
   | `--key-file <path>` | Your saved key. |

   The credentials come from `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY`. **Flags never carry them**, so they stay out of your shell history and the process list. The command downloads the snapshot and its description file, checks the size and SHA-256, and opens the result with the key. It prints the environment, the schema version, and the **names** of the stored secrets, never their values. A key that is not the one the snapshot needs exits non-zero before the download, with `the snapshot needs key <ID>; <file> is key <ID>`, and leaves nothing behind.

3. **Set up the server with the saved key.**

   ```bash
   berthy setup -e prod --host ops@10.0.0.5 --listen 10.0.0.5:7710 \
     --key-file ~/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key --config ~/.config/berthy/config.json
   ```

   Automatic remote setup wraps the key for the `cli_key` download. This rebuild's `--key-file` path is different: setup streams the key bytes on stdin over SSH, and sudo input recording on the server can capture them.

   Setup makes the managed parent directories traversable by the `berthy` user, installs your key instead of making one, gives the restored state to that user, installs the agent and starts it on that state. Secrets, history and the audit log are back. If a state directory exists but no key, setup stops and tells you to pass `--key-file`; it never replaces a key that is there.

   **The tokens you made with `berthy token create` are part of the state.** The snapshot holds their digests, so your CI and AI agent tokens work again as soon as the restored agent starts, with the values you already gave them. Only the first `admin` token lives in the agent's configuration, so setup makes a new one. A confirmed credential-store save suppresses it by default. If the save is unavailable or unconfirmed, setup prints it; `--show-token` prints it as well. A token whose expiry has passed is still refused.

4. **Check:** `berthy doctor -e prod`.

5. **Redeploy the apps.** The new server has no containers. Deploy `redis`, then `postgres`, then `api`, as in step 4. `api` needs a digest as before. The restored state already holds the manifest, so schedules, probes and backups resume as soon as the apps exist. If you use managed ingress, run `berthy ingress apply` to bring the connector back.

6. **Restore the data.** The new `postgres` starts with an empty database. List the backups, restore the newest dump into a new volume, and load it, as in step 10:

   ```bash
   berthy backup list -e prod
   berthy restore <key> --into todo-restore -e prod
   ```

   Then follow the PostgreSQL recovery recipe, and run `berthy wait api --healthy -e prod` once the API is back.

Volumes come back **separately** from the agent's state, with `berthy restore`. Check that the apps recovered, deploys work, alerts reach you, and the next scheduled backup runs.

Practise this on a test server before you need it.

---
## 5. Reference

### Commands

Every command that talks to an agent needs `-e <env>`, or else `$BERTHY_ENV` when `-e` is not given. A given `-e` wins. It picks the project with `--project`, else from the manifest directory, else the only project that has that environment. It reads the CLI configuration file that [How to read the commands](#how-to-read-the-commands) describes; `--config <file>` names another. The tables list only the other flags. Most commands take `--json`.

A name from the manifest's `aliases` runs the command line it stands for; see [Aliases](#aliases). It is expanded before any flag is checked. Quotes are not interpreted, `-e` and `--config` are not allowed in it, the environment comes from `-e` or `$BERTHY_ENV` as for other agent commands, the arguments you give after the name are appended, and the MCP server does not offer it.

Scope is the least token that may run the command. `read` < `deploy` < `admin`.

#### Read

| Command | Scope | Flags and arguments | What it does |
| --- | --- | --- | --- |
| `ps` | read | | Apps, roles, replicas, health, running version, backup ages. |
| `describe <app>` | read | | One app in full: roles, tasks, last deploys, job results, and the drift from its applied release. |
| `logs <app>` | read | `--follow`/`-f`, `--tail <n>`, `--since <duration or time>`, `--grep <regex>`, `--role <name>`, `--replica <id>` | Container logs, read from Docker. |
| `stats` | read | `--watch`, `--since <duration up to 1h>` | Server and container metrics. |
| `df` | read | | Disk space and Docker disk usage. |
| `history <app>` | read | `--diff <release id> [<other release id>]` | Releases and failed deploys, with reasons and operation ids. With `--diff`, what a release changes compared with another. |
| `wait <app>` | read | `--healthy`, `--role <name>`, `--timeout <duration up to 10m>` | Block until the app is healthy. Exit 0 when it is. |
| `doctor` | read | | The agent's own checks. Exit 1 when a critical one fails. |
| `checks` | read | | Stored state of every probe and built-in condition. |
| `jobs` | read | | Every job, its schedule, next occurrence and last run. |
| `audit` | read | | The last 100 changes: who, what, when, outcome. |
| `agent-info` | read | | Environment, host, protected flag, agent version. |
| `lock status` | read | | Whether the deploy lock is held, by whom and why. |
| `backup list` | read | `--backup <name>` | Backups in object storage, with their keys. |
| `ingress status` | read | | Tunnel health, connectors, hostnames and DNS records. |
| `approvals` | read | `--all` | Held changes (the plan column needs `deploy`). |
| `versions <app>` | admin, not an agent token | `--manifest-dir`, `--json` | List the image app's registry tags through the agent. One tag per line, or one JSON document. |

#### Change

Every one of these also reads `-e` and `--config`. All accept `--json` except `secret set` with no name. **A change command refuses any other flag it does not read.** It exits `2` with `<flag> is not a flag of <command>` before anything is sent. So `berthy approve <id> --dry-run` does not approve for real: it is refused. The last column is the flags each command reads, exactly.

| Command | Scope | Flags it reads | What it does |
| --- | --- | --- | --- |
| `deploy <app>` | deploy | `--dry-run`, `--request-id`, `--manifest-dir`, `--version`, `--commit`, `--adopt`, `--replace-existing`, `--allow-recreate` | Deploy an image app or a Compose app. On a protected environment a human admin may give a tag. After checkout is frozen the CLI resolves that tag, shows the pinned digest and plan, and asks before admission. CI and agent tokens still give a digest. |
| `deploy` (no app) | deploy | `--dry-run`, `--manifest-dir`, `--version` (repeatable, `<app>=<ref>`), `--commit` | Deploy every app of the manifest in `depends_on` order and stop at the first failure. An image app given no version keeps the one it runs. An interactive protected selection checks every plan before one confirmation. A plain or digest batch submits in order after preflight. Refuses `--adopt`, `--replace-existing`, `--allow-recreate` and `--request-id`. |
| `promote <app>` | deploy | `--from` (required), `--dry-run`, `--request-id`, `--manifest-dir`, `--commit` | Deploy the applied release of the same app in `--from` to this environment after a pinned preview and confirmation. |
| `apply` | deploy | `--dry-run`, `--manifest-dir`, `--commit` | Apply the environment settings of the manifest (probes, peers, alerts, destinations, telemetry and the rest) without deploying an app. Prints the changes, or `no changes`. Refused while the lock is held. |
| `rollback <app>` | deploy | `--dry-run`, `--request-id`, `--to`, `--revert-schema`, `--adopt`, `--replace-existing`, `--allow-recreate` | Return to the previous release, or the one named by `--to`. The environment's settings stay as they are. |
| `restart <app>` | deploy | `--dry-run`, `--request-id`, `--role` | Restart an app's tasks or containers. |
| `scale <app>` | deploy | `--dry-run`, `--request-id`, `--role`, `--replicas` (required) | Change the replica count of an image app. (`--manifest-dir` is accepted and not read.) |
| `diagnostics <operation id>` | deploy | none | Evidence of a failed operation. |
| `lock acquire` | deploy | `--dry-run`, `-m`/`--message` (required) | Freeze deploys. |
| `lock release` | deploy | `--dry-run` | Let deploys run again. It refuses `-m`. |
| `ingress apply` | deploy | `--dry-run`, `--request-id`, `--manifest-dir`, `--commit`, `--replace-existing` | Create or repair the tunnel and connector, and sync routes and DNS. |
| `job run <name>` | deploy | none | Run a job now and wait. Exit 0 only on success. |
| `job logs <name>` | deploy | `--run` | Print the output kept of a failed or timed-out run of a job. `--run` names a run; without it, the newest run that kept output. |
| `job cancel <name>` | deploy | none | Stop the run of a job that is in progress. It records the run as failed with `cancelled by <token name>`. |
| `cancel <operation id>` | deploy | `--dry-run` | Stop a running operation while it can still be undone cleanly, wait for it to end and print how. Refused with the reason after its point of no return. |
| `backup run <name>` | deploy | none | Run a volume backup now and wait. Exit 0 only on success. |
| `alerts test` | deploy | none | Send a test message to every alert channel (Telegram, webhook) and report each. Exits 1 when a channel failed. |
| `exec <app> -- <command>` | admin | `--dry-run`, `--request-id`, `--role`, `--service` | Run a command in a running container: of an image app's role (`--role`), or of a Compose app's service (`--service`). |
| `run <app> -- <command>` | admin | `--dry-run`, `--request-id`, `--role`, `--timeout` | Run a command in a new container of the app's applied release, with its environment and the role's limits and named volumes, and remove the container afterwards. Image apps only. `--timeout` defaults to `1h` and runs from `1s` to `24h`. |
| `prune` | admin | `--dry-run`, `--request-id` | Remove old images and stopped containers now. |
| `remove <app>` | admin | `--dry-run`, `--request-id`, `--volumes`, `--allow-recreate` | Take an app down and remove what Berthy created for it. |
| `destroy` | admin | `--dry-run`, `--request-id`, `--confirm` (required), `--volumes`, `--allow-recreate`, `--tunnel` | Remove everything Berthy created in the environment. |
| `secret set <NAME>` | admin | `--dry-run`, `--registry`, `--manifest-dir`; the value is typed at a hidden prompt or piped on standard input | Store a secret. Setting a registry password again keeps its registry and updates the running services. |
| `secret set` (no name) | admin | `--manifest-dir`; terminal input required, no `--json` or `--dry-run` | Generate declared secrets and ask for each unmet value. |
| `secret generate <NAME>` | admin | `--dry-run`, `--replace`, `--bytes` (16 to 256, default 32), `--format` (`hex`, `base64` or `alnum`), `--manifest-dir` | Make a random secret on the server and store it. The value is never shown. A stored name is refused unless `--replace`. A registry password is refused. |
| `secret generate` (no name) | admin | `--dry-run`, `--manifest-dir` | Generate each secret declared under `secrets` that is not stored and whose apps were never deployed here. Prints one line per secret; `--json` prints the agent's document. |
| `secret import` | admin | `--dry-run`; standard input is `NAME=value` lines | Store every line of standard input as a secret, all or nothing. A registry password name is refused. |
| `secret list` | admin | `--manifest-dir` | List secret names (never values). With `--manifest-dir`, also the secrets the manifest needs that are missing or unusable, including registry association conflicts. |
| `secret rm <NAME>` (or `delete`) | admin | `--dry-run` | Remove a secret. |
| `restore <key>` | admin | `--dry-run`, `--request-id`, and `--into` or `--exec` (one is required); with `--exec`: `--service` or `--role`, `--timeout`, and the command after `--` | Restore a backup into a new volume, or stream a command backup into a command. |
| `state-backup` | admin | none | Snapshot the agent's state now and wait. |
| `key rotate` | admin, not an agent token | `--dry-run` | Replace the encryption key of the agent's state, [as step 10 says](#rotate-the-encryption-key). |
| `recovery resolve <operation id>` | admin | `--dry-run`, `-m`/`--message` (required) | End an operation stuck in recovery as failed and release its lock. |
| `token create <name>` | admin, not an agent token | `--dry-run`, `--scope` (default `read`), `--agent`, `--expires` | Make a token. The value is printed once. It works at once. `--expires` is `90d`, a Go duration such as `36h`, or a date. |
| `token list` | admin | none | Every token: name, scope, agent mark, where it is defined (`config` or `api`), created, expires and last used. Never a token or digest. |
| `token revoke <name>` | admin, not an agent token | `--dry-run` | Remove an `api` token. A `config` token, and the last `admin` token, are refused. |
| `approve <id>` | admin, not an agent token | none | Run a held change as the agent that asked, and follow it. |
| `reject <id>` | admin, not an agent token | `-m`/`--message` | Refuse a held change. |

The read commands in the tables above (`wait`, `history`, `audit`, `lock status`, `ingress status`, `backup list`, `approvals`) are refused unknown flags in the same way.

Using `--allow-recreate`, `--adopt`, `--replace-existing` or `--revert-schema` also needs an `admin` token, whatever command carries it.

Flags that belong to one command only: `--revert-schema` (`rollback`), `--commit` (`deploy`, `apply`, `ingress apply` and `promote`), `--version` (`deploy`), `--from` (`promote`), `--to` (`rollback`), `--confirm` and `--tunnel` (`destroy`), `--into` and `--exec` (`restore`), `--registry` (`secret set <NAME>`), `--replace`, `--bytes` and `--format` (`secret generate <NAME>`), `--replicas` (`scale`), `--run` (`job logs`), `--volumes` (`remove` and `destroy`), `--all` (`approvals`), `--backup` (`backup list`), `--scope`, `--agent` and `--expires` (`token create`).

`--dry-run` prints the plan and changes nothing. It is available only where the table lists it. For `secret generate <NAME>`, a dry run also says when a real run would be refused without `--replace`. `backup run`, `job run`, `job cancel`, `state-backup`, `alerts test`, `approve` and `reject` have no dry run, so they refuse it. `--request-id` is for retries; the CLI makes a fresh one for each command.

#### Local (no agent)

| Command | Flags | What it does |
| --- | --- | --- |
| `setup` | `-e`, `--project`, `--host`, `--local`, `--listen` (first run), `--config`, `--manifest-dir`, `--network`, `--protected`, `--no-install-docker`, `--dry-run`, `--json`, `--verbose`, `--binary`, `--key-file`, `--new-token`, `--show-token` | Prepare a server and install or upgrade the agent, or add a hosted environment to one that already runs, over SSH or on the server. Exit 0 all steps fine, 1 a step failed, 2 wrong command line. Run one setup at a time against a server. |
| `context add` | `--project`, `-e`, `--url`, `--token-env`, `--save-token`, `--config` | Add or replace one environment of one project in the CLI configuration. Prints `added`, `updated`, or `already`. With `--save-token`, reads the token and saves it in the credential store. Needs no agent. |
| `context list` | `--config`, `--json` | One row per context: project, environment, URL, token variable, `yes` or `no` for whether the variable is set, and `stored`, `not stored`, or `unknown` for the stored token. Never a token. An empty or missing file prints nothing. |
| `context remove` | `--project`, `-e`, `--config`, `--delete-token` | Remove one context from the CLI configuration. `--delete-token` deletes its stored token first. |
| `version` | `--json` | The CLI's version and platform. |
| `config validate` | `-e`, `--manifest-dir` | Check the merged manifest. Prints `manifest valid`. |
| `config show` | `-e`, `--manifest-dir`, `--json`, `--origin` | Print the merged manifest. With `--origin`, one line per value with the file and line that set it, or `default`. |
| `config schema` | `--overlay` | Print a JSON Schema (draft-07) of the manifest, or with `--overlay` of an overlay, for an editor. Needs no `-e`. |
| `docs` | an optional section name | Print the manifest reference, or one section of it, such as `docs backups`. |
| `agent token` | `--project`, `-e`, `--agent`, `--name`, `--scope read\|deploy\|admin`, `--config` | Make a token offline and print it once, with its digest and the object for the `tokens` list of `agent.json`, and a `context add` line for another machine. No agent, no network. To make a token on a running agent, use `token create`. |
| `state-restore` | `--project`, `--manifest-dir`, `--endpoint`, `--bucket`, `--region`, `--object`, `--out`, `--key-file` | Rebuild the agent's state from a snapshot. `--project` may be omitted when the manifest or the bucket names one project for the snapshot's environment. Credentials from `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY`. |
| `agent` | `--config <file>` | Run the agent (Linux only). `berthy.service` runs this. |
| `ui` | `-e`, `--config` | The terminal UI. |
| `mcp` | `-e`, `--config`, `--manifest-dir` | The MCP server on standard input and output. |

`setup` is the only command that uses SSH. It uses your own `ssh`, needs root or passwordless `sudo` on the server, is not available through the API or MCP, and is not recorded in the agent's audit log (the server's SSH and `sudo` logs record it). `context` edits the CLI configuration on this machine and contacts no agent. Every other command goes through the agent's API.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Done. For `deploy`, `rollback`, `restart` and the like: the operation `succeeded`. For `job run`, `backup run`, `state-backup`: the run succeeded. For `doctor`: no critical check failed. |
| `1` | Failed: the operation `failed`, `rolled_back`, `interrupted` or needs `recovery_required`; the agent refused (the message says why); the agent could not be reached; the CLI configuration file could not be read (the message names it); a setup step failed. |
| `2` | The command line is wrong: an unknown flag, a missing argument, a missing `-e`. |
| `3` | Held for approval: an AI agent's token asked for a change on a protected environment. Not done, not failed. |

### Manifest keys

The manifest is `berthy.yml` plus `berthy.<env>.yml`. Unknown keys are errors. "Required" means the manifest is refused without the key, once the section that holds it is there. The tables below are generated from one definition, `internal/manifest/keys.go`: do not edit them here. `berthy docs [section]` prints the same reference in a terminal, and `berthy config schema` prints a JSON Schema of the manifest for your editor (see [Look up a key](#look-up-a-key-and-check-it-in-your-editor)).

<!-- BEGIN GENERATED: manifest reference. Edit internal/manifest/keys.go and run: go generate ./internal/manifest -->

#### Top level

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `project` | name | required | The project's name, which prefixes service and Compose project names. Lowercase letters, digits, `_` and `-`, at most 63 characters, starting with a letter or digit. |
| `network` | name | `<project>-<environment>` | Override the environment network to adopt an existing overlay network. `berthy setup` creates it when it does not exist. |
| `protected` | boolean | `false` | Protect the environment: digest-only deploys, and changes that an AI agent's token asks for are held for approval. |
| `registries` | map | none | Registry credentials, by registry host. |
| `secrets` | map | none | Secrets Berthy may generate, by name. Each must be read by an app. |
| `apps` | map | required | The apps, by name. At least one. |
| `jobs` | map | none | Scheduled or on-demand commands, by name. |
| `backups` | map | none | Volume backups, by name. |
| `destinations` | map | none | Object storage for backups and state backups, by name. |
| `state_backup` | map | none | Snapshots of the agent's own state. |
| `telemetry` | map | none | OpenTelemetry export of metrics and operation records. |
| `probes` | map | none | Scheduled checks, by name. |
| `peers` | map | none | Other agents to watch, by name. |
| `alerts` | map | none | Where alerts go. |
| `ingress` | map | none | Managed Cloudflare Tunnel. |
| `aliases` | map | none | Short names for command lines, for people at a terminal. At most 64. The MCP server does not offer them. See [Aliases](#aliases). |
| `aliases.<alias>` | string | none | The command line the alias stands for: a command that talks to an agent, then its arguments, separated by spaces. Quotes are not interpreted, and `-e` and `--config` are not allowed. |
| `min_version` | version | none | The oldest Berthy release the manifest works with, such as `0.9.0`. The CLI and the agent refuse a manifest that needs a newer release. See [the top of `berthy.yml`](#the-top-of-berthyyml). |
| `timezone` | string | `UTC` | The time zone every `schedule` is read in, as an IANA name such as `Europe/Lisbon`. A time that does not exist on a day, because the clocks go forward, is skipped. A time that happens twice, because they go back, runs once, the first time. See [Scheduled commands](#step-9-scheduled-commands). |

#### `registries.<host>`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `username` | string | required | The user name for the registry. |
| `password_secret` | secret name | required | The secret that holds the password. Store it with `berthy secret set NAME --registry <host>`. |

#### `secrets.<SECRET>`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `generate` | map | required | Generated by `berthy setup` at a terminal and by `berthy secret generate` without a name, only while the secret is not stored and no app that reads it was ever deployed. |
| `generate.format` | string | required | How the value is encoded: `hex`, URL-safe `base64` without padding, or `alnum`. One of `hex`, `base64`, `alnum`. |
| `generate.bytes` | integer | `32` | How many random bytes (for hex and base64) or characters (for alnum), from 16 to 256. |

#### `apps.<name>`

| Key | Applies to | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `kind` | both | string | required | The kind of app: an image app runs as Swarm services, a Compose app as a Docker Compose project. One of `image`, `compose`. |
| `image` | image | string | required | The image's repository, with no tag or digest. |
| `roles` | image | map | required | The app's roles, by name, at least one. A role is a set of containers that run the image with a command, replicas and health check of its own. |
| `file` | compose | string | required | The Compose file's path, relative to the manifest directory. No `..`. |
| `project_name` | compose | name | `<project>-<environment>-<app>` | The Compose project name. Never change it once the app holds data. |
| `stateful` | compose | boolean | `false` | Recreating or removing the app needs `--allow-recreate` and an `admin` token. |
| `depends_on` | both | list | none | The apps that `berthy deploy` without an app deploys before this one. Each must be another app of the manifest, listed once, with no cycle. It orders nothing else. |
| `env` | both | map | none | The environment of the app's containers. |
| `env.plain` | both | map | none | Variables with a value written in the manifest, which is reviewed like code. Names that start with `BERTHY_` are reserved. |
| `env.plain.<VAR>` | both | string | none | The variable's value. |
| `env.secret` | both | list | none | Secrets whose values the containers get, kept in the agent. An entry is a secret's name, which is also the variable's name, or a one-key map from a variable to a secret's name, such as `DATABASE_URL: API_DATABASE_URL`. No variable twice, and none that is also in `plain`. |
| `env.template` | both | map | none | Variables whose value is built from secrets. The agent fills a template in when it deploys. The manifest and the release keep the template, and the filled value is a secret: it is redacted like one. A variable is in one of `plain`, `secret` and `template`. Names that start with `BERTHY_` are reserved. |
| `env.template.<VAR>` | both | string | none | The variable's template: text with `${NAME}` where the value of the secret NAME goes, such as `postgres://app:${DB_PASSWORD}@db:5432/app`. `$$` writes one `$`, and any other `$` is an error. There are no defaults, no nesting and no references to variables. A reference cannot ask for URL encoding: the hex value `berthy secret generate` makes by default needs none, but a password with `@` or `/` does, so use one that has none. |
| `deploy` | image | map | none | How a rollout of a new version runs. |
| `deploy.deploy_timeout` | image | duration | `120s` | The longest a new version may take to become healthy. |
| `deploy.drain_timeout` | image | duration | `30s` | Time the old version gets to finish its requests. |
| `deploy.start_attempts` | image | integer | `3` | Failed task starts that a rollout tolerates before it gives up, from 1 to 10. |
| `deploy.order` | image | string | none | How an update replaces each role's old version. `start-first` starts the new one beside the old one. `stop-first` stops the old one before the new one starts, so two versions never write a volume at once. Empty: `stop-first` for a role that mounts a read-write volume, and `start-first` for any other role. `config validate` warns about `start-first` on a role with a read-write volume, and about more than one replica of one. One of `start-first`, `stop-first`. |
| `deploy.verify` | image | boolean | `true` | Whether a deploy checks, once the new version serves, that each role with a `port` answers on the shared network and that each of its `hostnames` answers from outside. A check that fails only warns: the deploy still succeeds. `false` turns both off. |
| `deploy.retain` | image | integer | `5` | The number of deploys whose images are kept, at least 1. |
| `hooks` | image | map | none | Steps that run around a deploy. An overlay's list replaces the base manifest's. |
| `hooks.pre_deploy` | image | list | none | Steps that run in order before the new version starts. A failed step stops the deploy. |
| `hooks.post_deploy` | image | list | none | Steps that run in order after the new version is serving. |
| `migrations` | image | map | none | Database migrations, which run as a step of the deploy after the pre-deploy hooks. |

#### `apps.<name>.roles.<role>`

Roles belong to image apps.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `service` | name | `<project>-<environment>-<app>-<role>` | The name of the role's Swarm service. Set it to adopt an existing service. |
| `command` | list | the image's | The container's command, as a list. |
| `entrypoint` | list | the image's | The container's entrypoint, as a list. `command` is passed to it as arguments. |
| `user` | string | the image's | The user the container runs as: a name or a number, with a group after a colon, such as `1000:1000`. |
| `replicas` | integer | `1` | The number of replicas, at least 1. |
| `port` | integer | none | The port the role listens on, from 0 to 65535. Needed for `hostnames`. |
| `health` | map | none | The container health check, with the fields Docker uses. A new version must pass it before it takes traffic. |
| `health.test` | list | required | The command, as a list that starts with `CMD` or `CMD-SHELL`. Exit code 0 means healthy. The image must contain the command. |
| `health.interval` | duration | `30s` | Time between checks. |
| `health.timeout` | duration | `30s` | The longest one check may take. |
| `health.start_period` | duration | `0s` | Grace time after the container starts. Failures in it do not count. |
| `health.start_interval` | duration | `Docker's` | Time between checks during the start period. Check that your Docker version supports it for Swarm services. |
| `health.retries` | integer | `3` | Failed checks in a row before the container is unhealthy, at least 1. |
| `volumes` | list | none | Named volumes to mount, each `name:/absolute/path`, with `:ro` or `:rw` at the end. A named volume, never a host path. |
| `resources` | map | none | Resource limits of each container. |
| `resources.cpu` | string | no limit | Cores, as a string such as `"0.5"`. |
| `resources.memory` | string | no limit | Memory, such as `512M`, `1G` or `256MiB`. |
| `hostnames` | list | none | Public hostnames of the role. They need `ingress` and `port`. A hostname belongs to one role. |
| `logging` | map | none | The log driver and options of the role's containers. They replace Berthy's default log rotation, which is `max-size: 10m` and `max-file: 3` on `json-file` or `local`; any other driver gets nothing from Berthy unless the role sets `logging`. |
| `logging.driver` | string | required | The Docker log driver, such as `json-file`, `local` or `journald`, or a plugin image. |
| `logging.options` | map | none | Driver options, as strings, such as `max-size: 50m` and `max-file: "5"`. The role gets exactly these options. Quote a number. |
| `logging.options.<option>` | string | none | The option's value, at most 1024 bytes. |

#### Hooks and migrations

Hooks and migrations belong to image apps. A step is either `backup` or `run`, never both.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hooks.pre_deploy[].backup` | name | none | The step runs the backup of this name and waits for it. The name must be a key of `backups`. A `backup` step takes no other setting. |
| `hooks.pre_deploy[].run` | list | none | The step runs this command, as a list, in a container of the new image with the app's environment. |
| `hooks.pre_deploy[].timeout` | duration | `5m` | A `run` step: the time limit of each attempt, from `1s` to `24h`. A command that runs past it is never retried, because it may still be running. |
| `hooks.pre_deploy[].retries` | integer | `0` | A `run` step: how many more times the command runs after it exits non-zero, from 0 to 5. Set it only for a command that is safe to run again. |
| `hooks.post_deploy[].backup` | name | none | The step runs the backup of this name and waits for it. The name must be a key of `backups`. A `backup` step takes no other setting. |
| `hooks.post_deploy[].run` | list | none | The step runs this command, as a list, in a container of the new image with the app's environment. |
| `hooks.post_deploy[].timeout` | duration | `5m` | A `run` step: the time limit of each attempt, from `1s` to `24h`. A command that runs past it is never retried, because it may still be running. |
| `hooks.post_deploy[].retries` | integer | `0` | A `run` step: how many more times the command runs after it exits non-zero, from 0 to 5. Set it only for a command that is safe to run again. |
| `migrations.version` | list | required | The command that prints one line naming the current schema state. Berthy stores the line and never interprets it. |
| `migrations.apply` | list | required | The command that brings the schema to the latest state the image knows. |
| `migrations.revert` | list | none | The command that brings the schema back to a given state, which `berthy rollback --revert-schema` uses. Exactly one argument must be the standalone word `{target}`. |
| `migrations.timeout` | duration | `5m` | The time limit of each migration command, from `1s` to `24h`. |
| `migrations.retries` | integer | `0` | How many times a failed `apply` runs again, from 0 to 5. `version` and `revert` are never retried. |

#### `jobs.<name>`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `app` | name | required | The app the job runs in. |
| `role` | name | none | For an image app: the role whose environment, limits and named volumes the job container takes. Needed when the app has several roles. Not with `service`. |
| `service` | name | none | For a Compose app: the service that runs the command. Not with `role`. |
| `schedule` | string | on demand | A five-field cron expression, read in the manifest's `timezone`, UTC by default. Without it the job runs only on demand. |
| `command` | list | required | The command to run, as a list. An image app runs it in a new container of its applied release, and a Compose app in its service's container. |
| `timeout` | duration | `1h` | The time limit of a run, from `1s` to `24h`. A run past it is stopped; for an image app that stops its container. |

#### `backups.<name>`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `app` | name | required | The app that mounts the volume, or that the command runs in. |
| `volume` | string | none | What to back up: a volume, archived whole. For a Compose app, the key in the Compose file's top-level `volumes`; Berthy works out the real Docker name. For an image app, the name of a volume one of its roles mounts. A backup has exactly one of `volume` and `command`. |
| `command` | list | none | What to back up instead of a volume: a command whose standard output is the backup, such as a database dump. The output is compressed and sent to the destination as it is produced, with nothing written to the server's disk. A command that exits non-zero, or writes nothing, fails the backup and nothing is kept. Restore it with `berthy restore KEY --exec`. |
| `service` | name | none | For a command backup of a Compose app: the service whose running container runs the command. Not with `role`. |
| `role` | name | none | For a command backup of an image app: the role whose environment, limits and named volumes the command's new container takes. Needed when the app has several roles. Not with `service`. |
| `timeout` | duration | `1h` | For a command backup: the time limit of the command, from `1s` to `24h`. A command past it is stopped and the backup fails. |
| `schedule` | string | on demand | A five-field cron expression, read in the manifest's `timezone`, UTC by default. Without it the backup runs only on demand or from a deploy hook. |
| `destination` | name | required | A key of `destinations`. |
| `prefix` | string | `<app>/<volume>` | Where the backup's objects sit in the bucket, under `<project>/<environment>/`. A command backup has `<app>/command` in place of `<app>/<volume>`. |
| `before` | name | none | For a volume backup: a job to run first, such as one that dumps a database. If it fails, the backup fails and nothing is uploaded. A command backup needs no such job. |
| `retention` | map | none | How many backups to keep. |
| `retention.keep` | integer or all | `all` | `all`, or a whole number of at least 1: keep that many of the newest successful backups. |

#### `destinations.<name>`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | string | required | The kind of storage: any S3-compatible object storage. One of `s3`. |
| `endpoint` | string | `AWS` | `https://host[:port]`, with no path. `http://` is accepted only for localhost or a loopback address. Leave it out for AWS. |
| `region` | string | none | The bucket's region, when the storage needs one. |
| `bucket` | string | required | The bucket's name: 3 to 63 characters of lowercase letters, digits, `.` and `-`, starting and ending with a letter or digit. |
| `access_key_secret` | secret name | required | The secret that holds the access key. |
| `secret_key_secret` | secret name | required | The secret that holds the secret key. |

#### `state_backup`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `destination` | name | required | A key of `destinations`. |
| `prefix` | string | `berthy-state` | The object prefix of the snapshots, under `<project>/<environment>/`. |
| `schedule` | string | 17 3 * * * | A five-field cron expression, read in the manifest's `timezone`, UTC by default. The default is daily at 03:17. |
| `keep` | integer | `14` | The number of snapshots kept, from 1 to 1000. |

#### `probes.<name>`

A probe has exactly one of `http`, `tcp` and `service`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `http` | string | none | A URL, `http` or `https`, with a host. |
| `tcp` | string | none | `host:port`, with a port from 1 to 65535. |
| `service` | map | none | A role or Compose service on the shared network, reached by the overlay helper. A Compose service must join the shared network. |
| `service.app` | name | required | The app, which must be in the manifest. |
| `service.role` | name | none | The role, or for a Compose app the service. May be left out when the app has one role. |
| `service.port` | integer | required | The port, from 1 to 65535. |
| `service.path` | string | none | The path to request. It starts with `/`. |
| `expect_status` | list | any 200 to 399 | The status codes that count as healthy, each from 100 to 599. |
| `interval` | duration | `30s` | Time between runs. At least `5s`. |
| `timeout` | duration | `5s` | The longest one run may take. Shorter than `interval`. For a `service` probe, from `1s` to `25s`. |
| `failures` | integer | `3` | Failed runs in a row before the state changes, at least 1. |

#### `peers`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `<name>` | string | none | The base URL of another agent to watch: `http` or `https`, a host and a port, and no path, query or user. |

#### `alerts`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `reminder` | duration | `4h` | How often to repeat an alert while its check keeps failing, on every channel. `0s` turns reminders off. |
| `deploys` | string | `failed` | Which deploys and rollbacks send a message when they end, on every channel. One of `failed`, `all`, `none`. |
| `telegram` | map | none | Alerts to one Telegram chat. |
| `telegram.bot_token_secret` | secret name | required | The secret that holds the bot token. |
| `telegram.chat_id` | string | required | A numeric chat ID, or `@channel_name`. Quote it. |
| `webhook` | map | none | Alerts as an HTTP POST of a small JSON document: `environment`, `kind` (`check` or `deploy`), `name`, `state`, `detail`, `since` and `text`, the line Telegram would get. It holds no application output and no secret value. |
| `webhook.url_secret` | secret name | required | The secret that holds the URL, an `http` or `https` URL with a host. The URL is often the credential, so it is never in the manifest. |
| `heartbeat` | map | none | Dead man's switch: the agent sends one `GET` to a URL every `interval` while it runs and Docker answers, with a 5-second timeout and no retries. A service that watches for the pings raises the alarm when they stop. `berthy checks` and `doctor` show a `heartbeat` entry with the time of the last accepted ping. It is `unknown` when the URL cannot be reached, and it never alerts. |
| `heartbeat.url_secret` | secret name | required | The secret that holds the URL, an `http` or `https` URL with a host. A 2xx answer counts as accepted. |
| `heartbeat.interval` | duration | `1m` | Time between pings. At least `10s`. A change applies within a minute. |
| `webhook.headers_secret` | secret name | none | The secret that holds request headers, `name=value,name=value`, for example an `Authorization` header. |

#### `telemetry`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `otlp_endpoint` | string | required | The collector's OTLP endpoint. The agent runs on the host, so it must be an address the host can reach; a Docker service name does not resolve there. |
| `headers_secret` | secret name | none | The secret that holds request headers in the `OTEL_EXPORTER_OTLP_HEADERS` form, `name=value,name=value`, for backends that need authorization. |

#### `ingress`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cloudflare` | map | required | Managed ingress: Berthy owns the tunnel, the connector that runs on the server, the hostname routes and the DNS records. |
| `cloudflare.account_id` | string | required | The Cloudflare account that owns the tunnel. |
| `cloudflare.api_token_secret` | secret name | required | The secret that holds the Cloudflare API token. |
| `cloudflare.image` | string | required | The connector's image, with a tag or a digest. |
| `cloudflare.replicas` | integer | `1` | The number of connectors, at least 1. |
| `cloudflare.tunnel` | name | `<project>-<environment>` | The tunnel's name in Cloudflare. |
| `cloudflare.dns` | boolean | `true` | Whether Berthy creates the DNS records. |

<!-- END GENERATED: manifest reference -->

#### Limits and reserved names

- The manifest, and each overlay, are at most 1 MiB. YAML nesting at most 64 levels.
- A Compose file is at most 512 KiB, UTF-8, with no NUL.
- The secret name `TUNNEL_TOKEN` and the app name `ingress` (with managed ingress) are reserved.
- Environment names that start with `BERTHY_` are reserved for the variables Berthy sets (see Environment in step 2).
- A secret value is at most 64 KiB.

### Agent configuration

The agent reads one JSON file, `/etc/berthy/agent.json`, which `berthy setup` writes. It must not be readable by group or others (mode `0600`). Unknown keys are errors. You normally do not edit it: tokens are made with `berthy token create`. An `agent.json` of a release before projects (one environment at the top level, no `environments` list) is refused: set the server up again with `berthy setup` after [moving the old install aside](#a-server-set-up-before-projects).

| Key | Required | Meaning |
| --- | --- | --- |
| `listen` | yes | `address:port`. The address must be a loopback, private or VPN (`100.64.0.0/10`) IP, never `0.0.0.0`. |
| `docker_socket` | no | Path to the Docker socket. Default `/var/run/docker.sock`. |
| `approval_ttl` | no | How long a held request waits, a Go duration of at least `1m`. Default `15m`. |
| `compose_command` | no | The Compose command as a list. Default `["docker", "compose"]`. The Compose plugin must be installed system-wide, or this must name a standalone Compose binary. |
| `cloudflare_api_url` | no | Overrides the Cloudflare API base URL. `https`, or `http` on a loopback host. For tests. |
| `telegram_api_url` | no | Overrides the Telegram Bot API base URL. Same rule. For tests. |
| `environments` | yes, at least one | List of hosted environments. Each entry is below. A (project, environment) pair, a `state_dir`, a `key_file` and a `network` each appear once in the file. |

Each entry of `environments`:

| Key | Required | Meaning |
| --- | --- | --- |
| `project` | yes | The project name. |
| `environment` | yes | The environment name, such as `prod`. |
| `state_dir` | yes | Directory of this environment's state (SQLite). Setup uses `/var/lib/berthy/environments/<project>/<environment>/state`. |
| `key_file` | yes | The 32-byte encryption key for that state. Setup uses `/var/lib/berthy/environments/<project>/<environment>/key`. Every hosted environment has state and a key. |
| `protected` | no | `true` marks the environment as protected from the first start. |
| `network` | no | The shared network of this hosted environment. `doctor` checks it. Setup writes it from the manifest, or defaults it to `<project>-<environment>`. |
| `tokens` | yes, at least one | List of `{"name": ..., "digest": <64 hex>, "scope": "read"\|"deploy"\|"admin", "agent": true\|false}`. `name` and `agent` are optional. Digests must be unique across the whole file, and so must names within one entry (letters, digits, `.`, `-`, `_`). Setup writes the first `admin` token here, and `--new-token` adds one. A token here never expires and cannot be revoked through the API: remove it from the file and restart the agent. Every token made with `berthy token create` is in that environment's state instead, and the agent accepts both. A token name is unique across the two for that environment. |

Example (the digest is a placeholder):

```json
{
  "listen": "10.0.0.5:7710",
  "docker_socket": "/var/run/docker.sock",
  "approval_ttl": "15m",
  "environments": [
    {
      "project": "todo",
      "environment": "prod",
      "state_dir": "/var/lib/berthy/environments/todo/prod/state",
      "key_file": "/var/lib/berthy/environments/todo/prod/key",
      "protected": true,
      "network": "todo",
      "tokens": [
        { "name": "admin", "digest": "<64 hex characters>", "scope": "admin" },
        { "name": "claude", "digest": "<64 hex characters>", "scope": "deploy", "agent": true }
      ]
    }
  ]
}
```

The agent API is HTTP and JSON. Streams (logs, metrics, operation events) use server-sent events, so `curl` and AI agents can read them without a client library. Only `GET /healthz` needs no token. A token is `bty.<project>.<environment>.<64 hex characters>`, sent as `Authorization: Bearer <token>`. It works only for its own hosted environment.

### Token scopes

| Scope | Allows |
| --- | --- |
| `read` | `ps`, `describe`, `logs`, `stats`, `df`, `history`, `wait`, `doctor`, `audit`, `agent-info`, `checks`, `jobs`, `lock status`, `backup list`, `ingress status`, `approvals` (without plans), following an operation's events. |
| `deploy` | Everything in `read`, plus `diagnostics`, `job logs`, `deploy`, `rollback`, `restart`, `scale`, `backup run`, `ingress apply`, `lock acquire`, `lock release`, `job run`, `job cancel`, `cancel`, `alerts test`, and the plans in `approvals`. |
| `admin` | Everything in `deploy`, plus `secret`, `exec`, `run`, `prune`, `restore`, `state-backup`, `key rotate` (not for an agent token), `remove`, `destroy`, `recovery resolve`, `approve`, `reject`, `token list`, `token create`, `token revoke` (the last two never for an agent token), and the flags `--allow-recreate`, `--adopt`, `--replace-existing`, `--revert-schema`. Compose settings that reach into the host. |

A token marked `agent` has the scope it says. The mark only decides whether its changes are held on a protected environment, and that it can never approve or reject.

### MCP tools

See [step 11](#connect-an-ai-agent-through-mcp). Eleven tools: `list_resources`, `describe_resource`, `list_console_logs`, `get_stats`, `list_deploys`, `get_deploy_diagnostics`, `list_backups`, `wait_for_resources`, `doctor`, `list_approvals` (all read-only) and `execute_resource_command` (`deploy`, `rollback`, `restart`, `backup_run`, `restore`). Three prompts: `explain_failed_deploy`, `troubleshoot_resource` and `health_report`, described in step 11.

### Terminal UI keys

See [step 12](#step-12-the-terminal-ui).

### Files Berthy leaves on the server

| Path | What |
| --- | --- |
| `/usr/local/bin/berthy` | The binary. |
| `/etc/berthy/agent.json` | The agent's configuration. Owner `berthy:berthy`, mode `0600`. `/etc/berthy` is `root:berthy`, mode `0750`. |
| `/etc/systemd/system/berthy.service` | The service. It runs `berthy agent --config /etc/berthy/agent.json` as the `berthy` user in the `docker` group, with `StateDirectoryMode=0700`. |
| `/var/lib/berthy/environments/<project>/<environment>/state/` | One hosted environment's state: `state.db` (SQLite), and `compose/<app>/` with each Compose app's stored files and `.env`. |
| `/var/lib/berthy/environments/<project>/<environment>/key` | That environment's encryption key. `berthy:berthy`, mode `0600`. Never uploaded. |
| `/var/lib/berthy/environments/<project>/<environment>/key.prev` | The key from before the last rotation, kept until the next state snapshot succeeds. `key.next` exists only while a rotation runs. |

Besides these, Berthy creates Docker objects: Swarm services named `<project>-<environment>-<app>-<role>`, Compose projects named `<project>-<environment>-<app>`, role volumes named `<project>-<environment>_<volume>`, one attachable overlay network per hosted environment (default `<project>-<environment>`), a probe helper container and image (`berthy-helper:<hash>`) when a service probe needs it, and the connector service `<project>-<environment>-ingress-connector` when managed ingress is on. Objects it created carry `berthy.project` and `berthy.environment` labels.

---

## 6. Limits and what is not there yet

- **One agent per server, any number of hosted environments.** Image apps are Swarm services, so a three-server Swarm cluster needs no redesign, but v1 does not set one up. `berthy setup` starts a single-node Swarm. Joining servers, placement settings and merged views are a later, optional phase.
- **No upgrade in place from a release before projects.** Move the old configuration, state and key aside, then run setup again ([A server set up before projects](#a-server-set-up-before-projects)).
- **No command that removes a hosted environment** from a server. After `destroy`, stop the agent, remove its entry and directory by hand, and restart the agent only if at least one hosted environment remains.
- **Host ports are shared** by everything on a server. Two hosted environments cannot both publish the same host port.
- **Plain HTTP over a private network.** The agent has no TLS. It relies on the private network for encryption and authenticates every request with a token. Do not expose its port to the internet.
- **No proxy and no certificates.** Berthy ships no reverse proxy. Public traffic enters through Cloudflare Tunnel (managed) or an app you run yourself.
- **Limited secret interpolation.** A template (`env.template`) joins secrets into one value with `${NAME}` only: no defaults, no nesting, no URL encoding and no references to variables. Berthy can make a random secret on the server with `berthy secret generate`. See step 2 and [generating a random secret](#generate-a-random-secret).
- **Secrets live in the agent's store.** There is no external secret manager. Remote `berthy setup` saves a copy of the encryption key under `~/.berthy/keys`; store another in a password manager or vault.
- **No `berthy update`.** Upgrade the agent by running `berthy setup` again with a newer CLI.
- **No starter manifest.** There is no command that writes one. Start from `examples/todo` and check it with `berthy config validate`.
- **No web UI, and no long-term logs or metrics.** Berthy keeps the last hour of metrics in memory and stores no logs. Export metrics over OpenTelemetry and send logs to a backend of your choice.
- **Telegram and one HTTP webhook are the only alert channels.** Email, Slack and the others are reached through the webhook.
- **Images are not built.** CI builds and pushes them.
- **A Compose app has no automatic rollback, no `scale` and no `--version`.** `exec` works on a Compose app with `--service`. A Compose `build:` is refused.
- **`hostnames` only on image apps.** Compose services are published by a rule you add in Cloudflare.
- **Release downloads need a published release of that version.** The repository's release workflow publishes one when a version tag (`v*`) is pushed, with the `berthy-<os>-<arch>` CLIs and `checksums.txt`. A release publishes only a commit whose CI run succeeded, and the workflow can also be run by hand as a dry run that publishes nothing. A Linux CLI of the server's architecture uploads itself. A release CLI on another platform downloads its own version from the release site (`BERTHY_RELEASE_URL` overrides it) and checks the checksum. A development build on another platform, or a version with no published release, uses `--binary <path>` instead.
- **A scheduled restore drill is not built.** You verify restores by hand (steps 10 and 15).

#### Not verified against real services

Berthy's own tests and the phase verification records (`docs/phase-*-verification.md`) ran against a real Docker Swarm, a real registry and fixtures. On 2026-11-17 the owner also ran Berthy by hand against real services:

- `berthy setup` over SSH on a real Ubuntu x86_64 server that already had Docker 28.3.2: 13 of 13 steps, and `doctor` 9 of 9. The server had a broken Swarm left by another tool, which had to be cleared with `docker swarm leave --force` first.
- Managed ingress against the real Cloudflare API: the tunnel was created, the cloudflared connector was deployed, and a route and a proxied DNS record for one hostname were created at the end of the API deploy. The app was served over HTTPS through the tunnel.
- A private image pulled from GHCR with a `read:packages` token.
- Compose deploys of PostgreSQL and Redis.
- Image deploys by tag, an update to a newer tag, and a rollback.

The items below were **not** run against real services. Expect to find your own edge cases the first time:

- **Cloudflare:** token scopes, error codes, rate limits, `--replace-existing` and DNS conflict handling, a connector update, more than one connector, traffic to several replicas through the tunnel, and the unhealthy-tunnel alert. The tests used a fake Cloudflare API for these. The readiness command of the pinned connector image was not confirmed against a running, ready connector. Try managed ingress on a non-production tunnel first.
- **Telegram and webhooks:** real delivery of alerts. The tests used a fake Bot API and a fake webhook.
- **OpenTelemetry backends:** a real collector over `https`, and a backend's own authorization.
- **S3:** a real provider. The backup, restore and state-snapshot code ran against an in-memory fake S3, so a `kill -9` during a snapshot, big states and provider quirks are untested.
- **Other hosts:** arm64 servers, SSH through jump hosts, and a server reboot.
- **Rebuilding a second host** with `state-restore` and `setup --key-file`, end to end (step 15).
- **A real MCP client** (Claude Code, Claude Desktop) over standard input and output, and the TUI on real terminals other than a terminal emulator (Windows Terminal, macOS Terminal, iTerm2), light backgrounds and `NO_COLOR` by eye.
- **The default 15-minute approval expiry** (the tests shortened it), and an agent restart while an approval is pending.
- **Agent memory** against the 30 MB target with telemetry on.

Each phase's verification record lists what it did not cover. Read them before you rely on a feature in production.

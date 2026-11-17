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

- `prod` is the environment in the story. The server is `10.0.0.5`, and its agent listens on `10.0.0.5:7710`.
- Commands that talk to the agent need two flags: `-e prod` (which environment) and `--config $CFG` (the CLI configuration file, see step 1). Set the variable once:

  ```bash
  export CFG=~/.config/berthy/config.json
  ```

- `<token>`, `<password>` and similar in angle brackets are placeholders. The guide never prints a real token or secret. Secrets are always read from standard input, so they stay out of your shell history.
- Flags can come in any order, before or after the app name. The one exception is `exec`: everything after `--` is the command to run.
- The exit code matters. `0` means done. `1` means failed. `2` means you typed the command wrong. `3` means an AI agent's change is held for approval. Scripts and CI should check it.

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
  +------------------ Server (one per environment) --------------------+
  |  Berthy agent  (systemd service, API on a private address)         |
  |     |                                                              |
  |     +--> Docker Swarm: image apps (api)                            |
  |     +--> Docker Compose: postgres, redis, ...                      |
  |     +--> state: one encrypted SQLite file                          |
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

- **One agent per server, one server per environment.** `prod` and `dev` are different servers, each with its own agent, secrets and tokens.
- **Private network only.** The agent listens on one private address and speaks plain HTTP. The private network (a VPN such as WireGuard or Tailscale) encrypts it. Every request carries a token.
- **Swarm is always on.** Image apps run as Docker Swarm services, even on one server. That gives rolling updates and rollback.
- **Git is the source of truth.** What you want lives in a manifest in your repository. Every deploy sends the manifest of the commit you deploy. Nothing is configured by hand on the server.
- **Berthy does not build images.** CI builds and pushes them. Berthy deploys images that already exist.

## 2. Words you will see

| Word | Meaning |
| --- | --- |
| **Environment** | One named target: its own server, agent, overlay file, secrets and tokens. This guide uses `prod` and `dev`. Every command names one with `-e`. There is no default. |
| **App** | One thing Berthy runs, named in the manifest: `api`, `postgres`, `redis`. |
| **Kind** | How an app runs. `image` apps are Swarm services made from a registry image. `compose` apps are `docker compose` projects made from a Compose file in your repository. |
| **Role** | A part of an image app that runs the same image with its own replica count, command, health check and resources. The API has one role, `web`. You could add a `worker` role later. |
| **Replica** | One running copy of a role. |
| **Release** | One recorded deploy of an app: the image digest (or Compose file), the commit, and the manifest at that time. Rollback goes back to a release. |
| **Operation** | One change run by the agent: a deploy, a rollback, a restart, a restore. It has an id, a state (`running`, `succeeded`, `failed`, `rolled_back`, `interrupted`, `recovery_required`), and events you can follow. |
| **Digest** | A `sha256:` hash that names one exact image. A tag such as `1.4.2` can move. A digest cannot. Berthy pins every deploy to a digest. |
| **Stateful** | A Compose app marked `stateful: true`. It holds data, so Berthy never recreates or removes it unless the command says so with `--allow-recreate`. |
| **Protected** | An environment marked `protected: true`. It refuses mutable tags (you deploy a digest), and it holds changes that AI agents ask for until a person approves them. |
| **Token** | The secret a client sends to the agent. Each token has one environment and one scope: `read`, `deploy` or `admin`. |
| **Agent token** | A token marked as belonging to an AI agent. On a protected environment its changes are held. It can never approve anything. |
| **Approval** | A change that an agent token asked for on a protected environment. It waits for a person to approve or reject it, and expires after 15 minutes. |
| **Lock** | The environment's deploy lock. A deploy takes it for its length. You can also take it by hand to freeze deploys. |
| **Manifest** | The YAML that says what you want: `berthy.yml` plus one overlay per environment. |
| **Overlay** | `berthy.<environment>.yml`. It changes the base manifest for one environment. |
| **Secret** | A value the agent stores encrypted on the server, set with `berthy secret set`. The manifest names it. It never holds the value. |
| **Agent state** | The agent's SQLite file: secrets, releases, history, audit log. Secrets are sealed with a key file that stays on the server. |

**Token scopes** in one table (the full list is in the [reference](#token-scopes)):

| Scope | You can |
| --- | --- |
| `read` | Look: `ps`, `describe`, `logs`, `stats`, `df`, `history`, `doctor`, `audit`, `checks`, `jobs`, `backup list`, `ingress status`, `approvals`. |
| `deploy` | Everything in `read`, plus deploy, roll back, restart, scale, run jobs and backups, take the lock, apply ingress, read diagnostics. |
| `admin` | Everything in `deploy`, plus secrets, `exec`, `prune`, `restore`, `remove`, `destroy`, recreating stateful apps, `approve` and `reject`. |

## 3. The todo app

The todo app has three parts. They run in one project, `todo`, on one shared Docker network, `todo`.

| App | Kind | What it is |
| --- | --- | --- |
| `api` | `image` | The web service. The image is `ghcr.io/acme/todo-api`, in a **private** registry. It runs as the `web` role: two replicas in prod, one in dev. |
| `postgres` | `compose`, `stateful: true` | The database. It has its own Compose file, a named volume for its data, and a second volume for database dumps. |
| `redis` | `compose` | The cache. It holds nothing worth keeping, so it is not stateful. |

Replace `acme` with your own registry user or organisation wherever you see it.

The API finds the database at the name `todo-db` and the cache at `todo-redis`. Those are **network aliases**: each Compose file gives its service an alias on the shared network. Swarm and Compose containers on that network can reach each other by name.

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
- **prod** is `protected`, has two replicas and resource limits, nightly backups, alerts, probes and a public hostname. You deploy a digest to it.

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
| `check` | Linux with systemd, a supported CPU, and `--listen` is an address assigned to this server. A server that already runs an agent for a different environment stops the run. |
| `docker` | Confirms Docker Engine is installed (version 25 or newer), enabled at boot and running. Installs it with Docker's official script when it is missing (unless `--no-install-docker`), and starts it when it is stopped. A Docker you did not install is never upgraded or reconfigured. |
| `swarm` | Turns on Swarm with your private address as the advertise address, with the management port on that address only. A server that already is a manager keeps its Swarm. A worker in another Swarm stops the run. |
| `network` | Creates the shared attachable overlay network named in the manifest (`todo`), unless it exists. An existing network that is not an attachable overlay stops the run. |
| `user` | Creates the `berthy` system user and adds it to the `docker` group. |
| `binary` | Installs the Berthy binary as `/usr/local/bin/berthy` (see "Where the binary comes from"). |
| `key` | Prepares `/var/lib/berthy` and `/var/lib/berthy/state` and makes the encryption key `/var/lib/berthy/key`. It never replaces an existing key. |
| `token` | Creates the first `admin` token. It is shown once, at the end. The agent keeps only its digest. |
| `config` | Writes `/etc/berthy/agent.json`. It sets the environment, the listen address, `docker_socket` (`/var/run/docker.sock`), the state directory and key file, `protected` and `network`, and the tokens. |
| `service` | Installs, enables and starts `berthy.service`, and waits until the agent answers. |
| `cli_config` | Adds the environment to the CLI configuration file that `--config` names. Without `--config` this step is skipped, with a hint of the entry to add yourself. |
| `verify` | Runs `doctor` on the new agent (see below). |

Every step ends with one status, shown as a glyph: `✓` for `ok` (nothing to change) and `changed`, `·` for `would_change` (dry run), `–` for `skipped` and `✖` for `failed`. This is a real first run, on a test server with another environment name and address. The names are the guide's (`prod`, `ops@10.0.0.5`, `10.0.0.5:7710`, network `todo`), and the details are what setup prints:

```text
✓ connect     ops@10.0.0.5 (sudo)
✓ check       linux amd64, systemd, 10.0.0.5 assigned
✓ docker      installed 29.10.0 with the official script
✓ swarm       turned on Swarm advertising 10.0.0.5
✓ network     created network todo
✓ user        created the berthy user, added it to the docker group
✓ binary      uploaded this CLI (v0.1.0-me), sha256 58eb0c5853b3
✓ key         prepared /var/lib/berthy, prepared /var/lib/berthy/state, generated an encryption key on the server
✓ token       created an admin token named admin; it is shown once, at the end
✓ config      created /etc/berthy/agent.json (listen 10.0.0.5:7710, 1 token)
✓ service     installed, enabled and started berthy.service
✓ cli_config  wrote prod at http://10.0.0.5:7710 to config.json (token in $BERTHY_PROD_TOKEN)
✓ verify      agent v0.1.0-me, 9 of 9 checks ok
setup of prod on ops@10.0.0.5: done

admin token for prod (shown once, store it now): <token>

next steps:
  1. keep a copy of the encryption key off the server, in a password manager or your provisioning vault: ssh ops@10.0.0.5 sudo cat /var/lib/berthy/key > prod.key
  2. store the admin token above, and set it in $BERTHY_PROD_TOKEN when you run berthy
  3. set the secrets the manifest names: berthy secret set NAME -e prod --config /home/me/.config/berthy/config.json
  4. apply the managed ingress: berthy ingress apply -e prod --config /home/me/.config/berthy/config.json
  5. run the first deploy of each app: berthy deploy APP -e prod --config /home/me/.config/berthy/config.json
```

The token comes **after** the step lines, once. Setup prints the next steps only after a successful run that is not a dry run. The ingress item appears only when the manifest declares managed ingress. In the next steps, `--config <config>` shows the path you gave to `--config`, or the word `CONFIG` when you gave none. (The sample above is from a run on a test server, shortened where its details differ.)

A **second run** shows every line with `✓` and wording such as "kept", "in place" or "running", and no token:

```text
✓ binary      this CLI (v0.1.0-me) is installed
✓ token       the tokens of /etc/berthy/agent.json are kept
✓ verify      agent v0.1.0-me, 9 of 9 checks ok
```

If you want a machine-readable result, add `--json`. It prints one object and nothing else. The token is in it as `"token"`, and the next steps as `"next_steps"`:

```json
{"environment": "prod", "target": "ops@10.0.0.5", "dry_run": false, "ok": true,
 "steps": [{"step": "docker", "status": "ok", "detail": "Docker 29.9.3, running, enabled"}],
 "token": "<token>", "next_steps": ["..."]}
```

Exit codes: `0` all steps fine, `1` a step failed (the output names it), `2` the command line is wrong. If a later step fails after the configuration holding the token went live, the token is still printed, because a second run keeps that configuration and would not make another.

#### Where the binary comes from

Setup installs the version of Berthy that runs it. It picks the source in this order:

1. `--binary <path>`, a Linux build for the server's architecture. Setup checks that it is an ELF executable of that architecture.
2. **This CLI**, when it is a Linux build for the server's architecture. It uploads itself.
3. **The release download.** The server downloads `berthy-linux-<arch>` and `checksums.txt` for the CLI's version from the release site, and verifies the checksum. The base URL is GitHub's releases unless `BERTHY_RELEASE_URL` says otherwise (`https`, or `http` on a loopback or private address).

A development build on macOS or Windows has no release to download, so give it `--binary`.

#### The `verify` step

`verify` asks the new agent for its `doctor`. It sends the request **from your machine**, with the token this run made, or else the token in the variable the CLI configuration names (`BERTHY_PROD_TOKEN`). If your machine cannot reach the private address, setup says so and runs the same check **on the server**. With no token at all, it only checks that the agent answers on `/healthz`, and tells you to run `berthy doctor` yourself. Any critical check that fails fails the step.

#### Save three things

1. **The first admin token.** It is printed once, after the step lines. Put it in a password manager and into your shell:

   ```bash
   export BERTHY_PROD_TOKEN=<token>
   ```

   Lost it? Run setup again with `--new-token`. It adds another `admin` token and leaves the others alone.

2. **The encryption key.** It lives on the server at `/var/lib/berthy/key` (32 bytes). It seals every secret in the agent's state. The agent never uploads it. If the server dies and you do not have it, the secrets are gone. Copy it somewhere off the server, as the next steps say:

   ```bash
   ssh ops@10.0.0.5 sudo cat /var/lib/berthy/key > prod.key
   chmod 600 prod.key
   ```

   Keep `prod.key` in a password manager or your provisioning tool's vault.

3. **The CLI configuration file.** The `cli_config` step writes it for you when you pass `--config`. It maps each environment to an agent address and **the name of the environment variable that holds the token**. It never contains a token:

   ```json
   {
     "environments": {
       "prod": { "url": "http://10.0.0.5:7710", "token_env": "BERTHY_PROD_TOKEN" }
     }
   }
   ```

   The default variable name is `BERTHY_<ENVIRONMENT>_TOKEN`. An environment that already has a `token_env` keeps it, and other environments in the file are kept as they are. You can edit this file by hand: unknown keys are refused. `--config` must name this file on every command that talks to an agent.

#### Setup is safe to run again

A second run repairs what is missing and changes nothing else. It never replaces the encryption key, the tokens or the agent's state, and it never touches a running app.

Running it with a **newer CLI**, or with `--binary`, **upgrades the agent**. Only the agent restarts. Apps keep running. The previous binary and configuration are kept for one generation, and **if the new agent does not answer, setup puts the previous binary and configuration back** and restarts the old one, with the agent's last log lines in the error. On a first install there is nothing to put back, so setup stops the service and leaves it stopped.

#### The other setup options

| Option | Meaning |
| --- | --- |
| `-e <env>` | The environment to set up. |
| `--host <user>@<server>` | Set up a remote server over SSH. |
| `--local` | Set up the server the command runs on. Use exactly one of `--host` and `--local`. |
| `--listen <address>:<port>` | The private address the agent's API listens on. Required on the first run. A later run keeps the agent's own address, and a different one is refused. It must be one specific address of the server, not `0.0.0.0` or `::`. |
| `--config <file>` | The CLI configuration file to add the environment to. Without it, `cli_config` is skipped. |
| `--manifest-dir <dir>` | Where to read the manifest from. Default: the current directory. |
| `--network <name>` | The shared network, when the directory has no manifest. |
| `--protected` | Mark the environment as protected, when the directory has no manifest. |
| `--no-install-docker` | Stop if Docker is missing instead of installing it. |
| `--dry-run` | Check and report what would change, without changing anything. |
| `--json` | Report as JSON. |
| `--binary <path>` | Install this Linux build of Berthy instead of this CLI or the release. |
| `--key-file <path>` | Install a saved encryption key (exactly 32 bytes) instead of generating one. Used when you [rebuild a server](#step-15-rebuild-a-server). It never replaces a different key that is already on the server. |
| `--new-token` | Add another `admin` token, when the first one is lost. |

If the directory has a manifest, setup reads `network` and `protected` from the merged manifest of the environment. A `--network` flag that disagrees with the manifest is an error. With no `berthy.yml` and no `--network`, setup stops and asks for `--network NAME`.

#### What setup leaves on the server

| Item | Location and owner |
| --- | --- |
| Binary | `/usr/local/bin/berthy` |
| Agent configuration | `/etc/berthy/agent.json`, owner `berthy:berthy`, mode `0600`. The folder `/etc/berthy` is `root:berthy`, mode `0750`. |
| State (SQLite) | `/var/lib/berthy/state`, `berthy:berthy`, mode `0700` |
| Encryption key | `/var/lib/berthy/key`, `berthy:berthy`, mode `0600` |
| Service | `/etc/systemd/system/berthy.service`, running as the `berthy` user in the `docker` group, with `StateDirectoryMode=0700` |

The agent's configuration is plain JSON. Its keys are listed in the [reference](#agent-configuration).

> **Setup does not do these.** It does not create the server, its users, its firewall or your private network. It does not install the VPN. It does not change Docker's log rotation, storage driver or daemon options. It does not write a manifest: that is step 2. It deploys nothing.

#### Check that it works

```bash
berthy version
berthy doctor -e prod --config $CFG
berthy agent-info -e prod --config $CFG
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
| `network` | The shared network exists and is an attachable overlay. It checks the network in the agent configuration, or else the one in the last applied manifest. |
| `ingress_tunnel` | The Cloudflare tunnel, once managed ingress is set up. |
| `compose` | The Compose plugin answers. |
| `lock` | The deploy lock (`free` or who holds it). |
| `peer:<name>`, `telegram`, `backup:<name>`, `probe_helper`, ... | One check each for the peers, the Telegram bot token secret, every backup, and the probe helper, once the manifest uses them. |
| `orphan_apps` | Apps that are deployed but no longer in the manifest. |
| telemetry | The OTLP exporter, when configured. |

A backup or alert in trouble does not make `doctor` exit non-zero: that is an alert, not a fault of the agent.

`berthy agent-info` prints the environment, the host name, whether the agent is protected, and its version.

---

### Step 2. Write the manifest

The manifest is the YAML in your repository that says what you want. There is a base file and one overlay per environment.

- `berthy.yml` holds what every environment shares.
- `berthy.<environment>.yml` changes it for one environment. It is optional.

The agent never reads your repository. Instead, the CLI **reads the files from the commit you are deploying** and sends the merged manifest in the deploy request.

#### How the merge works

- A **map** is merged key by key. A key in the overlay replaces the same key in the base, and keys that only one file has are all kept.
- A **list** or a plain value in the overlay **replaces** the base's. If the overlay has `hooks.pre_deploy`, it replaces the whole base list.
- The file must be one YAML document. **Anchors, aliases and `null` are refused.** So are duplicate keys, and keys Berthy does not know (a typo is an error, not a silent no-op). A file is at most 1 MiB.
- **Quote numbers and booleans that you mean as text.** `DB_PORT: "5432"` is right. `DB_PORT: 5432` is refused, because environment values are strings.
- Names of apps, roles, jobs, backups and so on use lowercase letters, digits, `-` and `_` (up to 63 characters, starting with a letter or digit). Environment variable and secret names use letters, digits and `_`.
- Durations are Go-style: `15s`, `2m`, `1h30m`. There is no `d` for days.

#### The top of `berthy.yml`

```yaml
project: todo
network: todo

registries:
  ghcr.io:
    username: acme
    password_secret: GHCR_TOKEN
```

| Key | Meaning |
| --- | --- |
| `project` | The project name. It prefixes Swarm service names and Compose project names. |
| `network` | The shared overlay network every app joins. Setup creates it. If you adopt a server that already has a network, use its name. |
| `protected` | `true` for a protected environment. Usually set in an overlay. Default `false`. |
| `registries.<host>` | A credential for a private registry. `username` is the user, `password_secret` names the secret that holds the token. A registry with no entry is pulled from anonymously. |

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
| `service` | The name of an existing Swarm service to adopt. See [adoption](#adopting-an-app-that-already-runs). | `<project>-<app>-<role>` |

Berthy names the Swarm service `<project>-<app>-<role>`. The API's web role is `todo-api-web`. Other containers on the network can reach it at that name.

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

**Environment.** `env.plain` values live in the manifest and are reviewed like code. `env.secret` lists secret **names** only; the values live in the agent. A name cannot be in both. Both kinds of app take the same `env` block. For a Compose app, Berthy writes the values into the project's `.env` file, where the Compose file reads them as `${NAME}`.

**Deploy settings.**

| Key | Meaning | Default |
| --- | --- | --- |
| `deploy_timeout` | The longest the new version may take to become healthy. | `120s` |
| `drain_timeout` | How long the old version has to finish requests in flight. It is also the Swarm stop grace period. | `30s` |
| `start_attempts` | How many failed task starts a rollout tolerates before it gives up (1 to 10). | `3` |
| `retain` | How many deploys' images are kept, so a rollback needs no pull. At least 1. | `5` |

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
| `project_name` | The Compose project name. Default `<project>-<app>`, so `todo-postgres`. Compose names volumes after it, so **never change it** once the app holds data. Set it to the existing name when you adopt a running project. |

Compose rules to remember:

- **Join the shared network yourself.** Berthy does not add it. Declare it as an external network in the Compose file, and give each service the alias the API uses.
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
    name: todo
```

Three details matter:

- `networks.todo.external: true` with `name: todo` joins the network setup created. `aliases: [todo-db]` is the name the API's `DB_HOST` uses.
- `${POSTGRES_PASSWORD}` comes from the manifest's secrets. Postgres reads its password **only when it first initialises an empty data volume**. Changing the secret later does not change the database's password: you must also run `ALTER USER` (see [step 13](#step-13-update-the-database-or-the-cache)).
- The `db-dumps` volume is where the dump job writes. [Step 10](#step-10-backups-and-restore) backs it up. `$$` in a Compose file is a literal `$`.

`examples/todo/deploy/redis.yml` follows the same pattern, with the alias `todo-redis`, `--requirepass` set from `REDIS_PASSWORD`, and nothing saved to disk.

> **There is no secret interpolation yet.** The manifest cannot build `postgres://user:pass@todo-db/todo` out of a secret, and one secret cannot be aliased under a second name. A secret's name is the environment variable's name, and one name is shared by every app in the environment. That is why the API takes `DB_HOST`, `DB_NAME`, `DB_USER` and `POSTGRES_PASSWORD` separately and builds its connection string itself. If your app insists on a single `DATABASE_URL`, store the whole URL as its own secret and keep it in step with the password.

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

To see the merged result, with secret values hidden (the manifest only holds secret names), run:

```bash
berthy config show -e prod
berthy config show -e prod --json
```

Defaults are filled in, so the output shows `deploy_timeout: 120s`, `retain: 5` and so on.

Run `config validate` in CI too. It is the cheapest check there is.

#### The finished example

`examples/todo/berthy.prod.yml` is the finished prod overlay: it has everything this guide adds, in one file. Each later step shows the part it adds. If you copy the finished file as it is, set every secret in the next step's table before you deploy.

---

### Step 3. Registry credentials and secrets

A **secret** is a value the agent keeps encrypted. You set it with the CLI, and the manifest refers to it by name. Values are write-only: you can set, list (names only) and remove them, but nothing ever prints a value.

Secrets belong to one environment. `secret` commands need an `admin` token.

#### Set the secrets the first deploy needs

Read each value from standard input. The command strips one trailing newline.

```bash
# The registry token: a GitHub token that can read packages. Note --registry.
read -rs GHCR_PAT
printf '%s' "$GHCR_PAT" | berthy secret set GHCR_TOKEN --registry ghcr.io -e prod --config $CFG
unset GHCR_PAT

# Passwords you make up. They never appear on screen.
openssl rand -hex 24 | berthy secret set POSTGRES_PASSWORD -e prod --config $CFG
openssl rand -hex 24 | berthy secret set REDIS_PASSWORD -e prod --config $CFG
```

Two rules about `--registry`:

- A secret that a manifest's `registries.<host>.password_secret` names **must** be set with `--registry <host>` (`ghcr.io` here). A deploy that finds it set without, or for a different host, refuses to use it.
- A secret listed in an app's `env.secret` **must not** have `--registry`. A secret is one or the other.

Secrets are limited to 64 KiB. For a Compose app, a value cannot contain a line break.

Check what is stored (names only):

```bash
berthy secret list -e prod --config $CFG
```

Remove one with `berthy secret rm <NAME> -e prod --config $CFG` (`delete` also works). Add `--dry-run` to any `secret set` or `secret rm` to see the plan without changing anything.

#### Which secret is needed when

| Secret | Named by | Needed when |
| --- | --- | --- |
| `GHCR_TOKEN` | `registries.ghcr.io` | Every deploy of `api`, and **every Compose deploy** in an environment whose manifest lists a registry. |
| `POSTGRES_PASSWORD` | `api` and `postgres` `env.secret` | Deploying `api` and `postgres`. |
| `REDIS_PASSWORD` | `api` and `redis` `env.secret` | Deploying `api` and `redis`. |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `destinations.offsite` | A backup runs, including the pre-deploy backup hook ([step 10](#step-10-backups-and-restore)). |
| `CLOUDFLARE_API_TOKEN` | `ingress.cloudflare.api_token_secret` | `ingress apply`, and deploying an app that has `hostnames` ([step 7](#step-7-put-it-on-the-internet)). |
| `TELEGRAM_BOT_TOKEN` | `alerts.telegram.bot_token_secret` | Sending alerts ([step 8](#step-8-keep-it-healthy)). |
| `OTLP_HEADERS` | `telemetry.headers_secret` | Exporting metrics to a backend that needs authorization. |

**A deploy stops before changing anything if a secret it lists has no value.** You find out at once, not halfway through a rollout.

The name `TUNNEL_TOKEN` is reserved for managed ingress. You cannot use it for your own secrets.

#### How the values reach the app

- For `api`, Berthy passes plain and secret values as container environment variables, so `POSTGRES_PASSWORD` is an environment variable of the `web` containers.
- For `postgres` and `redis`, Berthy writes them into the project's `.env` file (readable only by the agent). The Compose file reads them as `${POSTGRES_PASSWORD}` and passes them on in `environment:`.
- Secret values are replaced by `[redacted]` in logs the agent returns, in deploy records, in diagnostics and in plans.

#### Rotating a secret

Set the new value, then redeploy the apps that use it so they pick it up. For `POSTGRES_PASSWORD` that is not enough: the database keeps its old password. You must change it in the database too. `berthy exec` does not work on Compose apps, so do that on the server with Docker:

```bash
ssh ops@10.0.0.5
docker exec -it "$(docker ps -qf label=com.docker.compose.project=todo-postgres)" \
  psql -U todo -d todo -c "ALTER USER todo PASSWORD '<new password>'"
```

Do the `ALTER USER` first, then `secret set`, then redeploy `api`, in a quiet moment. Berthy has no step for this yet.

---
### Step 4. The first deploy

Deploy in this order: **redis, postgres, then the API.** The API reads from both, and its migrations need the database to exist. (The API's `depends_on` says the same, and [one command](#all-the-apps-in-one-command) can deploy all three.)

Every deploy starts the same way: look at the plan first.

```bash
berthy deploy redis -e prod --config $CFG --dry-run
```

`--dry-run` prints the plan and acts on nothing. Many commands that change something accept it (the [reference](#commands) lists which). For a Compose app the plan lists the Compose project (`todo-redis`), each service with its action (`create`, `keep`, `recreate` or `remove`) and each volume with `create` or `keep`.

Then run it for real:

```bash
berthy deploy redis    -e prod --config $CFG
berthy deploy postgres -e prod --config $CFG
```

A Compose app takes **no** `--version`: the version is whatever its Compose file says. (`berthy deploy redis --version 7` is refused with `--version does not apply to a compose app`.)

The CLI reads the Compose file from `--manifest-dir` (default: the current directory), sends it with the deploy, and follows the operation until it ends. It prints the name of each event as it arrives, then the operation's record:

```text
app: redis
commit:
id: <operation id>
kind: deploy
started: 2026-11-16T10:21:07Z
state: succeeded
```

Exit code `0` means `succeeded`. Anything else (`failed`, `rolled_back`, `recovery_required`, `interrupted`) exits `1`.

#### What a Compose deploy does

1. Takes the environment's deploy lock and checks the manifest.
2. Works out which services would be recreated and which volumes created, and prints that plan.
3. **Stops if a `stateful` service would be recreated**, unless the command carries `--allow-recreate` (and an `admin` token). A first deploy creates things, so it needs neither.
4. Writes the Compose file and the `.env` file, then runs `docker compose up -d --remove-orphans`.
5. Waits for health checks, records the release and releases the lock.

A failed `up` is reported. There is no automatic rollback for Compose apps: the next deploy brings the project to its file again.

#### The API: a digest, not a tag

The prod overlay says `protected: true`. A protected environment **refuses a tag**, even a unique one such as a git SHA, because a tag can be moved. You must give the image's **digest**:

```bash
berthy deploy api -e prod --config $CFG --dry-run \
  --version sha256:<64 hex characters>
```

Get the digest from your CI's build step (`docker/build-push-action` outputs it as `digest`), or look it up:

```bash
docker buildx imagetools inspect ghcr.io/acme/todo-api:1.4.2
```

Try a tag on prod and you see why:

```text
protected environment requires a digest
```

In **dev**, which is not protected, `--version 1.4.2` (a tag) works. `--version` also accepts a full reference such as `ghcr.io/acme/todo-api:1.4.2` as long as the repository matches the app's `image`. An image app without `--version` is refused with `deploy requires --version`.

The dry run for an image app prints the plan as JSON when you add `--json`:

```json
{
  "app": "api",
  "image": "ghcr.io/acme/todo-api@sha256:<64 hex characters>",
  "roles": [
    "web"
  ]
}
```

Notice that the plan shows the image **pinned by digest**. Now deploy it, with the commit that the manifest came from:

```bash
berthy deploy api -e prod --config $CFG \
  --version sha256:<64 hex characters> \
  --commit "$(git rev-parse HEAD)"
```

`--commit` is recorded with the release. It shows in `history`, and it is how you find which code a release was.

#### All the apps in one command

Deploying app by app shows what each deploy does. Once the project is set up, one command deploys every app of the manifest, in the order `depends_on` gives: an app after the apps it depends on, and among the apps that are ready, the first by name. Here that is `postgres`, `redis`, then `api`. The todo manifest has one image app, so a plain `--version` names its version:

```bash
berthy deploy -e prod --config $CFG --version sha256:<64 hex characters> --dry-run
berthy deploy -e prod --config $CFG --version sha256:<64 hex characters> \
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

- **Everything is checked first.** Nothing is sent to the agent until every app's request is ready: manifest loaded, Compose files read, versions checked. A missing Compose file or a bad version for the last app leaves the first apps undeployed.
- **It stops at the first failure.** The command exits with that app's code, prints `deploy stopped at <app>; not run: <the apps after it>` and runs nothing more. With `--dry-run` it plans every app, goes on past a plan that fails, and exits `1` if any failed.
- **Versions.** A plain `--version` is for a manifest with exactly one image app. With several, name each one: `--version api=sha256:...`, once for each app. A plain version together with `app=version`, an `app=` that names an unknown app or a Compose app, and a repeated app are refused with exit `2` before anything is sent.
- **An image app given no version keeps the one it runs now.** Berthy deploys the digest of its last release, and the tag it was deployed with, and applies the new manifest, migrations and hooks as in any deploy. This is how a change to the manifest alone reaches every app. An app that was never deployed has no version to keep: the command refuses it with `image app api is not deployed yet: give --version api=REF` and exit `2`, before anything is deployed. A first deploy names a version for every image app.
- **Flags that need an app** (`--adopt`, `--replace-existing`, `--allow-recreate`, `--request-id`) are refused with exit `2`.
- **`--json`** prints one document, `{"apps": [...]}`, with an entry for each app in order: its `app`, its `exit` code and its `result`, which is what `berthy deploy <app> --json` prints. An app that did not run has `"state": "not_run"`.

`depends_on` is a manifest key like the others: an agent that does not know it refuses the manifest. Upgrade the agent with `berthy setup` before you deploy a manifest that uses it.

#### What an image deploy does

A deploy either finishes healthy or leaves the previous version running. It never leaves an app half-updated.

1. **Lock.** Takes the deploy lock. If someone holds it, the deploy stops and says who and why.
2. **Check.** Validates the manifest. Confirms every secret has a value. Resolves the tag to a digest (if you gave a tag) and pulls the image. On a protected environment, you gave a digest already.
3. **Pre-deploy hooks.** Runs them in order. A failure stops the deploy with nothing changed.
4. **Migrations.** Runs `version`, then `apply`, then `version` again (see step 6).
5. **Start new.** Starts the new version *beside* the old one. It must pass its health check within `deploy_timeout`. Failures during the check's `start_period` do not count. If the new version's tasks fail to start `start_attempts` times (3 by default), Berthy gives up at once instead of waiting out the timeout.
6. **Switch and drain.** Sends traffic to the new version. The old one gets a stop signal and `drain_timeout` to finish requests in flight.
7. **Publish.** With managed ingress, updates the app's routes and DNS records. A failure here is reported and the command exits non-zero, but the new version stays running.
8. **Post-deploy hooks.** Runs them in order. A failure is reported, but does not undo the deploy.
9. **Record and tidy.** Writes the release, removes old images beyond `retain`, releases the lock.

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

#### Flags of `deploy`

| Flag | Meaning |
| --- | --- |
| `--version <ref>` | Image apps only. A tag, a digest (`sha256:...`) or a full reference. Required for image apps, refused for Compose apps. Without an app, `--version <app>=<ref>` for each image app (repeatable), or a plain `<ref>` when the manifest has one image app. |
| `--commit <sha>` | The commit the manifest and the image come from. Recorded with the release. |
| `--manifest-dir <dir>` | Where `berthy.yml`, the overlay and the Compose files are. Default `.`. |
| `--dry-run` | Print the plan. Change nothing. |
| `--allow-recreate` | Allow a `stateful` Compose app's services to be recreated. Needs an `admin` token. |
| `--adopt` | Take over a service or Compose project that already runs, instead of creating one. Needs an `admin` token. |
| `--replace-existing` | With managed ingress, take over a route or DNS record that Berthy did not create. Needs an `admin` token. |
| `--request-id <id>` | A retry key. The CLI makes a random one; pass the same one to retry the same request safely. |
| `--json` | Print JSON. |

#### Adopting an app that already runs

If a server already runs an app another tool deployed, Berthy can take it over without recreating it. Name the Swarm service in the role (`service: <existing name>`), or for Compose set `project_name` to the name it already runs under. Then run `berthy deploy <app> --adopt --dry-run`. Berthy compares what runs with the manifest and prints the differences before it changes anything. Adopt the least critical environment first. The spec's [adoption checklist](spec-v1.md#adopting-an-existing-deployment) lists the steps.

#### If the deploy fails

Read [Step 6](#step-6-ship-a-new-version-of-the-api): `history` and `diagnostics` tell you why. The usual first-deploy causes are a missing secret (`workload secret unavailable`), a wrong registry credential (`registry credential unavailable for image host`), a missing shared network (`overlay network unavailable`), and a health check command that is not in the image.

---

### Step 5. Look at it

All of these are read-only, and work with a `read` token.

```bash
berthy ps       -e prod --config $CFG
berthy describe api -e prod --config $CFG
```

`ps` lists every app: its kind, roles, desired and running replicas, health and the running image, plus how old each backup is. `describe <app>` shows one app in full: roles, tasks, the last deploys and the last job results. When a name is ambiguous (a Swarm service and a Compose project with the same name), write `image:api`, `swarm:api` or `compose:api`.

The text output is `key: value` lines. Add `--json` for JSON that scripts and AI agents can parse. It is the same for every command.

#### Logs

```bash
berthy logs api -e prod --config $CFG --follow
berthy logs api -e prod --config $CFG --since 10m --grep 'ERROR|panic' --role web --tail 500
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
berthy stats -e prod --config $CFG            # one sample
berthy stats -e prod --config $CFG --watch    # a live stream, Ctrl-C to stop
berthy stats -e prod --config $CFG --since 5m # the last 5 minutes (at most 1h)
berthy df    -e prod --config $CFG
```

`stats` shows CPU, memory, swap, load, network and disk I/O for the server, and CPU, memory against limit, block and network I/O and restarts for each container. The agent samples every 10 seconds and keeps the last hour in memory. `df` shows disk space per mount and what Docker's images, containers, volumes and build cache use.

#### History

```bash
berthy history api -e prod --config $CFG
```

`history` lists the app's releases newest first. Each row has an `id` (the release id you can roll back to), the digest, the commit and the time. A release deployed with `--version v1.0.2` also shows its `tag` (`tag: v1.0.2`), so you can tell which version it is without matching digests. A deploy by digest has no `tag` line, and a rollback shows the tag of the release it returns to. **Failed** deploys appear too, with their `operation_id`, `state` and a one-line `reason` such as `role web: container never became healthy (last check: exit 1)`.

#### Wait for health

```bash
berthy wait api --healthy -e prod --config $CFG --timeout 5m
```

It blocks until the app (or one `--role`) is healthy, or the timeout passes. The default is 2 minutes, the most is 10. Exit `0` means healthy. CI uses it after a restart or a scale.

#### Who did what

```bash
berthy audit -e prod --config $CFG
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

This is the daily loop. CI builds the image, pushes it, and deploys it.

#### A token for CI

CI needs a `deploy` token for `prod`. It can deploy, roll back and restart, but it cannot touch secrets, run `exec`, restore backups or approve anything.

Create tokens on your laptop. `agent token` needs no agent and no network:

```bash
berthy agent token -e prod --name ci --scope deploy
```

```text
token: bty.prod.<64 hex characters>
sha256: <64 hex characters>
{"name":"ci","digest":"<64 hex characters>","scope":"deploy"}
```

Three lines:

- The `token` is the secret. It is printed once. Put it in your CI's secret store. Berthy keeps no copy.
- The `sha256` is its digest.
- The JSON object is what the agent stores. Add it to the `tokens` list in `/etc/berthy/agent.json` on the server and restart the agent:

  ```bash
  sudo nano /etc/berthy/agent.json
  sudo systemctl restart berthy
  ```

  The agent keeps only digests, never tokens. The file must stay readable only by the agent's user. Apps keep running while the agent restarts.

`--scope` is `read`, `deploy` or `admin` (default `read`). `--name` is a label shown in the audit log (letters, digits, `.`, `-`, `_`). `--agent` marks an AI agent's token (step 11).

#### The CI script

`examples/ci/deploy.sh` is the deploy step. It checks that `IMAGE_DIGEST` is a `sha256:` digest, validates the manifest, and deploys:

```sh
commit=$(git rev-parse --verify HEAD)
"$BERTHY_BIN" config validate -e "$BERTHY_ENV" --manifest-dir "$PWD"
"$BERTHY_BIN" deploy "$APP" -e "$BERTHY_ENV" --config "$BERTHY_CONFIG" \
  --manifest-dir "$PWD" --version "$IMAGE_DIGEST" --commit "$commit"
```

Its inputs are environment variables: `BERTHY_ENV` (`prod`), `BERTHY_CONFIG` (a CLI configuration file), `IMAGE_DIGEST`, `BERTHY_TOKEN`, and optionally `APP` (default `api`) and `BERTHY_BIN`. The CLI configuration in CI names the variable that holds the token:

```json
{ "environments": { "prod": { "url": "http://10.0.0.5:7710", "token_env": "BERTHY_TOKEN" } } }
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
berthy rollback api -e prod --config $CFG --revert-schema
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
berthy lock acquire -m "postgres maintenance until 14:00" -e prod --config $CFG
berthy lock status -e prod --config $CFG
berthy lock release -e prod --config $CFG
```

`acquire` needs `-m` (a message). While the lock is held, every deploy, from CI or an AI agent, is refused with the holder and the message. `lock status` is a read; `acquire` and `release` need a `deploy` token.

If the agent crashes in the middle of an operation, the lock stays and the operation goes to `recovery_required`. The agent tries to finish it by itself at start. If it cannot, look first, then resolve it:

```bash
berthy recovery resolve <operation id> -m "checked: nothing half-done" --dry-run -e prod --config $CFG
berthy recovery resolve <operation id> -m "checked: nothing half-done" -e prod --config $CFG
```

`recovery resolve` needs an `admin` token. It ends the operation as failed and releases the lock; `--dry-run` shows the journaled steps first.

#### When a deploy fails

A new version can fail for reasons only its own output explains: a missing setting, a migration that did not apply, a health check that never passed. The old version keeps serving. The evidence is kept before anything is cleaned up.

1. The deploy command prints a one-line reason and where to look:

   ```text
   ...
   state: rolled_back
   reason: role web: task exited with code 1 (gave up after 3 failed starts)
   diagnostics: berthy diagnostics <operation id> -e prod
   ```

   Other reasons read `role web: container never became healthy (last check: exit 1)`, `pre-deploy command 1 exited with code 3`, `migration apply exited with code 2 (after 3 attempts)` and `pre-deploy backup main-db failed: upload failed`. A reason never carries the app's output, so it is safe in history.

2. `history` shows the same reason next to the failed operation.

3. `diagnostics` shows the evidence:

   ```bash
   berthy diagnostics <operation id> -e prod --config $CFG
   berthy diagnostics <operation id> -e prod --config $CFG --json
   ```

   For each role of the new version it shows the newest tasks (at most 5 per role): Swarm state and error, exit code, whether the container was killed for lack of memory, the health state and the last five health-check results, and the last 200 lines of its output. A failed hook or migration leaves the same for its container. Secret values are replaced by `[redacted]`. The evidence of the newest 50 operations is kept, at most 1 MiB each. It needs a `deploy` token, not `read`, because application output can hold personal data.

#### Roll back

```bash
berthy rollback api -e prod --config $CFG --dry-run
berthy rollback api -e prod --config $CFG
berthy rollback api -e prod --config $CFG --to <release id>
```

`rollback` redeploys the **previous** recorded digest with the manifest saved at that deploy. `--to` picks an older release: use the `id` column of `history`. **Secrets stay at their current values.** The images of the last `retain` deploys are kept on the server, so a rollback needs no pull.

`--revert-schema` also reverts the database (see above). Rollback takes the lock like a deploy and exits non-zero if it does not finish healthy.

Rollback works for Compose apps too: it redeploys the Compose file stored with the earlier release. If that would recreate a `stateful` app's service, it needs `--allow-recreate` and an `admin` token, like a deploy does.

#### Restart and scale

```bash
berthy restart api -e prod --config $CFG
berthy restart api -e prod --config $CFG --role web
berthy scale api  -e prod --config $CFG --replicas 3 --role web
```

- `restart` restarts the tasks of an image app, one role at a time (pass `--role` when the app has several). It restarts a Compose app's containers without recreating them (`--role` does not apply to a Compose app).
- `scale` sets the replica count. It needs `--replicas` (at least 1) and works only on image apps. The manifest stays the source of truth, and a deploy applies its `replicas`, so change the manifest too.

Both need a `deploy` token and accept `--dry-run`.

#### Run a command in a container

```bash
berthy exec api -e prod --config $CFG -- /app/bin/migrate version
berthy exec api -e prod --config $CFG --role web -- sh -c 'echo "$LOG_LEVEL"'
```

Everything after `--` is the command. `exec` runs it in a running container, prints its output, and exits non-zero when the command did. It needs an **`admin`** token and works only on image apps. On a protected environment, an AI agent's `exec` is held like any other change.

---

### Step 7. Put it on the internet

Without ingress the API is reachable only by name, from inside the Docker network. **Managed ingress** makes Berthy own the whole path from a public hostname to the API, through a Cloudflare Tunnel: the tunnel, the connector that runs on the server, the hostname routes and the DNS records. It is optional, and it uses Cloudflare's API throughout.

Without it, publishing an app means creating a tunnel in a dashboard, copying a token command to the server, and pointing a hostname at a Docker service by hand. With it, the hostname is one line in the manifest.

#### What you need

- A Cloudflare account, with the domain (`example.com`) already in it. Berthy finds the zone from the hostname and does not add domains.
- A Cloudflare **API token** with two permissions: *Cloudflare Tunnel: Edit* on the account, and *DNS: Edit* on the zones with your hostnames. Limit it to those zones.
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
printf '%s' "$CF_TOKEN" | berthy secret set CLOUDFLARE_API_TOKEN -e prod --config $CFG
berthy ingress apply -e prod --config $CFG --dry-run
berthy ingress apply -e prod --config $CFG
berthy ingress status -e prod --config $CFG
```

`ingress apply` creates or repairs the tunnel, deploys the connector, and brings every route and DNS record in line with the manifest. Run it once per environment, and again to change the connector's image or replicas. It needs a `deploy` token. `ingress status` shows the tunnel's health as Cloudflare reports it, the connectors, and each hostname with its target and DNS record.

After that, **`berthy deploy api` keeps the routes in step**: as the last step of a deploy, once the new version is healthy, it updates that app's routes and DNS records. A new hostname goes live only after the app can answer it. Before it changes anything, the deploy checks that the API token works, each hostname's zone is in the account, and no hostname is taken.

#### What Berthy creates

| Item | How |
| --- | --- |
| Tunnel | Found by name, or created as a remotely managed tunnel. |
| Connector | A Swarm service on the shared network, with the tunnel's token as a secret. It shows in `ps` as `ingress`, and `logs` and `restart` work on it. |
| Routes | One rule per hostname in the tunnel's configuration. A hostname routes to `http://<project>-<app>-<role>:<port>`, here `http://todo-api-web:8080`. Swarm spreads requests across healthy replicas. |
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
| **Built-in condition** | Disk space, Docker disk, memory, restart loops, overdue backups, silent peers, an unhealthy tunnel. | Alert. |

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

#### Alerts to Telegram

```yaml
alerts:
  telegram:
    bot_token_secret: TELEGRAM_BOT_TOKEN
    chat_id: "-1001234567890"
    reminder: 4h
```

| Key | Meaning | Default |
| --- | --- | --- |
| `bot_token_secret` | The name of the secret that holds the bot token. | required |
| `chat_id` | A numeric chat id, or `@channel_name`. Quote it. | required |
| `reminder` | How often to repeat while a check keeps failing. `0s` turns reminders off. | `4h` |

```bash
printf '%s' "$BOT_TOKEN" | berthy secret set TELEGRAM_BOT_TOKEN -e prod --config $CFG
berthy alerts test -e prod --config $CFG
```

`alerts test` sends a test message (it needs a `deploy` token and has no dry run: it refuses `--dry-run`). An alert goes out when a check **changes state**. Its first symbol says which way: a red circle for critical, an orange one for warning, a green check for recovered, and a repeat arrow for a reminder ("still failing"). Telegram is the only channel in v1.

#### Built-in conditions

They always run:

- **Disk** and **Docker disk**: warning from 80 percent used, critical from 90 percent. They cover `/`, the mount that holds Docker's data, and every mount of at least 1 GiB.
- **Memory**: warning below 10 percent available, critical below 5 percent.
- **Restart loops** of the apps Berthy manages: three restarts of one replica, or three failed or rejected Swarm tasks, within 10 minutes, or an out-of-memory kill.
- **Backups**: failed, overdue or suspiciously small (step 10), and jobs that fail (step 9).
- **The tunnel**, when managed ingress is set up.

#### Peers

```yaml
peers:
  dev: http://10.0.0.4:7710
```

Each peer is another agent's base URL (no path). Every 30 seconds the agent asks it for `/healthz` (a request that needs no token, answering `{"ok":true}` and nothing else), and raises an alert after three misses. This is how you notice a server that is completely down and cannot report itself. It does not cover all servers failing together or the private network being down: keep one external check on the app's public URL for that.

#### See the state

```bash
berthy checks -e prod --config $CFG
```

Example output:

```text
NAME             STATE  SINCE                 DETAIL
api-health       ok     2026-11-16T10:21:50Z  ...
backup:main-db   ok     2026-11-16T10:30:00Z  last success 3h ago, 38 MiB
```

`doctor` (step 1) shows the same state for the agent itself.

#### Metrics export

The agent shows live metrics and the last hour without any backend. For history, export them over OpenTelemetry:

```yaml
telemetry:
  otlp_endpoint: http://10.0.0.6:4318
  headers_secret: OTLP_HEADERS
```

`headers_secret` names a secret that holds request headers in the standard `OTEL_EXPORTER_OTLP_HEADERS` form (`name=value,name=value`), for backends that need authorization. The agent runs on the host, so the endpoint must be an address the host can reach, such as a port published on a private address. A Docker service name does not resolve there. `doctor` shows a `telemetry` check.

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
| `schedule` | Five-field cron, in **UTC**. Leave it out for an on-demand job. | on demand |
| `command` | The command, as a list. It is not run through a shell, so write `sh -c` yourself if you need shell syntax. | required |
| `timeout` | Time limit of one run, from `1s` to `24h`. | `1h` |

How a job runs:

- The command runs **once** per occurrence, in one running container for the target, even when a role has several replicas. For an image app it picks the replica with the lowest slot. It uses that container's environment and mounts. That is why `dump-db` can read `$POSTGRES_PASSWORD`: the Compose file passes it in.
- The agent re-reads the manifest every minute, so a changed schedule takes effect within a minute of its deploy. An occurrence is recorded **before** it runs, so a restart in the same minute cannot run it twice. Occurrences that pass while the agent is down are **not** made up.
- A run that exceeds `timeout` fails with `timed out after <timeout>`. Docker cannot stop an exec, so the command may still be running.
- If a run is still going at the next scheduled time, that occurrence is skipped and recorded. A skip never alerts.
- The command's output is read and thrown away, because it may hold secrets. The record keeps the exit code and a fixed reason such as `exit status 3` or `no running container for api/web`.
- A non-zero exit, a missing container, an exec error or a timeout **fails the run and raises an alert** through the `job:<name>` check, which stays critical until a later run succeeds.
- Jobs do not take the deploy lock, so they can run during a deploy. Every run is written to the audit log with `job:<name>` as the caller.

#### See and run them

```bash
berthy jobs -e prod --config $CFG
berthy job run dump-db -e prod --config $CFG
```

Example output:

```text
NAME     TARGET            SCHEDULE   NEXT                  LAST       WHEN
cleanup  api/web           30 2 * * * 2026-11-17T02:30:00Z  succeeded  2026-11-16T02:30:01Z
dump-db  postgres/postgres on demand  -                     -          -
```

`jobs` needs a `read` token. `job run <name>` starts the job now, waits until it finishes or its `timeout` plus 30 seconds pass, prints the status, exit code and reason, and **exits 0 only when the run succeeded**. It fails at once if a run of that job is already going. It needs a `deploy` token. `dump-db` has no schedule: it runs on demand, and as the `before` step of the volume backup (step 10).

---
### Step 10. Backups and restore

Berthy backs up **named Docker volumes** to S3-compatible object storage. A backup is a compressed archive of one volume, plus a small description file. Backups are opt-in: you declare each one.

The todo app backs up the database by dumping it and uploading the dump:

1. The `dump-db` job (step 9) writes a consistent dump to `/backups/latest.dump`, a file on the `db-dumps` volume.
2. The volume backup `main-db` uploads that volume.

Archiving the live `pgdata` volume would copy files while the database writes to them. A dump is safe. That is why `dump-db` writes to a dedicated volume.

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
| `backups.<name>.app` | The app that mounts the volume. | required |
| `volume` | For a Compose app, the key in the Compose file's top-level `volumes` (here `db-dumps`; Berthy works out the real Docker name). For an image app, the name of a volume one of its roles mounts (`volumes: ["uploads:/app/uploads"]`). | required |
| `destination` | A key of `destinations`. | required |
| `schedule` | Five-field cron, in UTC. Leave it out to run only on demand or from a deploy hook. | on demand |
| `prefix` | Where the backup's objects sit in the bucket. | `<app>/<volume>` |
| `before` | A job (step 9) to run first. If it fails, the backup fails and nothing is uploaded. | none |
| `retention.keep` | `all`, or a number: keep that many newest successful backups. | `all` |

Create a storage credential limited to the backup bucket, store it, and consider a retention lock on the bucket so a compromised server cannot delete the history:

```bash
printf '%s' "$S3_KEY"    | berthy secret set S3_ACCESS_KEY -e prod --config $CFG
printf '%s' "$S3_SECRET" | berthy secret set S3_SECRET_KEY -e prod --config $CFG
```

A backup of a volume the app does not mount is refused, and a backup of an app that is not deployed is not part of the configuration.

#### Run, list, watch

```bash
berthy backup run main-db -e prod --config $CFG
berthy backup list -e prod --config $CFG
berthy backup list --backup main-db -e prod --config $CFG
```

`backup run` (a `deploy` token) runs the backup now, waits for it, prints the run and **exits 0 only when it succeeded**. Backups of the same volume run one at a time: a second is refused with `409`. `backup list` (a `read` token) shows what is in storage:

```text
BACKUP   APP       VOLUME    SIZE     FINISHED              SHA256    KEY
main-db  postgres  db-dumps  38 MiB   2026-11-16T01:00:12Z  <hash>    postgres/todo/main-db/20261116T010000Z-7.tar.gz
```

The **key** is what `restore` takes. A backup is listed only when its description file (`<same name>.json`, with the checksum and size) exists. The agent writes it after the upload finishes, so a backup that is listed is complete. An interrupted upload leaves nothing that looks like a good backup.

How a run goes: the `before` job runs and must succeed; the agent reads the volume through a read-only mount and streams a gzip tar to storage while hashing it; only then it writes the description file, records the run and applies retention (`keep: N` deletes all but the `N` newest backups of this job; objects without a description file are never touched). A failed run is recorded with a detail that starts with its step: `preparation failed`, `archive failed`, `upload failed` or `sidecar failed`.

A scheduled run happens once per UTC occurrence, even across an agent restart, and occurrences missed while the agent was down are not made up. If a backup of the volume is still running at an occurrence, that occurrence is skipped without an alert.

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
berthy restore postgres/todo/main-db/20261116T010000Z-7.tar.gz --into todo-restore \
  -e prod --config $CFG --dry-run
berthy restore postgres/todo/main-db/20261116T010000Z-7.tar.gz --into todo-restore \
  -e prod --config $CFG
```

`restore` needs an **`admin`** token. It streams the archive from storage into a **new** Docker volume, preserving permissions and ownership, and compares the SHA-256 and size to the description file. A mismatch fails the operation with `backup checksum mismatch` and removes the volume. A volume that already exists is refused, and so is a key without a description file. `--dry-run` shows what it would restore: the key, the new volume, the backup, app and volume, when it was taken, its size and checksum.

Restore never overwrites a live volume. It always makes a new one, and you decide what to do with it. `backup list` and `restore` work from the last applied manifest even after `berthy remove`, so backups stay restorable.

If the agent stops during a restore, the operation ends `interrupted`, and at its next start the agent removes the half-built volume (it carries the label `berthy.restore-operation=<operation id>`).

#### The PostgreSQL recovery recipe

The restored volume holds `latest.dump`. Load it into a **scratch** database first, and look at it, before you touch the real one. On the server:

```bash
ssh ops@10.0.0.5

# 1. A throwaway Postgres with the restored volume mounted read-only.
docker run -d --name pg-scratch -e POSTGRES_PASSWORD=scratch \
  -v todo-restore:/restore:ro postgres:17.2-alpine

# 2. Load the dump into a scratch database and inspect it.
docker exec pg-scratch createdb -U postgres todo_check
docker exec pg-scratch pg_restore -U postgres -d todo_check --no-owner /restore/latest.dump
docker exec pg-scratch psql -U postgres -d todo_check -c '\dt'
docker rm -f pg-scratch
```

If it looks right, load it into the real database. Stop the writers first. Berthy cannot scale an app to zero, so do it with Docker (`docker service scale todo-api-web=0`), and bring the API back afterwards with `berthy scale api --replicas 2 --role web`. Then:

```bash
docker run --rm -v todo-restore:/restore:ro -v "$PWD":/out alpine cp /restore/latest.dump /out/latest.dump
docker exec -i "$(docker ps -qf label=com.docker.compose.project=todo-postgres)" \
  pg_restore -U todo -d todo --clean --if-exists --no-owner < latest.dump
```

Recovery starts from the backup's capture time. Anything written after the last dump is lost, and missed or failed runs make that window longer.

#### Back up the agent's state

The agent's SQLite file holds its releases, history, audit log, checks and **secrets**. The agent can upload a copy of it daily. Secrets in it are sealed, and the key that opens them is never read or uploaded. Add this to the prod overlay:

```yaml
state_backup:
  destination: offsite
  prefix: berthy-state/prod
  schedule: "17 3 * * *"
  keep: 14
```

| Key | Meaning | Default |
| --- | --- | --- |
| `destination` | A key of `destinations`. | required |
| `prefix` | Object prefix. Each segment may hold letters, digits and `._@+=-`. | `berthy-state/<environment>` |
| `schedule` | UTC cron. | `17 3 * * *` |
| `keep` | Snapshots to keep, 1 to 1000. | `14` |

A snapshot is a consistent copy taken while the agent keeps running, stored as `<prefix>/<UTC time>.db` with a description file. The block belongs to the environment, so it stays in force whatever apps are deployed. A `state_backup` check alerts on a failed or overdue snapshot, and shows in `berthy checks`.

Take one now (an `admin` token). It waits and exits 0 only on success:

```bash
berthy state-backup -e prod --config $CFG
```

```text
run: 3
status: succeeded
key: berthy-state/prod/20261116T031700Z.db
size: 412000
sha256: <hash>
```

Restoring a snapshot needs neither the agent nor its server (step 15).

---

### Step 11. Protected environments and AI agents

The agent can control Docker, which is as good as root on the server. You may want an AI agent to **look at** production, and even **ask for** changes, but not to make them unreviewed. A protected environment does that.

#### What `protected: true` does

- It **refuses mutable image tags.** You deploy a digest (step 4).
- It **holds the changes an AI agent asks for** until a person approves them.

Set it in the overlay (`protected: true` in `berthy.prod.yml`), or in the agent's configuration (`"protected": true`, which setup writes from the manifest). Once a deploy of a protected manifest has succeeded, the agent remembers the environment as protected, even if the line is later removed.

#### Make a token for an AI agent

```bash
berthy agent token -e prod --agent --name claude --scope deploy
```

The `--agent` flag marks it as an agent token. Add the printed JSON object to `tokens` in `/etc/berthy/agent.json` and restart the agent, as for any token (step 6). Give the token to the AI agent's tool through an environment variable; never write it into a file.

- `--scope read` lets the AI agent only look. This is the safe default.
- `--scope deploy` lets it ask for deploys, rollbacks, restarts, backups and so on.
- The mark does not change what the scope allows. What changes is that **on a protected environment its changes are held.** On an unprotected environment, an agent token is served like any other token of its scope.
- An agent token can **never approve or reject**, whatever its scope.

#### What is held, and what is not

The agent checks the token and its scope as usual, then **stores the request instead of carrying it out**. Nothing changes: no operation starts and the lock is not taken. The answer is `202` with an approval id.

Held: `deploy`, `rollback`, `restart`, `scale`, `exec`, `prune`, `remove`, `destroy`, `restore`, `ingress apply`, `secret set` and `secret rm`, `lock acquire` and `release`, `backup run`, `job run`, `state-backup`, `recovery resolve` and `alerts test`.

Not held: reads; `--dry-run` (it changes nothing, so an agent gets the plan at once); and every request on an unprotected environment. A request the token has no right to make is refused at once, not held.

What an agent token's CLI sees:

```bash
BERTHY_PROD_TOKEN=<claude's token> \
  berthy deploy api -e prod --config $CFG --version sha256:<digest>
```

```text
held for approval: 5f1c0d2a... (expires 2026-11-16T10:45:12Z)
plan:
  app: api
  image: ghcr.io/acme/todo-api@sha256:<digest>
  ...
```

The exit code is **`3`**: not done, not failed. With `--json` it prints the answer as JSON.

#### Review and decide

A person with an `admin` token (not an agent token) lists, reviews and decides:

```bash
berthy approvals -e prod --config $CFG
berthy approvals --all -e prod --config $CFG
berthy approve 5f1c0d2a -e prod --config $CFG
berthy reject  5f1c0d2a -m "not during the freeze" -e prod --config $CFG
```

`approvals` lists what is waiting: id, age, time left, who asked, and a one-line summary such as `deploy api sha256:...`, `restart api/web` or `secret set DATABASE_URL`. `--all` adds the decided and expired ones, with their status and who decided. A `read` token sees each request without its plan. The **plan**, which can repeat a command line, shows only to a `deploy` token or above.

The plan is the same object that `--dry-run` of the same request prints. Read it before you approve.

`approve` shows the plan, then runs the request **as the agent that asked**, and follows the operation it starts. Before it runs, the agent plans the stored request again. If the plan is no longer the one that was stored (for example because a release was recorded in between), nothing runs, the approval is marked `failed`, and you ask for a new request. The audit log shows the agent, with `(approved by <you>)` after its name.

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
      "args": ["mcp", "-e", "prod", "--config", "/home/me/.config/berthy/config.json", "--manifest-dir", "/home/me/todo"],
      "env": { "BERTHY_PROD_TOKEN": "${BERTHY_PROD_TOKEN}" }
    }
  }
}
```

The CLI configuration file is the same one as everywhere (`token_env` names the variable). The token comes from the environment the client runs in. It is never printed and never in a tool result. `--manifest-dir` (default `.`) is where `deploy` reads the manifest and a Compose app's file. The AI agent's `version` for `api` on prod must be a digest.

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
- **Held.** On a protected environment: `{"status": "held for approval", "approval_id", "expires", "plan"}`. It is not an error. The AI agent must tell the person to run `berthy approve <id>`, and must not retry. `list_approvals` shows later whether it was approved, rejected or expired.
- **Plan.** With `dry_run`: `{"dry_run": true, "plan": ...}`. Never held.
- **Refused.** The wrong scope, a held deploy lock, an unknown app: a tool error with the agent's message.

Some commands have no MCP tool on purpose: `scale`, `exec`, `prune`, `remove`, `destroy`, `lock`, `ingress apply`, `job run`, `alerts test`, `state-backup`, `secret`, `recovery resolve`, `approve` and `reject`. An AI agent can deploy, roll back, restart, back up and restore; the rest stays with people and the CLI.

---

### Step 12. The terminal UI

```bash
berthy ui -e prod --config $CFG
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
4. **Follow.** The operation's events stream in with a spinner and the time elapsed. It ends with the result ("Restarted api in 12s"), or for a failure, the reason and the command `berthy diagnostics <operation> -e prod`. `esc` while it runs closes the overlay and leaves a note on the status line, `operation <id> continues on the agent`. The operation is not cancelled.

`esc` cancels at any time before the confirmation and sends nothing.

---

### Step 13. Update the database or the cache

CI deploys only the API. The other two apps change when you decide, usually to take a security fix.

#### Redis: a cache can be recreated

A CVE is announced for Redis. Edit `deploy/redis.yml`, bump the tag (for example to `redis:7.4.2-alpine`), commit, and:

```bash
berthy deploy redis -e prod --config $CFG --dry-run
berthy deploy redis -e prod --config $CFG
berthy ps -e prod --config $CFG
```

The dry run shows `redis` as `recreate`. That is fine: `redis` is not `stateful`, and a cache can start empty. The API reconnects when it is back. A `deploy` token is enough.

#### Postgres: back up first, then name the recreation

The same fix for Postgres is a deliberate act, because `postgres` is `stateful`. Edit `deploy/postgres.yml`, bump the **minor** tag (for example `postgres:17.2-alpine` to `postgres:17.4-alpine`), commit, and look:

```bash
berthy deploy postgres -e prod --config $CFG --dry-run
```

The plan shows `postgres` as `recreate` and a **blocker** that says the stateful app would be recreated and needs `--allow-recreate` and an admin token. Berthy refuses to go on without them. Take a backup first, then say you mean it:

```bash
berthy backup run main-db -e prod --config $CFG
berthy deploy postgres -e prod --config $CFG --allow-recreate     # needs an admin token
```

The container is replaced and starts on the same `pgdata` volume, so the data stays. A **major** version change (17 to 18) cannot start on the old data directory. Plan that as a dump and restore instead.

Only an `admin` token can pass `--allow-recreate`. On a protected environment an AI agent cannot even ask for it unreviewed: its deploy is held, and the plan carries the blocker.

---

### Step 14. Clean up

#### Prune

```bash
berthy prune -e prod --config $CFG
```

`prune` removes old images and stopped containers now (it needs an `admin` token). It never removes volumes. A deploy already does this after each success, keeping the images of the last `retain` deploys. Containers of finished migration steps and timed-out commands stay until `prune` removes them; their output is already in the diagnostics.

#### Remove one app

```bash
berthy remove redis -e prod --config $CFG --dry-run
berthy remove redis -e prod --config $CFG
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
berthy destroy -e prod --config $CFG --confirm prod --dry-run
berthy destroy -e prod --config $CFG --confirm prod
```

`destroy` removes everything Berthy created in the environment, as one operation under the lock (an `admin` token). `--confirm` must repeat the environment name, or the CLI refuses before it sends anything. In order: every app (as `remove` does, with the same `--volumes` and `--allow-recreate` rules; if any cannot be removed the whole destroy is refused up front and removes nothing); managed ingress (routes, DNS records, the connector); helper containers and images; stopped one-off containers; and images no container uses.

| Flag | Meaning |
| --- | --- |
| `--confirm <env>` | Required. Must equal `-e`. |
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

2. **Restore the agent's state.** It needs neither an agent nor the old server. Put the Berthy binary and your saved key (`prod.key`, from step 1) on the new server (mode `0600`), find a snapshot (`berthy-state/prod/<time>.db` in the bucket), and run, as root:

   ```bash
   install -d -m 0700 /var/lib/berthy
   chmod 600 prod.key
   BERTHY_S3_ACCESS_KEY=<access key> BERTHY_S3_SECRET_KEY=<secret key> \
     berthy state-restore \
       --endpoint https://s3.example.com --bucket acme-todo-backups --region eu-central-1 \
       --object berthy-state/prod/20261116T031700Z.db \
       --out /var/lib/berthy/state --key-file ./prod.key
   ```

   | Flag | Meaning |
   | --- | --- |
   | `--endpoint <url>` | The S3-compatible endpoint. |
   | `--bucket <name>` | The bucket. |
   | `--region <r>` | The bucket's region, when the storage needs one. |
   | `--object <key>` | The snapshot's key, ending in `.db`. |
   | `--out <dir>` | Where to write the state. Created (mode `0700`) when missing, otherwise it must be empty. |
   | `--key-file <path>` | Your saved key. |

   The credentials come from `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY`. **Flags never carry them**, so they stay out of your shell history and the process list. The command downloads the snapshot and its description file, checks the size and SHA-256, and opens the result with the key. It prints the environment, the schema version, and the **names** of the stored secrets, never their values. A wrong key exits non-zero with `the key does not open this state` and leaves nothing behind.

3. **Set up the server with the saved key.**

   ```bash
   berthy setup -e prod --host ops@10.0.0.5 --listen 10.0.0.5:7710 \
     --key-file ./prod.key --config ~/.config/berthy/config.json
   ```

   Setup installs your key instead of making one, gives the restored state to the `berthy` user, installs the agent and starts it on that state. Secrets, history and the audit log are back. If a state directory exists but no key, setup stops and tells you to pass `--key-file`; it never replaces a key that is there.

   **Tokens are not part of the state.** They live in the agent's configuration, so setup makes a new first `admin` token. Make new tokens for CI and for your AI agents (step 6, step 11).

4. **Check:** `berthy doctor -e prod --config $CFG`.

5. **Redeploy the apps.** The new server has no containers. Deploy `redis`, then `postgres`, then `api`, as in step 4. `api` needs a digest as before. The restored state already holds the manifest, so schedules, probes and backups resume as soon as the apps exist. If you use managed ingress, run `berthy ingress apply` to bring the connector back.

6. **Restore the data.** The new `postgres` starts with an empty database. List the backups, restore the newest dump into a new volume, and load it, as in step 10:

   ```bash
   berthy backup list -e prod --config $CFG
   berthy restore <key> --into todo-restore -e prod --config $CFG
   ```

   Then follow the PostgreSQL recovery recipe, and run `berthy wait api --healthy` once the API is back.

Volumes come back **separately** from the agent's state, with `berthy restore`. Check that the apps recovered, deploys work, alerts reach you, and the next scheduled backup runs.

Practise this on a test server before you need it.

---
## 5. Reference

### Commands

Every command that talks to an agent needs `-e <env>` and `--config <file>`. The tables list only the other flags. Most commands take `--json`.

Scope is the least token that may run the command. `read` < `deploy` < `admin`.

#### Read

| Command | Scope | Flags and arguments | What it does |
| --- | --- | --- | --- |
| `ps` | read | | Apps, roles, replicas, health, running version, backup ages. |
| `describe <app>` | read | | One app in full: roles, tasks, last deploys, job results. |
| `logs <app>` | read | `--follow`/`-f`, `--tail <n>`, `--since <duration or time>`, `--grep <regex>`, `--role <name>`, `--replica <id>` | Container logs, read from Docker. |
| `stats` | read | `--watch`, `--since <duration up to 1h>` | Server and container metrics. |
| `df` | read | | Disk space and Docker disk usage. |
| `history <app>` | read | | Releases and failed deploys, with reasons and operation ids. |
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

#### Change

Every one of these also reads `-e`, `--config` and `--json`. **A change command refuses any other flag it does not read.** It exits `2` with `<flag> is not a flag of <command>` before anything is sent. So `berthy approve <id> --dry-run` does not approve for real: it is refused. The last column is the flags each command reads, exactly.

| Command | Scope | Flags it reads | What it does |
| --- | --- | --- | --- |
| `deploy <app>` | deploy | `--dry-run`, `--request-id`, `--manifest-dir`, `--version`, `--commit`, `--adopt`, `--replace-existing`, `--allow-recreate` | Deploy an image app or a Compose app. |
| `deploy` (no app) | deploy | `--dry-run`, `--manifest-dir`, `--version` (repeatable, `<app>=<ref>`), `--commit` | Deploy every app of the manifest in `depends_on` order and stop at the first failure. An image app given no version keeps the one it runs. Refuses `--adopt`, `--replace-existing`, `--allow-recreate` and `--request-id`. |
| `rollback <app>` | deploy | `--dry-run`, `--request-id`, `--to`, `--revert-schema`, `--adopt`, `--replace-existing`, `--allow-recreate` | Return to the previous release, or the one named by `--to`. |
| `restart <app>` | deploy | `--dry-run`, `--request-id`, `--role` | Restart an app's tasks or containers. |
| `scale <app>` | deploy | `--dry-run`, `--request-id`, `--role`, `--replicas` (required) | Change the replica count of an image app. (`--manifest-dir` is accepted and not read.) |
| `diagnostics <operation id>` | deploy | none | Evidence of a failed operation. |
| `lock acquire` | deploy | `--dry-run`, `-m`/`--message` (required) | Freeze deploys. |
| `lock release` | deploy | `--dry-run` | Let deploys run again. It refuses `-m`. |
| `ingress apply` | deploy | `--dry-run`, `--request-id`, `--manifest-dir`, `--commit`, `--replace-existing` | Create or repair the tunnel and connector, and sync routes and DNS. |
| `job run <name>` | deploy | none | Run a job now and wait. Exit 0 only on success. |
| `backup run <name>` | deploy | none | Run a volume backup now and wait. Exit 0 only on success. |
| `alerts test` | deploy | none | Send a test message through Telegram. |
| `exec <app> -- <command>` | admin | `--dry-run`, `--request-id`, `--role` | Run a command in a running container of an image app. |
| `prune` | admin | `--dry-run`, `--request-id` | Remove old images and stopped containers now. |
| `remove <app>` | admin | `--dry-run`, `--request-id`, `--volumes`, `--allow-recreate` | Take an app down and remove what Berthy created for it. |
| `destroy` | admin | `--dry-run`, `--request-id`, `--confirm` (required), `--volumes`, `--allow-recreate`, `--tunnel` | Remove everything Berthy created in the environment. |
| `secret set <NAME>` | admin | `--dry-run`, `--registry`; the value on standard input | Store a secret. |
| `secret list` | admin | none | List secret names (never values). |
| `secret rm <NAME>` (or `delete`) | admin | `--dry-run` | Remove a secret. |
| `restore <key>` | admin | `--dry-run`, `--request-id`, `--into` (required) | Restore a backup into a new volume. |
| `state-backup` | admin | none | Snapshot the agent's state now and wait. |
| `recovery resolve <operation id>` | admin | `--dry-run`, `-m`/`--message` (required) | End an operation stuck in recovery as failed and release its lock. |
| `approve <id>` | admin, not an agent token | none | Run a held change as the agent that asked, and follow it. |
| `reject <id>` | admin, not an agent token | `-m`/`--message` | Refuse a held change. |

The read commands in the tables above (`wait`, `history`, `audit`, `lock status`, `ingress status`, `backup list`, `approvals`) are refused unknown flags in the same way.

Using `--allow-recreate`, `--adopt`, `--replace-existing` or `--revert-schema` also needs an `admin` token, whatever command carries it.

Flags that belong to one command only: `--revert-schema` (`rollback`), `--commit` (`deploy` and `ingress apply`), `--version` (`deploy`), `--to` (`rollback`), `--confirm` and `--tunnel` (`destroy`), `--into` (`restore`), `--registry` (`secret set`), `--replicas` (`scale`), `--volumes` (`remove` and `destroy`), `--all` (`approvals`), `--backup` (`backup list`).

`--dry-run` prints the plan and changes nothing. It is available only where the table lists it. `backup run`, `job run`, `state-backup`, `alerts test`, `approve` and `reject` have no dry run, so they refuse it. `--request-id` is for retries; the CLI makes a fresh one for each command.

#### Local (no agent)

| Command | Flags | What it does |
| --- | --- | --- |
| `setup` | `-e`, `--host`, `--local`, `--listen` (first run), `--config`, `--manifest-dir`, `--network`, `--protected`, `--no-install-docker`, `--dry-run`, `--json`, `--binary`, `--key-file`, `--new-token` | Prepare a server and install or upgrade the agent, over SSH or on the server. Exit 0 all steps fine, 1 a step failed, 2 wrong command line. |
| `version` | `--json` | The CLI's version and platform. |
| `config validate` | `-e`, `--manifest-dir` | Check the merged manifest. Prints `manifest valid`. |
| `config show` | `-e`, `--manifest-dir`, `--json` | Print the merged manifest. |
| `agent token` | `-e`, `--agent`, `--name`, `--scope read\|deploy\|admin` | Make a token and print it once, with its digest and the object for the agent's `tokens` list. No agent, no network. |
| `state-restore` | `--endpoint`, `--bucket`, `--region`, `--object`, `--out`, `--key-file` | Rebuild the agent's state from a snapshot. Credentials from `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY`. |
| `agent` | `--config <file>` | Run the agent (Linux only). `berthy.service` runs this. |
| `ui` | `-e`, `--config` | The terminal UI. |
| `mcp` | `-e`, `--config`, `--manifest-dir` | The MCP server on standard input and output. |

`setup` is the only command that uses SSH. It uses your own `ssh`, needs root or passwordless `sudo` on the server, is not available through the API or MCP, and is not recorded in the agent's audit log (the server's SSH and `sudo` logs record it). Every other command goes through the agent's API.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Done. For `deploy`, `rollback`, `restart` and the like: the operation `succeeded`. For `job run`, `backup run`, `state-backup`: the run succeeded. For `doctor`: no critical check failed. |
| `1` | Failed: the operation `failed`, `rolled_back`, `interrupted` or needs `recovery_required`; the agent refused (the message says why); the agent could not be reached; a setup step failed. |
| `2` | The command line is wrong: an unknown flag, a missing argument, a missing `-e` or `--config`. |
| `3` | Held for approval: an AI agent's token asked for a change on a protected environment. Not done, not failed. |

### Manifest keys

The manifest is `berthy.yml` plus `berthy.<env>.yml`. Unknown keys are errors. "Required" means the manifest is refused without it.

#### Top level

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `project` | name | required | Project name. Prefixes service and Compose project names. |
| `network` | name | required | The shared overlay network. |
| `protected` | boolean | `false` | Protect the environment (digest-only deploys, agent changes held). |
| `registries` | map | none | Registry credentials by host. |
| `apps` | map | required, at least one | The apps. |
| `jobs` | map | none | Scheduled or on-demand commands. |
| `backups` | map | none | Volume backups. |
| `destinations` | map | none | Object storage for backups and state backups. |
| `state_backup` | map | none | Snapshots of the agent's state. |
| `telemetry` | map | none | OpenTelemetry export. |
| `probes` | map | none | Scheduled checks. |
| `peers` | map | none | Other agents to watch. |
| `alerts` | map | none | Where alerts go. |
| `ingress` | map | none | Managed Cloudflare Tunnel. |

#### `registries.<host>`

| Key | Meaning |
| --- | --- |
| `username` | Required. |
| `password_secret` | Required. The secret, stored with `--registry <host>`. |

#### `apps.<name>`

| Key | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | both | required | `image` or `compose`. |
| `image` | image | required | Repository, with no tag or digest. |
| `roles` | image | required | Map of roles. |
| `file` | compose | required | Compose file path, relative, inside the manifest directory. No `..`. |
| `project_name` | compose | `<project>-<app>` | Compose project name. Never change it once the app holds data. |
| `stateful` | compose | `false` | Recreating or removing it needs `--allow-recreate` and `admin`. |
| `depends_on` | both | none | List of apps deployed before this one by `berthy deploy` without an app. Each must be another app of the manifest, listed once, with no cycle. |
| `env.plain` | both | none | Map of name to string value. |
| `env.secret` | both | none | List of secret names. No duplicates, and not also in `plain`. |
| `deploy.deploy_timeout` | image | `120s` | Longest to become healthy. |
| `deploy.drain_timeout` | image | `30s` | Time for the old version to finish requests. |
| `deploy.start_attempts` | image | `3` | Failed starts tolerated, 1 to 10. |
| `deploy.retain` | image | `5` | Deploys whose images are kept, at least 1. |
| `hooks.pre_deploy`, `hooks.post_deploy` | image | none | Lists of steps. |
| `migrations` | image | none | `version`, `apply`, optional `revert`, `timeout`, `retries`. |

#### `apps.<name>.roles.<role>` (image apps)

| Key | Default | Meaning |
| --- | --- | --- |
| `replicas` | `1` | At least 1. |
| `port` | none | 0 to 65535. Needed for `hostnames`. |
| `command` | the image's | Command as a list. |
| `health.test`, `interval`, `timeout`, `start_period`, `start_interval`, `retries` | see step 2 | Container health check. |
| `volumes` | none | `name:/absolute/path[:ro\|:rw]`. A named volume, not a host path. |
| `resources.cpu` | no limit | Cores, such as `"0.5"`. |
| `resources.memory` | no limit | Such as `512M`, `1G`, `256MiB`. |
| `hostnames` | none | Public hostnames. Needs `ingress` and `port`. A hostname belongs to one role. |
| `service` | `<project>-<app>-<role>` | Existing Swarm service to adopt. |

#### Hooks and migrations

| Key | Meaning |
| --- | --- |
| `backup: <name>` | A step that runs the backup `<name>` and waits. The name must be a key of `backups`. Takes no other setting. |
| `run: [command]` | A step that runs the command in a container of the new image. |
| `timeout` | A `run` step: limit of each attempt, `1s` to `24h`. Default `5m`. |
| `retries` | A `run` step: extra tries after a non-zero exit, 0 to 5. Default `0`. |
| `migrations.version`, `apply` | Required commands (lists). |
| `migrations.revert` | Optional command. Exactly one argument must be the standalone word `{target}`. |
| `migrations.timeout` | Each migration command, `1s` to `24h`. Default `5m`. |
| `migrations.retries` | Re-runs of a failed `apply`, 0 to 5. Default `0`. |

A step is either `backup` or `run`, never both. A command that runs past its `timeout` is never retried, because it may still be running.

#### `jobs.<name>`

`app` (required), `role` (image app) or `service` (Compose app) but not both, `schedule` (five-field UTC cron; none means on demand), `command` (required list), `timeout` (`1s` to `24h`, default `1h`). An image app with several roles needs `role`. The `ingress` app name is reserved.

#### `backups.<name>`

`app`, `volume`, `destination` (all required), `schedule`, `prefix`, `before` (a job name), `retention.keep` (`all` or a whole number of at least 1).

#### `destinations.<name>`

`type: s3`, `bucket` (3 to 63 characters: lowercase letters, digits, `.`, `-`), `access_key_secret`, `secret_key_secret` (required), `endpoint` (`https://host[:port]` or a loopback `http://`), `region`.

#### `state_backup`

`destination` (required), `prefix`, `schedule`, `keep` (1 to 1000). See step 10.

#### `probes.<name>`

One of `http`, `tcp` or `service` (`app`, `role`, `port`, `path`), plus `expect_status`, `interval`, `timeout`, `failures`. See step 8.

#### `peers`, `alerts`, `telemetry`

`peers.<name>`: a base URL with host and port and no path. `alerts.telegram`: `bot_token_secret`, `chat_id`, `reminder`. `telemetry`: `otlp_endpoint` (required), `headers_secret`.

#### `ingress.cloudflare`

`account_id`, `api_token_secret`, `image` (required), `replicas`, `tunnel`, `dns`. See step 7.

#### Limits and reserved names

- The manifest, and each overlay, are at most 1 MiB. YAML nesting at most 64 levels.
- A Compose file is at most 512 KiB, UTF-8, with no NUL.
- The secret name `TUNNEL_TOKEN` and the app name `ingress` (with managed ingress) are reserved.
- A secret value is at most 64 KiB.

### Agent configuration

The agent reads one JSON file, `/etc/berthy/agent.json`, which `berthy setup` writes. It must not be readable by group or others (mode `0600`). Unknown keys are errors. You normally edit it only to add a token.

| Key | Required | Meaning |
| --- | --- | --- |
| `environment` | yes | The environment name, such as `prod`. |
| `listen` | yes | `address:port`. The address must be a loopback, private or VPN (`100.64.0.0/10`) IP, never `0.0.0.0`. |
| `docker_socket` | no | Path to the Docker socket. Default `/var/run/docker.sock`. |
| `state_dir` | with `key_file` | Directory of the state (SQLite). Setup uses `/var/lib/berthy/state`. |
| `key_file` | with `state_dir` | The 32-byte encryption key. Setup uses `/var/lib/berthy/key`. Without state and key the agent is read-only: no deploys. |
| `protected` | no | `true` marks the environment as protected from the first start. |
| `network` | no | The shared network. `doctor` checks it. Setup writes it from the manifest. |
| `approval_ttl` | no | How long a held request waits, a Go duration of at least `1m`. Default `15m`. |
| `compose_command` | no | The Compose command as a list. Default `["docker", "compose"]`. The Compose plugin must be installed system-wide, or this must name a standalone Compose binary. |
| `cloudflare_api_url` | no | Overrides the Cloudflare API base URL. `https`, or `http` on a loopback host. For tests. |
| `telegram_api_url` | no | Overrides the Telegram Bot API base URL. Same rule. For tests. |
| `tokens` | yes, at least one | List of `{"name": ..., "digest": <64 hex>, "scope": "read"\|"deploy"\|"admin", "agent": true\|false}`. `name` and `agent` are optional. Digests must be unique. |

Example (the digest is a placeholder):

```json
{
  "environment": "prod",
  "listen": "10.0.0.5:7710",
  "docker_socket": "/var/run/docker.sock",
  "state_dir": "/var/lib/berthy/state",
  "key_file": "/var/lib/berthy/key",
  "protected": true,
  "network": "todo",
  "approval_ttl": "15m",
  "tokens": [
    { "name": "admin", "digest": "<64 hex characters>", "scope": "admin" },
    { "name": "claude", "digest": "<64 hex characters>", "scope": "deploy", "agent": true }
  ]
}
```

The agent API is HTTP and JSON. Streams (logs, metrics, operation events) use server-sent events, so `curl` and AI agents can read them without a client library. Only `GET /healthz` needs no token. A token is `bty.<environment>.<64 hex characters>`, sent as `Authorization: Bearer <token>`. It works only for its own environment.

### Token scopes

| Scope | Allows |
| --- | --- |
| `read` | `ps`, `describe`, `logs`, `stats`, `df`, `history`, `wait`, `doctor`, `audit`, `agent-info`, `checks`, `jobs`, `lock status`, `backup list`, `ingress status`, `approvals` (without plans), following an operation's events. |
| `deploy` | Everything in `read`, plus `diagnostics`, `deploy`, `rollback`, `restart`, `scale`, `backup run`, `ingress apply`, `lock acquire`, `lock release`, `job run`, `alerts test`, and the plans in `approvals`. |
| `admin` | Everything in `deploy`, plus `secret`, `exec`, `prune`, `restore`, `state-backup`, `remove`, `destroy`, `recovery resolve`, `approve`, `reject`, and the flags `--allow-recreate`, `--adopt`, `--replace-existing`, `--revert-schema`. Compose settings that reach into the host. |

A token marked `agent` has the scope it says. The mark only decides whether its changes are held on a protected environment, and that it can never approve or reject.

### MCP tools

See [step 11](#connect-an-ai-agent-through-mcp). Eleven tools: `list_resources`, `describe_resource`, `list_console_logs`, `get_stats`, `list_deploys`, `get_deploy_diagnostics`, `list_backups`, `wait_for_resources`, `doctor`, `list_approvals` (all read-only) and `execute_resource_command` (`deploy`, `rollback`, `restart`, `backup_run`, `restore`).

### Terminal UI keys

See [step 12](#step-12-the-terminal-ui).

### Files Berthy leaves on the server

| Path | What |
| --- | --- |
| `/usr/local/bin/berthy` | The binary. |
| `/etc/berthy/agent.json` | The agent's configuration. Owner `berthy:berthy`, mode `0600`. `/etc/berthy` is `root:berthy`, mode `0750`. |
| `/etc/systemd/system/berthy.service` | The service. It runs `berthy agent --config /etc/berthy/agent.json` as the `berthy` user in the `docker` group, with `StateDirectoryMode=0700`. |
| `/var/lib/berthy/state/` | The state: `state.db` (SQLite), and `compose/<project>/` with each Compose app's stored files and `.env`. |
| `/var/lib/berthy/key` | The encryption key. `berthy:berthy`, mode `0600`. Never uploaded. |

Besides these, Berthy creates Docker objects: Swarm services named `<project>-<app>-<role>`, Compose projects named `<project>-<app>`, the shared overlay network, a probe helper container and image (`berthy-helper:<hash>`) when a service probe needs it, and the connector service `ingress` when managed ingress is on. Objects it created carry `berthy.*` labels.

---

## 6. Limits and what is not there yet

- **One server per environment.** Image apps are Swarm services, so a three-server cluster needs no redesign, but v1 does not set one up. `berthy setup` starts a single-node Swarm. Joining servers, placement settings and merged views are a later, optional phase.
- **Plain HTTP over a private network.** The agent has no TLS. It relies on the private network for encryption and authenticates every request with a token. Do not expose its port to the internet.
- **No proxy and no certificates.** Berthy ships no reverse proxy. Public traffic enters through Cloudflare Tunnel (managed) or an app you run yourself.
- **No secret interpolation, aliases or generated values.** A secret's name is the environment variable's name, and it is shared by every app of the environment. See step 2.
- **Secrets live in the agent's store.** There is no external secret manager. Back up the encryption key yourself.
- **No `berthy update`, no `secret import`.** Upgrade the agent by running `berthy setup` again with a newer CLI. Set secrets one at a time.
- **No starter manifest.** There is no command that writes one. Start from `examples/todo` and check it with `berthy config validate`.
- **No web UI, and no long-term logs or metrics.** Berthy keeps the last hour of metrics in memory and stores no logs. Export metrics over OpenTelemetry and send logs to a backend of your choice.
- **Telegram is the only alert channel.**
- **Images are not built.** CI builds and pushes them.
- **A Compose app has no automatic rollback, no `scale`, no `exec` and no `--version`.** A Compose `build:` is refused.
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
- **Telegram:** real delivery of alerts. The tests used a fake Bot API.
- **OpenTelemetry backends:** a real collector over `https`, and a backend's own authorization.
- **S3:** a real provider. The backup, restore and state-snapshot code ran against an in-memory fake S3, so a `kill -9` during a snapshot, big states and provider quirks are untested.
- **Other hosts:** arm64 servers, SSH through jump hosts, and a server reboot.
- **Rebuilding a second host** with `state-restore` and `setup --key-file`, end to end (step 15).
- **A real MCP client** (Claude Code, Claude Desktop) over standard input and output, and the TUI on real terminals other than a terminal emulator (Windows Terminal, macOS Terminal, iTerm2), light backgrounds and `NO_COLOR` by eye.
- **The default 15-minute approval expiry** (the tests shortened it), and an agent restart while an approval is pending.
- **Agent memory** against the 30 MB target with telemetry on.

Each phase's verification record lists what it did not cover. Read them before you rely on a feature in production.

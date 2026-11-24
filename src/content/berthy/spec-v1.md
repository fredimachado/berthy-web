# Berthy v1 spec

Last updated: 2026-11-23

## Summary

Berthy is a small deployment and operations agent for Docker servers. It deploys image and Compose apps, shows live logs and metrics, and runs health checks with alerts. It can run commands in app containers on a schedule and back up Docker volumes to object storage. People use the CLI or terminal UI. AI agents use the CLI or MCP server.

It is built for a small team that runs one or several web applications on its own servers. One agent hosts any number of (project, environment) pairs; a three-server Swarm cluster is optional and not set up by Berthy yet.

v1 is done when an environment can be run entirely through Berthy, with deploys, monitoring, alerts, scheduled jobs and backups all handled by it.

"Berthy" is a working name.

## Scope

v1 is deliberately small. It covers what it takes to run a web application and its supporting services on your own servers, and nothing else.

**In scope**

- Deploy Docker image apps and Compose apps. One agent hosts any number of (project, environment) pairs on one server.
- Preparing a server with one command: `berthy setup` checks or installs Docker, turns on Swarm mode and installs the agent, over SSH or on the server itself.
- Optional managed ingress through Cloudflare Tunnel: Berthy creates the tunnel, runs its connector, and keeps public hostnames and DNS records in step with the manifest.
- Image deploys with no downtime: new version starts first, must pass its health check, and rolls back automatically if it does not.
- Live logs per app.
- Live metrics per server and per container: CPU, memory, disk space, Docker disk usage, block I/O and network I/O.
- Health checks with alerts to Telegram and to an HTTP webhook.
- Cron jobs that run commands inside image app or Compose service containers.
- Opt-in scheduled backups of app volumes to S3-compatible object storage, with a restore command.
- Every function available from the CLI with JSON output, and through MCP.
- A small footprint: one binary, no database server. The target is under 30 MB of resident memory for the agent, to be measured in phase 1.
- A deployment model that extends to a three-server cluster without redesign.
- Adopting apps that another deployment tool already runs, without recreating them.

**Out of scope for v1**

- A reverse proxy and certificates. Berthy ships no proxy; public traffic enters through a tunnel connector or proxy that runs as an app. Berthy can manage a Cloudflare Tunnel for this, and Cloudflare serves the certificates. Any other ingress is an ordinary app you configure yourself.
- Cloudflare settings beyond the tunnel, its hostnames and their DNS records, such as access policies and firewall rules.
- Building and pushing images. CI does both; Berthy deploys only images that already exist in a registry.
- Database provisioning and Postgres high availability.
- Users, teams and roles beyond token scopes.
- Templates and preview environments.
- A web UI.
- Long-term storage of logs and metrics. Berthy exports them over OpenTelemetry to a backend of your choice.
- Server provisioning and hardening beyond what `berthy setup` does. Creating the server, its users, its firewall and its private network stays with your provisioning.

## Architecture

Berthy is one static Go binary that runs in four modes, with an agent on each server and no central server between them.

```mermaid
flowchart LR
  subgraph private["On the private network"]
    laptop["Laptop<br/>CLI, TUI, MCP server"]
    ci["CI runner<br/>CLI in the pipeline"]
  end

  subgraph server["Server, one agent for any number of environments"]
    agent["Berthy agent<br/>deploys, health checks, jobs, backups<br/>API on a private address"]
    subgraph docker["Docker"]
      image["Image apps<br/>web and worker roles, Swarm services"]
      compose["Compose apps<br/>databases and supporting services"]
      ingress["Ingress app<br/>tunnel connector or proxy"]
    end
  end

  registry["Image registry<br/>pulled at deploy"]
  storage["Object storage<br/>volume backups"]
  telegram["Telegram<br/>alerts"]
  cloudflare["Cloudflare API<br/>tunnel, hostnames, DNS"]
  public["Public traffic"]

  laptop --> agent
  laptop -. "setup, over SSH" .-> server
  ci --> agent
  agent -- manages --> docker
  agent --> registry
  agent --> storage
  agent --> telegram
  agent -. "managed ingress" .-> cloudflare
  public --> ingress
```

The agent is the only component clients talk to. It drives Docker and reaches the registry, object storage and Telegram itself; public traffic enters only through the ingress app.

The one exception is `berthy setup`. It reaches a server over SSH to install the agent, because there is no agent to talk to yet. See Server setup.

| Mode | Runs on | Job |
| --- | --- | --- |
| Agent | Each server, as a systemd service | Talks to Docker, runs deploys, health checks, scheduled jobs and backups, and serves the API |
| CLI | Laptops and the CI runner | Sends commands to an agent; prints text or JSON |
| TUI | Laptops | Live view of apps, logs and metrics |
| MCP server | Wherever an AI agent runs | Exposes the same operations as tools |

### Decisions

- **One agent per server, no gateway.** An agent hosts any number of (project, environment) pairs, of one or several projects. Each hosted environment has its own state, key, tokens, network and Docker-name claims. The CLI keeps one named context per hosted environment and talks to the right agent directly.
- **Swarm mode is always on, even with one node.** Image apps run as Swarm services, which gives rolling updates and rollback for free, and the same model extends to a cluster.
- **Private network only.** The agent listens on one configured address, which should belong to a private network such as a WireGuard-based VPN. It never listens on all interfaces.
- **No bundled proxy.** Ingress is an app on the shared Docker network that routes to other apps by service name. With managed ingress, Berthy runs a Cloudflare Tunnel connector as that app and configures its routes; see Managed ingress with Cloudflare Tunnel.
- **A systemd service, not a container.** The agent keeps reporting when Docker itself is unhealthy. `berthy setup` installs it.
- **SSH for setup only.** Installing the agent is the single operation that uses SSH. Every other command goes through the agent's API, so Berthy stores no SSH credentials and day-to-day access needs no shell on the server.
- **HTTP and JSON API.** Streams (logs, metrics, deploy progress) use server-sent events, so `curl` and AI agents can read them without a client library.
- **Go.** Docker's client library, the Compose tooling and the strongest terminal UI libraries are all written in it.

### Where state lives

| State | Lives in |
| --- | --- |
| Desired configuration, including apps, checks, jobs and backups | Git, as a manifest in the application's repository |
| What is running | Docker; labels mark what Berthy manages |
| Secrets, deploy history, audit log, job status and backup records | One SQLite file on the server, secrets encrypted |
| Log and metric history | An OpenTelemetry backend, if one is configured |
| Volume backups | Object storage |
| Tunnel, public hostnames and DNS records, with managed ingress | Cloudflare; the manifest says what they should be |

The agent keeps what it runs from, so schedules and checks keep running between deploys. Git remains the source of truth. The next section says what it keeps.

### Two scopes of the manifest

The manifest has two scopes, and the agent stores each one on its own.

- **App scope.** `apps.<name>`, the `jobs` and `backups` that name the app, and the `probes` whose `service.app` is the app. A deploy of the app applies it. It is stored with the app's release, so a rollback of the app takes it back with the app and changes nothing of any other app.
- **Environment scope.** Everything else: `project`, `network`, `protected`, `registries`, `secrets`, `destinations`, `state_backup`, `telemetry`, `peers`, `alerts`, the probes that name no app, `min_version`, `timezone`, `aliases` and `ingress`. The agent stores it as one record per environment, with the commit it came from and whether that checkout had local changes. Every deploy that records a release writes it, in the same transaction as the release: an image app, a Compose app and an adoption. `berthy apply` writes it too, and deploys nothing. A rollback, the ingress connector's own deploy and a schema revert never write it. The `ingress` block is stored here like the rest; `ingress apply` still does the Cloudflare work.

The agent runs from the environment record plus, for each app that has an applied release, the app scope of that release. No release of any app decides for the others. So a rollback of one app changes that app's jobs, backups and probes and nothing else, and the alerts, peers, probes of the environment and the other settings stay as the last deploy or `apply` left them. A deploy of an app applies the environment scope of its manifest and the app scope of that app only: a changed job of another app takes effect with that app's next deploy. A deploy from an older commit applies that commit's environment scope, as any deploy does; `berthy apply` from a newer checkout puts the settings right without a deploy.

**The project is fixed.** Setup writes the project into the hosted environment when it creates it. The environment record remembers that project. For commands that submit the manifest (`deploy`, `apply`), when the CLI has resolved a target and that project's name differs from the manifest, it refuses before it sends anything, with `the manifest in <dir> is for project <have>, not <want>`. If `--project` names a project/environment that is not in the CLI configuration, resolution fails first with `no environment <env> for project <project> in the CLI configuration`. Without `--project`, those commands take the project from the manifest. An explicit `--project` can still target another project's agent from any checkout for commands that do not submit the manifest, such as `ps` and `history`. The agent refuses a mismatched request with `environment <env> runs project <a>; this manifest is for project <b>`. An overlay cannot set `project`. Changing the project means creating another hosted environment.

## Application model

Berthy manages two kinds of application: image apps for stateless services and Compose apps for everything that holds data or supports the stack.

|  | Image app | Compose app |
| --- | --- | --- |
| Source | An image reference in a container registry | A Compose file from the repository at a given commit |
| Runs as | A Swarm service | A `docker compose` project on one named server |
| Used for | Web services and background workers | Databases, caches, telemetry backends, the ingress app |
| Update | Rolling: new starts first, or the old stops first for a role that mounts a read-write volume; gated on its health check, automatic rollback | Only changed services are recreated |
| Replicas | One or more | One per service |
| Ports | None published; reached by service name on the shared network | May bind a port to a private address |

### Rules

- **Roles.** An image app can define several roles that run the same image with different commands, such as `web` and `worker`. Each role has its own replica count, resources and health check, so web replicas can scale without multiplying job workers. An app can start with one role and split later.
- **Stateful apps are separate.** Deploying an image app never touches a Compose app. Restarting or recreating a Compose app marked `stateful` always takes an explicit command that names it.
- **Dependencies.** An app can name, in `depends_on`, the apps that must be deployed before it. The list orders `berthy deploy` without an app and nothing else: a deploy of one app does not deploy or check its dependencies. See Deploying every app.
- **Images are pinned by digest.** The agent resolves the tag to a digest at deploy time and records it. Rollback uses the recorded digest. Protected environments reject every tag, `latest` and a git SHA alike, and deploy only by digest. A release also records the tag the deploy asked for (`--version v1.0.2` records `v1.0.2`), which `history` shows as `tag`. The tag is a label only: the digest is what runs, and nothing decides from it. A digest deploy, a Compose app and an adoption record no tag, and a rollback records the tag of the release it returns to.
- **Compose project names are explicit.** A Compose app runs under the project name `<project>-<environment>-<app>` unless `project_name` sets another. Compose names volumes after the project, so the name must not change once an app holds data.
- **Adoption.** Existing services and Compose projects can be adopted by name without being recreated. See Adopting an existing deployment.
- **Services deleted outside Berthy.** If a role's service is gone under both its bound name and its recorded ID, the next deploy or rollback recreates it under that name and binds the new service to the role. A service that carries the bound name under a different ID, or that still exists under its ID after a rename, is refused before any service changes.
- **One shared network.** Each hosted environment has an attachable overlay network shared by its apps. Its name defaults to `<project>-<environment>`; set `network` to adopt an existing network. `berthy setup` creates it when it does not exist. Image roles have the alias `<app>-<role>` on that network. A Compose app joins it as an external network with `name: ${BERTHY_NETWORK}`.

## Configuration

All desired configuration lives in the application's repository as one base manifest plus one overlay per environment.

- `berthy.yml` holds what is common.
- `berthy.<environment>.yml` overrides it per environment: replicas, resources, schedules.
- **Merge rules.** A map in an overlay is merged key by key. A list or a plain value in an overlay replaces the base's, and `config validate` warns when the list leaves out an entry of the base list (`<path> replaces the base list and drops <entries>`), except for a command line (`command`, `entrypoint`, a health check's `test`, and a migration's `version`, `apply` and `revert`), which is replaced without a note. A `null` in an overlay removes the key it is set on, and a `null` for a key the base does not set is a warning. The base file refuses `null`, and both files refuse anchors and aliases. Each value keeps the file and line that set it, for `config show --origin` and for the place of a problem.
- Every deploy carries the merged manifest from the commit being deployed. Nothing is configured by hand on the server. The commit is `HEAD` of the manifest directory's checkout unless `--commit` gives one, and a deploy whose manifest or Compose files have local changes is recorded as modified, which a protected environment refuses.
- A top-level `aliases` map in the manifest names command lines for people at a terminal, for example `console: exec api --role web -- bin/console`. The CLI expands them; see "CLI" below.
- The reference of every manifest key, with its type, default and meaning, is not written here. It is generated from one definition, `internal/manifest/keys.go`, and kept in step with the code by a test: `berthy docs [section]` prints it, the user guide's "Manifest keys" holds it, and `berthy config schema` prints a JSON Schema (draft-07) of the manifest for editors. This spec describes the design.
- A top-level `min_version` (a release such as `0.9.0`) is the oldest Berthy release the manifest works with. The CLI and the agent refuse a manifest that needs a newer release than theirs. `config validate` checks its format and the CLI's own release, without contacting a server.
- A top-level `timezone` (an IANA name such as `Europe/Lisbon`, default `UTC`) is the zone every `schedule` of the manifest is read in: jobs, backups and the state backup. `config validate` refuses a name the binary does not know, with the file and line. It is part of the environment scope. See "Scheduled container commands".
- A top-level `secrets` map declares secrets Berthy may generate (`secrets.<SECRET>.generate`), each with a required `format` (`hex`, `base64` or `alnum`) and optional `bytes` (16 to 256, default 32). Each name must be a secret name other than `TUNNEL_TOKEN`, must be read by an app (`env.secret` or `env.template`), and must not be needed by a registry, destination, telemetry, alerts or ingress. An overlay merges the map; a `null` removes one secret. It is part of the environment scope. An agent refuses a key it does not know, so this key needs the release that ships it: upgrade the agent with `berthy setup` before the first deploy of a manifest that uses it, and set `min_version` to that release.

The examples in this spec use two environments named `dev` and `prod`. Names and values are placeholders.

```yaml
# berthy.yml
project: myapp
network: myapp

registries:
  ghcr.io:
    username: <user>
    password_secret: REGISTRY_TOKEN

apps:
  api:
    kind: image
    image: ghcr.io/<org>/<image>
    depends_on: [postgres]
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
        LOG_LEVEL: info
      secret:
        - DATABASE_URL
        - JWT_SIGNING_KEY
    deploy:
      deploy_timeout: 120s
      drain_timeout: 30s
      start_attempts: 3
      verify: true
      retain: 5
    hooks:
      pre_deploy:
        - backup: main-db

  postgres:
    kind: compose
    file: deploy/postgres/docker-compose.yml
    stateful: true
    env:
      plain:
        POSTGRES_DB: myapp
      secret:
        - POSTGRES_PASSWORD
```

### Environments

An environment is one named target of a project, such as `dev` or `prod`, with its overlay, secrets and tokens. It is placed on exactly one agent as a **hosted environment** (`project/environment`). Two projects may both have `prod`; one project may have several environments on one agent. Each hosted environment owns its state, key, tokens, protected flag, network, every Docker object labelled with both names, and every Docker name it has claimed.

- **No default environment.** Every command that needs an environment takes `-e <name>`, or else `$BERTHY_ENV` from the shell when `-e` is not given. A given `-e` wins, including an empty one. `context add` and `context remove`, `agent token`, `state-restore` and `mcp` do not read `BERTHY_ENV`. A command that needs an environment and has neither is rejected. The CLI picks the project with `--project`, else the `project` of `berthy.yml` in the manifest directory, else the only project that has that environment; an environment several projects have is refused with a message that names them.
- **Protected environments.** An overlay can set `protected: true`, typically for production. A protected environment rejects every image tag and deploys only by digest, and holds changes requested by AI agents until a person approves them. It refuses a deploy from a checkout whose manifest or Compose files have local changes.

```yaml
# berthy.prod.yml
protected: true
```

### Health checks

A role's health check is a command run inside the container, with the same fields Docker uses.

The fields are `test` (a command that starts with `CMD` or `CMD-SHELL`; exit code 0 means healthy), `interval`, `timeout`, `start_period`, `start_interval` and `retries`. Their types and defaults are in the generated reference (`berthy docs roles`).

- Durations are written as `15s`, not in nanoseconds.
- The check runs inside the container, so the image must contain the command.
- With the example values a container that never becomes healthy is marked unhealthy after about 75 to 90 seconds, inside the 120-second `deploy_timeout`.
- A healthy container is first noticed about one `interval` after start, so every deploy takes at least that long. An optional `start_interval` checks more often during the start period; confirm the installed Docker version supports it for Swarm services before using it.

### Environment variables

- **Plain** values are written in the manifest and reviewed like code.
- **Template** values are the variables of `env.template`: text that refers to secrets as `${NAME}`, where NAME is a secret name (letters, digits and `_`, not starting with a digit, and not `TUNNEL_TOKEN`). `$$` writes one `$`, and any other `$` is an error whose text names the offset of the reference. There are no defaults, no nesting, no references to variables and no URL encoding. A template is checked where the manifest is loaded (the error is placed at the template's line), and a variable is in one of `plain`, `secret` and `template`. The agent fills a template in when it deploys, for an image app's service spec and for a Compose app's `.env` file alike, with one function that builds the app's environment. The manifest and the stored release keep the template, never the filled value. The filled value is a secret: `config show` prints the template, the redaction of exec, run, diagnostics and logs replaces the filled value as a whole (and the secrets inside it), a migration version that prints it is refused, and an adoption plan takes the service's own value of the variable, as it does for a secret variable.
- **Secret** values are listed in the manifest by name only, as the entries of `env.secret`. An entry is a name, which is also the variable the container gets, or a one-key map from the variable to the secret: `- DATABASE_URL: API_DATABASE_URL` gives the container `DATABASE_URL` with the value of the secret `API_DATABASE_URL`. A variable is listed once, and two variables may take one secret. The values live in the agent's encrypted store and are set with `berthy secret set NAME`, with `--registry HOST` for a registry password (see Registries). At a terminal the CLI asks for the value and does not echo it. A piped value is read from standard input, and one trailing newline is removed.
- At a terminal, the CLI first asks the agent which secrets it holds. If the agent cannot be reached or refuses the agent token, the command stops with exit status 1 before the prompt. If the secret is already stored, the CLI says the new value replaces it. A piped value makes one request and skips this.
- `berthy secret import -e ENV [--dry-run]` reads `NAME=value` lines from standard input (the value is everything after the first `=`, one trailing carriage return is removed, and blank lines and lines starting with `#` are skipped) and stores each as a secret. The CLI checks the lines, and the agent checks the same rules again: one to 500 entries, each name a valid secret name other than `TUNNEL_TOKEN` and appearing once, each value at most 64 KiB with no NUL. The import is all or nothing: the agent stores every entry in one transaction, or none when any entry is refused, and it refuses a name that is stored as a registry password. The request is one `POST secrets/import` with `{"secrets":[{"name","value"}],"dry_run"}`, and it must fit in one request body of 1 MiB; a larger import is refused by the CLI before it is sent. The answer is `{"created":[...],"replaced":[...]}`. A dry run answers `{"action":"secret import","create":[...],"replace":[...]}`, with names only, sorted. Each secret is audited as `secret_set:NAME`, as `secret set` audits it. On a protected environment an agent token's import is held, and its plan holds the names only.
- `berthy secret generate NAME -e ENV [--bytes N] [--format FORMAT] [--replace] [--dry-run]` makes a random value on the agent and stores it, so the value never reaches the CLI or a shell. The agent draws the bytes from `crypto/rand`. `hex` (the default) is `N` bytes in hex, `base64` is `N` bytes in URL-safe base64 without padding, and `alnum` is `N` characters from letters and digits, each one equally likely. `N` defaults to 32 and must be from 16 to 256; a bad format or length is refused with 400. The request is `POST secrets/generate` with `{"name","bytes","format","replace","dry_run"}`, and the answer is `{"name","bytes","format","replaced"}`, which never holds the value. A name that is stored is refused with 409 unless `replace` is set, so a database password in use is not changed by accident. A registry password is refused with 400. The check and the write share one transaction, and the write is audited as `secret_generate:NAME`. A dry run answers `{"action":"secret generate","name","exists","bytes","format"}`. On a protected environment an agent token's generate is held, and its plan holds no value. The generate needs an admin token, as the other secret commands do.

  The request may also carry `manifest` and `compose_files` (a map from app name to Compose file text). Without `replace`, an unstored secret is refused if a reader in any recorded release was deployed, or if a submitted reader has a release, an admitted deploy, a container, service or Compose-labelled volume, or an existing fixed-name volume. Image readers' declared volumes are checked too. An unreadable state or Compose file, an included Compose file, an interpolated volume name, or an unavailable inventory refuses generation. Another environment's claimed Compose project is refused before its resources are inspected. The named route answers 409 naming the reader and, when applicable, the volume; its dry run includes `app` and optionally `volume`. `replace` skips this guard. The CLI supplies a matching manifest and its Compose readers' files when the named secret has a reader, using `--manifest-dir` when given.

- `POST secrets/generate-declared` needs admin scope and takes `{"manifest", "compose_files", "dry_run"}`. It returns `{"action":"secret generate declared","secrets":[...]}` with each secret's `name`, `outcome`, `bytes` and `format`, sorted by name. `keep` leaves a stored value unchanged; `refuse` names the reader as `app` and optionally its `volume`; `generate` creates the missing value, or would create it in a dry run. Neither the answer nor the plan holds a value. Each generated secret has its own `secret_generate:NAME` audit row. If a batch stops, a subsequent request keeps completed values and can finish the rest.
- `berthy secret list -e ENV --manifest-dir DIR` lists the stored names, then the manifest's unmet secret needs (`env.secret`, the secrets `env.template` refers to, registry passwords, destination keys, telemetry headers, the Telegram bot token and the managed ingress token). A `missing:` line names an absent secret or one with an incompatible registry or plain-secret association. A `conflict:` line reports an impossible shared use, such as one password secret named by multiple registries or by a registry and a plain reader. With `--json`, the `missing` array contains all these needs. The manifest must load.
- A deploy stops before changing anything if a named secret has no value, in `env.secret` or in a template, and its error names the secret: `secret NAME is not set` (or `secret NAME is a registry password, not a workload secret`). A secret's name is not secret, so these two messages are public.
- Values that differ between environments go in the overlays.
- Both kinds of app take the same `env` block. For a Compose app, Berthy writes each variable and its value into the project's environment file, where the Compose file reads the variable as `${NAME}`. Only the agent can read that file.
- **Identity.** Every container of an image app, the services of its roles and the one-off containers of its `run:` hooks and migrations, also gets `BERTHY_ENVIRONMENT` (the environment name), `BERTHY_PROJECT` (the manifest's `project`), `BERTHY_APP` (the app's name), `BERTHY_ROLE` (the role's name, empty in a one-off container, which belongs to the app), `BERTHY_VERSION` (the tag the deploy asked for, empty for a digest deploy and for the containers of a schema revert, which record no tag) and `BERTHY_IMAGE_DIGEST` (the digest that runs, as `sha256:…`). These values change only with the image, so a deploy that keeps the version gives its containers the same environment. A rollback sets the tag and digest of the release it returns to. A Compose app gets `BERTHY_ENVIRONMENT`, `BERTHY_PROJECT`, `BERTHY_APP` and the resolved `BERTHY_NETWORK` in its environment file and no role, version or digest. An `env.plain` name, an `env.secret` variable or an `env.template` variable that starts with `BERTHY_` is refused.
- Secrets are stored per environment. Other parts of the manifest refer to them by name as well: registries, backup destinations and telemetry.

### Registries

Image apps pull from any OCI registry. A private registry needs a credential, declared under `registries` with its password held as a secret.

```yaml
registries:
  ghcr.io:
    username: <user>
    password_secret: REGISTRY_TOKEN
```

- The credential should be read-only.
- The agent uses it to resolve tags to digests and to pull. It hands the credential to Swarm with the service, so every server in a cluster can pull.
- The password is set with `berthy secret set NAME --registry HOST`, where HOST is the registry's key under `registries`. The agent uses that secret only for that host. An environment secret is set without `--registry`, and an app's environment refuses a secret that has one.
- At a terminal, `secret set` for a registry password checks it before storing it. For a registry the manifest lists under `registries`, the CLI asks the registry whether the credential can read the repository of each image app that pulls from that host. If the registry refuses the credential, the command stops with exit status 1 and sends nothing to the agent. If the registry cannot be reached from this machine, the CLI reports that the credential was not checked and stores the password. For `ghcr.io`, the CLI also prints a link that creates a classic token with `read:packages` only. A piped value is not checked.
- The agent checks each registry password as the check `registry:HOST`, one for each registry of the environment's settings that a deployed image app pulls from. The monitor asks every 10 minutes, and `doctor` asks when it runs. Each check asks the registry whether the stored username and password can read each repository those apps pull from that host, the same question as the terminal check above, and it only reads. It is ok when the registry accepts the password, critical when the registry refuses it or the secret is not stored, and unknown when the registry cannot be asked. A registry does not say when a password expires, so no registry check warns ahead of an expiry. Health checks gives the details and the alert rules.
- Setting a stored registry password again without `--registry` keeps its registry. `--registry HOST` on an existing secret replaces the registry. To make a registry password a plain secret, remove it with `secret rm` first.
- Storing a registry password gives it to every running Swarm service of an image app that pulls from that registry, without restarting the tasks. Compose apps get it at their next deploy. The CLI prints one line per service. A service that could not be updated is printed as `not updated` with the reason, and running `secret set` again retries it.
- A registry password rotation leaves `secret_set:NAME` in the audit log and, when services were involved, `registry_auth_refresh:HOST`, with outcome `succeeded`, or `failed` when a service was not updated.
- Compose apps use the same credential for images from a listed registry. A Compose deploy needs the credential of every registry the manifest lists, not only of those its images come from, because the agent writes them all for the Compose CLI; a missing one stops the deploy.
- A registry with no entry is pulled from anonymously.

### Checking a manifest

- `berthy config validate -e prod` checks the merged manifest without contacting a server. It reports every problem it finds, one per line as `<file>:<line>:<column>: <path>: <message>`, where the file is the base manifest (`berthy.yml`) or the overlay (`berthy.<env>.yml`) that sets the key, followed by a count such as `2 problems`, and exits 1. A part that is not known is left out of the line, and the path is left out when the message already says it. A value of the wrong type stops the check of the rest of the manifest. Other commands that load the manifest, and the agent, stop at the first problem and give its message. A valid manifest can still have warnings. Each one is a line `warning: <file>:<line>:<column>: <path>: <message>` on standard error, and the check still passes with `manifest valid`. `--json` prints the warnings as a `warnings` list instead, empty when there are none. Warnings name a `deploy.order: start-first` on a role that mounts a read-write volume, a role with more than one replica that mounts one, and an overlay list that drops entries of the base list.
- `berthy config show -e prod` prints the merged result with secret values hidden. With `--origin` it prints one line per value, with the file and line that set it, or `default` for a value that no file sets. `--origin --json` prints `[{path, value, file, line}]`, where a default has no `file` and no `line`.

## Server setup

`berthy setup` takes a Linux server from a bare operating system to a running agent in one command, and deploys nothing.

```sh
berthy setup -e prod --host <user>@<server> --listen <private address>:<port>
```

Without `-e`, setup reads `$BERTHY_ENV` the same way other agent-facing commands do. A given `-e` wins.

It works in one of two ways.

| Where it runs | How | Used for |
| --- | --- | --- |
| From a laptop | `--host <user>@<server>` connects over SSH | Setting up a remote server by hand |
| On the server | `--local` runs the same steps directly | Provisioning tools and images that already carry the binary |

### What it does

1. **Connect.** Over SSH, or locally. The account must be root or able to use `sudo` without a password prompt: setup runs `sudo -n` and never asks for one. Over SSH, setup runs the `ssh` found on `PATH`, so keys, the agent, jump hosts and host key checks are the ones the operator already uses. Setup never takes a password and never stores a key.
2. **Check the server.** Linux with systemd, a supported CPU architecture, and the `--listen` address already assigned to the server. A server that already runs an agent can receive another hosted environment: setup adds the entry and leaves the others alone.
3. **Docker.** Confirm Docker Engine is installed, at a supported version, enabled at boot and running. If Docker is missing, install it with Docker's official install script. If it is stopped, start it.
4. **Swarm.** Turn on Swarm mode with the private address as the advertise address, and the Swarm management port listening on that address only, unless the server is already a manager.
5. **Network.** Create the shared attachable overlay network for this hosted environment, unless it exists. Its name comes from the manifest, or defaults to `<project>-<environment>` when there is no manifest and `--network` is omitted. Two hosted environments cannot share one network name.
6. **Agent.** Create the `berthy` system user and add it to the `docker` group (`user`). Put the agent binary on the server (`binary`; see "Same version as the CLI" below). Create this environment's state directory and encryption key (`key`). Write the agent's configuration (`config`), then install the systemd unit, enable the service and start it, or restart it when the binary, the configuration or the unit changed (`service`). Adding or changing a hosted environment rewrites `agent.json` and restarts the shared agent for every hosted environment on the server. The new agent has to answer its health check; if it does not, setup puts the previous one back.
7. **First token and CLI configuration.** For a new hosted environment, create one `admin` token (`token`). Save it locally or show it (`cli_token`). When the entry already exists, keep its tokens unless `--new-token` adds another. Add the environment to the CLI's configuration with the agent's address (`cli_config`): the file `--config` names, else the one `BERTHY_CONFIG` names, else the default file.
8. **Verify.** Call the new agent's `doctor` (`verify`). If this machine cannot reach the private address, setup says so and sends the same request on the server instead.
9. **Key copy.** After a successful run that is not a dry run and not `--local`, save a copy of the environment's encryption key on the operator's machine (`cli_key`).

It ends by printing the next steps: keep the key copy setup saved and store another off this machine (or, when none was saved, the step that says what to do instead), set the token in the environment variable the CLI configuration names when a token is shown and was not saved, set the secrets, apply the managed ingress if the manifest declares one, and run the first deploy.

### Rules

- **It deploys nothing.** Setup never builds, pushes, pulls or starts an app. The first deploy is a separate `berthy deploy`, after the secrets are set.
- **Safe to run again.** Each step checks before it acts. A second run repairs what is missing and changes nothing else. It never replaces the encryption key, the tokens or the agent's state, and it never touches a running app.
- **It upgrades the agent.** Running setup with a newer CLI replaces the agent binary and restarts the service. Apps keep running while the agent restarts: setup never calls Docker for an app, and only the agent's process restarts. The new binary is first placed next to the live one (`/usr/local/bin/berthy.new`, checked against its SHA-256), then renamed over it with the previous one kept as `berthy.prev`; a changed configuration is handled the same way (`agent.json.new`, the previous one kept as `agent.json.prev`). Setup then waits up to 30 seconds for the agent to answer `GET /healthz` on its listen address, asked on the server. If it does not, setup puts the previous binary and configuration back, restarts the service, and fails the `service` step with `the new agent did not come up; the previous one was put back` and the last 20 lines of the agent's journal. On a first install there is nothing to put back: the step fails with the journal lines and leaves the service stopped. The `.prev` files are kept for one generation.
- **Existing Docker is left alone.** Setup does not upgrade or reconfigure a Docker installation it did not make. Docker older than the minimum supported version stops the run with a message. The minimum is Docker Engine 25.
- **Existing Swarm and network are kept.** A server that is already a manager keeps its Swarm. An existing network with the right name is used as it is; if it is not an attachable overlay, setup stops. A server that is a worker in another Swarm stops the run.
- **Same version as the CLI.** Setup installs the version of Berthy that runs it, chosen in this order:
  1. `--binary <path>`: a local file, which must be an ELF executable for the server's architecture (`x86_64` or `aarch64`) or setup stops.
  2. A Linux CLI of the server's architecture uploads itself.
  3. A release CLI on any other platform makes the server download the matching release, with `curl` or `wget`, from `<release URL>/<version>/berthy-linux-<arch>` (`amd64` or `arm64`) and `<release URL>/<version>/checksums.txt`, a file in `sha256sum` format with one line per artifact. The server checks the line of the artifact with `sha256sum -c` and stops with `checksum mismatch` if it differs. The release URL is `https://github.com/fredimachado/berthy/releases/download`, or the value of `BERTHY_RELEASE_URL`, which exists for tests and mirrors and must be `https`, or `http` on a loopback or private address. Releases are published by `.github/workflows/release.yml` when a `v*` tag is pushed: it builds static (`CGO_ENABLED=0`) binaries stamped with the tag for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64 and windows/amd64, named `berthy-<os>-<arch>` (`.exe` on Windows), writes `checksums.txt` over them, and creates the GitHub release of the tag with them. A tag with a `-` is published as a prerelease, and a tag that does not match the release version pattern fails before anything is published. A release publishes only a commit whose CI run succeeded, and the workflow can also be run by hand as a dry run that checks and builds a commit and publishes nothing.
  4. A development build on any other platform has nothing to install: setup stops and asks for `--binary`.

  An upload streams the file through the SSH session into `berthy.new` and compares the SHA-256 the server computes with the local one. A server that already has that exact binary (by hash, or by version for a download) keeps it: the `binary` step is `ok`.
- **The encryption key is never replaced.** `--key-file` reads a saved key of exactly 32 bytes. If the server has a key, it must be the same one, or setup stops with `the server has a different encryption key; setup never replaces it`. If it has none, setup installs the saved key (mode 0600, owned by `berthy`; no key byte appears in a command line or in the output). Without `--key-file`, an existing key is kept; with no key and no state, setup generates one on the server; with state but no key it stops with `/var/lib/berthy/environments/<project>/<environment>/state has state but no key: pass --key-file with the saved key`. The `key` step never reads a key back: it compares hashes. Only remote setup's `cli_key` reads the configured key under the existing reader rules and saves a copy on the operator's machine (wrapped for that download). A rebuild with `--key-file` streams the key bytes on stdin over SSH instead; sudo input recording on the server can capture them.
- **The key copy.** After a successful remote run that is not a dry run, `cli_key` saves the configured key file under `<home>/.berthy/keys/berthy.<project>.<environment>.<key ID>.key` (one file per key ID, never replaced). The installed binary reads the key as the `berthy` user with the checks of the agent's own reader, then hands it over wrapped: one RSA-OAEP (SHA-256, 3072-bit) ciphertext for a wrapping key that lives only in that setup run (`berthy-key-wrap/1`). While `<key>.next` exists the hand-over returns unsettled and setup saves nothing; find and fix what kept the agent from putting its key files in place before any restart, then restart the agent and follow the CLI retry guidance: run the same setup again from the same working directory and with the same scope, omit a previously supplied `--key-file` because the old copy can mismatch the settled key, and leave out `--new-token` when that run already created the token. Only the SSH exchange is bounded (30 seconds, then a short pipe cleanup); wrapping-key generation runs before that timer, and local publication after it. The key folder, its parent `.berthy` and the file are private to the current user before any key byte is written (POSIX: exact `0700` / `0600`; macOS: also no access-control entry; Windows: one protected full-control entry for that user). Any problem leaves the step `skipped` and the run exit 0, with no `key_copy`. `--local` saves no copy. The key never appears in a log, a step detail, an error or the report.
- **The configuration is merged, never overwritten.** Setup starts from the server's own `agent.json` and adds or updates one hosted environment in its `environments` list. It sets `listen` on the first run, `docker_socket` when empty, and for that entry `project`, `environment`, `state_dir` and `key_file` when empty, `network`, and `protected` (set from the manifest or `--protected`, never turned off). Other hosted environments, their tokens and every other field are kept. A different `--listen` than the agent's is refused (`the agent listens on <address>; setup does not move it`), and `--listen` may be left out once the server has a configuration. A configuration that does not validate stops the run, without printing it. The file is written only when its content changes. An `agent.json` of an earlier release (one environment at the top level, no `environments` list) is refused: setup prints the commands that move the old configuration, state and key aside, and deletes nothing.
- **Secrets after setup.** After successful setup at a terminal, when a manifest and admin token are available, setup prints its summary and any token, then runs the secrets guide. The guide generates declared secrets and asks for missing values. A completed guide removes the secrets step or names those still missing. A held or failed guide leaves the manual secret steps, and does not change setup’s exit status. JSON, piped input and dry runs do not run the guide.
- **One setup run at a time.** Run one `berthy setup` at a time against a server. Two runs that add different environments can read the same `agent.json` and lose one entry. (A setup lock is planned: #53.)
- **The first token.** A new hosted environment gets one `admin` token named `admin`. The agent keeps its digest. Once live, setup saves the value under the CLI entry's URL, project, environment and token variable in the local credential store. It prints the value after the step lines and in `--json` if the save is unavailable or unconfirmed, or if `--show-token` is given. An unconfirmed save may still finish later. The token is never in a step detail, an error, a log, or a command or script sent to the server. `--new-token` adds another `admin` token named `admin-<UTC date and time>` and keeps the existing ones. A live token is shown if not confirmed saved even when a later step fails; a token rolled back with a failed upgrade is not shown. If an interrupted swap or rollback leaves its outcome unconfirmed, the failed run shows the token in case the server kept it. Setup neither saves that token nor treats it as live.
- **The CLI configuration.** With `--config <path>`, or else the file the CLI finds (see "CLI" below), setup adds or updates `projects.<project>.environments.<env>` with `url` (`http://<listen address>`) and `token_env` (the variable the entry already names, or `BERTHY_<PROJECT>_<ENV>_TOKEN`, with each name in upper case and other characters as `_`), keeps every other project and environment, and replaces the file atomically (a new file has mode 0600). Without `--config` and `BERTHY_CONFIG`, the default file's directory is created with mode 0700 when it is missing. The file never holds a token. CLI commands use the named variable first and otherwise look for the entry's token in the OS credential store, keyed by agent URL, project, environment and variable. `BERTHY_TOKEN_STORE=none` disables the store. When no location is known (no home or configuration directory), the step is `skipped` and its detail says which entry to add and how to name the file. A CLI configuration of an earlier release (`environments.<env>` at the top level) is refused.
- **Verify.** With an admin token (the one just made, or the one in the variable the CLI configuration names, or the stored token for that entry), setup calls `GET /v1/projects/<project>/environments/<env>/doctor` from this machine with a 5 second connect timeout and prints a one-line summary; a critical check that is not ok fails the step and the run exits 1. If this machine cannot reach the agent, setup says so and sends the same request on the server with `curl`; the token goes to `curl` on its standard input, never in a command line. Without a token, setup only checks that `/healthz` answers.
- **Dry run.** `--dry-run` connects, runs every check and prints what would change, without changing anything on the server: not a package, a service, a setting or a temporary file. A step that would change something reports `would_change`.
- **Scriptable.** `--json` prints one object on standard output and nothing else. A failed step exits 1 and names the step; a wrong command line exits 2.
- **Verbose.** `--verbose` prints each command or script setup sends on standard error: the script before it is sent, and its exit status after. Standard output keeps the step lines and, with `--json`, the report, and the report gains a `commands` list on each step. With `--dry-run` the log holds the reads the dry run runs, and for each step that would change something the scripts a real run would send, each marked `→ not run: dry run`. A dry run lists the health check that `verify` would send when there is no admin token to check with. It cannot list the doctor request that `verify` sends from the server when this machine cannot reach the agent, because only a real run finds out whether it can. The log shows what is sent as the script, never the stdin a script reads and never what it prints, so the token and the encryption key never appear in it. What `cli_key` sends and receives is not shown either, and the key crosses it only encrypted.

Each step has a name (`connect`, `check`, `docker`, `swarm`, `network`, `user`, `binary`, `key`, `token`, `config`, `service`, `cli_config`, `cli_token`, `verify`, `cli_key`) and ends with one status: `ok` (nothing to change), `changed`, `would_change` (a dry run), `skipped` or `failed`. A failed step stops the run.

```json
{"project": "shop", "environment": "prod", "target": "ops@s1", "dry_run": false, "ok": true,
 "steps": [{"step": "docker", "status": "ok", "detail": "Docker 29.9.3, running, enabled"}],
 "token": "bty.shop.prod.…",
 "key_copy": "/home/me/.berthy/keys/berthy.shop.prod.91c0aa11bb22cc33.key",
 "next_steps": ["keep the copy of the encryption key that setup saved in /home/me/.berthy/keys/berthy.shop.prod.91c0aa11bb22cc33.key, and store another in a password manager or vault: without the key, the secrets of a lost server are gone"]}
```

`token` is present when this run made a live token and the save was unconfirmed or `--show-token` was given, or when a failed activation left the token's configuration outcome unconfirmed. `token_stored` is true when this run saved the token and the store confirmed it. `key_copy` is the path of the key copy on this machine. It is absent when none was saved. `next_steps` is present after a successful run that is not a dry run. `commands` is present on each step only with `--verbose`: the scripts the step sent, each as it was sent, and in a dry run also the scripts a real run would send. A dry run makes no token, writes no file and sends only reads to the server: the steps that would change something report `would_change`, and `verify` reports `skipped` with `would check the agent`.

### What it reads from the manifest

Run from the application's repository, setup reads two values from the merged manifest for the environment.

| Value | Used for | Without a manifest |
| --- | --- | --- |
| `project` | The project of the hosted environment | `--project <name>` (required when there is no manifest) |
| `network` | The shared network to create; defaults to `<project>-<environment>` | `--network <name>` |
| `protected` | Marking the hosted environment as protected from its first start | `--protected` |

### Options

| Option | Meaning |
| --- | --- |
| `--host <user>@<server>` | Set up a remote server over SSH |
| `--local` | Set up the server the command runs on |
| `--listen <address>:<port>` | The private address the agent's API listens on. Required on the first run; later runs keep the agent's own. It must be one specific address of the server, not `0.0.0.0` or `::`, and a loopback, private or VPN address. |
| `--project <name>` | The project, required when the directory has no manifest |
| `--network <name>` | The shared network, when the directory has no manifest |
| `--protected` | Mark the environment as protected, when the directory has no manifest |
| `--manifest-dir <dir>` | Where to read the manifest from. The default is the current directory. |
| `--no-install-docker` | Stop if Docker is missing instead of installing it |
| `--dry-run`, `--json` | Report what would change without changing it; report as JSON |
| `--verbose` | Print each command setup sends, and its exit status, on standard error. With `--dry-run`, also the commands a real run would send. Never the token or the key. |
| `--binary <path>` | Install this Linux build of Berthy instead of the CLI itself or the release that matches it |
| `--key-file <path>` | Install a saved encryption key instead of generating one, when rebuilding a server |
| `--new-token` | Add another `admin` token, for when the first one is lost |
| `--show-token` | Print the newly created admin token as well as saving it |
| `--config <path>` | The CLI configuration to add the environment to. Without it, setup uses the file the CLI finds (`BERTHY_CONFIG`, else the default file). |

### What it leaves on the server

| Item | Location |
| --- | --- |
| Binary | `/usr/local/bin/berthy`; the previous one as `berthy.prev` after an upgrade |
| Agent configuration | `/etc/berthy/agent.json`, owned by `berthy`, mode 0600 (the agent refuses a configuration that group or others can access); the previous one as `agent.json.prev` after a change |
| State of one hosted environment | `/var/lib/berthy/environments/<project>/<environment>/state`, owned by `berthy`, mode 0700 |
| Encryption key of one hosted environment | `/var/lib/berthy/environments/<project>/<environment>/key`, 32 bytes, owned by `berthy`, mode 0600 |
| Service | `/etc/systemd/system/berthy.service`, the file the repository ships as `deploy/systemd/berthy.service`, running as the `berthy` user in the `docker` group |

The agent's configuration names the listen address, the Docker socket, and an `environments` list. Each entry is one hosted environment: `project`, `environment`, `state_dir`, `key_file`, `protected`, `tokens`, and `network` (the overlay network its apps join). Every hosted environment has state and a key. Setup writes `network` from the manifest, or defaults it to `<project>-<environment>`. `doctor` checks the network the entry names, and when it names none, the network of the environment's settings. With neither, the check is left out, as on a fresh hosted environment before its first deploy. The agent's version is in its `agent` check and in `GET /v1/projects/<project>/environments/<env>/agent`.

### What it does not do

- It does not create the server, its users, its firewall rules or its private network. The private address must exist before setup runs.
- It does not install or configure the VPN.
- It does not configure Docker's storage driver, its default log driver or its daemon options. The log rotation of each image app's services is set per service, not in the daemon (see [Logs](#logs)).
- It does not write a manifest. Start from the example in Configuration and check it with `berthy config validate`.

## Managed ingress with Cloudflare Tunnel

Berthy can own the whole path from a public hostname to an app: the tunnel, the connector that runs on the server, the hostname routes and the DNS records. It is optional, and it uses Cloudflare's API throughout.

Without it, publishing a new app means creating a tunnel in Cloudflare's dashboard, copying a command with a token to the server, then returning to the dashboard to point a hostname at the app's Docker service. With it, the hostname is one line in the manifest.

### Configuration

The base manifest turns managed ingress on. Hostnames usually differ by environment, so they go in the overlays.

```yaml
# berthy.yml
ingress:
  cloudflare:
    account_id: <account id>
    api_token_secret: CLOUDFLARE_API_TOKEN
    image: cloudflare/cloudflared:<version>
    replicas: 1
```

```yaml
# berthy.prod.yml
ingress:
  cloudflare:
    tunnel: myapp-prod

apps:
  api:
    roles:
      web:
        hostnames:
          - api.example.com
```

The fields are `account_id`, `api_token_secret` and `image` (required), and `replicas`, `tunnel` and `dns`; a role's `hostnames` lists the public hostnames that route to its `port`. The connector image is pinned by digest at deploy like any image app. Each field's type and default is in the generated reference (`berthy docs ingress`).

- **One tunnel per environment.** Every published app in the environment shares it.
- **A hostname belongs to one role.** The same hostname on two roles fails validation.
- **The target is worked out for you.** A hostname routes to `http://<project>-<environment>-<app>-<role>:<port>`, the role's service name on the shared network. Swarm spreads requests across the role's healthy replicas.
- **The domain must already be in the Cloudflare account.** Berthy finds the zone from the hostname and does not add domains.

### What Berthy manages

| Item | How |
| --- | --- |
| Tunnel | Found by name, or created as a remotely managed tunnel |
| Connector | Run as a Swarm service on the shared network, with the tunnel's token as a secret. It appears in `ps` as `ingress`, and `logs` and `restart` work on it. |
| Routes | One rule per hostname in the tunnel's configuration |
| DNS | One proxied `CNAME` record per hostname, pointing at the tunnel |

The connector publishes no port. It makes outbound connections to Cloudflare only, on port 7844.

### When changes are applied

- **`berthy ingress apply -e prod`** creates or repairs the tunnel, deploys the connector, and brings every route and DNS record in line with the manifest. Run it once per environment, and again to change the connector's image or replicas.
- **`berthy deploy <app>`** updates that app's routes and DNS records as the last step of the deploy, once the new version is healthy. A new hostname goes live only after the app can answer it.
- **`berthy ingress status -e prod`** shows the tunnel's health as Cloudflare reports it, the connectors, and each hostname with its target and DNS record.
- **Removing a hostname** from the manifest removes its route and DNS record at the next apply or deploy of that app.
- **An app that is dropped from the manifest keeps its routes.** `ingress apply` removes the routes of an app only when the app has no applied release. An app that is still deployed but missing from the manifest keeps running, so its routes and records stay, and the plan and the dry run say so with `app <name> is deployed but not in the manifest; run berthy remove <name>`. `berthy doctor` lists such apps as `orphan_apps`. Run `berthy remove <name>` to take the app and its routes down.
- **Checks run first.** The check step of a deploy confirms the API token works, each hostname's zone is in the account, and no hostname is taken. A problem stops the deploy before anything changes.
- **Dry run.** `--dry-run` prints the routes and DNS records that would be added, changed or removed.

### Rules

- **Berthy only touches what it created.** A tunnel's routes are stored as one document, so Berthy reads it, changes its own rules and writes it back with every other rule kept. It marks the DNS records it creates and never edits or deletes one without that mark. A rule or record that already matched is adopted, not created: Berthy marks an adopted record so it can tell it from others, but remembers its old comment, and when the route goes away it releases what it adopted instead of deleting it. The adopted rule stays in the tunnel, and the adopted record stays in the zone with its old comment back. A rule or record that `--replace-existing` took over counts as Berthy's own, because Berthy replaced it with one it wrote.
- **An existing route or record stops the run.** If a hostname is already routed to a different target, or its DNS name is already used by a record Berthy did not create, the run stops and reports it. `--replace-existing` takes it over and needs an `admin` token. A route or record that already matches is adopted with no change.
- **Berthy's rules come first.** They are placed ahead of rules it did not write, and the tunnel's final catch-all rule stays last.
- **One writer.** Edit a managed hostname in the manifest, not in the dashboard. A dashboard edit to a managed route is overwritten at the next apply and shown in the dry run first.
- **The tunnel stays.** Removing managed ingress from the manifest removes the routes and records Berthy created and stops the connector, and leaves the tunnel. Berthy deletes a tunnel only with `berthy destroy --tunnel`, and only when it is clean (see "Destroying an environment").
- **Image apps only.** Hostnames can be declared on image app roles. A Compose service is published by a rule added in Cloudflare, which Berthy keeps.

### Credentials

- The API token needs two permissions: Cloudflare Tunnel edit on the account, and DNS edit on the zones that hold the hostnames. Limit it to those zones.
- It is stored in the agent's secret store like any other secret, and set with `berthy secret set CLOUDFLARE_API_TOKEN -e prod`.
- At a terminal, `secret set` for this token prints a link to Cloudflare's account token form with the permissions filled in: Cloudflare Tunnel edit, and DNS edit unless `dns: false`. Before it stores the token, the CLI checks that Cloudflare accepts it, that it can read tunnels in the account and, when DNS is on, that it sees the zone of each hostname. The check only reads.
- Replacing the API token is `berthy secret set CLOUDFLARE_API_TOKEN -e prod` again. The agent reads the token from its store on every Cloudflare call and keeps no copy, so the next call uses the new one. The connector runs with the tunnel's own token, not this one; that token is rotated as described under Limits.
- The agent calls Cloudflare itself, so the server needs outbound HTTPS to Cloudflare's API.
- The tunnel's token is fetched from the API, stored as a secret, and passed to the connector in its environment. It is never printed.
- **DNS edit is the larger risk.** A token with it can repoint any record in those zones. To avoid granting it, create one wildcard record that points at the tunnel by hand and set `dns: false`; Berthy then manages routes only.

### Health

- The connector's health check runs the connector's own readiness command, so its rolling update is gated like any other image app. Confirm the command against the pinned connector version.
- A second connector can run beside the first, so a connector update starts the new one before it stops the old one.
- `doctor` reports the tunnel's status as Cloudflare sees it. A tunnel that Cloudflare reports as degraded or down raises an alert.
- `doctor` (the `ingress_tunnel` check) and `ingress status` report `unavailable` both when Cloudflare refuses the API token and when Cloudflare cannot be reached. The tunnel's alert check is unknown in both cases, so it never alerts. The `cloudflare_token` check tells them apart: it is critical when the token is refused, and unknown when Cloudflare cannot be reached (see Health checks).

### Adopting an existing tunnel

- Set `tunnel` to the existing tunnel's name. `ingress apply --dry-run` then shows what would change; existing routes and records that already match the manifest are adopted as they are.
- Only a remotely managed tunnel can be adopted: one created in the dashboard and run with a token. A tunnel configured by a file on the server has to be migrated in Cloudflare first.
- A connector started by hand keeps working next to Berthy's. Remove it once `ingress status` shows Berthy's connector as healthy, so traffic never drops.

### Limits

- Cloudflare's standard certificate covers one level of subdomain, such as `api.example.com`. A deeper name such as `api.dev.example.com` needs an advanced certificate, which Berthy does not order.
- Rotating the tunnel's token is done in Cloudflare's dashboard, followed by `ingress apply` to pick up the new one.
- Cloudflare is the only provider in v1.

## Deploy lifecycle

A deploy either finishes healthy or leaves the previous version running; it never leaves an app half-updated.

### Image app deploy

1. **Lock.** Take the environment's deploy lock. If someone holds it, stop and report who and why.
2. **Check.** Validate the manifest, confirm every named secret has a value, resolve the tag to a digest, pull the image.
3. **Pre-deploy hooks.** Run them in order. A failure stops the deploy with nothing changed.
4. **Start new.** Start the new version beside the old one, or after the old one has stopped for a role that mounts a read-write volume (see "Stop first for a volume" below). It must pass its health check within `deploy_timeout`; failures during the check's `start_period` do not count. A new version whose tasks fail to start `start_attempts` times (3 by default) is given up on at once, without waiting for `deploy_timeout`.
5. **Switch and drain.** Route traffic to the new version. The old one gets a stop signal and `drain_timeout` to finish requests in flight.
6. **Publish.** With managed ingress, update the app's routes and DNS records to match its `hostnames`. A failure is reported and the command exits non-zero, but the new version stays running.
7. **Post-deploy hooks.** Run them in order. A failure is reported but does not undo the deploy.
8. **Reachability.** For each role with a `port`, open a TCP connection to `<service>:<port>` from the overlay helper, and for each hostname that the publish step served, make HTTPS requests to it from the agent (see "Reachability checks" below). A check that fails only warns.
9. **Record and tidy.** Write the deploy record, prune old images, release the lock.

If step 4 fails, the agent rolls back to the previous digest and records the deploy as failed. Whether anyone is told depends on `alerts.deploys` (see Alerts): by default a failed deploy sends one message on every alert channel.

### When a deploy fails

A new version can fail to start for reasons only its own output explains: a missing setting, a migration that did not apply, a health check that never passed. The old version keeps serving, and the evidence is kept before anything is cleaned up, so the cause can be found afterwards even though the failed task has been replaced and a service created by the deploy has been deleted.

- **What is kept.** Before a failed rollout is rolled back or removed, the agent reads, for every role in the deploy, the newest tasks of the new version (at most five per role), including failed, rejected and shut-down ones. Per task it keeps the Swarm state and error, the exit code, whether the container was killed for lack of memory, the health state and the last five health-check results, and the last 200 lines (at most 64 KiB) of its output with standard output and error interleaved. A failed pre-deploy or post-deploy command, a migration step, or one that ran past its time limit leaves the same for its container: exit code, error and the last lines of output. A piece that cannot be read is marked in that entry, and the rest is kept. Together the evidence of one deploy is limited to 1 MiB; the oldest logs are dropped first and marked truncated.
- **A public reason.** The operation also records one line saying what happened, such as `role web: task exited with code 1 (gave up after 3 failed starts)`, `role web: container never became healthy (last check: exit 1)`, `pre-deploy command 1 exited with code 3` or `migration apply exited with code 2 (after 3 attempts)`. It carries no output of the app, so it is safe in history and in the event stream. `berthy history` and the operation record show it; the deploy, rollback and ingress apply commands print it when they fail.
- **Redaction and storage.** Every managed secret value is replaced by `[redacted]` in the output and health-check results before they are stored. The evidence is encrypted in the state file like the other private records. The evidence of the newest 50 operations that have any is kept; older evidence is deleted. Containers of finished migration steps and of commands that timed out stay until `berthy prune` removes them, which is safe because the evidence already holds their output.
- **Reading it.** `berthy diagnostics <operation id> -e <env>` prints it for a person, and `--json` prints it for an agent; the id is in the output of the failed command and in `berthy history`. The API serves it at `GET /v1/projects/<project>/environments/<env>/operations/<id>/diagnostics`. It needs the `deploy` scope, not `read`: application output can hold personal data that a read-only token should not see. An operation without evidence answers 404.

### Deploy lock

- One lock per environment, taken automatically for the length of a deploy.
- `berthy lock acquire -e prod -m "reason"` freezes deploys until someone releases it. It holds back `berthy apply` too.
- The lock records its holder, message and age. `berthy lock status` shows them.
- A `berthy run` holds it too, for as long as its command runs (at most its `--timeout`), because the command runs in a container of the applied release and a deploy must not replace that release under it.
- An interactive session (`exec -i`, `run -i`) does not take it and is not journaled: it can last an hour, and it must not block a deploy.
- An operation never waits for the lock: one that finds it held is refused at once, so there is nothing to cancel in that wait.

### Cancelling an operation

`berthy cancel <operation id> -e <env>` stops a running operation while it can still be undone cleanly, and refuses once it cannot. The agent decides by the operation's **point of no return**.

**One point of no return per operation, recorded with it.** An operation records its point of no return in the state, in the same transaction as the step that crosses it (the `no_return` column of the operation holds the reason a cancel is refused from then on, and is empty before). Before it, a cancel wins. After it, a cancel is refused with that reason. A cancel and the crossing of the point are decided under one lock of the operation inside the agent, so exactly one of them comes first: an operation that crossed is never ended as cancelled, and a cancel that was accepted is never followed by the crossing.

| Where a deploy or rollback is | Cancel |
| --- | --- |
| Checking, pulling the image | Accepted. Nothing was changed. The deploy ends `failed`. |
| Running a pre-deploy command (a `run` step or a `backup` step) | Accepted. The command's container is stopped, then the deploy ends `failed`. |
| Running a migration (its `version` and `apply` commands, and the `version` that follows) | Refused: `a migration is running`. The schema may be half changed. The refusal lasts for as long as the migration runs. It is not a point of no return: once the migration is over, a cancel is accepted again. |
| Waiting for the new version to become healthy, and the checks that follow it | Accepted. The previous version is restored as for a failed rollout. The deploy ends `rolled_back` when a service of the app was updated, and `failed` when the deploy only created services. A migration that already ran stays applied, as it does for a failed rollout, and its schema states stay recorded. |
| After the new version is verified (the point of no return, recorded with the barrier step that records the release), while it publishes routes and runs post-deploy commands | Refused: `the deploy already switched traffic`. The deploy is done in every way that matters. |

Other kinds:

- **Compose deploy.** The point of no return is the first change to the project, the step that journals the Compose file just before its files replace the project's. Before it a deploy only checks, and a cancel is accepted. After it, `compose up` runs, Compose has no compensation, and a cancel is refused with `the Compose project is being changed`.
- **Rollback of a schema** (`rollback --revert-schema`) is a migration from start to end: refused with `a schema revert is running`.
- **`run`.** It has no point of no return. A cancel stops the command's container, as at a time limit: the output so far is recorded and the container is removed. The operation ends `failed` with `operation cancelled`. A run can be cancelled until it ends.
- **`restore`, `remove`, `destroy`, `exec`, `restart`, `scale`, `prune`, `ingress apply`** cannot be cancelled: the answer is `a restore cannot be cancelled` and so on.
- An operation that has ended, or that has begun to end, is refused with `the operation already ended: <state>` or `the operation is ending`.

**What a cancel does.** The agent answers at once; the operation then stops where it is, takes back what it changed, and ends as `failed` or `rolled_back` with the error `operation cancelled` and the reason `cancelled by <token name>` (for a request that a person approved, `cancelled by <agent token> (approved by <person>)`). The lock is released as for any ending, and the operation is alerted and reported to telemetry as a failure, with that reason. An operation in `recovery_required` is not a running one: it is resolved with `recovery resolve`.

**The request.** `POST /v1/projects/<project>/environments/<env>/operations/<id>/cancel` with `{"dry_run": false}` (an empty body is a cancel). The scope is `deploy`. A cancel answers `200` with `{"operation_id", "kind", "app", "accepted": true}`; a refusal is `409` with the code `cancel_refused` and the reason; an unknown operation is `404`. With `"dry_run": true` it answers `200` and changes nothing, with `accepted` true or false and the `reason` when it is false. `berthy cancel <id> -e <env>` prints this, then waits for the operation to end and prints its state and reason; `--dry-run` prints whether the cancel would be accepted and exits 1 when it would not; `--json` prints the answer and does not wait. Every cancel that is not a dry run is audited as `cancel:<operation id>`, with the outcome `accepted` or `refused`.

**Agent tokens.** On a protected environment an AI agent's cancel is held like any other change. Its plan is the dry run above, so the person who reviews it sees whether it would be accepted. The approval of the hold carries the cancel out as the agent, and the summary reads `cancel <operation id>`.

**Job runs.** A run of a job is not an operation. A job has at most one run at a time, so `berthy job cancel <name> -e <env>` (`POST /v1/projects/<project>/environments/<env>/jobs/<name>/cancel`, scope `deploy`, audited as `job_cancel:<name>`) names it. The container of an image app's job is stopped as at its time limit and removed; the run is recorded as `failed` with the detail `cancelled by <token name>`, and the last lines of its output are kept for `berthy job logs`. The command of a Compose app's job runs as an exec, which Docker cannot stop: the cancel ends the wait and records the run, and the command may go on, as it may after a time limit. A job that is not running answers `409` with `job is not running`; one that ended on its own before the cancel took effect keeps the result it had. `job cancel` applies to jobs only: the command of a command backup, and the command that `restore --exec` feeds, are not job runs and are not stopped by it, and a restore is an operation that cannot be cancelled. A held `job cancel` has a description plan: `{"action":"job cancel","target":"<name>"}`.

### Hooks

Hooks are declared per app as `pre_deploy` and `post_deploy` lists. Two step types exist in v1.

| Step | What it does | Typical use |
| --- | --- | --- |
| `backup: <name>` | Runs the named volume backup, including its preparation job if set, and waits for it. The name is a key of `backups` | Archiving a fresh database dump before a deploy |
| `run: <command>` | Runs the command in a container of the new image, with the app's environment. Runs once unless `retries` is set | A one-off task before traffic switches |

A `run` hook takes two optional settings.

| Setting | Meaning | Default |
| --- | --- | --- |
| `timeout` | Time limit of each attempt, from `1s` to `24h` | `5m` |
| `retries` | How many more times the command runs after it exits non-zero, from 0 to 5 | `0` |

```yaml
    hooks:
      pre_deploy:
        - run: [bin/warm-cache]
          timeout: 2m
          retries: 2
```

- **Retries are off by default, and a command should only be retried when it is safe to run again.** A command that failed halfway may have changed something. Set `retries` only for a command that is idempotent, such as one that checks a dependency or warms a cache.
- Each attempt runs in its own container, five seconds after the previous one ended. The deploy keeps the output of the last attempt, and the failure reason says how many attempts ran, such as `pre-deploy command 1 exited with code 3 (after 3 attempts)`.
- **A command that runs past its `timeout` is never retried.** It may still be running, so starting it again could run it twice. The deploy stops and the operation needs recovery, as it always did for a timed-out command.
- `backup:` steps take neither setting.
- **A backup step runs in order with the `run` steps** of its list, and runs the backup through the same code as `backup run`, with the trigger `hook`. The manifest being deployed supplies the backup, its destination and its volume, and the backup's `before` job runs first as for any run. A `backup` that no `backups` key names is refused when the manifest is read.
- **A failed `pre_deploy` backup stops the deploy before the migration block.** Nothing after it in the list runs, the migration's version and apply commands do not run, and the old version keeps serving. The operation fails with `pre-deploy backup failed`, and its reason names the backup and the step that failed, such as `pre-deploy backup main-db failed: upload failed`. `berthy diagnostics <operation>` (a `deploy` token) shows a diagnostic of kind `backup` with the run's own detail, such as `upload failed: access denied`, and no logs.
- **A failed `post_deploy` backup** is reported like a failed post-deploy command: the new version stays, and the operation fails with `post-deploy backup failed` and the same kind of reason.
- A backup whose app has no applied release has no volume to read yet, as on the first deploy of an app. The step is skipped, and the operation's events say so.
- A backup that cannot start, such as one of the same volume that is running, fails the step with its reason.

### Database migrations

Migrations run as their own deploy step, not at application startup, and the schema is never rolled back automatically when a deploy fails.

An app that applies migrations when it starts can leave the schema ahead of the running code after a failed deploy, with no defined way back.

**The rule that makes a failed deploy safe.** Every migration must work with the previous version of the app. A rolling deploy already runs the old and new versions against the same database for a short time, so this is required anyway. With it, a failed deploy needs no schema rollback: the old version keeps running on the new schema.

- Add columns and tables in one release; remove or rename them in a later one.
- A change that cannot be made compatible is split across two deploys.

**A generic contract.** Berthy does not know which migration tool an app uses. An app declares three commands, and Berthy runs each in a one-off container with the app's environment.

| Command | Contract | Runs from |
| --- | --- | --- |
| `version` | Prints one line that identifies the current schema state, such as the name of the last applied migration. Berthy stores it and never interprets it. | The new image |
| `apply` | Brings the schema to the latest state the image knows. | The new image |
| `revert` | Brings the schema back to a given state, passed as `{target}`. | The image being rolled back from |

```yaml
    migrations:
      version: [<command>]
      apply: [<command>]
      revert: [<command>, "{target}"]
      timeout: 5m
      retries: 0
```

`timeout` limits every migration command (`version`, `apply` and `revert`), each attempt on its own, from `1s` to `24h`; it defaults to `5m`. `retries`, from 0 to 5 and `0` by default, runs a failed `apply` again.

**Retrying `apply` is only safe for an idempotent command.** A migration that failed halfway may have applied part of its changes, and running it again from the middle can fail or change the schema twice. Berthy cannot know whether yours handles that, so `retries` is off. Turn it on for a migration tool that records each step in its own transaction and skips what it has applied, or for a failure that comes from outside the migration, such as a database that was still starting.

- `version` and `revert` are never retried.
- A migration command that runs past `timeout` is never retried, because it may still be running. The deploy stops with the outcome uncertain, and recovery stops the container.
- Each attempt of `apply` runs in its own container, five seconds after the previous one ended. The state after is recorded once, after the last attempt.

**How a deploy applies migrations.** The block runs after the pre-deploy hooks and before the new version starts.

1. The pre-deploy hooks have already run, including a `backup:` step if one is declared.
2. Berthy runs `version` and stores the result in the deploy record as the state before.
3. Berthy runs `apply`, once unless `retries` is set.
4. Berthy runs `version` again and stores the state after. One deploy can apply several migrations; the two recorded states mark exactly where it started and ended.
5. If `apply` fails, the deploy stops and the old version keeps running. The state after is still recorded, because a failed `apply` may have applied some of its migrations.
6. If it succeeds but the new version fails its health check, the image rolls back and the schema stays where it is.

**Reverting the schema on purpose.** `berthy rollback <app> --revert-schema` runs `revert` with `{target}` set to the state recorded before the failed deploy. Every migration that deploy applied is undone, and nothing else.

- It runs from the newer image, because that image holds the revert code for the migrations it added.
- With `--to <release id>` (the `id` column of `berthy history`), the target is the state recorded after that release's deploy.
- It takes an `admin` token and is never automatic, because reverting a migration can delete data.
- An app that declares no `revert` command cannot use it.

**Last resort.** Restore the pre-deploy backup to a new volume, then use the app's restore procedure. For a PostgreSQL dump, load it into a scratch database first. Recovery starts from the backup's capture time.

**What the app must provide.** The three commands must be runnable from the app's image. An app that migrates at startup stops doing so once Berthy runs the migration step.

### Timing settings

| Setting | Meaning | Docker's default | Berthy default |
| --- | --- | --- | --- |
| `deploy_timeout` | Longest the new version may take to become healthy | No overall limit; bounded by the health check | 120s |
| `drain_timeout` | Time the old version gets to finish requests | 10s | 30s |
| `start_attempts` | How many failed task starts a rollout tolerates before it gives up, from 1 to 10 | Unlimited restarts | 3 |
| `verify` | Whether the deploy checks at its end that each role's port and hostnames answer (see "Reachability checks") | None | true |

The wait before health checks count is the health check's own `start_period`, set per role.

**Start attempts.** Swarm restarts a task that exits or is killed as unhealthy. During a deploy Berthy counts those failures for each role of the new version and gives up as soon as one role's reach `start_attempts`: the old version keeps running, a service the deploy created is removed, and the deploy fails with a reason such as `role web: task exited with code 1 (gave up after 3 failed starts)`. A deploy that gives up this way does not wait out `deploy_timeout`. A new version that fails twice and starts on the third try passes with the default of 3. Failures of the old version, or from an earlier deploy, are not counted.

**Reachability checks.** A role's health check runs inside its container, so it can pass while the role cannot be reached from anywhere else: the app listens on `127.0.0.1`, `port` is not the port it listens on, or the hostname does not lead to it. After the post-deploy hooks of a successful deploy or rollback, and for each role with a `port` that has at least one replica, the agent makes two checks. Neither changes the operation's outcome, and `deploy.verify: false` turns both off.

- *Network.* The overlay helper opens a TCP connection to `<service>:<port>` within 3 seconds. The result is the event line `role web: port 8080 answers on the network`, or `role web: healthy, but port 8080 does not answer on the network; is the app listening on 127.0.0.1?`. When the helper cannot run, the line is `role web: port 8080 could not be checked on the network (<reason>)`. An agent with no Reacher (no state, no monitoring) makes no network check and prints no line. The helper is started for the check when no service probe needs it, kept for five minutes after the last check, and removed by the monitor after that.
- *Outside.* Only when the deploy published routes. For each hostname of the role the agent makes up to four HTTPS GET requests to `/`, five seconds apart, each limited to 5 seconds, redirects not followed, and stops at the first status below 500. The line is `role web: https://<hostname> answers with status <n> from outside`, with `; the route or the app is not ready` appended when the last status was 5xx, or `role web: nothing answers at https://<hostname> from outside; DNS or the route may still be settling` when nothing answered.

Each line is one operation event of kind `verify` with the data `role`, `check` (`network` or `outside`), `status` (`ok`, `warn` or `unknown`) and `step`, the line. The CLI prints `step`, `--json` adds the events to its document as `checks`, and the MCP command result lists them as `checks`.

**Stop first for a volume.** A role that mounts a named volume read-write is updated stop-first by default: the old version stops before the new one starts, so two versions never write the same files at once. From the moment the old version stops until the new one is healthy, the role has no running task, so a failed rollout ends with a reason that says so, such as `role web: container never became healthy (last check: exit 1); role web was stopped first, so it was down until the previous version came back`. A read-only mount (`:ro`) does not change the default. `deploy.order` sets `start-first` or `stop-first` for every role of the app. The plan, and the dry run, list each stop-first role with its reason: `role web: stop-first, because it mounts volume uploads`, or `role web: stop-first, set by deploy.order`. A role that starts first gets no line.

The limit applies to a rollout only. Once a version is serving, Swarm keeps restarting a task that crashes, without limit, so a service that dies at 3 in the morning comes back by itself.

Hook and migration time limits and retries are set with the hooks and migrations; see Hooks and Database migrations.

### Service defaults

An image app that sets nothing else runs with these Swarm settings.

| Setting | Berthy default |
| --- | --- |
| Update order | Start the new version first |
| Update parallelism | 1 at a time |
| On a failed update | Berthy counts failed starts of the new version (`start_attempts`, 3) and restores the previous version when they are used up; Swarm keeps replacing a failing task meanwhile |
| Rollback order and parallelism | Start first, 1 at a time |
| Restart policy | Restart on any exit, after 5 seconds, without limit; set explicitly on every service |
| Placement | No constraints |
| Replicas | 1 |
| Resource limits | None unless set per role |
| Log rotation | `max-size` 10m and `max-file` 3 when the daemon's default log driver is `json-file` or `local` and the role sets no `logging`; see [Logs](#logs) |
| Stop grace period | `drain_timeout`, 30 seconds |

**The spec is a function of the release.** The Swarm spec of a role comes from the manifest, the image digest and the secret values, and from nothing else. A first deploy creates the service with it, and every later deploy updates the service with the same spec, so a service that was updated in place, one that was recreated and one that a rebuilt server creates are the same service. A deploy reads the live service only for its ID and version, to check that it is the service the role is bound to, and to restore it if the rollout fails. A setting that someone changed on the live service by hand, such as `docker service update --user`, is gone after the next deploy. `restart` and `scale` are not deploys: they change the live service in place and keep everything else in it.

- Thirty seconds gives a web framework's graceful shutdown its full time to finish requests. Docker alone would stop the container after 10.
- With no memory limit, a leak in one app can starve a database on the same server. Set a limit per role once real usage is known.

### Rollback

`berthy rollback <app> -e <env>` redeploys the previous recorded digest with the manifest saved at that deploy. `--to <release id>` picks an older one: the `id` column of `berthy history`, not an operation id. Secrets stay at their current values. The app comes back with its own part of that manifest: its roles, hooks, jobs, backups and service probes. The environment's settings, such as the alerts, the peers and the other probes, stay as they are; the old manifest does not apply them.

### Applying environment settings

`berthy apply -e <env>` applies the environment scope of the manifest in `--manifest-dir` without deploying an app: it is how a probe, a peer, the alert chat, a destination or the telemetry endpoint changes with no release (see Two scopes of the manifest). It is synchronous and starts no operation, like `lock acquire`.

- It validates the manifest as a deploy does, including `min_version` and the rule of one project per environment, and applies the local-changes rule of a protected environment.
- It is refused with `409` while the deploy lock is held, by an operation or by `lock acquire`. The write and the audit row `apply` happen in one transaction.
- It needs the `deploy` scope. An agent token on a protected environment is held for approval like any change, with the summary `apply the environment settings`, and the plan is the dry run.
- `--dry-run` prints what would change and writes nothing. The plan and the answer list one line per change, such as `alerts: changed`, `probes: + api-up`, `destinations: ~ offsite`, `registries: - ghcr.io` and `network: a -> b`; a secret appears by name only. With nothing to change the command prints `no changes`. `--json` prints `{"changes": [...]}`. The API is `POST /v1/projects/<project>/environments/<env>/apply` with `{manifest, commit, modified, dry_run}`.
- The apps, and the jobs, backups and service probes of the manifest, are not applied: they come with the deploy of their app.

### Retain and prune

- The agent keeps the images of the last `retain` deploys per app (default 5), so rollback needs no pull.
- After each successful deploy it removes older images, stopped containers and unused layers.
- It never removes volumes.
- An app that was removed with `berthy remove` has no applied release, so none of its releases protects an image any more; its images are removed at the next prune. Its release history stays.

### Compose app deploy

1. Take the lock and validate, as above.
2. Work out which services would be recreated and which volumes would be created, and print that plan.
3. If a `stateful` service would be recreated, stop unless the command carries `--allow-recreate`.
4. Write the Compose file and environment, then run `docker compose up -d --remove-orphans`.
5. Wait until every container of the project runs, and is healthy when it has a health check, or has exited with code 0, which is a finished one-shot. Record the deploy, release the lock.

The wait is Berthy's own: it runs `docker compose ps --all` and judges each container, because Compose's `up --wait` fails the whole deploy once any container has exited, even with code 0. A container that exits with any other code, or runs unhealthy, fails the deploy at once, and the message names the service (`service job exited with code 3`, `service web is unhealthy`). A service that is still not ready when `deploy_timeout` ends, counted from before `up`, fails it with `service web not ready after 120s`. Right after `up` a one-shot can still show as running a moment before it exits with an error, so the project must read ready on two polls in a row, one interval apart. A standalone one-shot that is still running when everything else is ready does not hold the deploy; to make the deploy wait for it to finish, make a service depend on it with `condition: service_completed_successfully`, which Compose waits for during `up`. A container event of the project (`die`, `health_status`) wakes the wait at once; the polls decide, every 500 ms, or every 5 seconds while the event feed is open.

The CLI reads the Compose file named by the app's `file` and sends its content with the request. The agent keeps that copy with the release, so a rollback redeploys the same file. Only that one file is sent, so a `build:` section is refused. These settings need an admin token: `privileged`, host `network_mode`, `pid`, `ipc`, `uts`, `userns_mode` or `cgroup`, `cap_add`, `devices`, relaxed `security_opt` entries, bind mounts of host paths, `env_file`, `secrets` or `configs` read from host files, and sharing a container outside the project (`volumes_from`, or `network_mode`, `pid`, `ipc` or `userns_mode` naming `container:`). The agent runs the Compose CLI named by `compose_command` (`docker compose` by default) with an isolated home directory, so the Compose plugin must be installed system-wide, or `compose_command` must name a standalone Compose binary. A bind mount must not point inside the agent's Compose directory, which each deploy replaces. A Compose deploy has no automatic rollback: a failed `up` is reported, and the next deploy brings the project to its file, since `up` is idempotent. Adoption records a release only when the plan would change nothing; otherwise it stops and names the first difference. `restart` restarts containers without recreating them, and `scale` refuses Compose apps. `exec` runs in a running container of a Compose service, named with `--service` (see the `exec` row of the command table). `--version` does not apply to a Compose deploy.

### Removing an app

`berthy remove <app> -e <env> [--volumes] [--allow-recreate] [--dry-run]` takes an app down and removes what Berthy created for it. It takes an `admin` token, runs as an operation under the deploy lock, and needs no manifest: it works from the app's applied release. The ingress connector app cannot be removed this way; remove managed ingress with `ingress apply` and a manifest without an `ingress` block.

What it does, in this order:

1. **Routes and DNS records.** It removes the routes and DNS records Berthy created for the app. A route or record Berthy adopted is released, not deleted: its rows are dropped, an adopted DNS record gets its old comment back, and an adopted rule stays in the tunnel. A record that has lost Berthy's mark is left alone.
2. **Services.** An image app's services are deleted, one at a time, after each deletion is journaled. Each must still be the service the app is bound to (same name and ID), and any Berthy label it carries must name this environment, app and role; a service adopted with `--adopt` that has no labels yet is accepted. Otherwise nothing is deleted and the removal is refused. A service that is already gone counts as removed. A Compose app is brought down with `compose down --remove-orphans` in its stored project directory, which is then deleted. When the files are gone, Berthy runs `compose -p <project> down` with no file, which Compose resolves by label and which removes the project's containers and network.
3. **Volumes, only with `--volumes`.** An image app's volumes are the named volumes its roles mount (`name:/path`); a Compose app's are the project's named, non-external volumes, removed by `down --volumes`. A volume another container still uses is kept and reported. Berthy never removes an external volume or a volume the app does not name.
4. **State.** The app's bindings, applied release and route rows are forgotten. Releases, operations, job runs, backups and the audit log stay as history, so `history <app>` still works. The app is no longer monitored, scheduled or listed.

What it keeps: volumes unless `--volumes`, the release history, routes and records Berthy adopted, and the tunnel. A `stateful` Compose app is removed only with `--allow-recreate`, as it is recreated only with it. Removing an app again after it is gone changes nothing and succeeds. A removal that stops partway is finished by running it again; at start the agent also completes any service deletion it had journaled and records the operation as interrupted. `--dry-run` lists the services, volumes, routes and records, and the volumes that would be kept.

### Destroying an environment

`berthy destroy -e <env> --confirm <project/environment> [--volumes] [--allow-recreate] [--tunnel] [--dry-run]` removes everything Berthy created in the environment. It takes an `admin` token and runs as one operation under the deploy lock. `--confirm` must name the project and the environment, as `project/environment`, or the CLI refuses before it sends anything and the agent refuses the request. `--dry-run` prints the whole plan and changes nothing.

What it does, in this order:

1. **Every app** with an applied release, except the connector, is removed as `berthy remove` removes it, with the same `--volumes` and `--allow-recreate` rules. If a `stateful` Compose app needs `--allow-recreate` and the flag is missing, or any other app cannot be removed, the whole destroy is refused up front, lists them, and removes nothing.
2. **Managed ingress** is removed: the routes and DNS records Berthy created, the release of the ones it adopted, the connector, the tunnel token and the stored ingress state.
3. **Helper containers.** The overlay probe helper container, and any backup or restore helper container of this environment that has stopped. Helper images stay: they belong to the agent, which every hosted environment shares.
4. **One-off containers.** Hook and migration containers of this environment that are not running.
5. **Images.** Every image this hosted environment pulled that no container or service uses and that no other hosted environment on the agent retains for a rollback, now that no app of this environment has a release.

What it keeps: all secrets, including the Cloudflare API token, the state database and the release, operation, job and backup history, the shared network, Docker objects Berthy did not create, routes and records that are not Berthy's, and volumes unless `--volumes`. A running container is left and reported. Running the command again after it stopped partway finishes it; at start the agent also completes a service deletion it had journaled, and records the operation as interrupted.

**`--tunnel`** deletes the Cloudflare tunnel, but only when nothing else uses it. Berthy remembers the tunnel when it removes managed ingress, so a later `destroy --tunnel` can still find it. The tunnel is deleted only if all of these hold after the connector is gone, and the result names each one that does not:

- its remotely managed configuration has no rule with a hostname, only catch-all rules (an adopted route stays in the tunnel, so it keeps the tunnel);
- no DNS record in any zone of the account points at `<tunnel id>.cfargotunnel.com`, which includes records Berthy adopted and released;
- Cloudflare reports no active connections, checked for up to a minute after the connector is removed, so a connector started by hand elsewhere keeps the tunnel.

A tunnel that is kept stays remembered, and `destroy --tunnel` deletes it once the reasons are gone. With no managed tunnel the command says "no managed tunnel".

### Deploying every app

`berthy deploy -e <env>` without an app deploys every app of the manifest, one after another, each exactly as `berthy deploy <app>` would, and stops at the first app that does not succeed. It takes `--version`, `--commit`, `--dry-run`, `--json` and `--manifest-dir`; `--adopt`, `--replace-existing`, `--allow-recreate` and `--request-id` need an app and are refused with exit 2 (`--adopt needs an app: berthy deploy APP --adopt`). Each app is its own operation with its own request ID.

```yaml
apps:
  api:
    kind: image
    image: ghcr.io/<org>/<image>
    depends_on: [postgres, redis]
```

- **Order.** An app's `depends_on` lists the apps deployed before it. `config validate` refuses a name that is not an app of the manifest, an app that depends on itself, a name listed twice and a cycle (`depends_on cycle: api -> worker -> api`). Among the apps whose dependencies are done, the next one is the first by name, so the example above deploys `postgres`, `redis`, `api`. An overlay replaces the whole list, as it replaces any list. `depends_on` is a manifest key, and an agent refuses a key it does not know, so upgrade the agent with `berthy setup` before the first deploy of a manifest that uses it, and set `min_version` (see Configuration) to the release that added the key.
- **Versions.** `--version REF` is allowed only when the manifest has exactly one image app. Otherwise give `--version <app>=REF`, once for each app that needs one. A plain REF together with `<app>=REF`, an `<app>=` that names an unknown app or a Compose app, an empty REF and a repeated app are refused with exit 2 before any request is sent. A Compose app takes no version.
- **An app given no version keeps the one it runs.** The CLI sends such an image app with `keep_version`, and the agent deploys the digest of the app's applied release and records that release's tag. The new manifest is applied and the migrations and hooks run as in any deploy; only the image does not change. It is never resolved to `latest`. Before anything is deployed, the CLI asks the agent for the applied release of every app that keeps its version, with `GET /v1/projects/<project>/environments/<env>/applied/<app>` (`read` scope; it answers `{"id", "digest", "tag"}`, `tag` only when the release has one, and 404 with code `not_deployed` when the app has no applied release). An app that was never deployed, or was removed, is refused with `image app <app> is not deployed yet: give --version <app>=REF` and exit 2, so a first deploy names a version for every image app. A protected environment accepts it: what the app keeps is a digest. The CLI also sends the digest it read as `keep_digest` (only with `keep_version`); when the app's applied release has another digest by the time the agent resolves the version, at admission, at the dry run and again when the operation starts, the request is refused with `app <app> changed since its version was read: it runs <sha256:12 hex> now, not <sha256:12 hex>; deploy it again`, and nothing is deployed. Without `keep_digest` the version is not checked.
- **Everything is prepared first.** Nothing is sent to the agent until every app's request is ready: the manifest loaded, the Compose files read, the versions checked, the kept apps asked about. A bad Compose path or version for the last app leaves the first apps undeployed (`app zstack: compose file unavailable (nothing was deployed)`, exit 1).
- **Stops at the first failure.** Text output has one `==> deploy <app> (<version, or keeps <tag>>)` header for each app, followed by what `berthy deploy <app>` prints, and at the end one line each, `<app>  succeeded`. When an app fails, the command exits with its code, prints `deploy stopped at <app>; not run: <the apps after it>` on standard error, and runs nothing more. A change held for approval counts as a stop, with exit 3.
- **Dry run.** `--dry-run` plans every app and does not stop at a plan that fails; it exits 1 when any failed, and its summary lines say `planned` or `failed`.
- **JSON.** `--json` prints one document, with what `berthy deploy <app> --json` prints for each app as its `result`, in the order they ran; an app that did not run has `"state": "not_run"` and no result:

```json
{"apps": [
  {"app": "postgres", "exit": 0, "result": {}},
  {"app": "api", "exit": 1, "result": {}},
  {"app": "worker", "state": "not_run"}
]}
```

### Interactive sessions

`berthy exec <app> -i -- <command>` and `berthy run <app> -i -- <command>` connect the command's standard input: an application console, a database shell or a restore from a dump works from a laptop with no shell on the server.

- **What the CLI does.** When its own standard input and standard output are both terminals, the session has a terminal: the CLI puts its terminal in raw mode, restores it at the end, and sends the terminal's size when it starts and at every change (`SIGWINCH`; on Windows it polls the size every 250 ms). Otherwise there is no terminal: standard input streams to the command, ends with `CloseStdin` when it ends, and the command's standard output and standard error stay apart. The CLI exits with the command's own exit code. A `Failure` frame prints its message on standard error and exits 1, and a lost connection prints `the session ended unexpectedly` and exits 1. `--dry-run` ignores `-i` and prints the plan of the command.
- **What the agent does.** An `exec` session runs in the container `exec` would choose, and ends when the command does. When the client leaves, the session ends and the command may keep running in the container, as with `docker exec`. A `run` session creates a new container of the applied release, prepared as `run` prepares it (role environment, limits, the shared network), with its standard input open and attached, and a terminal when asked, labelled `berthy.environment=<env>`, `berthy.session=<id>` and `berthy.oneoff=session`. It attaches before it starts, resizes to the first size, and removes the container when the command ends, when the client leaves (the container is stopped first) and when the agent shuts down. `--timeout` stops a `run` session past it (with the grace of `run`) and reports `run timed out after <timeout>`; without it a `run` session has no time limit.
- **Not an operation.** A session takes no deploy lock, starts no operation and is not journaled. It needs an `admin` token. It is not in the MCP server and not in the terminal UI.
- **Orphans.** At start, after recovery, the agent removes every container of its environment that has a `berthy.session` label, in whatever state: a running agent owns no session of an earlier process. On shutdown the agent closes every open session, so the containers of `run` sessions are stopped and removed before it exits (bounded by the shutdown's 5 seconds).
- **Limit.** An agent holds at most 16 open sessions. The 17th is refused with `429` and `too many interactive sessions`.
- **Protected environments.** A session cannot wait for a person, so an agent token is refused one on a protected environment with `403` and `an interactive session cannot be held for approval; use a person's token`: nothing is held, queued or recorded. An agent token with `admin` scope may open one on an unprotected environment.
- **Audit.** The audit log records the start, with the action `session exec <app>[/<role or service>]` or `session run <app>[/<role>]` and the outcome `started: <command>`, and the end with the outcome `ended: exit <code>`, `ended: client disconnected`, `ended: the agent is stopping`, or `ended: <the failure the client was told>`. The command is its words joined by spaces, with managed secret values replaced by `[redacted]` and cut to 200 characters. What was typed and what was printed are never recorded.

The API is `POST /v1/projects/<project>/environments/<env>/sessions` (`admin` scope). The request asks to switch protocols, `Connection: Upgrade` and `Upgrade: berthy-session/1`, and its JSON body (at most 64 KiB, unknown fields refused) is:

```json
{"kind":"exec","app":"api","role":"web","service":"","command":["bin/console"],"tty":true,"size":{"Rows":40,"Cols":120},"timeout":"30m"}
```

`kind` is `exec` or `run`; `role` and `service` are exclusive, `service` is for `exec`, and `timeout` for `run`. `size` goes with `tty`, from 1 to 1000 rows and columns. A request that is refused is an ordinary error answer (400 for a request without the upgrade headers or an invalid one or a refusal such as `run is for image apps; use exec --service`, 403, 429). Otherwise the agent answers `101 Switching Protocols` and both sides exchange **frames** on the connection until the agent sends `Exit` or `Failure`. A frame is one byte for the kind, four bytes for the payload's length (big-endian, at most 64 KiB), and the payload:

| Kind | Byte | From | Payload |
| --- | --- | --- | --- |
| `Stdin` | 1 | client | bytes for the command's standard input |
| `Resize` | 2 | client | rows, then columns, 2 bytes each, big-endian; only with a terminal |
| `CloseStdin` | 3 | client | none: the input has ended |
| `Stdout` | 4 | agent | output; with a terminal, all of it |
| `Stderr` | 5 | agent | error output; only without a terminal |
| `Exit` | 6 | agent | `{"code":N}`; the last frame of a command that ended |
| `Failure` | 7 | agent | a short public message; the last frame of a session that could not start or broke |

**The ending.** After the last frame the agent half-closes the connection, keeps reading and discarding what the client sends, and closes only when the client has closed or 5 seconds have passed. The client closes as soon as it has read `Exit` or `Failure`. The agent does not close first because closing a socket that still holds unread input resets the connection, and the client, which may still be sending input, could then lose the last frame before it read it.

### Dry run

Every command that changes something accepts `--dry-run` and prints the plan without acting.

### Release diff

The plan of an image deploy, a Compose deploy and a rollback has a `diff`: what the request changes compared with the release the app runs now. It is made from the two stored manifests and the two images, so it holds names and settings and never a secret value.

- **Shape.** `{"new": true}` for the first deploy of an app, `{"same": true}` when nothing differs, or `{"changes": [{"area", "change"}]}`. The changes come in a fixed order, so the same pair of releases always gives the same diff: the image, the app's own settings (`app`), the roles added or removed (`roles`), each role's settings by role name, `deploy`, `env`, `hooks`, `migrations`, `ingress`, `jobs`, `backups`, `probes` and, for a Compose app, `compose`.
- **What is compared.** Both manifests are compared after the defaults a stored manifest takes, and only the part that belongs to the app: `apps.<app>`, its jobs and backups, and the service probes aimed at it (see "Two scopes of the manifest"). The environment's settings are not in it. The image is its digest and the tag the deploy asked for. A role is compared by its service, command, entrypoint, user, replicas, port, health check, volumes, resources, log driver and options, and its hostnames, which are lines of `ingress`. The rollout settings of the app (`deploy.*`) are compared too. A Compose app shows the digest of its Compose file and the services its Compose plan would create, recreate or remove.
- **Variables.** A variable is plain, from a secret or a template. A plain variable that is added or removed shows as `+ NAME (plain)` or `- NAME (plain)`, and one whose value changes shows both values, cut at 60 characters. A secret variable shows its name and the name of its secret (`~ DATABASE_URL now from secret API_DATABASE_URL`), a template variable its name and its template text, which names secrets and holds no value. A change of the value stored under a secret name is not in the manifests, so it is not in the diff.
- **Lines.** `Lines()` of the diff is the text of the CLI, the TUI and the MCP server: the area, padded to 8 characters or the longest area, and the change. `new app` and `no changes: the same release would be recorded` stand for the first deploy and for no difference.
- **Approvals.** The diff is part of the plan, so a held request stores it and `approve` plans again and compares: a release recorded since the request changes the diff, and then nothing runs. What a person read is what runs.
- **Two releases.** `GET /v1/projects/<project>/environments/<env>/history/<app>/diff?release=<id>[&base=<id>]` (`read`) answers the diff of release `release` against `base`, or against the release before it. Both must be releases of the app, or the agent refuses with `release <id> is not a release of app <app>`. `berthy history <app> --diff <id> [<id>]` calls it.

## Interfaces

The CLI is the complete interface; the TUI and the MCP server are two other ways to call the same agent API.

### CLI

Every command that talks to an agent through a resolved CLI context needs `-e <env>`, or else `$BERTHY_ENV` when `-e` is not given; most of those also take `--json`. A given `-e` wins, including an empty one. `setup` has its own flags and reads `BERTHY_ENV` the same way: it installs or upgrades the agent over SSH or on the server, creates or updates a CLI context, and contacts the agent to verify (`doctor` or `/healthz`). Other local commands (`context`, `config schema`, `version`, `docs`, `agent token`, `state-restore`, `mcp`) each have their own flags; of those that take `-e`, only the agent-facing ones and `setup` read `BERTHY_ENV`. A command that talks to an agent reads the CLI configuration: the file `--config <file>` names, else the file `BERTHY_CONFIG` names, else `berthy/config.json` in the user configuration directory (`os.UserConfigDir()`: `$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on macOS, `%AppData%` on Windows). The file is `projects.<project>.environments.<env>` with `url` and `token_env`; it never holds a token. The project comes from `--project`, else the `project` of `berthy.yml` in the manifest directory, else the only project that has the environment. An invalid `$BERTHY_ENV` is refused with `BERTHY_ENV is not a valid environment` and exit 2. A file that cannot be read fails the command with exit 1, and the message names its path. Exit codes are meaningful: a failed or rolled-back deploy exits non-zero. A command that an AI agent's token ran on a protected environment, and that the agent held for approval instead of carrying out, exits with code 3: it is neither done nor failed (see "Approval for AI agents on protected environments").

On a terminal's stderr, a mutating remote command prints `berthy: <project>/<environment> at <agent URL>` after the target is resolved and before any request, and `setup` prints `berthy: <project>/<environment> on <host>` (or `on this server` with `--local`) after the command line and manifest are checked and before the first step. Dry runs print it too. When `$BERTHY_ENV` chose the environment, the line ends with ` (environment from BERTHY_ENV)`. With stderr not a terminal, nothing is printed; `--json` stdout is unchanged.

**Aliases.** The CLI expands a name from the manifest's `aliases` before it checks any flag, so the agent gets an ordinary request, and the scope, the approval and the audit log are those of the command the alias stands for. `berthy console -e prod` runs `berthy exec api --role web -e prod -- bin/console`, and arguments given after the name are appended. The `-e`, `--config` and `--manifest-dir` given with an alias are used to find it, and `--manifest-dir` is passed on only to commands that take it. Without `-e`, `$BERTHY_ENV` selects the overlay the same way it does for other agent commands; a given `-e` wins. The words are split on spaces and never quoted, so a value with a quote is refused. `-e` and `--config` are refused inside an alias, so the environment comes from the command line or `$BERTHY_ENV`. An alias may not take the name of a built-in command, and its first word must be a command that talks to the agent. `config validate` checks all of this and names the alias that is wrong. The agent accepts the key and ignores it. Aliases are not an MCP tool.

Flags are checked before anything is sent. A read command refuses an unknown flag with exit 2 and `unknown flag`, before it reads any configuration. A change command refuses a flag it does not read with exit 2 and `<flag> is not a flag of <command>`, so `approve <id> --dry-run` is refused rather than approving for real.

**Versions.** A manifest's `min_version` is checked three times: by the CLI when it loads the manifest (`config validate` too, with no server), by the CLI against the agent's version before it sends a request that carries the manifest, and by the agent. Each refuses a manifest that needs a newer release than the one doing the check. A development build on either side skips the check. A deploy or an ingress apply that an older agent refuses as invalid gets one more line when that agent runs an older release than the CLI: `the agent runs an older release than this CLI; upgrade it with berthy setup`.

Every command goes through the agent's API except `setup`, which runs over SSH or on the server and has no MCP tool, and `context`, which edits the CLI configuration on this machine.

| Command | Purpose | Changes things |
| --- | --- | --- |
| `ps` | Apps, roles, replicas, health, running version | No |
| `describe <app>` | Full detail for one app, including its last deploys and job results, and how it differs from its applied release | No |
| `logs <app>` | Tail or follow logs; `--tail N`, `--follow` (or `-f`), `--since`, `--grep`, `--role`, `--replica` | No |
| `stats` | Server and container metrics; `--watch` for live, `--since DURATION` for the samples of that time (at most an hour) | No |
| `df` | Disk space and Docker disk usage | No |
| `history <app>` | Deploy records, with the reason of each failed deploy; a deploy from local changes is marked `(modified)` next to its commit. `--diff <release id> [<release id>]` prints what a release changes compared with another (see "Release diff") | No |
| `diagnostics <operation id>` | Evidence of a failed deploy: task and command state, exit codes, health checks and the last lines of output (needs the `deploy` scope) | No |
| `wait <app>` | Block until each service of the app, or of `--role`, has all its replicas running and healthy, or until `--timeout` passes (default 2m, at most 10m; then it exits non-zero). `--healthy` is accepted and changes nothing. A Compose app has no bound services, so it is refused | No |
| `doctor` | Checks the agent and its version, the host, root disk, Docker and its API version, Swarm manager, the shared network, the managed tunnel when configured, Compose, each registry password that a deployed image app pulls with and the Cloudflare API token when managed ingress is set up (see Health checks), the deploy lock, each peer, the secrets of each alert channel (Telegram, webhook) when alerts need them, the heartbeat when it is configured, each backup, the overlay helper when a service probe needs it, apps that are deployed but no longer in the manifest, each deployed app's drift from its release (a warning), the Compose services whose logs have no size limit, telemetry when configured, the TCP ports that listen on a public address and that containers publish (`public_ports`), and a pending reboot (`reboot_required`). The last two only warn, and never make the doctor exit 1. It prints the CLI's version and the agent's, and a note when the agent runs a different release than the CLI | No |
| `version` | Prints the CLI's version and platform; `--json` for JSON. It needs no agent | No |
| `audit` | Who changed what and when | No |
| `config show`, `config validate` | Print or check the merged manifest | No |
| `config schema [--overlay]`, `docs [section]` | Print the manifest's JSON Schema (draft-07; with `--overlay`, the schema of an overlay, where no key is required), or the reference of the manifest keys. Both are built into the CLI: they need no agent, no manifest and no `-e` | No |
| `backup list [--backup <name>]` | Backups in object storage: key, size, checksum and when each finished (`read` scope) | No |
| `ingress status` | Tunnel health, connectors, hostnames and DNS records, with managed ingress | No |
| `checks` | Stored state of every probe and built-in condition, with when each state began | No |
| `jobs` | Every job with its target, schedule, next occurrence and last run | No |
| `alerts test` | Send a test message to every alert channel and report each (exit 1 when one failed) | Yes |
| `job run <name>` | Run a job now, wait for it to finish and exit 0 only when it succeeded | Yes |
| `job logs <name> [--run <id>]` | The output kept of a failed or timed-out run of a job, redacted (`deploy` scope) | No |
| `ingress apply` | Create or repair the tunnel and connector, and sync every route and DNS record | Yes |
| `setup` | Prepare a server and install or upgrade the agent, over SSH or locally | Yes |
| `context add --project <project> -e <env> --url URL --token-env VAR [--save-token]` | Write one project's environment into the CLI configuration; with `--save-token`, also save the token in the local credential store; needs no agent | Yes |
| `context list` | List the CLI configuration's contexts: project, environment, URL, token variable, whether the variable is set, and whether a token is stored, not stored, or unknown; never a token | No |
| `context remove --project <project> -e <env> [--delete-token]` | Remove one context from the CLI configuration; `--delete-token` deletes its stored token first | Yes |
| `deploy <app> --version <tag>` | Deploy an image app; a Compose app takes no `--version`. On a protected environment `--version` is a digest, never a tag | Yes |
| `deploy [--version <app>=<tag>]…` | Deploy every app in `depends_on` order and stop at the first failure; an image app given no version keeps the one it runs, and a plain `--version` is for a manifest with one image app (see Deploying every app) | Yes |
| `apply` | Apply the environment settings of the manifest, such as probes, peers, alerts, destinations and telemetry, without deploying an app; `--dry-run` lists the changes | Yes |
| `rollback <app>` | Return to a previous deploy | Yes |
| `restart <app>`, `scale <app>` | Restart or change replica count; `scale` is for image apps, and a Compose app is refused | Yes |
| `exec <app> [-i] -- <command>` | Run a command in a running container: the role's container for an image app (`--role`), or a service's container for a Compose app (`--service`, which may be left out when the app has one service); with `-i`, an interactive session (see "Interactive sessions"), and the exit code is the command's own | Yes |
| `run <app> [--role <name>] [--timeout <d>] [-i] -- <command>` | Run a command in a new container of the app's applied release, with the role's environment, the shared network, the role's resource limits and the role's named volumes, and remove the container after its output is recorded. Image apps only; `--timeout` defaults to `1h`, from `1s` to `24h`. An operation under the deploy lock, held while the command runs; with `-i`, an interactive session instead, which holds no lock, and with no `--timeout` has no limit | Yes |
| `secret set`, `secret generate`, `secret import`, `secret list`, `secret rm` | Manage secret values; values are never printed. At a terminal, `secret set` with no name generates declared secrets and asks for each unmet value. `secret generate NAME` makes a random value on the agent and stores it, refusing a stored name unless `--replace`. `secret generate` with no name generates each declared secret (`POST secrets/generate-declared`) that is not stored and whose apps were never deployed. `secret import` stores every `NAME=value` line of standard input, all or nothing; `secret list --manifest-dir` also names needs that are missing, have incompatible registry associations, or conflict; its JSON `missing` array contains those needs | Yes |
| `lock acquire`, `lock release`, `lock status` | Manage the deploy lock | Yes |
| `recovery resolve OPERATION_ID -m REASON` | Finish an operation stuck in recovery as failed and release its lock (admin; `--dry-run` shows the journaled steps) | Yes |
| `backup run <name>` | Run a backup of a volume or of a command's output now, wait for it to finish and exit 0 only when it succeeded (`deploy` scope) | Yes |
| `cancel OPERATION_ID`, `job cancel <name>` | Stop a running operation while it can still be undone cleanly, or the run of a job (`deploy` scope; see "Cancelling an operation"; `--dry-run` of `cancel` says whether it would be accepted) | Yes |
| `restore <key> --exec <app> [--service <name> \| --role <name>] [--timeout <d>] -- <command>` | Restore a command backup by streaming it, decompressed, into the input of a command in a running container or a new one (`admin` scope; the checksum is checked before the command starts; `--dry-run` shows where it would run) | Yes |
| `state-backup` | Take a snapshot of the agent's state now, wait for it to finish and exit 0 only when it succeeded (`admin` scope) | Yes |
| `key rotate [--dry-run]` | Replace the key the agent's state is sealed with (`admin` scope, never an agent token; see "Encryption key") | Yes |
| `state-restore [--project PROJECT] [--manifest-dir DIR] --endpoint URL --bucket NAME --object KEY --out DIR --key-file PATH` | Rebuild the agent's state from a state snapshot with the saved key, without an agent; the project is the flag, else the manifest in `--manifest-dir` (default `.`), else the only project that has the snapshot's environment among the bucket's object keys; the storage credentials come from `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY` | No |
| `prune` | Remove old images and stopped containers now | Yes |
| `destroy --confirm <project/environment> [--volumes] [--allow-recreate] [--tunnel]` | Remove every app, managed ingress, helpers, one-off containers and acquired images of the environment; volumes only with `--volumes`, the tunnel only with `--tunnel` and when clean (admin) | Yes |
| `remove <app> [--volumes] [--allow-recreate]` | Delete an app's services or Compose project, its routes and DNS records, and its state; volumes only with `--volumes` (admin) | Yes |
| `approvals [--all]` | List the changes AI agents have asked for and that wait for a person: id, age, time left, who asked and what; `--all` also lists the decided and expired ones (`read` scope; the plan column needs `deploy`) | No |
| `approve <id>` | Show the plan of a change an AI agent asked for, carry it out as that agent and follow the operation it starts; it asks nothing more, so the person has read the plan in `approvals` first (`admin` scope, never an agent token) | Yes |
| `reject <id> [-m <reason>]` | Refuse a change an AI agent asked for; nothing runs (`admin` scope, never an agent token) | Yes |
| `token create <name> [--scope read\|deploy\|admin] [--agent] [--expires <90d\|36h\|date>] [--dry-run]` | Make a token through the agent and print it once; it works at once and the agent keeps only its digest, in its state (`admin` scope, never an agent token; see Tokens) | Yes |
| `token list` | List every token with its scope, agent mark, origin (`config` or `api`), created, expires and last used; never a token or a digest (`admin` scope) | No |
| `token revoke <name> [--dry-run]` | Remove a token made through the API; it is refused at its next request (`admin` scope, never an agent token) | Yes |
| `agent token --project <project> -e <env> [--agent] [--name <name>] [--scope read\|deploy\|admin] [--config <file>]` | Make a token offline and print it once, with its digest and the object to paste into the `tokens` list of the agent's configuration, and a `context add` line for another machine; it needs no agent and no network | No |

### TUI

`berthy ui -e <env> [--config <cli config>]` opens a full-screen live view built for reading first. It reads the same configuration and token as every other command, so a `read` token shows every view; the token is never drawn, logged or written. It needs a terminal on standard input and output and refuses to start without one. It is built with the Charm libraries (Bubble Tea, Bubbles, Lip Gloss, Huh for the confirmations and Glamour for the plans) and works at 80×24 and up; a smaller terminal gets a notice. Colours follow the terminal's light or dark background, and `NO_COLOR` turns them off: every state also has a glyph and a word, so nothing depends on colour.

The header shows the environment, a badge when it is protected, and the host. Four tabs hold the views:

- **Apps.** A table of the apps with kind, roles, replicas (running/desired), health (`●` healthy, `◐` starting, `✖` unhealthy, `○` none), version (image tag or short digest) and the age of the oldest newest backup, red when the last run failed. `/` filters by name. `enter` opens the detail of the app: its roles and replicas (state, health, restarts, out-of-memory kills), the last ten deploys with the reason of a failed one, its jobs and its backups. `l` follows its logs.
- **Logs.** A filterable picker of apps, then the followed logs of the chosen app: the last 200 lines and what comes, with the time, the source (role and the first 6 characters of the container id, such as `web.f77449`) and the stream (stderr is tinted). `f` pauses and resumes following, which also pauses when you scroll up. `p` shows the lines of one source at a time: all, then each source in the order first seen, then all again. `/` greps with a regular expression (smart case) on the lines the view keeps, the newest 5 000; a line must pass both the replica and the grep. `esc` clears both. What an app prints is shown with every escape and control sequence removed. A dropped stream reconnects with a growing wait and asks only for the lines it has not seen.
- **Server.** Meters for CPU, memory, swap and every mount, the load, the network and disk traffic, a sparkline of the CPU of the last minutes, the Docker disk usage, and the containers sorted by CPU with their memory, network and block I/O.
- **Approvals.** The changes AI agents have asked for, the ones that wait first, with who asked and the time left. `enter` shows the request and its plan, and a countdown while it waits; a token without the `deploy` scope sees that the plan is hidden.

The status line shows the connection (a spinner while a request is under way; `agent unreachable — retrying in 4s` when the agent cannot be reached, with the last data kept on the screen and the wait growing from 1 s to 30 s), the deploy lock, the oldest successful backup, the pending approvals and the age of the data. The footer shows the keys of the view; `?` shows them all.

| Key | Action |
| --- | --- |
| `tab`, `shift+tab`, `1`-`4` | Switch tabs |
| `↑` `↓` `j` `k`, `pgup` `pgdn`, `g` `G` | Move and scroll |
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

The views read the agent API: the apps every 3 seconds, the lock and the number of pending approvals every 5, the approvals every 5 while their tab is open, the history of an app when its detail opens and every 10 seconds after, `df` every 30 seconds on the Server tab, and two event streams (`logs?follow=1` and `stats?watch=1`) that run only while their tab is open. The views only read: a change is made only through an action, below.

**Actions.** `R` restarts the app under the cursor or the open one, `b` rolls it back, and on the Approvals tab `a` approves and `x` rejects the selected pending request. The keys show in the footer only where they apply. Every action goes through one overlay and nothing is sent before the person confirms in it:

1. **Plan.** A restart or a roll back asks the agent for the same request with `dry_run` set, which is the plan `--dry-run` prints; an approval or a rejection reads the requests again and refuses at once when the request is no longer pending or has expired. A roll back first asks which release, in a list of the earlier successful releases from the app's history (id, tag when there is one, short digest, commit, age), the previous one chosen; a restart of an image app with several roles asks which role (the agent restarts one role at a time; a Compose app restarts as a whole).
2. **Confirm.** The plan is drawn as Markdown with Glamour in the colours of the interface, inside a scrolling pane: the facts (app, image and its whole digest, roles, what will happen), what the plan changes when it has a diff, and the full plan as JSON. The detail of an approval on the Approvals tab shows what changes as lines above the rest of the plan, coloured by their mark. Every string of the agent goes into the document inside a code span, so nothing in it can be formatting. For an approval the overlay also shows who asked, how long ago, and a live countdown to the expiry. A Huh confirmation follows, with Cancel as the default. On a protected environment a roll back and an approval also ask for the environment's name, typed exactly (it is case sensitive), in the same form: the confirmation cannot be reached before the name is right. A rejection asks for an optional reason of up to 200 characters. `esc` cancels at any time before the confirmation and sends nothing; the overlay takes every key while it is open.
3. **Run.** The real request is sent with a fresh `request_id`; after a network error `r` sends it again with the same one, so the agent recognizes a retry. The agent can answer with an operation, which is followed; with a held request (the token is an AI agent's on a protected environment), which the overlay reports as "Held for approval <id>" with the command a person runs to approve it; with a result (a rejection); or with a refusal, which is shown with the agent's message and, for a `403` of a token that is too weak, the scope it needs (`deploy` to restart and roll back, `admin` to approve and reject).
4. **Follow.** The events of the operation stream in as a live list with a spinner and the time elapsed, on the same events stream and with the same checks as the CLI; a dropped stream reconnects without showing an event twice. It ends with the result: "Restarted api in 12s", or for a failed, rolled back or recovery-required operation the reason, the command `berthy diagnostics <operation> -e <env>`, and `d` to open the app. `esc` while it runs closes the overlay and leaves a note on the status line, "operation <id> continues on the agent": the operation is not cancelled. For an operation that can be cancelled (a roll back, and an approved deploy, rollback or run), `c` opens a confirmation, "Cancel operation <id>?" with "Cancel it" and "Keep going", and sends the cancel only when it is confirmed. The agent answers: accepted ("Cancel accepted: the operation is stopping", after which the operation ends as the agent says, "was cancelled · rolled back" with the reason), held for approval for an AI agent token on a protected environment, or refused with its reason ("the deploy already switched traffic"), which leaves the operation going and the key where it was. `esc` in the confirmation goes back.

When an action ends, the apps, the lock, the pending count, the approvals and the open app's history are read again at once. Only one action is open at a time; the views under the overlay go on updating.

### MCP server

`berthy mcp -e <env> [--config <cli config>] [--manifest-dir <dir>]` runs a local MCP server over stdio that calls the agent API with the token it was given. The token comes only from the environment variable that the CLI configuration names for `<env>`, never from the credential store; use an agent token so its changes can be held for approval. It is never printed and never part of a tool result. Only protocol messages go to stdout; diagnostics go to stderr. `--manifest-dir` (default `.`) is where `deploy` reads the manifest, and a Compose app's file, from, exactly as `berthy deploy` does. The server shares the CLI's HTTP client and request code, so an AI agent sees what a person sees, with the same errors.

Tool names follow those of the Aspire MCP server, so an AI agent can ask a deployed environment the same questions it asks a local run. Each tool returns the agent's JSON as structured content (a list is wrapped in an object, `{"resources": [...]}`) and a short text: a summary line followed by the same JSON, or for `list_console_logs` the log lines. Every tool is read-only except `execute_resource_command`, and the tools say so in their MCP annotations.

| Tool | Maps to | Inputs |
| --- | --- | --- |
| `list_resources` | `ps` | none |
| `describe_resource` | `describe` | `resource_name`, which may be `image:NAME`, `swarm:NAME` or `compose:NAME` |
| `list_console_logs` | `logs`, without `--follow` | `resource_name`; `role`, `since`, `grep`; `tail` (default 200, at most 1000) |
| `get_stats` | `stats` and `df` | none; the result has `stats` and `df` |
| `list_deploys` | `history` | `resource_name`; failed deploys carry their `operation_id` and reason |
| `get_deploy_diagnostics` | `diagnostics` | `operation_id` of a failed deploy (needs the `deploy` scope: a `read` token gets the agent's 403 as a tool error) |
| `list_backups` | `backup list` | `backup_name` (optional) |
| `wait_for_resources` | `wait` | `resource_name`; `role`; `timeout` (a duration, at most 10 minutes, default 2) |
| `doctor` | `doctor` | none |
| `list_approvals` | `approvals --all` | none: what became of the changes that were held |
| `execute_resource_command` | `deploy`, `rollback`, `restart`, `backup run`, `restore` | see below |

`execute_resource_command` takes `command`, one of `deploy`, `rollback`, `restart`, `backup_run` and `restore`, and the fields of that command; a field that does not belong to the command, or a missing one, is a tool error before anything reaches the agent.

| `command` | Fields | Scope the token needs |
| --- | --- | --- |
| `deploy` | `resource_name`, `version` (an image app; a Compose app takes none), `dry_run` | `deploy` |
| `rollback` | `resource_name`, `to` (a release id; default the previous one), `dry_run` | `deploy` |
| `restart` | `resource_name`, `role`, `dry_run` | `deploy` |
| `backup_run` | `backup_name` (no `dry_run`) | `deploy` |
| `restore` | `backup_key` (from `list_backups`), `into_volume`, `dry_run` | `admin` |

The result of `execute_resource_command` is one of:

- **Done or failed.** A started operation is followed until it ends, for at most 10 minutes: `{"operation_id", "state", "reason"}` (a backup run has `backup_run_id` and `key` instead). `state` is the agent's: `succeeded`, `failed`, `rolled_back`, `interrupted`, `recovery_required`, or `running` when the bound passed first. Any state but `succeeded` and `running` is marked as a tool error, and the text points to `get_deploy_diagnostics`.
- **Held.** On a protected environment an agent token's change is not carried out (see "Approval for AI agents on protected environments"). The result is `{"status": "held for approval", "approval_id", "expires", "plan"}`, it is not an error, and the text says `held for approval <id>: a person must run berthy approve <id>`. The AI agent has to tell the person and not retry; `list_approvals` shows later whether it was approved, rejected or expired.
- **Plan.** With `dry_run`, `{"dry_run": true, "plan": ...}`: the plan that `--dry-run` prints. It is never held.
- **Refused.** A 400, 403, 409 or other refusal of the agent (the wrong scope, a held deploy lock, an unknown app or a manifest that does not allow the image) is a tool error carrying the agent's message, never a protocol error.

The server offers three prompts over `prompts/list` and `prompts/get`, and advertises the `prompts` capability. The initialize result lists them in its instructions. Each prompt is a fixed recipe over the tools above, filled in with its argument. It only reads: it never calls `execute_resource_command`, and it never calls the agent itself.

- `explain_failed_deploy` (`resource_name`): `list_deploys`, then the newest record with a state of `failed`, `rolled_back` or `interrupted`, then `get_deploy_diagnostics` for its `operation_id`. The answer is the reason, the evidence and a suggested fix. It never redeploys.
- `troubleshoot_resource` (`resource_name`): `describe_resource` (with its drift lines), recent `list_console_logs`, `doctor` and `get_stats`.
- `health_report` (no argument): `list_resources`, `doctor`, `list_backups` and `list_approvals`, one summary of the environment.

Each recipe says what to do when a tool answers 403: the token's scope is too low for it, and the person decides whether to give the token that scope. A fix a recipe suggests is a separate `execute_resource_command` call, with its usual holds. A prompt name that is not offered, or a missing required argument, is a JSON-RPC `invalid params` error. The recipes are one table in `internal/mcp`, and a test checks that every tool a recipe names is registered.

A client such as Claude Code starts the server itself. With the token in the environment the client runs it in, the entry of a `.mcp.json` is:

```json
{
  "mcpServers": {
    "berthy": {
      "command": "berthy",
      "args": ["mcp", "-e", "prod", "--manifest-dir", "/home/me/shop"],
      "env": { "BERTHY_SHOP_PROD_TOKEN": "${BERTHY_SHOP_PROD_TOKEN}" }
    }
  }
}
```

The plan that a `dry_run` of a deploy or rollback returns, and the plan of a held one, carries the release diff (see "Release diff") in its `diff` key. The text of the result also lists it, one line per change under `changes of <app>:`, with control characters shown as `?`.

The configuration file is the CLI's: `{"projects": {"shop": {"environments": {"prod": {"url": "http://127.0.0.1:8443", "token_env": "BERTHY_SHOP_PROD_TOKEN"}}}}}`. Any other stdio MCP client takes the same command, arguments and environment. Make the token with `berthy token create claude -e prod --agent --scope deploy` (or `--scope read` to let the AI agent only look), so that on a protected environment its changes are held for a person.

## Monitoring, logs and health checks

The agent shows what is happening now and raises alerts. History is kept by an OpenTelemetry backend, if one is configured.

### Metrics

| Scope | Metrics | Read from |
| --- | --- | --- |
| Server | CPU, memory, swap, load, disk space per mount, disk I/O, network I/O | The kernel's `/proc` and filesystem stats |
| Docker | Disk used by images, containers, volumes and build cache | The Docker API |
| Container | CPU, memory against its limit, block I/O, network I/O, restarts, out-of-memory kills | Control groups and the Docker API |

- Sampled every 10 seconds (proposed).
- The last hour is held in memory for `stats` and the TUI. Nothing is written to disk.
- Samples are exported over OpenTelemetry when the manifest names an endpoint. Without one, Berthy still shows live metrics and the last hour.
- Operations are exported too, as log records (see below).

```yaml
telemetry:
  otlp_endpoint: http://<collector>:4318
  headers_secret: OTLP_HEADERS   # optional
```

- `headers_secret` names a secret that holds request headers in the standard `OTEL_EXPORTER_OTLP_HEADERS` form, `name=value,name=value`. Backends that require authorization need it.
- The agent runs on the host, so the endpoint must be an address the host can reach, such as a port published on a private address. A Docker service name does not resolve there.
- With an endpoint, the agent also sends **two log records for every operation, of every kind** (deploy, rollback, restart, scale, exec, run, remove and the rest): one when the operation is admitted and one when it ends. They go to the endpoint's `/v1/logs` as OTLP protobuf over HTTP, with the same headers and the same resource attributes as the metrics (`service.name=berthy-agent`, `deployment.environment.name`, `host.name`). The body reads `<kind> started` or `<kind> <state>`, such as `deploy started` and `deploy rolled back`. The severity is INFO, and WARN when the operation ended as `failed`, `rolled_back`, `interrupted` or `recovery_required`. The attributes are `berthy.environment`, `berthy.app`, `berthy.operation.id`, `berthy.operation.kind`, `berthy.version` (the tag, or the short digest), `berthy.image.digest` (`sha256:` and the full digest), `berthy.operation.state` (`running` at the start), `berthy.actor` (the token's name), and, on the end record, `berthy.operation.duration_ms`. An attribute whose value is not known is left out: a restart has no version or digest, and a deploy that failed before its image was resolved has no digest. A record never holds the operation's output or its reason.
- The records are queued, at most 256, and sent in the background: an operation never waits for the backend. When the queue is full, or the backend does not answer, the records are dropped and the agent logs why, without the headers. Which endpoint they go to is read from the environment's settings when each batch is sent, so the first deploy that turns telemetry on sends its end record and not its start record, and an operation that ends in the same moment the endpoint is removed sends nothing. An operation that ended as `recovery_required` and is later decided, by recovery or by `recovery resolve`, sends a second end record with the final state.

### Logs

- `logs` tails or follows container output straight from Docker, per app, role or replica.
- A text line is the time in UTC, the source and the message. The source is the role and the first 12 characters of the container id (`web.f77449eeec32`), the ones `docker ps` shows; a stderr line is marked `[stderr]`. `--json` prints the records instead.
- `--replica` names a replica by its task id, its container id, or a prefix of at least 6 characters. A shorter prefix matches only a whole id. A prefix that matches more than one replica of the app, on any node, is refused with `bad_request`.
- The agent stores no logs. History and search belong to a log backend the apps send to.
- Image apps get log rotation per service: `max-size: 10m` and `max-file: 3` when the server's default log driver is `json-file` or `local` and the role sets no `logging`. A role's `logging` (`driver` and `options`) replaces it, with any driver. Under any other default driver Berthy sets nothing, so Docker's own settings apply. Compose apps keep their own logging settings; Berthy does not rewrite their files. Instead, `doctor` warns (`compose_log_limit`, not critical) about each service of a deployed Compose app whose logs have no size limit: its driver is json-file and neither it sets a `max-size` nor, when its driver is the daemon's default driver, does the daemon's `log-opts` set one. Docker merges the daemon's `log-opts` into a service's logging when the drivers match, so a service that sets only `max-file` still gets the daemon's `max-size`.
- An adopted service's plan lists the logging change its next deploy applies, as a `changes` line.

### Health checks

| Kind | What it checks | Effect |
| --- | --- | --- |
| Container health check | The check declared for a role in the manifest | Gates deploys; an unhealthy container is replaced |
| Probe | An HTTP or TCP check the agent runs on a schedule, against a service name or a public URL | Alert |
| Built-in condition | Disk space, Docker disk usage, memory, restart loops, missing replicas (down), drift from the applied release, overdue backup, silent peer, unhealthy tunnel with managed ingress, a credential refused, missing or about to expire | Alert |

Proposed thresholds: disk space and Docker disk usage warn at 80% and go critical at 90%.

**Where a probe runs.** The agent runs on the host, where Docker service names do not resolve and addresses on the shared overlay network cannot be reached.

- A probe against a public URL, or an address the host can reach, is run by the agent itself.
- A probe against a service name runs in the overlay helper: one container per environment on each server, built by the agent from its own static binary as `berthy-helper:<hash>` (no registry and no internet), attached to the shared network and published on 127.0.0.1 only. The agent gives it probes over a bearer token that it keeps in memory, so a restart recreates the helper with a new token, and a Compose service must join the shared network to be probed.

#### Drift

The check `drift:<app>` exists for every deployed app except the ingress connector. It runs every 5 minutes, changes state on its first non-ok result, and is a warning at most, never critical. It reports and never corrects: a deploy brings the app back.

- **The spec of a release.** A role's Swarm service is a function of the applied release: the same function builds the spec that a deploy sends and the spec the check compares with. Its inputs are the manifest stored with the release, the pinned image and tag of the release, the current values of the secrets the manifest reads, the image's own health check when the role sets none, and the daemon's default log driver. The check reads the image and pulls nothing.
- **Image apps.** Each role of the release is compared with the service bound to it. Both specs are compared as an adoption compares them: the service name, the `berthy.*` labels, the force-update counter and what Docker adds on its own are set aside. A field the live service has and the release does not produce, a field the release produces and the service lacks, and a field with another value each give one line, `<app>/<role>: <field> <live value>, release says <release value>`, where an absent value reads `none`. The environment is compared by name: `<app>/<role>: env A, B differ`, and no value is ever shown. A bound service that is missing gives `<app>/<role>: service <name> is gone`.
- **Compose apps.** The check stages the Compose file journaled with the applied release and the manifest's environment, and builds the plan a deploy builds (Compose's configuration hash against the label of each container, and the volumes that exist). Each service the plan would recreate, create or remove gives `<app>: service <name> would be recreated`, `created` or `removed`, and each volume it would create gives `<app>: volume <name> would be created`. The plan's blockers are not drift.
- **Scaled roles.** A role whose replica count differs and whose `berthy.operation` label names a `scale` or a `restart` operation (a restart keeps the scaled count) is reported as `<app>/<role>: scaled to N with berthy scale`, apart from the drift lines. The check is ok when only such lines remain, and says so in its detail. Any other difference of that role is still drift.
- **States.** Warning with the lines joined by `; ` and cut at 400 characters; ok with `matches release <tag or short digest>`; unknown, which never alerts, while an operation holds the environment lock for the app (read before and after the comparison), and when Docker, the image, a secret or the release cannot be read.
- **Where it shows.** `berthy checks` shows the stored state. `doctor` runs the comparison when it is asked, so it never shows an age. `describe <app>` and `GET apps/<name>` carry `drift` and `scaled` (lists of lines, left out when empty), computed on request and left out while an operation runs on the app.

#### Configuration

Probes, peers and alerts are part of the manifest, so they are reviewed like code. Monitoring uses the manifest the agent runs from (see Two scopes of the manifest): the environment's settings and the app scope of each deployed app's own release. A probe of the environment changes with a deploy of any app or with `berthy apply`; a service probe changes with a deploy of its app, and goes back with that app on a rollback. A release or settings the agent cannot read keep the checks that are already running.

```yaml
probes:
  site:
    http: https://app.example.com/health    # or tcp: 10.0.0.5:5432, or service: {app: api, port: 8080, path: /health}
    expect_status: [200, 204]               # default: any status from 200 to 399
    interval: 30s                           # default 30s, at least 5s
    timeout: 5s                             # default 5s, and shorter than the interval
    failures: 3                             # failed runs in a row before the state changes; default 3
peers:
  prod: https://prod.example.com:8443       # the other agent's base URL, with no path
alerts:
  reminder: 4h                              # while a check keeps failing; 0s turns reminders off; every channel
  deploys: failed                           # which deploys and rollbacks send a message: failed (default), all or none; every channel
  telegram:
    bot_token_secret: TELEGRAM_BOT_TOKEN    # the name of a secret that holds the bot token
    chat_id: "-1001234567890"               # quote it; or "@channel_name"
  webhook:
    url_secret: ALERT_WEBHOOK_URL           # the name of a secret that holds the URL, which is often the credential
    headers_secret: ALERT_WEBHOOK_HEADERS   # optional: a secret that holds name=value,name=value
  heartbeat:
    url_secret: HEARTBEAT_URL               # the name of a secret that holds the URL the agent pings
    interval: 1m                            # default 1m, at least 10s
```

- A check changes state after it has failed the configured number of times in a row. One success recovers it at once. Unknown results never alert.
- A service probe runs in the overlay helper. When the helper is not running, or the service cannot be named, the probe is unknown and its detail gives the reason. Its timeout is from 1s to 25s.
- Each peer is asked for `/healthz` every 30 seconds with a 5-second timeout, and is critical after three misses. `/healthz` needs no token and answers `{"ok":true}` and nothing else.
- Built-in conditions always run: disk and Docker disk (warning from 80%, critical from 90%), memory (warning below 10% available, critical below 5%), restart loops of the apps Berthy manages (three restarts of one replica, or three Swarm tasks that failed or were rejected, within 10 minutes, or an out-of-memory kill; shutdowns, such as a rolling update's old tasks, do not count; unmanaged Swarm services and Compose projects are not checked), and the tunnel when managed ingress is set up.
- Down checks, `down:APP/ROLE` for each role of an image app and `down:PROJECT/SERVICE` for each service of a Compose app, are critical when fewer replicas run and are healthy than the app should run, for two minutes. A replica is healthy when it runs and is not unhealthy. An image role should run the replica count of its Swarm service, so zero is ok. A Compose service should run the containers it has, and a service whose containers are gone counts as zero of the count it had. The checks read the inventory of the restart checks and make no Docker call of their own. No check is judged while a deploy, rollback, restart, scale, remove or ingress operation on its app runs, or for two minutes after it ends; while a destroy runs, no check is judged. Such a check is unknown and never alerts. The exit code of an exited Compose container is read from the status the container list gives, with no extra call, and a container that exited with code 0 is a finished one-shot, the same notion a Compose deploy uses to accept one: it is neither wanted nor down. The detail says what was seen, such as `0 of 2 replicas running`, `1 of 2 replicas healthy (1 unhealthy)`, `exited with code 137`, or `container exited` when the status gives no code. While the first two minutes of a shortfall run, the check is unknown and its detail reads `not yet confirmed`; then it is critical, with ` for Nm` added. The check is also unknown while its app is quiet, and when the inventory is older than six minutes. An unknown result never alerts, so a short gap never sends a recovered message.
- Docker events wake the checks, and the reads decide. The agent reads Docker's event feed (`GET /events`) on one goroutine and asks only for container `die`, `oom` and `health_status` events and service `update` and `remove` events; of the container events it keeps those of the environment's containers (the `berthy.environment` label) and those of Compose projects. A container event wakes the restart and down checks, and a service event wakes those and the drift checks: the monitor reads the inventory at once and runs the woken checks at once, then once more five seconds later, because Swarm records a failed task a moment after its container dies. Events that come within five seconds of the last early read are merged into the next one. An event changes no decision: every check judges what the read shows, and a lost event costs time, never correctness. While the feed is open the inventory is read every three minutes; while it is not, every minute, as before. After a dropped feed the agent asks again from the time of the last event it saw, with a wait that doubles from one second to 30 seconds, and reads the inventory once when the feed is back. A rollout's waits (for healthy replicas, for the update to complete, for the old tasks to end) poll every 5 seconds while the feed is open and every 500 ms otherwise, and an event of their service wakes them at once and keeps them at 500 ms for three seconds, because Swarm can record a task's state a moment after the event that announces it. A rollout never depends on the feed: its outcome is the same without it.
- Credential checks run too: `registry:HOST` for each registry of the environment's settings that a deployed image app pulls from, and `cloudflare_token` when managed ingress is set up. The monitor asks each one every 10 minutes. `doctor` asks when it runs, all of them at once and for no more than 5 seconds. A check changes state after two answers in a row that are not ok, so a refused credential alerts 10 to 20 minutes after it stops working. One accepted answer recovers it at once. The states are:
  - ok: `accepted`, or `accepted, expires DATE` when the Cloudflare token expires more than 14 days away.
  - warning: `expires in N (DATE): replace it with berthy secret set NAME -e ENV` when the Cloudflare token expires within 14 days. No registry check warns, because a registry does not say when its password expires.
  - critical: `refused: REASON: run berthy secret set NAME -e ENV`, or `secret NAME is not stored: run berthy secret set NAME -e ENV` when the secret is missing. For a registry password the command has `--registry HOST`. REASON is `HOST does not let it pull REPO` for a registry; for Cloudflare it is `Cloudflare does not accept the token: it is wrong, expired or disabled`, or `Cloudflare reports the token as expired` (or `disabled`), or `Cloudflare reports the token as not active` for a status Berthy does not know.
  - unknown: `could not be asked: REASON`, where REASON is `timeout`, `connection refused`, `unreachable`, `secret unavailable` (the agent could not read the secret from its store), or the HTTP status the service answered, such as `ghcr.io answered HTTP 503 to the request for acme/todo-api`. Unknown never alerts, so an outage of the registry or of Cloudflare is never reported as a refused credential.

  In `doctor` the credential checks are never critical, so they do not make it exit non-zero. No detail, log line or alert holds a credential value.
- A token check, `token:NAME`, runs for each token made through the API that has an expiry, every hour. It is ok (`expires DATE`) until 14 days before the expiry, then a warning: `token NAME expires in N (DATE): create a new one with berthy token create`. After the expiry it is still a warning, `token NAME expired on DATE: create a new one with berthy token create`, until the token is revoked. It is not in `doctor`.
- Disk checks cover `/`, the mount that holds Docker's data, and every mount of at least 1 GiB; smaller mounts are skipped.
- Host checks run every 10 minutes and change nothing on the host. `public_ports` lists the TCP ports that listen on an address that is not loopback, private (RFC 1918, ULA or link-local) or on the VPN range (100.64.0.0/10), and the TCP ports that containers publish on such an address. It reads the socket tables of the host and the published ports from Docker. It warns about every port except 22, 80 and 443, which it lists without a warning. Each port carries its name where Berthy knows it, and the agent's own listen port is named `berthy agent`. The detail says that a listening port is not proof that it is reachable. A source that cannot be read makes the check unknown, which never alerts, unless another port already warns. `reboot_required` warns when `/var/run/reboot-required` exists, and lists the packages in `/var/run/reboot-required.pkgs` when that file exists. A host without the update notifier's package directory does not get the check.
- An alert is sent when a state changes: 🔴 for critical, 🟠 for warning, ✅ on recovery. Reminders read 🔁 still failing. `berthy alerts test -e ENV` sends a test message to every channel and reports each one.

### Alerts

- Alerts go to Telegram, to an HTTP webhook, or to both. `reminder` and `deploys` are set once under `alerts`, for every channel.
- Host checks (disk, Docker disk, memory, public ports, reboot) run in every hosted environment's monitor. Each environment evaluates them independently and sends any resulting alerts to all of its configured channels (Telegram, webhook, or both); an environment with no channel configured sends none. Alerts, deploy reports, the webhook body and telemetry name the environment only, not the project. Server-level alert channels, and naming the project in those messages, are planned: #55, #56.
- An alert is sent when a check changes state, failing or recovering, with a reminder while it stays failing.
- A deploy or rollback also sends one message when it ends, as `alerts.deploys` says: `failed` (the default) sends one when it ends as `failed`, `rolled_back`, `interrupted` or `recovery_required`; `all` sends one for a success too; `none` sends none. Which settings decide: for a deploy, the manifest of the request, so a first deploy that fails still alerts; and for a rollback and for an operation that recovery ends after an agent restart, the alert settings the environment stores, which a rollback never changes. Other kinds of operation never send a message.
- A message holds the environment, the app, the tag or short digest, who asked (the token's name, or `NAME (approved by NAME)` for an approved request) and how long it took. For a failure it adds the public reason of the operation, never output of the application, and the command that shows the evidence. For example `✅ prod: api v1.4.2 deployed by ci in 48s`, and

  ```
  🔴 prod: api v1.4.3 rolled back: role web: container never became healthy (last check: exit 1)
  by ci in 48s
  berthy diagnostics <operation id> -e prod
  ```

  A rollback that succeeds reads `✅ prod: api rolled back to v1.0.1 by ci in 12s`; a failed one `🔴 prod: api rollback to v1.0.1 failed: ...`. An operation that stopped without finishing reads `interrupted`, and one that needs a person reads `needs recovery`.
- The heartbeat is a dead man's switch, not an alert channel. While the agent runs and Docker answers, it sends one `GET` to the URL of `alerts.heartbeat.url_secret` every `interval` (default 1m, at least 10s), with a 5-second timeout and no retries. Any 2xx answer is an accepted ping; a redirect is not. It is the check `heartbeat`, in `berthy checks` and `doctor`: ok with `last ping accepted at TIME` after an accepted ping, and unknown, with the reason and when a ping was last accepted, when the URL cannot be reached, answers with another status, or Docker does not answer (no ping is sent then). It is never a warning or critical, so it never alerts: the channel it would use may be down for the same reason the pings stop. The URL is a secret and appears in no log line, detail or error. A new `interval` applies within a minute.
- An operation is alerted once. One that ended as `recovery_required` and is later finished by recovery or by `recovery resolve` sends no second message: the channel heard of the failure when it first ended.
- The message is sent in the background with a 15-second limit, to every channel at the same time. When a channel cannot be reached, or a secret of it is missing, the agent logs that the alert was not sent, naming the channel and never the URL or the token, and the deploy is unaffected. An alert that one channel took counts as delivered, so a channel that is down does not make the others repeat it.
- The webhook gets one `POST` of `{"environment", "kind", "name", "state", "detail", "since", "text"}`. `kind` is `check` or `deploy` (`test` for a test alert), `name` is the check or the app, `state` is the state of the check or how the deploy ended, `detail` is the detail of the check, or for a deploy the public reason or the version, `since` is when the state began, and `text` is the line Telegram gets. No field holds application output or a secret value. The URL (`alerts.webhook.url_secret`) and the optional headers (`alerts.webhook.headers_secret`, `name=value,name=value`) are secrets. Any 2xx counts as delivered, a redirect does not, and nothing is retried.

### Peer check

Agents in different environments can be named as peers. Each probes the others over the private network and alerts when one goes silent. This covers a server that is completely down, which cannot report itself.

It does not cover all servers failing together or an outage of the private network. Keep one external check on the application's public URL for that.

## Scheduled container commands

Declare a named command under `jobs` in the manifest. Each job can have its own five-field cron schedule, read in the manifest's `timezone` (UTC by default).

```yaml
jobs:
  cleanup:
    app: api
    role: web
    schedule: "30 2 * * *"
    command: ["/app/bin/cleanup"]
```

- Select the app with `app`. For a Compose app, use `service` to select the service. For an image app, use `role` to select the role. The selector can be omitted when the app has exactly one service or role.
- Jobs come from the manifest the agent runs from, which it re-reads every minute, so a changed schedule takes effect at the next minute after the deploy of the job's app. A rollback of the app brings back the schedule of the release it returns to; no other app is touched.
- At each scheduled time, Berthy runs `command` once. For an image app it runs in a **new container of its own**, of the app's applied release, the way `berthy run` does: it has the role's environment, the shared network, the role's resource limits and the role's named volumes (the same mounts the role's service has, so the job sees the files the replica writes), and the labels `berthy.job=<name>` and `berthy.oneoff=job`. The container is removed when the command ends. The job needs no running replica, so it runs while the role is scaled to 0 or restarting, and a deploy of the app does not touch it: it finishes on the release it started with. A job that writes a volume the role's replica writes shares it with the replica while it runs. For a Compose app the command runs as an exec in the lowest-numbered running container of the service; if the app has several services running and no `service` is named, the run fails and says so. It uses that container's environment and mounts. Include a shell explicitly if the command needs shell syntax. A job has no option to run inside a replica of an image app.
- `timeout` (default `1h`, from `1s` to `24h`) limits a run. A run that exceeds it fails with `timed out after <timeout>`. For an image app the job's container is stopped (SIGTERM, then SIGKILL after 10 seconds) and removed, so nothing of the command is left running. For a Compose app the wait ends but the command may still be running inside the container, because Docker has no way to stop one exec.
- Each scheduled occurrence runs at most once. The agent records the occurrence in its state before it runs, so restarting the agent in the same minute cannot run it twice. Occurrences that pass while the agent is down are not made up.
- Berthy records each run's start, end, trigger, container, exit status and a short reason, and `describe <app>` and `berthy jobs` show the last run. A nonzero exit, a missing running container, a run that could not start or a timeout fails the run and raises an alert through the `job:<name>` check, which stays critical until a later run succeeds. When the failed run kept output, the alert's detail ends with `: berthy job logs <name> shows its output`; the failure of a backup's `before` job says the same. If the job is still running at its next scheduled time, Berthy skips that occurrence and records the skip; a skip never raises an alert.
- The output of a run that **succeeds** is read and thrown away, so a job may print as much as it likes. The output of a run that **fails or times out** is kept: its last 200 lines, at most 64 KiB, with every managed secret value and every filled `env.template` value replaced by `[redacted]`, sealed in the state like a stored secret (and sealed again by `key rotate`). A job that prints nothing keeps nothing. `berthy job logs <name> -e ENV` prints the output of the newest run that kept any, or of the run named by `--run <id>`; it takes a `deploy` token, as `diagnostics` does. The record holds the exit code and a fixed reason such as `exit status 3`, `timed out after 5s`, `no running container for db/postgres` or `run failed`. The `before` job of a volume backup runs the same way and keeps its output the same way.
- When the agent is stopped in an orderly way (a restart or an upgrade) while a job runs, the run is recorded as `interrupted` with `agent stopped during the run`. Like a skip, an interrupted run never raises an alert and does not change the job's check. A run still marked running when the agent starts again, because the agent crashed or was killed, is recorded as failed with `agent restarted during the run`. In both cases a Compose job's command may still be running in its container. The container of an image app's job is removed when the agent starts again.
- Every run is written to the audit log with the job as the caller (`job:<name>`, action `job_run:<name>`, outcome `succeeded`, `failed`, `skipped` or `interrupted`). Jobs do not take the deploy lock, so they can run during a deploy.
- A job with no `schedule` runs only on demand, as preparation for a volume backup or with `berthy job run <name> -e ENV`. The command starts the run, waits until it finishes or its `timeout` plus 30 seconds passes, prints the status, exit code and reason, and exits 0 only when the run succeeded. It fails at once when a run of the job is already in progress. It takes a `deploy` token, and the audit log records which token asked (`job_start:<name>`).
- `berthy jobs -e ENV` lists every job with its target, schedule, next occurrence and last run, and takes a `read` token. The next occurrence is shown on the clock of the manifest's `timezone` and in UTC, as in `2026-11-20 02:00 JST (2026-11-19 17:00Z)`. `describe` and `--json` give `next` (an instant in UTC), `next_local` (the same instant with the zone's offset) and `timezone`.
- **Time zone.** A manifest's `timezone` applies to every `schedule`: jobs, backups and the state backup. A wall-clock time that does not exist on a day, because the clocks go forward, is skipped that day. A wall-clock time that happens twice, because the clocks go back, runs once, at the first of its two instants. An occurrence is still identified by its instant, so each occurrence runs at most once as before, and run records, logs and the audit log stay in UTC. The binary embeds the zone database (`time/tzdata`), so the result does not depend on what the server has installed. The overdue checks of backups and of the state backup read their schedule in the same zone. `berthy apply --dry-run` lists a change of zone as `timezone: UTC -> Europe/Lisbon`.

## Volume backups and restore

Any named Docker volume mounted by a managed app can have a backup, and so can the standard output of a command (see "Command backups"). Declare a backup for each volume to back up, with the source volume, an S3-compatible destination and, for automatic backups, a five-field cron schedule.

### Configuration

This example backs up the `uploads` volume mounted by a service in a Compose app named `files`.

```yaml
destinations:
  offsite:
    type: s3
    endpoint: https://<s3-endpoint>
    bucket: <bucket>
    access_key_secret: S3_ACCESS_KEY
    secret_key_secret: S3_SECRET_KEY

backups:
  uploads:
    app: files
    volume: uploads
    schedule: "0 0 * * *"
    destination: offsite
    prefix: files/uploads
    retention:
      keep: all            # or a number of most recent backups
```

- For a Compose app, `volume` is the key in the Compose file's top-level `volumes` block. Berthy resolves it using the app's Compose project name and any explicit volume name.
- For an image app, `volume` is the manifest volume name mounted by one of its roles. A role declares mounts under `volumes`, with entries such as `uploads:/app/uploads`.
- Omit `schedule` to run a backup only through `backup run` or a deploy hook.
- **Schedules.** A backup with a `schedule` runs once per cron occurrence (read in the manifest's `timezone`), with the trigger `schedule`. The agent reads the manifest of the deployed apps every minute, so a changed schedule takes effect at the next minute after its deploy. Each occurrence is recorded in the agent's state before it runs and at most once, so restarting the agent in the same minute, or a second process on the same state, cannot run it twice. Occurrences that pass while the agent is down are not made up. If a backup of the same Docker volume is still running at an occurrence, the occurrence is skipped: nothing is recorded, the agent logs `skipped: previous backup still running`, and nothing alerts. A scheduled run that cannot start, such as one whose credentials are gone, is recorded as a failed run so that the backup's check shows why. Every scheduled run is written to the audit log with the backup as the caller (`backup:<name>`, action `backup_run:<name>`, outcomes `started`, then `succeeded` or `failed`).
- `retention.keep` defaults to `all`. Set it to a number to retain that many successful backups for the job.

### How a backup runs

1. If the backup names a job under `before`, the agent runs that command and waits for it to succeed. This applies to scheduled backups, manual runs and deploy hooks. A preparation that fails fails the backup with `preparation failed: <reason of the job run>`, and no archive is started.
2. The agent reads the volume through a read-only mount and streams a compressed archive to object storage, hashing it on the way. A failed archive or upload is aborted and never listed as a successful backup.
3. Only after the archive is stored does the agent write its sidecar, then it records the source volume, object key, size, duration and checksum, and applies retention.

A backup of a command's output runs the command in place of steps 1 and 2; see "Command backups".

Backups of the same volume run one at a time: a second one is refused with `409` while one runs, and records nothing. If the preparation job has its own schedule, the backup waits for any active run to finish, then reserves the job until archiving finishes; a scheduled occurrence that arrives in between is skipped.

A failed run is recorded as `failed` with a detail that starts with the step that failed: `preparation failed`, `archive failed`, `command failed`, `upload failed` or `sidecar failed`. A run that the agent's stop cut short reads `agent stopped during the backup`, and one that a crash left running reads `agent restarted during the backup`.

**Which volume.** For an image app, `volume` must be the source of a named-volume mount of one of its roles, and its Docker volume is named `<project>-<environment>_<volume>`. For a Compose app, `volume` is a key of the Compose file's top-level `volumes`, and the agent asks Compose, with the project's stored files, for the Docker name (an external volume has the name it declares). A volume the app does not mount is refused: `backup <name>: volume <volume> is not mounted by app <app>`. A backup of an app that is not deployed is not part of the configuration.

**What storage holds.** Objects of a backup sit under `<project>/<environment>/<prefix>/<backup>/`, where `<prefix>` is the backup's `prefix` or `<app>/<volume>`:

- the archive `<UTC time>-<run id>.tar.gz`, as in `20261116T100000Z-7.tar.gz`;
- its sidecar `<same name>.json`: `{"format":"berthy-volume-tar-gzip-1","project","environment","backup","app","volume","docker_volume","size","sha256","started","finished","run_id"}`. The format says what the archive is, so a restore knows what an object holds; a command backup has `berthy-command-gzip-1` and no `volume` or `docker_volume` (see "Command backups").

The sidecar is written only after the archive was uploaded, so a backup that has one is complete. `backup list` reads sidecars: an archive without one is never listed and never restorable, and neither is a sidecar of another backup, environment or format. The destination's credentials are the secrets named by `access_key_secret` and `secret_key_secret`; without them a run is refused with `backup credentials unavailable`.

**Retention.** `keep: all` (the default) deletes nothing. `keep: N` deletes, after a successful run, all but the `N` newest backups that have a sidecar for this backup, the archive first and then its sidecar. Objects without a sidecar of this backup are never touched. A failed deletion is logged and does not fail the run.

A volume archive reads files as they are encountered. For apps that need a consistent set of files while writes continue, use a preparation job to write a consistent export to a dedicated volume.

### Command backups

A backup has exactly one of `volume` and `command`; `config validate` refuses both, and neither, with the file and line. With `command` it runs a command and keeps its standard output, which is how a database is backed up without a dump volume, a `before` job or disk space on the server.

```yaml
backups:
  main-db:
    app: postgres
    service: postgres          # a Compose app; an image app names role instead
    command: ["sh", "-c", "pg_dump -Fc --no-acl --no-owner -U \"$POSTGRES_USER\" \"$POSTGRES_DB\""]
    timeout: 1h                # default 1h; from 1s to 24h
    schedule: "0 0 * * *"
    destination: offsite
    retention:
      keep: 14
```

- **Where the command runs.** It runs as a job does. A Compose app's `service` names the service whose running container the command is executed in (it may be left out when the app has one service). An image app's `role` (which may be left out when the app has one role) names the role whose environment, limits and named volumes a new container of the app's applied release takes; the container is attached before it starts, is created without a log driver so Docker keeps no copy of the output, is stopped when the run ends before the command does, and is always removed. `role` and `service` cannot be combined, and they, `timeout` and `command` do not belong to a volume backup. `before` does not belong to a command backup.
- **The stream.** The command's standard output is compressed with gzip, hashed with SHA-256 and uploaded as it is written, through a pipe, so nothing is written to the server's disk. The object is `<project>/<environment>/<prefix>/<backup>/<UTC time>-<run id>.gz`, where `<prefix>` is the backup's `prefix` or `<app>/command`, and its sidecar `<same name>.json` has `format` `berthy-command-gzip-1`, with the size and SHA-256 of the stored object. The command runs under its `timeout`, with 1 hour as the default; the upload has none beyond the agent's.
- **Failure.** A command that exits non-zero, writes no standard output, runs out of time or cannot run (a Compose app with no running container of the service), and an upload that fails, abort the upload: the multipart upload is aborted, no object is left, and no sidecar is written, so the backup is never listed. The run is `failed` with the detail `command failed: <how it ended>: <the end of its standard error>`, such as `command failed: exited with code 3: pg_dump: error: connection lost`. The standard error is the last 200 lines the command wrote, with every managed secret value replaced, cut to what fits the 512 bytes of a run's detail, and empty when the secrets cannot be read. The backup's check shows it as for a volume.
- **The rest.** Schedules, retention, the `backup:<name>` check with its overdue and size rules, `backup run` and the `backup:` deploy hook work as for a volume. A command backup runs one at a time, and a second is refused with `409`.

### Safety checks

Each backup of the deployed manifest has a check named `backup:<name>`, run every 60 seconds, which alerts on its first non-ok result, like a job's check. A run that an agent stop or restart cut short does not count for it.

- **Failure.** The newest finished run failed: critical, with its detail (`preparation failed: exit status 3`, `upload failed: access denied`, `backup credentials unavailable`). A later success clears it.
- **Overdue backup.** For backups with a schedule: critical, `overdue: last success <time> (expected by <time>)`, when the time is later than the first occurrence after the newest success plus a grace. The grace is the interval between that occurrence and the next one, at most one hour: an hourly backup is overdue 2 hours after its last success, a daily one at 02:30 one hour after 02:30 the next day. A backup that never succeeded counts from when the agent first saw it, and until then reports unknown `not run yet`, which never alerts.
- **Size anomaly.** Warning, `size dropped to N% of the previous backup`, when the newest success is under half the size of the one before it.
- Otherwise ok: `last success <age> ago, <size>`.

**Where ages show.** `describe <app>` and `ps` (in JSON) list the app's backups with `last_success`, `age`, `size`, `last_status` and, after a failure, its `detail`. `doctor` has one check per backup that shows the monitor's state and detail; a backup in trouble does not make the doctor exit non-zero, because it is an alert and not a fault of the agent.

### Restore

- `berthy backup list -e prod` shows what is in object storage, with the key of each backup.
- `berthy restore <key> --into <volume> -e prod` takes an `admin` token. It is an operation of kind `restore` under the deploy lock, with events like `remove` and `destroy`, and the audit log records it with the token that asked. It streams the archive from storage into a new Docker volume, preserving file permissions and ownership, and compares the SHA-256 and size it read with the sidecar's. A mismatch fails the operation with `backup checksum mismatch` and removes the new volume. Choose an unused name: a volume that exists is refused, and so is a key whose sidecar is missing.
- `--dry-run` checks that the key names a backup with a valid sidecar and that the volume does not exist, and shows the backup it would restore.
- `backup list` and `restore` read the backups of the newest release of every app that was ever deployed, and the destinations of the environment's settings, whether or not the app is still deployed, so backups stay restorable after `berthy remove` or `destroy`. Running a backup needs the app deployed.
- The volume a restore creates carries the label `berthy.restore-operation=<operation id>`. If the agent stops or crashes during a restore, the operation ends `interrupted`, and the recovery at the next start removes the restore container the agent left and the volume that carries that operation's label, and no other volume. If it cannot remove the volume, the operation says so: remove it and run the restore again.
- When the agent starts it also removes the archive and restore containers that a killed agent left running in its environment. A multipart upload that a killed agent left in storage is not removed; a lifecycle rule on the bucket that aborts incomplete uploads does that.
- Inspect the restored volume before mounting it in an app. If it contains an export, use the app's own restore command to import it.

### Restore into a command

`berthy restore <key> --exec <app> [--service <name> | --role <name>] [--timeout <d>] [--dry-run] -- <command>...` streams a command backup, decompressed, into the standard input of a command. It takes an `admin` token and is an operation of kind `restore` under the deploy lock, audited like `restore --into`.

- `--into` and `--exec` are exclusive. `restore --into` refuses a command backup with `this is a command backup; restore it with --exec`, and `--exec` refuses a volume backup with `this is a volume backup; restore it with --into`.
- The target is checked before the lock is taken, as a job's is: the app is deployed, `--service` is for a Compose app and `--role` for an image app, and a Compose app has a running container of the service. The command runs as a job does, in that container or in a new container of the applied release, with its input attached, and under the `--timeout`, `1h` by default.
- **The checksum comes first.** The agent reads the object from storage to its end, hashing it, and compares its size and SHA-256 with the sidecar's. A mismatch fails the operation with `backup checksum mismatch` before the command starts, so the command never sees bytes that are not what was stored. Only then does it read the object a second time and stream it, decompressed, into the command, and the second read is compared too. This costs a second read of the object and is chosen over loading data that may be damaged. Nothing is staged on the disk of the server.
- A command that exits non-zero, runs out of time or cannot run fails the operation with `restore command failed`, with a reason that says how the command ended and its last line of output, and one `step` event for each of its last 20 lines, with secret values replaced. If the agent stops during the restore, the operation ends `interrupted` with `restore interrupted; the command may have loaded part of the backup`, since what the command did with the part it received cannot be told.
- `--dry-run` shows the backup, where the command would run and the command, and starts nothing.

`restore --exec` is not an MCP command: `execute_resource_command` restores into a volume only.

### Example: PostgreSQL dump

The dump command is the backup. The example uses the `postgres` app of the base manifest, a Compose app whose `postgres` service has `POSTGRES_USER` and `POSTGRES_DB` in its environment, and the `offsite` destination above. Nothing else is needed: no dump volume, no job, no file on the server.

```yaml
backups:
  main-db:
    app: postgres
    service: postgres
    command:
      - sh
      - -c
      - pg_dump -Fc --no-acl --no-owner -U "$POSTGRES_USER" "$POSTGRES_DB"
    schedule: "0 0 * * *"
    destination: offsite
    prefix: postgres/myapp
    retention:
      keep: 14
```

The agent runs `pg_dump` in the running `postgres` container and sends its output to storage as it is written. If `pg_dump` fails halfway, nothing is kept and the backup's check goes critical with its error. The `backup: main-db` deploy hook takes a fresh dump before migrations in the same way. To recover, load the backup into a scratch database of the running container, and look at it:

```console
$ berthy restore postgres/myapp/main-db/20261116T000000Z-7.gz -e prod --exec postgres --service postgres \
    -- pg_restore -U todo -d todo_check --no-owner
```

A volume that holds a consistent export still works for what a dump command cannot reach: a `before` job writes the export to a dedicated volume, and a volume backup uploads it.

### Credentials

- The storage credential is scoped to the backup bucket only and lives in the agent's secret store.
- Consider a retention lock on the bucket, so a compromised server cannot delete backup history.

### Agent state

The agent's SQLite file holds its operations, releases, audit log, checks and secrets. The agent uploads a copy of it to object storage daily. That upload is a SQLite snapshot that contains sealed secret values, with a separate metadata sidecar. Secret values stay sealed, and the key file is not uploaded, but SQLite metadata such as operation actors and secret names can still be read without the key. Remote `berthy setup` (`cli_key`) reads the configured key under the existing reader rules and saves a copy on the operator's machine; keep another in a password manager or the provisioning tool's vault. Rebuild a server from its provisioning, `berthy setup --key-file <saved key>`, the agent state and the volume backups.

**Encryption key.** Every sealed value says how and with which key it was sealed: one version byte (`1`: AES-256-GCM), an 8-byte key ID, the 12-byte nonce, then the ciphertext and tag. The key ID is the first 8 bytes of SHA-256 over `berthy-state-key-id`, a zero byte and the key, shown as 16 hex characters, so no key material is stored. The version and the key ID are part of what the tag covers, so a header cannot be swapped. A value whose key ID the agent does not hold fails with `sealed with a key this agent does not have (key <ID>)`; a value of another version fails as an unknown format. Nothing is in production, so there is no reader for the format before this one: a state sealed the old way does not open. Sealed values are the secrets, the held requests, the journaled steps (before, desired and receipt), the diagnostics and the key check.

`berthy key rotate -e ENV [--dry-run]` (`admin` scope, never an agent token, which is refused with `403` and `an agent token cannot rotate the state key` before approval is considered, on every environment) replaces the key:

1. It refuses with `409` while an operation runs or the deploy lock is held, and with `--dry-run` stops there after counting the sealed values.
2. It writes a new random key beside the key file as `<key>.next` (mode 0600, synced).
3. In one transaction it seals every sealed value again with the new key, each under its own record, seals the key check, and records `key_rotate` in the audit log with the token that asked. Nothing else seals or opens a value while this runs.
4. It copies the old key to `<key>.prev`, renames `<key>.next` to `<key>` and swaps its keys in memory. The agent opens a value with the key its header names, so the previous key opens anything still sealed with it.

The key check says which key the state is sealed with, so a crash leaves a state that `Open` settles. When the check names the key file, a `<key>.next` is the leftover of a rotation that did not commit and is removed. When it names `<key>.next`, the rotation committed and the agent finishes the renames. The key file exists at every step.

The previous key is deleted after a state snapshot made with the current key succeeds. The agent answers with the IDs of the old and the new key, how many values it sealed again and where the key file is, never a key. The CLI prints the command that copies the new key off the server. The next `berthy setup` run saves the new key on the operator's machine and keeps the copy of the old one. The doctor shows a `state_key` check while a previous key is kept. `setup --key-file` never replaces a key on the server: a rotation happens only through the agent. The agent's user owns `/var/lib/berthy`, where the key and its two companions live.

**Configuration.** The environment's settings may have one `state_backup` block, which a deploy or `berthy apply` writes. It belongs to the environment, so it stays in force whatever apps are deployed:

```yaml
state_backup:
  destination: offsite        # a key of destinations, as for volume backups
  prefix: berthy-state        # optional; under <project>/<environment>/; the default is berthy-state
  schedule: "17 3 * * *"      # optional; cron in the manifest's timezone; the default is daily at 03:17
  keep: 14                    # optional; from 1 to 1000; the default is 14
```

The destination must exist, the schedule must parse, `keep` must be from 1 to 1000, and each segment of the prefix may hold only letters, digits and `._@+=-`, with no `.` or `..` segment. Removing the block stops the snapshots and removes the check.

**What storage holds.** A snapshot is a consistent copy taken with SQLite's `VACUUM INTO` while the agent keeps running. The agent writes it to a private temporary directory, uploads it and removes the directory. Each snapshot is an object `<project>/<environment>/<prefix>/<UTC time>.db`, as in `todo/prod/berthy-state/20261116T031700Z.db`, with a sidecar `<same name>.json`: `{"format":"berthy-state-sqlite-2","project","environment","schema_version","key_id","size","sha256","created"}`, where `key_id` names the key that opens the snapshot. The sidecar is written only after the snapshot was uploaded, so a snapshot that has one is complete. A failed snapshot, upload or sidecar is recorded as `failed` with a detail that starts with its step, and a failed upload leaves no sidecar.

**When it runs.** The schedule runs a snapshot once per occurrence, read in the manifest's `timezone`. Each occurrence is recorded in the agent's state, so a restart never takes it twice. Occurrences that pass while the agent is down are not made up. An occurrence that finds a snapshot still running is skipped and logged, and raises no alert. A scheduled run is audited as the actor `state-backup`.

**Retention.** After a successful run the agent deletes all but the `keep` newest snapshots that have a valid sidecar for this environment, the snapshot first and then its sidecar. Other objects under the prefix are never touched.

**Check.** While the block exists, a `state_backup` check runs every 60 seconds and alerts on its first non-ok result. It is critical when the newest run failed, with its detail, such as `upload failed: access denied`. It is also critical when the occurrence after the last success, plus two hours, has passed: `overdue: last snapshot <time> (expected by <time>)`. Before any success it is unknown, and it becomes critical once the first occurrence after the agent first saw the block, plus two hours, has passed. Otherwise it is ok: `last snapshot <age> ago, <size>`. The check appears in `berthy checks`.

**On demand.** `berthy state-backup -e ENV [--config CONFIG]` takes an `admin` token. It starts a snapshot, waits for it to finish, prints its key, size and checksum, and exits 0 only when it succeeded. The audit log records the token that asked. A request made while another snapshot runs is refused with `409`.

**Restore.** The procedure needs neither the agent nor its server:

1. On the new server, install the Berthy binary (any build; setup replaces it later) and save the key to a file that only root can read (mode 0600). Do not run setup yet: it would start an agent with an empty state.
2. Set the storage credentials in the environment: `BERTHY_S3_ACCESS_KEY` and `BERTHY_S3_SECRET_KEY`. Flags never carry them.
3. Run `berthy state-restore --project todo --endpoint <URL> --bucket <NAME> [--region <R>] --object todo/prod/berthy-state/<time>.db --out /var/lib/berthy/environments/todo/prod/state --key-file ./berthy.todo.prod.91c0aa11bb22cc33.key`. It downloads the snapshot and its sidecar, checks the size and SHA-256 against the sidecar, and opens the result with the key. It prints the environment, the schema version and the names of the stored secrets, never their values. It reads the sidecar first and compares the ID of the key file with its `key_id`: another key exits non-zero before the download, with `the snapshot needs key <ID>; <file> is key <ID>`, and leaves nothing behind. After a key rotation, a snapshot from before it needs the old key. The output directory is created with mode 0700 when it is missing, and must otherwise be empty.
4. From your own machine, run `berthy setup -e prod --project todo --host <user>@<server> --listen <address>:<port> --key-file ~/.berthy/keys/berthy.todo.prod.91c0aa11bb22cc33.key`, with the key from where you keep it. Setup makes the managed parent directories traversable by the `berthy` user, keeps the restored state in `/var/lib/berthy/environments/todo/prod/state`, and gives it to that user, installs the saved key, writes the configuration and starts the agent, which opens the state. Secrets, deploy history, the audit log and the tokens made through the API are back, so a CI token or an AI agent's token still works. Only the first `admin` token lives in the agent's configuration, so setup prints a new one. Volumes come back separately from the volume backups with `berthy restore`.
5. A key that does not open the state shows up as the agent failing to start: setup fails at `service` with the agent's log lines, and the agent is left stopped.

### Limits

- Recovery starts from the latest successful backup or from the export it contains. Missed or failed runs increase the amount of data that may be lost.
- A snapshot whose upload a crash cut short before its sidecar was written is never listed and never removed. Delete such an object by hand after checking the bucket.
- Keep-all means storage grows without bound. A lifecycle rule on the bucket can cap it later.
- A scheduled restore drill into a throwaway container is planned after v1.

## Security and guardrails

The agent controls Docker, which is equivalent to root on the server, so its API is reachable only over the private network and every call carries a scoped token.

### Network

- The agent listens on one configured address and refuses to listen on all interfaces.
- The API is plain HTTP in v1 and relies on the private network for encryption, as a WireGuard-based VPN provides.
- Compose apps that publish a port bind it to a private address, never to a public one.

### Tokens

Each token belongs to one environment and one scope.

| Scope | Allows |
| --- | --- |
| `read` | `ps`, `describe`, `logs`, `stats`, `df`, `history`, `wait`, `doctor`, `audit`, `backup list`, `ingress status`, `checks`, `jobs` |
| `deploy` | Everything in `read`, plus `diagnostics`, `job logs`, `deploy`, `rollback`, `restart`, `scale`, `backup run`, `ingress apply`, `lock acquire`, `lock release`, `job run`, `cancel`, `job cancel` and `alerts test` |
| `admin` | Everything in `deploy`, plus secrets, `exec`, `run`, `prune`, `restore`, `key rotate` (not for an agent token), `approve`, `recovery resolve`, `remove`, `destroy`, recreating stateful apps, taking over existing routes and DNS records, and token management |

- CI holds a `deploy` token for each environment it deploys to.
- AI agents get `read` tokens by default.
- A token can be marked as an **agent token** (`"agent": true` in the agent's configuration, `--agent` when it is made). The mark does not change the scope: an agent token with the `read` scope reads, and one with `deploy` or `admin` can ask for the changes of that scope. What changes is that on a protected environment its changes are held for a person (see below). An agent token can never approve or reject, whatever its scope.
- `approvals` needs the `read` scope, which lists each request without its plan; the plan, which can repeat a command line, is shown only to a token with the `deploy` scope or higher. `approve` and `reject` need the `admin` scope and a token that is not an agent token.
- `berthy setup` creates the first `admin` token. The agent stores only its digest. Setup saves the value on this machine, or shows it if the save is unconfirmed or unavailable; `--show-token` also shows it.
- **Two sources.** A token is defined in the `tokens` list of a hosted environment's entry in `agent.json`, or in that environment's state. The list holds the tokens that `berthy setup` writes (the first admin token and the ones `--new-token` adds) and tokens made by hand with `berthy agent token`; they never expire and cannot be revoked through the API. Every token made through the API is in the state. The agent builds one set from both for that hosted environment, and authentication, authorization, the approvals and the revoke guard all use it. Every hosted environment has state and a key; the list is still the home of the tokens setup writes. Token names are unique across both sources, with the same rule as `berthy agent token --name`: letters, digits, dots, dashes and underscores, at most 63 characters, starting with a letter or a digit.
- **State.** `tokens` holds the name, digest, scope, agent mark, creation time and optional expiry of each API token; `token_use` holds the time each token (of either source) was last used, by digest. The value is generated by the agent (`bty.<project>.<environment>.<64 hex>`), returned once in the answer to the create and never stored or logged. A state snapshot holds both tables, so a server rebuilt with `state-restore` keeps its tokens.
- **The API.** `GET /v1/projects/<project>/environments/<env>/tokens` lists `[{name, scope, agent, origin, created, expires, last_used}]`; the digest is never shown, and `created` is absent for a token of the file. `POST .../tokens` with `{name, scope, agent, expires, dry_run}` makes a token and answers `{name, scope, agent, expires, token}`; `expires` is an RFC 3339 time in the future, and the CLI turns `90d`, `36h` or a date into one (a date is the start of that day in UTC). `DELETE .../tokens/<name>` with an optional `{dry_run}` revokes one. A dry run answers the plan and changes nothing. `list` needs `admin`; `create` and `revoke` need `admin` and a token that is not an agent token.
- **An agent token never manages tokens.** `create` and `revoke` by an agent token are refused with `403 an agent token cannot manage tokens`, before any approval is considered: the request is never held, on an unprotected environment either, so an AI agent cannot mint access. An agent token with `admin` scope may list.
- **Revoke.** A token of `agent.json` answers `409 token <name> is defined in /etc/berthy/agent.json; remove it there`. A name that is not a token answers `404`. Revoking the last admin token is refused with `409`: the admin tokens that count are those that are not agent tokens and have not expired, in either source, and the check runs in the same transaction as the delete. `berthy setup --new-token` stays the way back when every admin token is lost.
- **Effect.** A created token works at its next request, and a revoked one is refused with `401` at its next request, with no restart. A token that has expired is refused with `401` at its next request. An approval held by a token that has since been revoked or has expired can no longer be approved: approving it marks it `failed`. If the state cannot be read, a token of `agent.json` still works and any other token is answered `503`.
- **Last used.** The agent records the time a token was used, at most once a minute for each token (it remembers in memory when it last wrote). A token that was never used has no time.
- **Audit.** `token_create:<name>` and `token_revoke:<name>`, recorded in the same transaction as the change, with the name of the token that asked. No token value is ever in the audit log.
- **Expiry.** Optional. A check `token:<name>` of each token that expires warns 14 days before the expiry, `token <name> expires in <age> (<date>): create a new one with berthy token create`, and still warns after the expiry until the token is revoked.
- The CLI configuration stores each agent's address and token variable name, never the token itself. The variable wins; when empty, CLI commands look for a token saved for the same agent, project, environment and variable in the OS credential store. `BERTHY_TOKEN_STORE=none` disables that lookup. MCP reads only the variable.

### Setup access

`berthy setup` is the only command that needs a shell on the server, so it is held to the server's own access controls instead of Berthy's tokens.

- It uses the operator's own SSH client and configuration. Keys, SSH agents, jump hosts and host key checks behave as they do for `ssh`.
- Berthy never stores an SSH key, a password or a `sudo` credential.
- It needs root or `sudo` on the server. No Berthy token can run it, and it is not available through the API or MCP.
- The agent's audit log does not record it, because it runs outside the agent. The server's SSH and `sudo` logs do.
- The Docker install script and a downloaded Berthy release are fetched over HTTPS from their publishers (a mirror named by `BERTHY_RELEASE_URL` may use plain HTTP on a loopback or private address only). The release is checked against its published checksum before it is installed.

### Approval for AI agents on protected environments

An environment is protected when the agent's configuration says `"protected": true` or when a protected deploy has marked it.

1. An AI agent's token is marked as an agent token when it is made: `berthy token create claude -e <env> --agent --scope deploy` makes it through the agent, and `berthy agent token --project <project> -e <env> --agent --name claude --scope deploy` prints the token and the object `{"name":"claude","digest":"...","scope":"deploy","agent":true}` for the agent's `tokens` list. An agent token cannot make or revoke tokens (see Tokens).
2. On a protected environment an agent token's request that changes something is **held**: the agent checks the token and its scope as always, then stores the request instead of carrying it out and answers `202` with `{"approval_id", "expires", "plan"}` and the header `Berthy-Approval: pending`. Nothing else changes: no operation starts, and the deploy lock is not taken. Every route that changes something is held: deploy, rollback, restart, scale, exec, run, prune, remove, destroy, restore, ingress apply, secret set, secret generate, declared secret generate, secret import and delete, lock acquire and release, backup run, job run, job cancel, cancel, state backup, recovery resolve and alerts test. `key rotate` is the exception: an agent token is refused for it at once, whatever its scope and on every environment, and it is never held.
3. What is not held: reads; a dry run, which an agent token gets as any token does, because it changes nothing; and every request of an agent token on an unprotected environment, which is served like a request of any token with its scope. A request that cannot be planned, such as one that needs a right the token lacks, is refused at once as it would be for any token and is not held.
4. The **plan** of a held request is the object that `--dry-run` of the same request prints. The agent produces it by running the route's own dry-run path on the stored request, so the CLI, the TUI and the MCP server show one plan. A route without a dry run (`backup run`, `job run`, `job cancel`, `state backup`, `alerts test`) has a description instead: `{"action":"backup run","target":"main-db"}`. An `exec` plan names the command and where it runs: the Swarm service of the role, or the Compose project and service. A `run` plan names the command, the image digest of the applied release and the role. A secret set or delete plan names the secret, the registry and whether it exists (`{"action":"secret set","name":"DATABASE_URL","registry":"","exists":true}`), a secret generate plan names the secret, whether it exists, and its length and format (`{"action":"secret generate","name":"POSTGRES_PASSWORD","exists":false,"bytes":32,"format":"hex"}`), a declared generate plan lists the outcomes for each secret, and a lock plan says whether the environment is locked now; a secret's value is never in a plan. Every managed secret value is replaced by `[redacted]` in a plan before it is stored, compared or shown, so a value typed into an exec command does not reach the state database in the clear.
5. The held request is stored in the state database with its plan and a one-line summary such as `deploy api 1.4.2`, `restart api/web` or `secret set DATABASE_URL`. The request itself can carry a secret value, so it is stored sealed with the state key, like a secret; listings show the summary and the plan, never the request.
6. A person lists what waits with `berthy approvals`, reviews the plan, and runs `berthy approve <id>`, or rejects it with `berthy reject <id> -m "reason"`; the TUI does the same later. `approve` and `reject` need an `admin` token that is not an agent token.
7. `approve` plans the stored request again with the same function. When that plan is not exactly the stored plan, for example because a release was recorded since the request, nothing runs: the approval is marked `failed` and the person is told to ask for a new request. Otherwise the stored request runs through the ordinary route as the requesting agent: the operation, the lock and the audit rows name the agent token, with ` (approved by <approver>)` after its name. The result, the operation ID or a short outcome, is recorded with the approval. If the agent's token was removed from the configuration or lost its scope since the request, nothing runs and the approval is marked `failed`.
8. A request that nobody approves **expires** after 15 minutes. An expired request cannot run: `approve` refuses it with `approval expired` and marks it `expired`. The lifetime is the agent's `approval_ttl` setting, a Go duration of at least one minute, 15 minutes when it is not set. An approval is decided once; approving or rejecting a decided one is refused.
9. An approval has one of the statuses `pending`, `approved` (it ran, or is running), `rejected`, `expired` and `failed`. The newest 500 decided approvals of an environment are kept, and the oldest are deleted. At most 100 requests wait at once; the next is refused with `429`.
10. The audit log records `approval_request:<summary>` by the agent when it is held, and `approval_approve`, `approval_reject`, `approval_expired` or `approval_failed` by the person who decided; an expiry that nobody caused is recorded by `berthy`. Expiry is recorded when the approval is next listed or decided.
11. The CLI exit code of a held command is **3**: not done, not failed. The command prints `held for approval: <id> (expires <time>)` and the plan, and with `--json` prints the answer as JSON. The plan of a held deploy or rollback has the release diff, which `berthy approvals`, `berthy approve`, the TUI and the MCP server show as lines (see "Release diff").

Interactive sessions are the exception to what an agent token's change does on a protected environment: they are refused, not held (see "Interactive sessions").

The approvals API: `GET /v1/projects/<project>/environments/<env>/approvals[?status=pending]` (`read`), which lists the approvals newest first with id, actor, kind, summary, plan (`deploy` scope or higher only), created, expires, status, decided_by, decided_at and result; `POST .../approvals/<id>/approve` and `POST .../approvals/<id>/reject` with an optional `{"reason"}` (`admin`, not an agent token).

### Other guardrails

- **Explicit environment.** No command that changes something runs without `-e`.
- **Dry run everywhere.** The plan a person approves is the same plan `--dry-run` prints, and `approve` checks that it still is before it runs the request.
- **Deploy lock.** A manual lock freezes an environment for everyone, people and AI agents alike.
- **Stateful protection.** Recreating or removing a `stateful` Compose app needs `--allow-recreate` and an `admin` token. `berthy remove` of a `stateful` Compose app needs the same.
- **Interactive sessions are not held.** An agent token is refused `exec -i` and `run -i` on a protected environment (see "Interactive sessions"), because a session cannot wait for approval and nothing may queue one. The audit log records a session's start and end, never its input or output.
- **Audit log.** Every change is recorded with time, command, target and outcome. API requests include the token name and caller's address. Scheduled runs identify the job as the caller.

### Secrets

- Encrypted at rest with a key file readable only by the agent's system user.
- Write-only through the API: values can be set and removed, and names can be listed, but values are never returned.
- Hidden in `config show`, deploy records and agent logs.

## CI integration

In v1, CI pushes deploys to the agent; the agent does not read the repository. Any CI system that can run the CLI and reach the agent works.

### The deploy step

- A deploy is one command: `berthy deploy api -e dev --version <tag>`. On a protected environment `--version` is the image's digest, `sha256:…`, since a tag is refused.
- The CLI reads the manifest and Compose files from the checkout and sends them with the commit SHA: `HEAD` unless `--commit` gives one (a `--commit` that differs from `HEAD` is kept, with a warning). Inside a git work tree the CLI asks git whether each file it reads (`berthy.yml`, the overlay of the environment and the app's Compose file) is modified, staged, deleted or untracked. If one is, the request carries `modified`, the CLI warns with the file names, and the release and `history` record it. A protected environment refuses such a request with `the manifest has local changes: commit them first`. Ignored files do not count, and outside a git work tree nothing is checked.
- The command waits for the result and exits non-zero if the deploy fails or rolls back. Later steps, such as tagging a release, then run only after a deploy that succeeded.

### What stays in CI

- Building and pushing the image.
- Release policy: who may deploy where, manual triggers, and any checks on the image before a production deploy.

### Credentials

- The agent holds one read-only credential for pulling images from the container registry, declared under `registries` in the manifest.
- The agent holds no repository credentials in v1.
- CI holds a Berthy `deploy` token per environment as a CI secret.
- The token for a protected environment is stored where only that environment's deploy job can read it.

### Reaching the agent

The agent is on a private network and a CI runner usually is not, so the deploy job joins the network for the length of the job.

- The runner joins as a short-lived, tagged node that is removed when the job ends. With Tailscale on GitHub Actions, the official [Tailscale GitHub Action](https://github.com/tailscale/github-action) does this with an OAuth client.
- Access rules let the CI node reach the agent's API port and nothing else on the network.
- Each environment uses its own network credential and tag.
- The Berthy token is still required. Reaching the agent grants nothing by itself.
- A runner that is already on the private network needs none of this.

### After v1

A Git provider integration, starting with a GitHub App, that lets the agent read the repository and deploy on push without a pipeline step. It is not needed while CI does the pushing.

## Optional multi-node mode

A three-server cluster is not a v1 deliverable, but nothing in v1 may block it. Because image apps are already Swarm services, going from one server to three changes configuration, not the deployment model.

### What it takes

- Join two more servers as managers. Three managers keep the cluster working with one server down. In v1, `berthy setup` only starts a single-server Swarm; joining servers is done by hand until the multi-node phase adds it to setup.
- Run an agent on each server, installed with `berthy setup`. Any manager accepts deploys; `ps` and `stats` query all agents and merge the answers.
- Raise the replica count of image apps and spread them across servers, with a cap per server.
- Run the ingress app on every server. With managed ingress, raise the connector's `replicas`.
- Keep Compose apps pinned to a named server with `node: <name>` in the manifest. This is part of the follow-on, not v1: the v1 manifest has no `node` key and refuses it as an unknown field. That server's agent runs their scheduled jobs and backs up their volumes.

### Known constraints

- **Cluster traffic over a VPN.** The overlay network's packet size must be lowered to fit inside the VPN's own, or packets are dropped silently. Tailscale's is 1280 bytes. Test this before relying on it.
- **The database stays a single point of failure.** More web replicas survive a lost server and give rolling deploys. They do not make Postgres highly available, which is a separate project.
- **Pinned Compose apps are durable, not highly available.** A supporting service on a lost server is redeployed on another one. It keeps its data only if that data lives off the server, for example in object storage.
- **One provider, one failure domain.** Three servers at the same provider can fail together.
- **Background jobs.** Check for in-process timers before running more than one replica, or use roles to keep a single worker.

## Build plan

Berthy is built one capability at a time, and each phase is proven on a non-production environment before the next one starts.

See the [v1 implementation plan](implementation-plan-v1.md) for dependencies and acceptance checks.

| Phase | Delivers | Done when |
| --- | --- | --- |
| 1. Read-only | Agent and CLI: `ps`, `describe`, `logs`, `stats`, `df`, `doctor`, JSON output, tokens | Numbers agree with `docker stats`; agent memory is measured |
| 2. Image deploys | Manifest validation, secrets, registry credentials, `deploy`, `rollback`, lock, command hooks, migrations, timing settings, retain and prune, history, audit, adoption of an existing service | An environment has deployed from CI for two weeks, including one forced failure that rolled back |
| 2b. Managed ingress | Cloudflare Tunnel: tunnel creation and adoption, connector, `hostnames`, routes, DNS records, `ingress apply`, `ingress status`. The unhealthy-tunnel alert follows with alerting in phase 3. | A new app was published on a new hostname by a manifest change and a deploy, with no visit to Cloudflare's dashboard |
| 3. Compose, checks, jobs, backups | Compose apps, probes, built-in conditions, alerts, peer check, scheduled commands, volume backups, backup hooks and restore | A cron job has run in its target container, a volume backup has been restored and verified, and a test failure raised an alert |
| 4. TUI and MCP | `berthy ui`, `berthy mcp`, agent tokens and approvals | An AI agent's request on a protected environment was held, reviewed and approved end to end |
| 5. Server setup | `berthy setup` over SSH and locally: Docker check and install, Swarm, shared network, agent install and upgrade, first token | A fresh server has been brought to a passing `doctor` by `berthy setup` alone, and a second run changed nothing |
| 6. Multi-node (optional) | Cluster helpers, placement settings, merged views | Not scheduled |

Until phase 5, the agent is installed by hand from the systemd unit in the repository.

## Adopting an existing deployment

Berthy can take over servers that another deployment tool already runs, one app at a time, without recreating what is running.

### How adoption works

- An existing Swarm service or Compose project is adopted by name.
- For a Compose project, set `project_name` to the name it already runs under. Under any other name Compose creates new, empty volumes beside the existing ones, and the app starts without its data.
- Berthy compares what is running with the manifest and prints the differences or a refusal before changing anything. A Compose volume that would be created shows in that plan.
- An image service is refused with `adoption would change volume <name>; align the manifest first` if an existing named volume differs from the scoped Docker name `<project>-<environment>_<volume>`. Stop writes, back up the old volume with the existing backup tool, restore it into a new volume under that scoped name, and verify the data before deploying. To adopt the service, switch it to the scoped volume and confirm it is healthy first; alternatively, stop the old service and deploy a new one without the `service` override.
- **An adopted service is settled once, at adoption.** The first deploy sends the release's spec, so it drops every setting of the live service that the manifest does not produce. The plan lists each one as a line of `changes`, such as `role web: user "1000" is not in the manifest; the first deploy drops it (set roles.web.user to keep it)`, and each setting the manifest produces differently, such as `role web: replicas 1 (now 3), applied by the next deploy`. A setting that must be kept needs a manifest key: `user` and `entrypoint` (the container's entrypoint; `command` stays its arguments) exist for this, and `placement` gets its key with multi-node support. An environment variable is listed by name only, never by value. The first deploy sets the Berthy labels and the `BERTHY_*` variables; they are not listed.
- **Unsafe services are refused at adoption.** A service with added capabilities, privileges, secrets or configs, custom DNS, hosts or sysctls, an isolation other than the default, a host mount, a published port, a network other than the shared one, or a mode other than replicated is not adopted. The plan stops with `unsafe or incompatible adoption service`.
- The existing shared network keeps its name; set it as `network` in the manifest.
- `berthy setup` is safe on a server that already runs apps. It leaves the existing Docker installation, Swarm and network as they are and only adds the agent.
- Adopt the least critical environment first.

### Rules during the transition

- **One writer per app.** Once Berthy adopts an app, the old tool's automatic deploy for that app is switched off.
- **Backups overlap.** The old backups keep running until a Berthy backup has been restored successfully.
- **The old tool stays installed but idle** until every environment has done a deploy, a backup and a restore test through Berthy. It is the way back.

### Checklist

- [ ] Run `berthy setup --dry-run` against the server and confirm it would change nothing but the agent.
- [ ] Read the existing Compose project names with `docker compose ls` and set each as `project_name`.
- [ ] Copy every environment variable from the old tool into the manifest or the secret store, for image apps and Compose apps.
- [ ] Declare a read-only registry credential if the images are private.
- [ ] Confirm the adopted service's settings with `docker service inspect` against the differences Berthy printed.
- [ ] If the server uses a Cloudflare Tunnel, set `tunnel` to its name, review `berthy ingress apply --dry-run`, and remove the hand-started connector once Berthy's is healthy.
- [ ] Create a storage credential scoped to the backup bucket.
- [ ] Store the agent's encryption key off the server.
- [ ] Set up CI access to the private network for each environment.
- [ ] Move migrations out of application startup and make the migration commands runnable from the image.
- [ ] Restore a Berthy backup to a new volume and verify the app can recover its data, then switch off the old backup schedules.
- [ ] Remove the old tool and update the server provisioning to run `berthy setup --local` in its place.

## Open questions

The questions below are resolved, most of them in Phase 1; the corresponding
later-phase features still need implementation and verification.

### Resolved

| Question | Decision |
| --- | --- |
| Schema revert on failed deploy | Never automatic; an explicit revert requires admin authorization. Migrations must remain compatible with the previous app version. |
| TLS on the agent | v1 uses HTTP over an encrypted private network; the listen-address check cannot establish that encryption is present. |
| Backup before protected deploy | An explicit policy or hook, not a universal requirement. A pre-migration backup is recommended where the data warrants it. |
| Service-name probes | Container health checks gate Swarm rollouts. Overlay-path alerts run in a helper built from the agent's own static binary, with no registry, one per environment on each server; see Where a probe runs. |
| Is the CI runner on the private network? | Not assumed. The deploy job joins as a short-lived, tagged node with restricted access. |
| Backup retention | Keep all by default. |
| Migration rollback | Generic `version`, `apply` and `revert` commands, with the schema state recorded on every deploy. |
| Migrations at startup? | No. They run as their own deploy step; see Database migrations. |
| Shared network name | Set in the manifest, so an adopted deployment keeps its existing network. |
| Metrics format | OpenTelemetry. |
| Long-term logs and metrics | Not stored by Berthy. Exported to a backend of the user's choice. |
| Alert channel | Telegram and an HTTP webhook. |
| Secret values | Kept in the agent's store for now. |
| Implementation language | Go. |
| How the agent gets onto a server | `berthy setup`, over SSH or on the server. It installs Docker when missing, turns on Swarm mode, creates the shared network and installs the agent. |
| Does setup deploy anything? | No. Images are built and pushed by CI, and the first deploy is a separate command after the secrets are set. |
| First token | Created by setup and saved locally, or shown when saving is unavailable or unconfirmed. |
| Automating the Cloudflare Tunnel | Through Cloudflare's API, from the agent. The `cloudflared` command line creates tunnels configured by a file on the server and needs a browser login, so it is not used. |
| Which tunnels Berthy can manage | Remotely managed ones only. Their routes can be read and written through the API. |
| Who owns a tunnel's routes | Berthy owns the hostnames in the manifest and keeps every other rule and record. |
| A command that writes starter manifests | None in v1. The example manifest in this spec is the starting point, and `config validate` checks it without a server. |

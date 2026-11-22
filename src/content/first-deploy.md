# The first deploy

Deploy in this order: **redis, postgres, then the API.** The API reads from both, and its migrations need the database to exist. The API's `depends_on` says the same, and [one command](#deploy-every-app-at-once) can deploy all three.

> [!NOTE]
> This page is excerpted from the Berthy user guide and shortened. It exists to show the docs layout, not to be followed.

## Look at the plan first

Every deploy starts the same way: look at the plan.

```bash title="Terminal" {1}
berthy deploy redis -e prod --config $CFG --dry-run
```

`--dry-run` prints the plan and acts on nothing. For a Compose app the plan lists the Compose project (`todo-prod-redis`), each service with its action (`create`, `keep`, `recreate` or `remove`) and each volume with `create` or `keep`.

Then run it for real:

```bash
berthy deploy redis    -e prod --config $CFG
berthy deploy postgres -e prod --config $CFG
```

A Compose app takes **no** `--version`: the version is whatever its Compose file says. The CLI follows the operation until it ends, prints the name of each event as it arrives, then the operation's record:

```text title="Output"
app: redis
commit:
id: <operation id>
kind: deploy
started: 2026-11-16T10:21:07Z
state: succeeded
```

Exit code `0` means `succeeded`. Anything else (`failed`, `rolled_back`, `recovery_required`, `interrupted`) exits `1`.

### What a Compose deploy does

1. Takes the environment's deploy lock and checks the manifest.
2. Works out which services would be recreated and which volumes created, and prints that plan.
3. **Stops if a `stateful` service would be recreated**, unless the command carries `--allow-recreate`.
4. Writes the Compose file and the `.env` file, then runs `docker compose up -d --remove-orphans`.
5. Waits for health checks, records the release and releases the lock.

> [!WARNING]
> A failed `up` is reported. There is no automatic rollback for Compose apps: the next deploy brings the project to its file again.

## The API: a digest, not a tag

The prod overlay says `protected: true`. A protected environment **refuses a tag**, even a unique one such as a git SHA, because a tag can be moved. You must give the image's **digest**:

```bash title="Terminal" {2}
berthy deploy api -e prod --config $CFG --dry-run \
  --version sha256:<64 hex characters>
```

Get the digest from your CI's build step, or look it up:

```bash
docker buildx imagetools inspect ghcr.io/acme/todo-api:1.4.2
```

Try a tag on prod and you see why:

```text
protected environment requires a digest
```

> [!TIP]
> In **dev**, which is not protected, `--version 1.4.2` (a tag) works. `--version` also accepts a full reference such as `ghcr.io/acme/todo-api:1.4.2` as long as the repository matches the app's `image`.

The dry run for an image app prints the plan as JSON when you add `--json`:

```json title="plan.json" {3}
{
  "app": "api",
  "image": "ghcr.io/acme/todo-api@sha256:<64 hex characters>",
  "roles": ["web"]
}
```

Notice that the plan shows the image **pinned by digest**. Now deploy it, with the commit that the manifest came from:

```bash
berthy deploy api -e prod --config $CFG \
  --version sha256:<64 hex characters> \
  --commit "$(git rev-parse HEAD)"
```

`--commit` is recorded with the release. It shows in `history`, and it is how you find which code a release was.

### Flags used in this step

| Flag               | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `--dry-run`        | Prints the plan and acts on nothing.                          |
| `--version`        | The image to deploy: a digest on a protected environment.     |
| `--commit`         | The commit the manifest came from, recorded with the release. |
| `--json`           | Prints the plan or result as JSON.                            |
| `--allow-recreate` | Lets a Compose deploy recreate a `stateful` service.          |

## Deploy every app at once

Once the project is set up, one command deploys every app of the manifest, in the order `depends_on` gives: an app after the apps it depends on, and among the apps that are ready, the first by name.

```bash
berthy deploy -e prod --config $CFG --version sha256:<64 hex characters> --dry-run
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

- **Everything is checked first.** Nothing is sent to the agent until every app's request is ready.
- **It stops at the first failure.** The command exits with that app's code and runs nothing more.
- **An image app given no version keeps the one it runs now.** This is how a change to the manifest alone reaches every app.

## What an image deploy does

A deploy either finishes healthy or leaves the previous version running. It never leaves an app half-updated.

1. **Lock.** Takes the deploy lock. If someone holds it, the deploy stops and says who and why.
2. **Check.** Validates the manifest, confirms every secret has a value, resolves the tag to a digest and pulls the image.
3. **Pre-deploy hooks.** Runs them in order. A failure stops the deploy with nothing changed.
4. **Migrations.** Runs `version`, then `apply`, then `version` again.
5. **Start new.** Starts the new version _beside_ the old one. It must pass its health check within `deploy_timeout`.
6. **Switch and drain.** Sends traffic to the new version. The old one gets `drain_timeout` to finish requests in flight.
7. **Publish.** With managed ingress, updates the app's routes and DNS records.
8. **Post-deploy hooks.** A failure is reported, but does not undo the deploy.
9. **Record and tidy.** Writes the release, removes old images beyond `retain`, releases the lock.

> [!DANGER]
> If step 5 fails, the agent **rolls back to the previous digest**, records the deploy as failed, and sends an alert. A failed _first_ deploy has nothing to roll back to, so the service it created is removed.

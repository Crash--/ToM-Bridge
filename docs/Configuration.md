# Configuration

The bridge is configured through two YAML files. The repository ships annotated
examples of both:

* [`config.example.yaml`](../config.example.yaml) - the bridge's own runtime
  configuration.
* [`registration.example.yaml`](../registration.example.yaml) - the Synapse
  Application Service registration.

## Registration File

The registration file declares the bridge as a [Synapse Application
Service](https://matrix.org/docs/guides/application-services). The key fields
are:

* `id` - unique service identifier (e.g. `common-settings-bridge`).
* `url` - callback URL; `null` because this is an AMQP-driven bridge, not
  HTTP.
* `as_token` / `hs_token` - secure tokens exchanged with Synapse
  (`openssl rand -hex 32`).
* `sender_localpart` - localpart of the bridge's sender user (e.g.
  `twp_bot`).
* `namespaces.users` - regex of the user IDs the bridge may act on (e.g.
  `@.*`).
* `rate_limited` - `false` to disable rate limiting for this internal
  service.

This file must be listed in Synapse's `app_service_config_files` for the
bridge to be loaded on the next startup.

## Config File

The config file tells the bridge how to reach the homeserver, its database and
the message broker. The reference blocks are:

* **`homeserverUrl` / `domain` / `registrationPath`** - where to find Synapse
  and the registration file from `registration.example.yaml`.
* **`synapse`** - retry behaviour for admin operations (e.g.
  `adminRetryMode: 'fallback'`) and optional avatar upload tuning.
* **`database`** - PostgreSQL connection details (`engine`, `host`, `name`,
  `user`, `password`, `ssl`, `vacuumDelay`).
* **`rabbitmq`** - AMQP connection (`host`, `port`, credentials) and the
  topology used to consume/publish settings updates (`queue`, `exchange`,
  `routingKey`). A dead-letter topology is provisioned automatically as
  `<exchange>.dlx` / `<queue>.dlq` / `<routingKey>.dead`.
* **`deletion`** (optional) - where user deletions arrive (`exchange`,
  `routingKey`, `queue`) and how the homeserver's SSO mapping named accounts
  (`localpartFrom`: `uid` for the message's `userId`, `email` for the local
  part of its `internalEmail`). The bridge deactivates and erases each deleted
  account, so it refuses to start unless its bot is a homeserver admin and
  `localpartFrom` is one of the two values. A message that names
  no account, or a Synapse failure, ends in the dead-letter queue after the
  retries.
* **`spaces`** (optional) - where space events arrive (`exchange`,
  `routingKey`, `queue`), where the bridge announces each space's Matrix space
  (`activityExchange`), how the homeserver's SSO mapping named accounts
  (`localpartFrom`: `uid` for the member's `username`, `email` for the local
  part of their `email`), and TwakeSpace's app service user
  (`twakeSpaceUserId`, `@twake-space:<domain>` by default). See
  [Spaces](Spaces.md).

## Passing the Files to the Service

When a developer runs the bridge through Devenv (either `devenv up` or
`_twp_bridge_run`), the generated config is passed automatically via the
`--config` flag, so no action is needed. To run the service manually against a
custom file:

```bash
bun dev -- --config /path/to/config.yaml
```

Devenv also exports the paths as environment variables for convenience:
`$TOM_CONFIG` (bridge config) and `$TOM_REGISTRATION` (Synapse registration).
Because the `registrationPath` inside the config file points at the Synapse
registration, keep the two in sync if you override either.

<!-- vim: set ft=markdown fenc=utf-8 spell spl=en tw=80 cc=80 et ts=2: -->

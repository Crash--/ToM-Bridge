# ToM Bridge Docker Image

## Building the Image

```bash
docker build -t tom-bridge .
```

The build uses a two stage process. The first stage installs the dependencies
and compiles the TypeScript source with `tsc`. The second stage, on
`node:24-trixie-slim`, holds only the compiled code and the production
dependencies, and runs as the unprivileged `node` user.

## Running the Container

```bash
docker run --rm \
  -v /path/to/config.yaml:/data/config.yaml:ro \
  -v /path/to/registration.yaml:/data/registration.yaml:ro \
  tom-bridge
```

The entrypoint runs `node dist/index.js -c /data/config.yaml`. The container
expects two YAML files mounted into `/data`:

* **config.yaml** (required) tells the bridge how to reach Synapse, PostgreSQL,
  and RabbitMQ.
* **registration.yaml** (optional) is the Synapse Application Service
  registration. It defaults to `/data/registration.yaml` via the
  `REGISTRATION_FILE` environment variable. If your config file already points
  to the registration file through `registrationPath`, you may omit the separate
  `-f` mount.

The image runs as the `node` user (uid 1000): the mounted `config.yaml` and
`registration.yaml` must be readable by it.

### Passing Additional CLI Flags

The bridge accepts all flags from `matrix-appservice-bridge`. You can append
them after the image name:

```bash
docker run --rm \
  -v /path/to/config.yaml:/data/config.yaml:ro \
  tom-bridge \
  -c /data/config.yaml \
  -f /data/registration.yaml \
  -p 8008
```

### Overriding the Registration File Path

If you mount the registration file to a non default location, set the
`REGISTRATION_FILE` environment variable:

```bash
docker run --rm \
  -v /path/to/config.yaml:/data/config.yaml:ro \
  -v /path/to/registration.yaml:/etc/tom-bridge/registration.yaml:ro \
  -e REGISTRATION_FILE=/etc/tom-bridge/registration.yaml \
  tom-bridge
```

## Configuration Reference

### config.yaml

The bridge configuration requires the following sections:

```yaml
homeserverUrl: 'http://synapse:8008'
domain: 'your.homeserver.com'
registrationPath: '/data/registration.yaml'

synapse:
  adminRetryMode: 'fallback'

database:
  host: 'postgres'
  name: 'tom_db'
  user: 'twake'
  password: 'twake_password'
  ssl: false

rabbitmq:
  host: 'rabbitmq'
  port: 5672
  username: 'guest'
  password: 'guest'
  vhost: '/'
  tls: false
  queue: 'chat.settings.updated.queue'
  exchange: 'settings.exchange'
  routingKey: 'user.settings.updated'
```

See `config.example.yaml` in the repository root for the full annotated
version.

### registration.yaml

The registration file declares the bridge as a Synapse Application Service.
Generate secure tokens with `openssl rand -hex 32` before use:

```yaml
id: common-settings-bridge
url: null
as_token: <GENERATE_SECURE_TOKEN_HERE>
hs_token: <GENERATE_SECURE_TOKEN_HERE>
sender_localpart: twp_bot
namespaces:
  users:
    - exclusive: false
      regex: '@.*'
  rooms: []
  aliases: []
rate_limited: false
```

See `registration.example.yaml` in the repository root for the full annotated
version.

## Networking Considerations

The bridge connects to three external services. When running in Docker, ensure
the container can reach them:

* **Synapse** at the URL specified in `homeserverUrl`
* **PostgreSQL** at the host and port specified in `database`
* **RabbitMQ** at the host and port specified in `rabbitmq`

Use Docker networking (`--network`, `--add-host`) or container orchestration
tools to make these services available to the bridge container.

## Environment Variables

* `REGISTRATION_FILE` (default `/data/registration.yaml`): path to the Synapse
  registration file inside the container.

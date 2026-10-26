# ToM-Bridge

**A Twake Workplace Matrix Appservice automating user management based on TWP
RabbitMQ messages**

The `tom-bridge` (Twake-on-Matrix Bridge) acts as a crucial middleware
component within the Twake Workplace ecosystem. It operates as a Matrix
Application Service, listening to TWP (Twake Workplace) message events (such as
user creation, profile updates, and deletions) and seamlessly replicating those
changes across the Matrix homeserver.

By leveraging an event-driven architecture, this bridge ensures that your
Matrix service remains perfectly synchronized with your central Twake Workplace
identity and user management systems, entirely eliminating the need for manual
user handling.

## Table of Contents

- [About the Project](#about-the-project)
- [Getting Started](#getting-started)
  - [Installation](#installation)
  - [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

## About the Project

Managing user lifecycles across different services can lead to fragmented
profiles and synchronization issues. `tom-bridge` solves this by acting as the
authoritative link between Twake Workplace and a Synapse server.

### Key Features

- **Automated User Provisioning**: Automatically creates Matrix accounts when
  new users are onboarded in Twake Workplace.
- **Real-time Profile Synchronization**: Keeps display names, avatars, and 3pid
  associations in sync using TWP message consumption (e.g., via RabbitMQ).
- **Application Service Architecture**: Privileged integration with the Matrix
  homeserver allows for silent, seamless administrative actions without
  requiring user passwords.
- **Lifecycle Management**: Handles account deactivation and data retention
  policies in Matrix when a user is removed from Twake Workplace. (***TBD***)

## Getting Started

This repository uses [Devenv](https://devenv.sh) to provide a unified,
standardized and full featured environments for developers.
We highly recommend you to get a look at it.
[https://devenv.sh](https://devenv.sh)

### Installation

Making sure everything is set up so a developer can contribute is handled
entirely by [Devenv](https://devenv.sh): once installed, it provisions the
toolchain (Node.js 24, PostgreSQL, RabbitMQ, Synapse, Caddy, mkcert) and wires
them together. There is no manual prerequisite to install.

```bash
# Clone the repository:
git clone https://github.com/linagora/tom-bridge.git

# Navigate to the project directory:
cd tom-bridge

# Enable the development environment (all tools are now on PATH):
devenv shell # or `devenv allow` for automatic shell setup on directory enter.

# Install dependencies:
npm ci
```

### Development

Inside the development shell, spin up the local stack:

```bash
# Trust the local mkcert root CA so Chrome and Firefox accept the TLS certs:
mkcert -install

# Start everything (Caddy, Synapse, RabbitMQ, Postgres and ToM Bridge).
# `sudo -v` caches sudo so mkcert can store its root CA:
sudo -v && devenv up
```

`devenv up` starts all required services, including the ToM Bridge itself
running as an auto-reloading (`npm run dev`, watch mode) process.

Once running, the local services are available at:

- **Caddy**: `https://twake.internal:8443`
- **Synapse**: `https://matrix.twake.internal:8443`
- **RabbitMQ**: `127.0.0.1:5672`
- **Postgres**: `127.0.0.1:5432`
- **ToM Bridge**: `npm run dev` (watch mode) under `devenv up`

## Documentation

Detailed information lives in the [`docs/`](./docs/README.md) folder:

- **Docker** - how to build and run the ToM Bridge as a Docker image.
- **Release** - branch naming and the release process.
- **Configuration** - the bridge and Synapse registration YAML files. See the
  annotated examples in the repository:
  [`config.example.yaml`](./config.example.yaml) and
  [`registration.example.yaml`](./registration.example.yaml).

## Contributing

Contributions are what make the open source community such an amazing place to
learn, inspire, and create. Any contributions you make are **greatly
appreciated**.

Please read our [Contributing Guidelines](./CONTRIBUTING.md) to learn about our
development process, how to propose bugfixes and improvements, and how to
submit Merge Requests.

### Contributors

Huge shout-out to all our participants!

- [@Montassar Ghanmy](https://github.com/MontaGhanmy)

#### Maintainers

- Pierre 'McFly' Marty <pmarty@linagora.com>

## Support

If you encounter any problems or have questions, please file an issue on our
[GitHub Issue Tracker](https://github.com/linagora/tom-bridge/issues).

## License

This project is licensed under the GNU Affero General Public License v3.0 or
later (AGPL-3.0-or-later) - see the [LICENSE](./LICENSE) file for details.

<!-- vim: set ft=markdown fenc=utf-8 spell spl=en tw=80 cc=80 et ts=2: -->

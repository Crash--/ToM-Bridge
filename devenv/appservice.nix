# devenv/appservice.nix
# Generates the ToM Bridge local configuration and Synapse App Service
# registration files inside the devenv state directory.
{
  pkgs,
  config,
  ...
}:

let
  tw = config.twake;
  pg = tw.pg.bridge;
  stateDir = "${config.env.DEVENV_STATE}/appservice";
  regPath = "${stateDir}/registration.yaml";
  cfgPath = "${stateDir}/config.yaml";
in
{
  files."${cfgPath}".yaml = {
    homeserverUrl = "http://127.0.0.1:${toString tw.synapse.port}";
    domain = tw.domain;
    registrationPath = regPath;

    synapse.adminRetryMode = "fallback";

    database = {
      host = "127.0.0.1";
      name = pg.db;
      user = pg.user;
      password = pg.password;
      ssl = false;
    };

    rabbitmq = {
      host = "127.0.0.1";
      port = tw.rabbitmq.port;
      username = "guest";
      password = "guest";
      vhost = "/";
      tls = false;
      queue = "chat.settings.updated.queue";
      exchange = "settings.exchange";
      routingKey = "user.settings.updated";
    };
  };

  # Registration is written with token placeholders first (devenv handles the
  # YAML serialization), then `twake:appservice:generate` swaps in secure,
  # persistent tokens before Synapse loads the file.
  files."${regPath}".yaml = {
    id = "common-settings-bridge";
    url = null;
    as_token = "__AS_TOKEN__";
    hs_token = "__HS_TOKEN__";
    sender_localpart = "twp_bot";
    namespaces.users = [
      {
        exclusive = false;
        regex = "@.*";
      }
    ];
    namespaces.rooms = [ ];
    namespaces.aliases = [ ];
    rate_limited = false;
  };

  tasks."twake:appservice:generate" = {
    description = "Inject secure, persistent tokens into the App Service registration";
    exec = ''
      stateDir="${stateDir}"
      mkdir -p "$stateDir"

      # Generate tokens once, persist them so they stay stable across shells
      asTokenFile="$stateDir/.as_token"
      hsTokenFile="$stateDir/.hs_token"
      if [ ! -f "$asTokenFile" ]; then
        ${pkgs.openssl}/bin/openssl rand -hex 32 > "$asTokenFile"
      fi
      if [ ! -f "$hsTokenFile" ]; then
        ${pkgs.openssl}/bin/openssl rand -hex 32 > "$hsTokenFile"
      fi
      asToken=$(${pkgs.coreutils}/bin/tr -d '\n' < "$asTokenFile")
      hsToken=$(${pkgs.coreutils}/bin/tr -d '\n' < "$hsTokenFile")

      sed -i "s/__AS_TOKEN__/$asToken/g" "${regPath}"
      sed -i "s/__HS_TOKEN__/$hsToken/g" "${regPath}"
    '';
    before = [ "devenv:processes:synapse@started" ];
  };

  # Create the appservice sender user (the bridge "bot") as a Synapse admin so
  # the bridge has full privileges (admin API provisioning, avatar uploads).
  #
  # `_twp_synapse_register_user` cannot be used here: Synapse reserves the appservice
  # sender user unconditionally (400 "This user ID is reserved by an application
  # service", or "User ID may not begin with _" for `_`-prefixed localparts).
  # Instead we create the user through the appservice register endpoint
  # (authenticated by the registration `as_token`, matching the appservice
  # identity), then flip the admin flag directly in the DB. Both are idempotent.
  tasks."twake:appservice:bot" = {
    description = "Create/promote the appservice bot user to admin";
    exec = ''
      stateDir="${stateDir}"
      synapseUrl="http://127.0.0.1:${toString tw.synapse.port}"

      # Wait until Synapse answers on its client API before registering
      for i in $(seq 1 60); do
        if ${pkgs.curl}/bin/curl -fs "''${synapseUrl}/_matrix/client/versions" >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done

      botLocalpart=$(${pkgs.gnused}/bin/sed -n 's/^sender_localpart: *\(.*\)$/\1/p' "${regPath}" | ${pkgs.coreutils}/bin/head -n1 | ${pkgs.coreutils}/bin/tr -d '\n')
      botToken=$(${pkgs.gnused}/bin/sed -n 's/^as_token: *\(.*\)$/\1/p' "${regPath}" | ${pkgs.coreutils}/bin/head -n1 | ${pkgs.coreutils}/bin/tr -d '\n')

      echo "[appservice] ensuring bot user @''${botLocalpart}:${tw.domain} exists..."
      ${pkgs.curl}/bin/curl -fsS \
        -X POST "''${synapseUrl}/_matrix/client/v3/register" \
        -H "Authorization: Bearer ''${botToken}" \
        -H "Content-Type: application/json" \
        -d "{ \"username\": \"''${botLocalpart}\", \"type\": \"m.login.application_service\" }" \
        -o /dev/null || true

      echo "[appservice] promoting @''${botLocalpart}:${tw.domain} to admin..."
      PGPASSWORD='${tw.pg.synapse.password}' ${pkgs.postgresql}/bin/psql \
        -h 127.0.0.1 \
        -U ${tw.pg.synapse.user} \
        -d ${tw.pg.synapse.db} \
        -tAc "UPDATE users SET admin=1 WHERE name='@''${botLocalpart}:${tw.domain}';"
    '';
    after = [ "devenv:processes:synapse@started" ];
    before = [ "devenv:processes:tom@started" ];
  };

  processes.tom = {
    exec = ''
      synapseUrl="http://127.0.0.1:${toString tw.synapse.port}"
      for i in $(seq 1 60); do
        if ${pkgs.curl}/bin/curl -fs "''${synapseUrl}/_matrix/client/versions" >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
      npm run dev -- --config "${cfgPath}"
    '';
    process-compose.depends_on.postgres.condition = "process_healthy";
    process-compose.depends_on.rabbitmq.condition = "process_healthy";
    process-compose.depends_on.synapse.condition = "process_started";
  };

  scripts._twp_bridge_run = {
    description = "Run the ToM Bridge in watch mode using the generated dev config";
    exec = ''
      npm run dev -- --config "$TOM_CONFIG"
    '';
  };

  scripts._twp_rabbitmq_update_common_settings = {
    description = "Send a RabbitMQ settings message to the bridge (interactive)";
    exec = ''
      npx tsx ./tools/send-message.ts
    '';
  };

  env.TOM_CONFIG = "${cfgPath}";
  env.TOM_REGISTRATION = "${regPath}";
  env.REGISTRATION_FILE = "${regPath}";
}

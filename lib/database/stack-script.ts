// Shell fragments that run an app's data stack on its on-premises server over SSH.
// They expect the variables set up by the deployment script: DOCKER_CONFIG (a private temp
// directory removed on exit), DATA_ENV_B64 and DATA_COMPOSE_B64 (read from stdin).
import { shellQuote } from "@/lib/shell";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafe(...names: string[]) {
  if (names.some((name) => !SAFE_NAME.test(name))) throw new Error("Unsafe data stack name.");
}

/** KEY=value lines as read by `docker run --env-file` and `docker compose --env-file`. */
export function encodeEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (!ENV_KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      if (/[\r\n]/.test(value)) throw new Error(`${key} cannot contain a line break.`);
      return `${key}=${value}\n`;
    })
    .join("");
}

// The compose file stays on the server (no secrets in it) so the stack can be inspected there.
// Passwords only ever exist in the temp env file. Volumes are never removed here.
export function dataStackScript(project: string, appId: string): string {
  assertSafe(project, appId);
  const name = shellQuote(project);
  return `
echo 'Preparing database containers...'
docker compose version >/dev/null 2>&1 || {
  echo 'Docker Compose is required for the database containers but is not installed on this server.' >&2
  echo 'Install it, then deploy again: sudo apt-get install -y docker-compose-v2 (or docker-compose-plugin)' >&2
  exit 22
}
DATA_DIR="$HOME/.sbsb/data/${appId}"
mkdir -p "$DATA_DIR" && chmod 700 "$DATA_DIR"
printf '%s' "$DATA_COMPOSE_B64" | base64 -d > "$DATA_DIR/compose.yaml"
DATA_ENV_FILE="$DOCKER_CONFIG/data.env"
printf '%s' "$DATA_ENV_B64" | base64 -d > "$DATA_ENV_FILE"
chmod 600 "$DATA_ENV_FILE"
# Logs shown on failure end up in the deployment history and the UI: drop any line with a secret.
DATA_SECRETS_FILE="$DOCKER_CONFIG/data.secrets"
cut -d= -f2- "$DATA_ENV_FILE" | grep -v '^$' > "$DATA_SECRETS_FILE" || true
if [ -n "$(docker compose -p ${name} ps -aq 2>/dev/null)" ]; then
  echo 'Database containers already exist: only changed settings are applied, data is kept.'
else
  echo 'Creating database containers (data is stored in named volumes)...'
fi
if ! docker compose -p ${name} -f "$DATA_DIR/compose.yaml" --env-file "$DATA_ENV_FILE" up -d --wait --wait-timeout 180; then
  echo 'The database containers did not become ready. The running app was left untouched.' >&2
  docker compose -p ${name} -f "$DATA_DIR/compose.yaml" --env-file "$DATA_ENV_FILE" logs --tail 30 2>&1     | grep -v 'GENERATED ROOT PASSWORD' | grep -vF -f "$DATA_SECRETS_FILE" >&2 || true
  exit 33
fi
echo 'Database containers are ready.'
`;
}

/** Deletes the data stack with its volumes. Only run when the user explicitly asks for it. */
export function removeDataStackScript(project: string, appId: string): string {
  assertSafe(project, appId);
  const name = shellQuote(project);
  return `set -Eeuo pipefail
docker compose version >/dev/null 2>&1 || {
  echo 'Docker Compose is not installed on this server, so the database containers and data were NOT removed.' >&2
  exit 22
}
DATA_DIR="$HOME/.sbsb/data/${appId}"
if [ -f "$DATA_DIR/compose.yaml" ]; then
  docker compose -p ${name} -f "$DATA_DIR/compose.yaml" down -v --remove-orphans
else
  docker compose -p ${name} down -v --remove-orphans
fi
rm -rf "$DATA_DIR"
echo 'Database containers and data were removed.'`;
}

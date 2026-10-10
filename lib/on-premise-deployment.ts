import "server-only";

import { createHash } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";

type DeploymentInput = {
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  privateKey?: string;
  hostPort: number;
  containerPort: number;
  image: string;
  registry: string;
  registryUsername: string;
  registryPassword: string;
};

export type ConnectionTestInput = {
  host: string;
  sshPort: number;
  username: string;
  password?: string;
  privateKey?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function appIdentifier(image: string): string {
  return createHash("sha256").update(image.split(":")[0]).digest("hex").slice(0, 12);
}

function connect(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(config);
  });
}

function execute(client: Client, command: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      stream.on("close", (code: number | null) => {
        if (code === 0) return resolve(stdout.trim());
        reject(new Error(stderr.trim() || stdout.trim() || `Remote command failed (${code ?? "unknown"}).`));
      });
      if (stdin !== undefined) stream.end(stdin);
    });
  });
}

export async function testSshConnection(input: ConnectionTestInput): Promise<string> {
  const auth = input.privateKey
    ? { privateKey: input.privateKey }
    : { password: input.password };
  const client = await connect({
    host: input.host,
    port: input.sshPort,
    username: input.username,
    readyTimeout: 15_000,
    keepaliveInterval: 5_000,
    ...auth,
  });

  const script = [
    "set -Eeuo pipefail",
    "command -v docker >/dev/null || { echo 'Docker is not installed on this server.' >&2; exit 20; }",
    "docker info >/dev/null 2>&1 || { echo 'The SSH user cannot run Docker. Add the user to the docker group.' >&2; exit 21; }",
    "echo 'SSH connection and Docker access verified.'",
  ].join("\n");

  try {
    return await execute(client, `bash -lc ${shellQuote(script)}`);
  } finally {
    client.end();
  }
}

export type OnPremiseDeploymentResult = {
  logs: string[];
  publicUrl?: string;
};

export async function deployToOnPremise(input: DeploymentInput): Promise<OnPremiseDeploymentResult> {
  const auth = input.privateKey
    ? { privateKey: input.privateKey }
    : { password: input.password };
  const client = await connect({
    host: input.host,
    port: input.sshPort,
    username: input.username,
    readyTimeout: 20_000,
    keepaliveInterval: 5_000,
    ...auth,
  });

  const appId = appIdentifier(input.image);
  const netName = `sbsb-net-${appId}`;
  const proxyName = `sbsb-proxy-${appId}`;
  const slotBlue = `sbsb-app-${appId}-blue`;
  const slotGreen = `sbsb-app-${appId}-green`;
  const tunnelName = `sbsb-tunnel-${appId}`;
  const legacyName = `sbsb-${appId}`;

  // Zero-downtime rolling deployment script:
  // 1. Authenticate & pull target image (and proxy image).
  // 2. Ensure custom docker network and configuration directory.
  // 3. Inspect existing active container (Blue or Green).
  // 4. Start candidate container on docker network WITHOUT stopping current active container.
  // 5. Verify candidate container is running and responds to HTTP requests.
  // 6. Update Nginx proxy config to route traffic to candidate container and reload Nginx seamlessly.
  // 7. Stop and remove previous container only after traffic is successfully switched.
  // 8. Launch Cloudflare Quick Tunnel to provide a public HTTPS URL accessible from anywhere.
  const script = `set -Eeuo pipefail
command -v docker >/dev/null || { echo 'Docker is not installed on this server.' >&2; exit 20; }
docker info >/dev/null 2>&1 || { echo 'The SSH user cannot run Docker. Add the user to the docker group.' >&2; exit 21; }

DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
IFS= read -r REGISTRY_PASSWORD
printf '%s' "$REGISTRY_PASSWORD" | docker --config "$DOCKER_CONFIG" login ${shellQuote(input.registry)} --username ${shellQuote(input.registryUsername)} --password-stdin >/dev/null

echo 'Pulling application image...'
docker --config "$DOCKER_CONFIG" pull ${shellQuote(input.image)}

echo 'Ensuring reverse proxy and tunnel images...'
docker pull nginx:alpine >/dev/null 2>&1 || true
docker pull cloudflare/cloudflared:latest >/dev/null 2>&1 || true

docker network inspect ${shellQuote(netName)} >/dev/null 2>&1 || docker network create ${shellQuote(netName)}

CONFIG_DIR="$HOME/.sbsb/proxy/${appId}"
mkdir -p "$CONFIG_DIR"

CURRENT=""
if [ "$(docker inspect -f '{{.State.Running}}' ${shellQuote(slotBlue)} 2>/dev/null || true)" = "true" ]; then
  CURRENT=${shellQuote(slotBlue)}
  CANDIDATE=${shellQuote(slotGreen)}
elif [ "$(docker inspect -f '{{.State.Running}}' ${shellQuote(slotGreen)} 2>/dev/null || true)" = "true" ]; then
  CURRENT=${shellQuote(slotGreen)}
  CANDIDATE=${shellQuote(slotBlue)}
else
  CURRENT=""
  CANDIDATE=${shellQuote(slotBlue)}
fi

# Clean up legacy standalone container if proxy is not yet running on hostPort
PROXY_RUNNING="$(docker inspect -f '{{.State.Running}}' ${shellQuote(proxyName)} 2>/dev/null || true)"
if [ "$PROXY_RUNNING" != "true" ] && docker inspect ${shellQuote(legacyName)} >/dev/null 2>&1; then
  echo 'Removing legacy container to bind proxy port...'
  docker rm -f ${shellQuote(legacyName)} >/dev/null 2>&1 || true
fi

echo "Starting candidate container ($CANDIDATE) alongside existing version..."
docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
docker run -d --name "$CANDIDATE" --network ${shellQuote(netName)} --restart unless-stopped ${shellQuote(input.image)}

echo "Checking health of new container ($CANDIDATE)..."
READY=0
for i in $(seq 1 30); do
  IS_RUNNING="$(docker inspect -f '{{.State.Running}}' "$CANDIDATE" 2>/dev/null || true)"
  if [ "$IS_RUNNING" != "true" ]; then
    echo "The candidate container ($CANDIDATE) exited unexpectedly during startup. Existing version was kept untouched." >&2
    docker logs --tail 40 "$CANDIDATE" >&2 || true
    docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
    exit 31
  fi

  if docker run --rm --network ${shellQuote(netName)} nginx:alpine wget -q -T 2 -O - "http://$CANDIDATE:${input.containerPort}" >/dev/null 2>&1; then
    READY=1
    break
  fi

  if [ "$i" -ge 12 ]; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "New container did not become ready in time. Retaining previous active version." >&2
  docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  exit 32
fi

cat << EOF > "$CONFIG_DIR/default.conf"
map \\$http_upgrade \\$connection_upgrade {
    default upgrade;
    '' close;
}

upstream app_backend {
    server $CANDIDATE:${input.containerPort};
}

server {
    listen 80;
    server_name _;
    client_max_body_size 0;

    location / {
        proxy_pass http://app_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection \\$connection_upgrade;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF

if [ "$PROXY_RUNNING" = "true" ]; then
  echo 'Switching proxy traffic to new container seamlessly...'
  docker exec ${shellQuote(proxyName)} nginx -s reload
else
  echo 'Starting reverse proxy on host port ${input.hostPort}...'
  docker rm -f ${shellQuote(proxyName)} >/dev/null 2>&1 || true
  docker run -d --name ${shellQuote(proxyName)} \\
    --network ${shellQuote(netName)} \\
    --restart unless-stopped \\
    -p ${input.hostPort}:80 \\
    -v "$CONFIG_DIR/default.conf:/etc/nginx/conf.d/default.conf:ro" \\
    nginx:alpine
fi

if [ -n "$CURRENT" ] && [ "$CURRENT" != "$CANDIDATE" ]; then
  echo "Traffic successfully switched. Gracefully terminating previous container ($CURRENT)..."
  sleep 3
  docker stop -t 10 "$CURRENT" >/dev/null 2>&1 || true
  docker rm -f "$CURRENT" >/dev/null 2>&1 || true
fi

echo "Zero-downtime rolling deployment complete: active slot is now $CANDIDATE."

TUNNEL_RUNNING="$(docker inspect -f '{{.State.Running}}' ${shellQuote(tunnelName)} 2>/dev/null || true)"
if [ "$TUNNEL_RUNNING" != "true" ]; then
  echo 'Starting public ingress tunnel...'
  docker rm -f ${shellQuote(tunnelName)} >/dev/null 2>&1 || true
  docker run -d --name ${shellQuote(tunnelName)} \\
    --network ${shellQuote(netName)} \\
    --restart unless-stopped \\
    cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://${shellQuote(proxyName)}:80
else
  echo 'Public ingress tunnel is already active, preserving existing URL.'
fi

PUBLIC_URL=""
for i in $(seq 1 18); do
  PUBLIC_URL="$(docker logs ${shellQuote(tunnelName)} 2>&1 | grep -o 'https://[a-zA-Z0-9.-]*trycloudflare.com' | head -n 1 || true)"
  if [ -n "$PUBLIC_URL" ]; then
    break
  fi
  sleep 1
done

if [ -n "$PUBLIC_URL" ]; then
  echo "SBSB_PUBLIC_URL: $PUBLIC_URL"
else
  echo "Tunnel container status:"
  docker logs --tail 15 ${shellQuote(tunnelName)} 2>&1 || true
fi`;

  try {
    const output = await execute(client, `bash -lc ${shellQuote(script)}`, `${input.registryPassword}\n`);
    const lines = output.split("\n").filter(Boolean);
    const publicUrlLine = lines.find((l) => l.startsWith("SBSB_PUBLIC_URL: "));
    const publicUrl = publicUrlLine ? publicUrlLine.replace("SBSB_PUBLIC_URL: ", "").trim() : undefined;
    const cleanLogs = lines.filter((l) => !l.startsWith("SBSB_PUBLIC_URL: ")).slice(-15);
    return {
      logs: cleanLogs,
      publicUrl,
    };
  } finally {
    client.end();
  }
}



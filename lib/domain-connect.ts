// Pure logic for connecting a custom domain to an app that SBSB deployed to a server over SSH:
// validation, the nginx site file, and the remote script. The SSH part lives in lib/ssh-exec.ts.

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const SITE_PREFIX = "sbsb-";

// DEPLOY_ALLOWED_DOMAIN_SUFFIXES="example.com,.example.org" limits which domains may be connected.
// Empty means any valid domain name (the DNS check still has to pass).
export function parseSuffixes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
}

export function validateDomain(input: string, allowedSuffixes: string[] = []): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || domain.length > 253) throw new Error("도메인이 비어 있거나 너무 깁니다.");
  if (/^\d+(\.\d+){3}$/.test(domain)) throw new Error("IP 주소가 아니라 도메인 이름을 입력하세요.");
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new Error("도메인에 사용할 수 없는 문자가 있습니다. 예: app.example.com");
  }
  if (allowedSuffixes.length > 0 && !allowedSuffixes.some((suffix) => domain.endsWith(suffix) && domain.length > suffix.length)) {
    throw new Error(`${allowedSuffixes.join(", ")} 의 하위 도메인만 연결할 수 있습니다.`);
  }
  return domain;
}

export function validateEmail(input: string | undefined): string | null {
  const email = (input ?? "").trim();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@'"\\;&|$`<>]+@[^\s@'"\\;&|$`<>]+\.[^\s@'"\\;&|$`<>]+$/.test(email)) {
    throw new Error("올바른 이메일 주소를 입력하세요.");
  }
  return email;
}

export function siteConfigPath(domain: string): string {
  return `/etc/nginx/conf.d/${SITE_PREFIX}${domain.replace(/\./g, "-")}.conf`;
}

export function nginxSiteConfig(domain: string, hostPort: number): string {
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    throw new Error("외부 포트는 1~65535 사이의 정수여야 합니다.");
  }
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${hostPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.]/g, "\\.");
}

// Installs nginx and certbot when they are missing (Debian/Ubuntu or RHEL family), writes one site file,
// verifies it with nginx -t (restoring the previous file on failure), reloads, then asks certbot for a certificate.
// Output lines "key=value" are parsed by the caller.
export function buildDomainScript(domain: string, hostPort: number, email: string | null): string {
  const conf = siteConfigPath(domain);
  const site = nginxSiteConfig(domain, hostPort);
  const certbotArgs = email ? `--agree-tos -m '${email}'` : "--agree-tos --register-unsafely-without-email";
  return `set -u
DOMAIN='${domain}'
CONF='${conf}'
DOMAIN_RE='${escapeRegex(domain)}'

sudo -n true 2>/dev/null || { echo "failed=sudo"; exit 20; }

if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
  echo "step=install"
  if command -v apt-get >/dev/null 2>&1; then
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -y >/tmp/sbsb_install.out 2>&1
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx >>/tmp/sbsb_install.out 2>&1 || { echo "failed=install"; tail -n 3 /tmp/sbsb_install.out | sed 's/^/install: /'; exit 21; }
  elif command -v dnf >/dev/null 2>&1; then
    sudo -n dnf install -y nginx certbot python3-certbot-nginx >/tmp/sbsb_install.out 2>&1 || { echo "failed=install"; tail -n 3 /tmp/sbsb_install.out | sed 's/^/install: /'; exit 21; }
  else
    echo "failed=no-nginx"; exit 21
  fi
  sudo -n systemctl enable --now nginx >/dev/null 2>&1 || true
fi

CLASH=$(sudo -n grep -lE "server_name[^;]*[[:space:]]$DOMAIN_RE[[:space:];]|server_name[[:space:]]+$DOMAIN_RE[[:space:];]" /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | grep -vx "$CONF" | head -n 1)
if [ -n "$CLASH" ]; then echo "failed=conflict"; echo "conflict=$CLASH"; exit 22; fi

PREVIOUS=""
if sudo -n test -e "$CONF"; then PREVIOUS=$(mktemp); sudo -n cp "$CONF" "$PREVIOUS"; fi

sudo -n tee "$CONF" >/dev/null <<'SBSB_SITE_EOF'
${site}SBSB_SITE_EOF

sudo -n nginx -t > /tmp/sbsb_nginx_t.out 2>&1
if ! grep -q "test is successful" /tmp/sbsb_nginx_t.out; then
  echo "failed=nginx-test"
  tail -n 3 /tmp/sbsb_nginx_t.out | sed 's/^/nginx: /'
  if [ -n "$PREVIOUS" ]; then sudo -n cp "$PREVIOUS" "$CONF"; else sudo -n rm -f "$CONF"; fi
  exit 23
fi
sudo -n systemctl reload nginx || { echo "failed=reload"; exit 24; }
echo "site=ok"

if sudo -n certbot --nginx -d "$DOMAIN" --non-interactive --redirect ${certbotArgs} > /tmp/sbsb_certbot.out 2>&1; then
  echo "cert=issued"
else
  echo "cert=failed"
  tail -n 4 /tmp/sbsb_certbot.out | sed 's/^/certbot: /'
fi
`;
}

export type DomainScriptOutcome = {
  ok: boolean;
  failed: string | null;
  detail: string;
  certificate: "issued" | "failed" | null;
  note: string | null;
};

const FAILURES: Record<string, string> = {
  sudo: "SSH 사용자가 비밀번호 없이 sudo를 사용할 수 없습니다",
  "no-nginx": "이 서버에서 nginx를 설치할 수 없습니다",
  install: "nginx 또는 certbot 설치에 실패했습니다",
  conflict: "이 도메인은 이미 다른 nginx 사이트가 사용 중입니다",
  "nginx-test": "생성한 nginx 설정을 nginx가 거부했습니다",
  reload: "nginx를 다시 불러오지 못했습니다",
};

export function parseDomainOutput(stdout: string, stderr: string, code: number): DomainScriptOutcome {
  const lines = (prefix: string) =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length).trim());
  if (code !== 0) {
    const failed = lines("failed=")[0] ?? "ssh";
    const detail = [...lines("conflict="), ...lines("nginx: "), ...lines("install: ")].join(" ") || stderr.trim().split("\n").slice(-2).join(" ");
    return { ok: false, failed, detail: `${FAILURES[failed] ?? "서버 명령이 실패했습니다"}.${detail ? ` ${detail}` : ""}`, certificate: null, note: null };
  }
  const issued = lines("cert=")[0] === "issued";
  return {
    ok: true,
    failed: null,
    detail: "",
    certificate: issued ? "issued" : "failed",
    note: issued ? null : lines("certbot: ").join(" ") || "인증서를 발급하지 못했습니다. HTTP로는 접속됩니다.",
  };
}

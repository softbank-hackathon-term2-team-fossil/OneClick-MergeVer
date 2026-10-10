import { describe, expect, it } from "vitest";
import {
  buildDomainScript,
  nginxSiteConfig,
  parseDomainOutput,
  parseSuffixes,
  siteConfigPath,
  validateDomain,
  validateEmail,
} from "../lib/domain-connect";

describe("validateDomain", () => {
  it("normalizes a valid domain", () => {
    expect(validateDomain(" App.Example.COM. ")).toBe("app.example.com");
  });

  it("rejects IP addresses, single labels and unsupported characters", () => {
    expect(() => validateDomain("203.0.113.5")).toThrow(/IP 주소/);
    expect(() => validateDomain("localhost")).toThrow(/사용할 수 없는 문자/);
    expect(() => validateDomain("bad_domain.example.com")).toThrow(/사용할 수 없는 문자/);
    expect(() => validateDomain("a.com; rm -rf /")).toThrow(/사용할 수 없는 문자/);
    expect(() => validateDomain("")).toThrow(/비어/);
  });

  it("limits domains to the allowed suffixes when configured", () => {
    const suffixes = parseSuffixes("example.com, .example.org");
    expect(suffixes).toEqual([".example.com", ".example.org"]);
    expect(validateDomain("app.example.com", suffixes)).toBe("app.example.com");
    expect(() => validateDomain("example.com", suffixes)).toThrow(/하위 도메인/);
    expect(() => validateDomain("app.other.net", suffixes)).toThrow(/하위 도메인/);
  });
});

describe("validateEmail", () => {
  it("accepts empty and valid values, rejects shell metacharacters", () => {
    expect(validateEmail(undefined)).toBeNull();
    expect(validateEmail("  ")).toBeNull();
    expect(validateEmail("me@example.com")).toBe("me@example.com");
    expect(() => validateEmail("a@b.com'; id #")).toThrow(/이메일/);
    expect(() => validateEmail("not-an-email")).toThrow(/이메일/);
  });
});

describe("nginx site and script", () => {
  it("proxies the domain to the app's host port", () => {
    const site = nginxSiteConfig("app.example.com", 8100);
    expect(site).toContain("server_name app.example.com;");
    expect(site).toContain("proxy_pass http://127.0.0.1:8100;");
    expect(() => nginxSiteConfig("app.example.com", 0)).toThrow(/외부 포트/);
  });

  it("builds a script that checks sudo, installs tools, tests nginx and requests a certificate", () => {
    const script = buildDomainScript("app.example.com", 8100, "me@example.com");
    expect(script).toContain(`CONF='${siteConfigPath("app.example.com")}'`);
    expect(script).toContain("sudo -n nginx -t");
    expect(script).toContain("apt-get install -y nginx certbot python3-certbot-nginx");
    expect(script).toContain("certbot --nginx -d \"$DOMAIN\" --non-interactive --redirect --agree-tos -m 'me@example.com'");
    expect(buildDomainScript("app.example.com", 8100, null)).toContain("--register-unsafely-without-email");
  });
});

describe("parseDomainOutput", () => {
  it("reports an issued certificate", () => {
    expect(parseDomainOutput("site=ok\ncert=issued", "", 0)).toMatchObject({ ok: true, certificate: "issued", note: null });
  });

  it("keeps HTTP working when the certificate fails", () => {
    const outcome = parseDomainOutput("site=ok\ncert=failed\ncertbot: rate limited", "", 0);
    expect(outcome).toMatchObject({ ok: true, certificate: "failed" });
    expect(outcome.note).toContain("rate limited");
  });

  it("explains failures", () => {
    expect(parseDomainOutput("failed=sudo", "", 20)).toMatchObject({ ok: false, failed: "sudo" });
    expect(parseDomainOutput("failed=conflict\nconflict=/etc/nginx/conf.d/x.conf", "", 22).detail).toContain("/etc/nginx/conf.d/x.conf");
    expect(parseDomainOutput("failed=nginx-test\nnginx: bad directive", "", 23).detail).toContain("bad directive");
  });
});

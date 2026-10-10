// Application environment variables (e.g. API keys) that SBSB passes to the container on every deployment.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VARIABLES = 40;
const MAX_VALUE_LENGTH = 4_096;

// Names a deployment target sets itself or that would change how the container starts.
const RESERVED = new Set(["PATH", "HOME", "HOSTNAME", "PORT", "LD_PRELOAD", "LD_LIBRARY_PATH", "DOCKER_CONFIG", "DOCKER_HOST"]);

export type AppEnv = Record<string, string>;

export function validateAppEnv(input: AppEnv): AppEnv {
  const entries = Object.entries(input);
  if (entries.length > MAX_VARIABLES) throw new Error(`환경변수는 최대 ${MAX_VARIABLES}개까지 저장할 수 있습니다.`);
  for (const [name, value] of entries) {
    if (!NAME.test(name)) throw new Error(`환경변수 이름이 올바르지 않습니다: ${name.slice(0, 40)} (영문, 숫자, 밑줄만 사용)`);
    if (RESERVED.has(name.toUpperCase())) throw new Error(`${name}은(는) SBSB가 관리하는 이름이라 사용할 수 없습니다.`);
    if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH || /[\u0000\r\n]/.test(value)) {
      throw new Error(`${name}의 값은 한 줄이고 ${MAX_VALUE_LENGTH}자 이하여야 합니다.`);
    }
  }
  return Object.fromEntries(entries);
}

// "KEY=value" per line; blank lines and lines starting with # are ignored. Later duplicates win.
export function parseEnvText(text: string): AppEnv {
  const result: AppEnv = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error(`"${line.slice(0, 40)}" 줄은 KEY=값 형식이어야 합니다.`);
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    result[name] = value;
  }
  return validateAppEnv(result);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// "-e 'NAME=value' " (with a trailing space) for docker run, or "" without variables.
// Every value is single-quoted, so it cannot break out of the command.
export function dockerEnvFlags(env: AppEnv | undefined): string {
  return Object.entries(validateAppEnv(env ?? {}))
    .map(([name, value]) => `-e ${shellQuote(`${name}=${value}`)} `)
    .join("");
}

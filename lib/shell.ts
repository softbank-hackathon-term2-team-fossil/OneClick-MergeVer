// Single-quotes a value for a POSIX shell so it is passed as one literal argument.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

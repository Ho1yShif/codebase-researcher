export type Fields = Record<string, unknown>;

export type Log = {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Log;
};

const serialize = (_key: string, value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message } : value;

/** One JSON object per line; Render captures task stdout. */
export function createLog(base: Fields = {}, write = (line: string) => void process.stdout.write(`${line}\n`)): Log {
  const emit = (level: string) => (msg: string, fields?: Fields) =>
    write(JSON.stringify({ level, msg, ...base, ...fields }, serialize));
  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createLog({ ...base, ...fields }, write),
  };
}

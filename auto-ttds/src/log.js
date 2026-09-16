// log.js: one tiny leveled logger. No secrets are ever passed to it (spec 10.1).
const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[String(level ?? 'info').toLowerCase()] ?? LEVELS.info;
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${args.map(fmt).join(' ')}`;
  if (level === 'error' || level === 'warning') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warning: (...a) => emit('warning', a),
  error: (...a) => emit('error', a),
};

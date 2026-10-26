const fail = message => { throw Object.assign(new Error(message), { httpStatus: 400 }); };
const formatters = new Map();

function formatter(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 128 || timezone.includes('\0')) fail('请提供有效的 IANA 时区。');
  if (!formatters.has(timezone)) {
    let value;
    try { value = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
    catch { fail('无效的 IANA 时区：' + timezone); }
    if (formatters.size >= 128) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, value);
  }
  return formatters.get(timezone);
}

function parts(timestamp, timezone) {
  return Object.fromEntries(formatter(timezone).formatToParts(timestamp)
    .filter(part => ['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type))
    .map(part => [part.type, Number(part.value)]));
}

function localParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) fail('单次时间必须为 YYYY-MM-DDTHH:mm。');
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59) fail('单次日期或时间无效。');
  return { year, month, day, hour, minute };
}

// Enumerate offsets around this date instead of assuming every local minute exists
// once. A fold deliberately selects its first occurrence; a gap has no result.
function resolveLocal(wanted, timezone) {
  const guess = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const offsets = new Set();
  for (let hour = -48; hour <= 48; hour += 6) {
    const timestamp = guess + hour * 3600000;
    const p = parts(timestamp, timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - timestamp);
  }
  const candidates = [...offsets].map(offset => guess - offset).filter(timestamp => {
    const actual = parts(timestamp, timezone);
    return Object.entries(wanted).every(([key, value]) => actual[key] === value) && actual.second === 0;
  });
  return candidates.length ? Math.min(...candidates) : null;
}

export function validateScheduleTiming(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('定时配置必须是对象。');
  if (!['once', 'daily'].includes(input.kind)) fail('定时类型必须是 once 或 daily。');
  const allowed = input.kind === 'once' ? ['kind', 'localDateTime', 'timezone'] : ['kind', 'time', 'timezone'];
  if (Reflect.ownKeys(input).some(key => !allowed.includes(key))) fail('定时配置包含未知字段。');
  formatter(input.timezone);
  if (input.kind === 'once') {
    const local = localParts(input.localDateTime);
    if (resolveLocal(local, input.timezone) === null) fail('此本地时间因夏令时或时区调整而不存在，请选择其它时间。');
    return { kind: 'once', localDateTime: input.localDateTime, timezone: input.timezone };
  }
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) fail('每日时间必须为 HH:mm。');
  return { kind: 'daily', time: input.time, timezone: input.timezone };
}

// Returns an epoch millisecond strictly after `after`, or null for an expired
// once schedule. Daily gap dates are skipped; the second half of a fold is not run.
export function nextScheduleOccurrence(input, after = Date.now()) {
  const timing = validateScheduleTiming(input);
  if (typeof after !== 'number' || !Number.isFinite(after) || !Number.isFinite(new Date(after).getTime())) fail('无效的参考时间。');
  if (timing.kind === 'once') {
    const timestamp = resolveLocal(localParts(timing.localDateTime), timing.timezone);
    return timestamp > after ? timestamp : null;
  }
  const local = parts(after, timing.timezone);
  const [hour, minute] = timing.time.split(':').map(Number);
  for (let offset = 0; offset < 370; offset++) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const timestamp = resolveLocal({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(), hour, minute }, timing.timezone);
    if (timestamp !== null && timestamp > after) return timestamp;
  }
  fail('无法计算下一次触发时间。');
}

// unix day = floor(unix_seconds / 86400)
export function unixDayNow(): bigint {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  return unixSeconds / BigInt(86400);
}

export function secondsUntilNextUnixDay(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const nextDay = Math.floor(nowSec / 86400) * 86400 + 86400;
  return Math.max(0, nextDay - nowSec);
}

export function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

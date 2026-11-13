import { CronTime } from 'cron';

export const monitoringJobKeys = ['expiry', 'dns_tls'] as const;
export type MonitoringJobKey = typeof monitoringJobKeys[number];
export interface MonitoringConfig {
  enabled: boolean;
  timeZone: string;
  schedules: Record<MonitoringJobKey, string>;
}

export function monitoringConfig(env: NodeJS.ProcessEnv = process.env): MonitoringConfig {
  const enabled = env.MONITORING_ENABLED ?? 'on';
  if (!['on', 'off'].includes(enabled)) throw new Error('MONITORING_ENABLED must be on or off.');
  const timeZone = env.MONITORING_TIME_ZONE ?? 'Asia/Ho_Chi_Minh';
  const schedules = {
    expiry: env.MONITORING_EXPIRY_CRON ?? '0 0 2 * * *',
    dns_tls: env.MONITORING_DNS_TLS_CRON ?? '0 */30 * * * *',
  };
  for (const key of monitoringJobKeys) {
    try { new CronTime(schedules[key], timeZone); }
    catch { throw new Error(`Invalid monitoring schedule or time zone for ${key}.`); }
  }
  return { enabled: enabled === 'on', timeZone, schedules };
}

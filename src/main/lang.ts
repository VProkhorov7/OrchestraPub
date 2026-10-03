import { AppConfig } from './types';

/** Language the models answer the owner in (plans, reports, digests); follows the panel's RU/EN switch. */
export function replyLang(cfg?: Pick<AppConfig, 'language'>): 'Russian' | 'English' {
  return cfg?.language === 'en' ? 'English' : 'Russian';
}

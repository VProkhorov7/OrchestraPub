import * as fs from 'fs';
import * as path from 'path';
import { orchestraHome } from '../main/paths';

export type Lang = 'ru' | 'en';

/** The app's language (the panel's RU/EN switch): ORCHESTRA_LANG, else the app's config.json, else Russian. */
export function appLanguage(): Lang {
  const env = process.env.ORCHESTRA_LANG;
  if (env === 'en' || env === 'ru') return env;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(orchestraHome(), 'config.json'), 'utf8'));
    if (c.language === 'en') return 'en';
  } catch {
    /* no app config: Russian */
  }
  return 'ru';
}

/** Automatic memory is on unless the app settings say `autoMemory: false` (or ORCHESTRA_NO_AUTOMEMORY is set). */
export function appAutoMemory(): boolean {
  if (process.env.ORCHESTRA_NO_AUTOMEMORY) return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(orchestraHome(), 'config.json'), 'utf8')).autoMemory !== false;
  } catch {
    return true;
  }
}

/** A project's workflow language: `language` in .memory/config.json if the owner set one, else the app's. */
export function projectLanguage(root: string): Lang {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, '.memory', 'config.json'), 'utf8'));
    if (c.language === 'en' || c.language === 'ru') return c.language;
  } catch {
    /* no project config */
  }
  return appLanguage();
}

/** One string in the language of the workflow. */
export const pick = <T>(lang: Lang | undefined, ru: T, en: T): T => (lang === 'en' ? en : ru);

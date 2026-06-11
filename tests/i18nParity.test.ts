import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type TranslationValue = string | number | boolean | null | TranslationTree;
type TranslationTree = Record<string, TranslationValue>;

const localesDir = path.join(process.cwd(), 'i18n/locales');

const readLocale = (locale: string): TranslationTree => {
  const filePath = path.join(localesDir, locale, 'translation.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TranslationTree;
};

const flattenKeys = (value: TranslationTree, prefix = ''): string[] => {
  return Object.entries(value).flatMap(([key, nested]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return flattenKeys(nested as TranslationTree, nextKey);
    }
    return [nextKey];
  });
};

describe('i18n locale coverage', () => {
  const localeCodes = fs.readdirSync(localesDir)
    .filter((entry) => fs.existsSync(path.join(localesDir, entry, 'translation.json')))
    .sort();
  const englishKeys = flattenKeys(readLocale('en')).sort();

  it('includes Bahasa Indonesia translations', () => {
    expect(localeCodes).toContain('id');
  });

  it.each(localeCodes)('%s has every English translation key', (locale) => {
    const keys = new Set(flattenKeys(readLocale(locale)));
    const missing = englishKeys.filter((key) => !keys.has(key));

    expect(missing).toEqual([]);
  });
});

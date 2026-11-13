import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages as backend } from '../src/i18n.js';
import { messages as frontend } from '../public/i18n.js';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const [label, dict] of [
  ['backend', backend],
  ['interface', frontend],
]) {
  test(`${label} : le français et l'anglais ont les mêmes clés`, () => {
    const fr = Object.keys(dict.fr).sort();
    const en = Object.keys(dict.en).sort();
    assert.deepEqual(
      fr.filter((k) => !en.includes(k)),
      [],
      'clés présentes en français mais absentes en anglais',
    );
    assert.deepEqual(
      en.filter((k) => !fr.includes(k)),
      [],
      'clés présentes en anglais mais absentes en français',
    );
  });

  test(`${label} : les variables {x} sont identiques dans les deux langues`, () => {
    for (const key of Object.keys(dict.fr)) {
      assert.deepEqual(placeholders(dict.fr[key]), placeholders(dict.en[key]), `variables différentes pour "${key}"`);
    }
  });

  test(`${label} : aucune traduction vide`, () => {
    for (const lang of ['fr', 'en']) {
      for (const [key, value] of Object.entries(dict[lang])) {
        assert.ok(String(value).trim(), `traduction vide : ${lang}.${key}`);
      }
    }
  });
}

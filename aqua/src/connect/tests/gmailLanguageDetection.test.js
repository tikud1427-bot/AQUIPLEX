/**
 * Phase 4B (2026-11-23) — language detection audit.
 *
 * The first real mailbox had 529 of 1,367 messages (39%) classified "not-english"; 520 of
 * those were English diluted by URLs / tracking tokens / footers. This file holds labelled
 * synthetic fixtures for every failure mode found, measures precision and recall for the
 * OLD detector (frozen copy below) and the current one, and pins the guarantees:
 *   · English is recognised through link-heavy, HTML-derived and boilerplate-heavy text;
 *   · real other-language mail stays explicitly unsupported (with the language code);
 *   · undecidable mail is 'uncertain' — statements kept, but only as uncertain inferences.
 * Pure: no network, no store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const K = await import('./testkit.js');   // isolated data dir (the extractor imports nothing that loads stores, but be safe)
void K;
const U = await import('../gmail/emailUnderstanding.js');
const N = await import('../gmail/gmailNormalize.js');
const F = await import('../testing/gmailFixtures.js');

// The detector as it was before Phase 4B (frozen, for the before/after measurement only).
const EN_FUNCTION = new Set(['the', 'and', 'to', 'of', 'a', 'in', 'is', 'it', 'you', 'that', 'we', 'i', 'for', 'on', 'be', 'will', 'with', 'this', 'are', 'have', 'as', 'at', 'by', 'can', 'please', 'our', 'your', 'not', 'from', 'or', 'was', 'if', 'do', 'so', 'let', 'me', 'my', 'all', 'about', 'thanks', 'hi', 'hello']);
function oldDetect(text) {
  const s = String(text ?? '');
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 12) return { supported: true };
  const latin = letters.filter(ch => /\p{Script=Latin}/u.test(ch)).length;
  if (latin / letters.length < 0.7) return { supported: false };
  const words = s.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return { supported: true };
  return { supported: words.filter(w => EN_FUNCTION.has(w)).length / words.length >= 0.1 };
}

const track = (n, base = 'https://click.mailer.example.com/ls/click') => Array.from({ length: n }, (_, i) => `${base}?upn=${'aZ9'.repeat(12)}${i}&utm_source=newsletter&utm_medium=email&utm_campaign=weekly_digest_${i}`).join('\n');
const FOOTER = 'Unsubscribe | Manage preferences | View in browser | Privacy policy\nCopyright 2026 Example Media Ltd, 12 Market Street, Springfield. All rights reserved.';
const DISCLAIMER = 'CONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be privileged. If you are not the intended recipient, please notify the sender immediately and delete this message. Any unauthorised review, use or distribution is prohibited.';

/** [label, isEnglish, body] */
export const LANGUAGE_FIXTURES = [
  ['plain personal English', true, "Hi Raj, thanks for the update. I'll send the revised budget by Friday and we can review it together next week."],
  ['English newsletter, 20 tracking links + footer', true, `This week in product: we shipped the new dashboard and fixed the export bug.\n${track(20)}\nRead the full story on our blog.\n${FOOTER}`],
  ['English newsletter, 40 links, one sentence', true, `Your weekly digest is ready to read.\n${track(40)}\n${FOOTER}`],
  ['HTML-derived English with entities', true, 'Hello&nbsp;team,&nbsp;the&nbsp;launch&nbsp;is&nbsp;on&nbsp;track.&nbsp;Please review the attached plan&#8212;we will confirm the date on Monday. &copy; 2026'],
  ['English with long tracking tokens', true, `Please confirm your attendance for the workshop on Thursday. Reference: ${'x8KqL2mN9pQ4rS7tV1wY3zB6cD0fG5hJ'.repeat(3)} Token ${'A1b2C3d4E5f6G7h8I9j0'.repeat(4)}`],
  ['short English', true, 'Thanks, see you Monday.'],
  ['English with long legal disclaimer', true, `Can you share the contract draft before the call? ${DISCLAIMER}`],
  ['English with a quoted Spanish reply (quoted part stripped)', true, U.stripQuoted("Sounds good, I'll book the room for Tuesday.\n\nOn Mon, 5 Jan 2026, Ana wrote:\n> Hola, ¿podemos reunirnos el martes para revisar el presupuesto?\n> Gracias")],
  ['English with a Spanish phrase', true, "Thanks for the warm welcome in Madrid — muchas gracias! We'll send the proposal to the whole team by the end of the month."],
  ['English receipt with codes and numbers', true, 'Your order #A-99812-XQ has shipped. Tracking: 1Z999AA10123456784. Items: 2 x USB-C cable (SKU 44-1182), 1 x charger. Total: $48.20. Thank you for shopping with us.'],
  ['English marketing copy, few function words', true, `SALE 50% OFF Shoes Bags Accessories. New Arrivals. Trending Styles. Shop Now. Free Shipping Worldwide. Limited Time Only.\n${track(10)}`],
  ['English with an e-mail-address-heavy signature', true, 'Please find the agenda below.\n\nPriya Sharma | Head of Ops | priya.sharma@acme.example | ops@acme.example | support@acme.example | +1 555 0100'],
  ['Spanish', false, 'Hola Raj, enviaré el informe el lunes. Decidimos usar Postgres para el almacenamiento. La reunión es el 15 de marzo y todos deben estar presentes.'],
  ['French', false, "Bonjour à tous, nous avons décidé de reporter la réunion. Je vous enverrai le compte rendu demain et merci pour votre patience dans cette période."],
  ['German', false, 'Hallo zusammen, wir haben uns für die neue Lösung entschieden. Ich schicke euch die Unterlagen morgen und danke für die Geduld mit dem Projekt.'],
  ['Portuguese', false, 'Olá equipe, vamos enviar o relatório na segunda-feira. Obrigado pela paciência e não esqueçam da reunião com o cliente na próxima semana.'],
  ['Italian', false, 'Ciao a tutti, abbiamo deciso di rinviare la riunione. Vi mando il documento domani e grazie per la pazienza con questo progetto.'],
  ['Dutch', false, 'Hallo allemaal, we hebben besloten om de vergadering te verplaatsen. Ik stuur jullie morgen het verslag en bedankt voor het geduld met het project.'],
  ['Hinglish (Hindi in Latin script)', false, 'Hi bhai, kal meeting hai kya? Main abhi report bhej raha hoon, aap bhi check kar lena aur feedback dena. Thik hai, haan kal baat karte hain.'],
  ['Hindi (Devanagari)', false, 'नमस्ते राज, मैं सोमवार तक रिपोर्ट भेज दूँगी। हमने पोस्टग्रेस इस्तेमाल करने का फैसला किया है।'],
  ['Chinese', false, '大家好，我们决定下周一发布新版本。请在周五之前提交所有的修改，谢谢大家的配合。'],
  ['Spanish newsletter with tracking links', false, `Novedades de la semana: lanzamos el nuevo panel y corregimos el error de exportación para todos los clientes.\n${track(15)}\nGracias por leernos.`],
  ['Spanish mentioning "Project Atlas"', false, 'Hola equipo, el Project Atlas empieza el lunes. Por favor revisen el presupuesto antes del viernes. Gracias a todos por el trabajo de esta semana.'],
];

const measure = detect => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const wrong = [];
  for (const [label, en, body] of LANGUAGE_FIXTURES) {
    const sup = detect(body).supported === true;
    if (en && sup) tp++; else if (!en && sup) { fp++; wrong.push(label); } else if (en && !sup) { fn++; wrong.push(label); } else tn++;
  }
  return { englishPrecision: +(tp / Math.max(1, tp + fp)).toFixed(3), englishRecall: +(tp / Math.max(1, tp + fn)).toFixed(3),
    otherLanguagePrecision: +(tn / Math.max(1, tn + fn)).toFixed(3), otherLanguageRecall: +(tn / Math.max(1, tn + fp)).toFixed(3), wrong };
};

describe('L · language detection (labelled fixtures; precision / recall)', () => {
  test('L1 · before vs after (printed for the report); the new detector meets the floors', () => {
    const before = measure(oldDetect);
    const after = measure(U.detectLanguage);
    process.stderr.write(`[LANG] before ${JSON.stringify(before)}\n[LANG] after  ${JSON.stringify(after)}\n`);
    assert.equal(after.englishRecall, 1, `English classified unsupported: ${after.wrong}`);
    assert.equal(after.otherLanguageRecall, 1, `other language treated as English: ${after.wrong}`);
    assert.ok(before.englishRecall < after.englishRecall, 'the fixtures reproduce the real-mailbox failure');
  });

  test('L2 · other languages are explicit, with the language identified', () => {
    const got = Object.fromEntries(LANGUAGE_FIXTURES.filter(([, en]) => !en).map(([l, , b]) => [l, U.detectLanguage(b).detected]));
    assert.equal(got.Spanish, 'es');
    assert.equal(got.French, 'fr');
    assert.equal(got.German, 'de');
    assert.equal(got.Portuguese, 'pt');
    assert.equal(got.Italian, 'it');
    assert.equal(got.Dutch, 'nl');
    assert.equal(got['Hinglish (Hindi in Latin script)'], 'hi-latn');
    assert.equal(got['Hindi (Devanagari)'], 'non-latin-script');
    assert.equal(got.Chinese, 'non-latin-script');
    for (const [l, d] of Object.entries(got)) assert.notEqual(d, 'uncertain', l);
  });

  test('L3 · undecidable text is UNCERTAIN, not discarded — and never yields a stated fact', () => {
    const body = 'Quarterly numbers: revenue up, churn down. Next steps: hiring, pricing, roadmap. We will ship pricing v2 by Friday. Board deck attached. Questions welcome. Regards, Priya.';
    const lang = U.detectLanguage(body);
    // This text's function-word ratio is borderline by design; whichever way it falls, it is never 'not-english'.
    assert.notEqual(lang.supported, false);
    const uncertainBody = 'Roadmap: pricing v2, onboarding revamp, analytics export, SSO, audit logs, billing portal, mobile beta. Owners: Priya, Raj. Status: green. We will ship pricing v2 Friday.';
    const l2 = U.detectLanguage(uncertainBody);
    assert.deepEqual([l2.detected, l2.supported, l2.uncertain], ['uncertain', true, true]);
    const msg = N.renderGmailDocument(N.parseGmailMessage(F.buildMessage({ id: '18f0000000000a01', threadId: 't', date: 'Mon, 5 Jan 2026 10:00:00 +0000', headers: { From: 'Priya <priya@acme.example>', To: 'Raj <raj@acme.example>', Subject: 'Roadmap', 'Message-ID': '<l3@x>' }, text: uncertainBody })));
    const rec = U.understandEmail(msg, { extractedAt: '2026-01-06T00:00:00.000Z' });
    assert.equal(rec.language.uncertain, true);
    const statements = rec.items.filter(i => !['document', 'topic'].includes(i.type));
    assert.ok(statements.length > 0, 'statements are kept, not silently discarded');
    for (const i of statements) assert.deepEqual([i.certainty, i.explicit, i.languageUncertain, i.confidence <= 0.35], ['uncertain', false, true, true], i.type);
    assert.deepEqual(U.validateUnderstanding(rec), []);
  });

  test('L4 · prose words ignore links, addresses, entities and over-long tokens', () => {
    assert.deepEqual(U.proseWords('See https://x.example/a?utm_source=a&utm_medium=b and mail bob@x.example&nbsp;now Zq9'.replace('Zq9', 'q'.repeat(30))), ['see', 'and', 'mail', 'now']);
  });
});

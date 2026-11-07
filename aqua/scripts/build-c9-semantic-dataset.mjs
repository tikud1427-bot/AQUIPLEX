#!/usr/bin/env node
/**
 * Builds eval/datasets/c9-semantic-relevance.dev.v1.json — the C9 semantic-
 * understanding dataset (2026-11-07). Deterministic: the same script always
 * writes the same bytes, and the dataset hash is recorded beside it
 * (c9-semantic-relevance.dev.v1.sha256).
 *
 *   node scripts/build-c9-semantic-dataset.mjs            write dataset + hash
 *   node scripts/build-c9-semantic-dataset.mjs --check    verify the committed file is what this script builds
 *
 * WHAT IT COVERS — the five C9 cases (mind/tests/cognitiveRelevanceSynonyms.test.js):
 *   C1  a "21 km race" is the half-marathon goal
 *   C2  Duolingo / app practice is about the language goal
 *   C3  "deployment is blocked" / "CI failing" is the pipeline blocker
 *   C4  "career" is about the promotion goal (which later changes and completes)
 *   C5  a planning question about ONE thing should not pull in every goal
 * For ten fictional people: goal and blocker statements, later statements that
 * continue them in other words, temporal changes, related-but-distinct
 * statements (someone else's marathon, a colleague's language, a slow-but-green
 * CI), lexical traps (race condition, Spanish omelette, sales pipeline, promo
 * code) and 55 unrelated everyday statements each, so every owner's corpus is
 * above the dense lane's 60-statement floor (pic/retrievalIntelligence.js).
 *
 * Every person, company, project, city and event is invented. The one real
 * product named is Duolingo, because C2 is about recognising it; it is named as
 * a product, never with any real person's data.
 *
 * LABELS. Each query lists `relevant` statement ids (must be found) and
 * `forbidden` ids (must not be connected); `pairs` lists statement pairs with
 * the relation the model is expected to see (equivalent / distinct / trap).
 * Labels are written here, before any vector exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.json');
const SHA = path.join(AQUA, 'eval/datasets/c9-semantic-relevance.dev.v1.sha256');

// ── Ten fictional people ──────────────────────────────────────────────────────
const P = [
  { name: 'Mara Ellison', company: 'Brindlewood Analytics', project: 'Kestrel', city: 'Port Halden', race: 'Larkfield Half Marathon', month: 'October', lang: 'Spanish', other: 'Portuguese', role: 'senior analyst', next: 'product management', brother: 'Callum', colleague: 'Josie', due: 'March 3', pet: 'Biscuit', street: 'Wren Lane', dish: 'lentil soup', friend: 'Hattie', town: 'Oakmere' },
  { name: 'Tobias Renn', company: 'Quillmark Systems', project: 'Orchid', city: 'Easthollow', race: 'Easthollow Harbour Half', month: 'September', lang: 'Spanish', other: 'Catalan', role: 'staff engineer', next: 'engineering management', brother: 'Anselm', colleague: 'Petra', due: 'April 14', pet: 'Pepper', street: 'Corran Road', dish: 'mushroom risotto', friend: 'Wim', town: 'Duncliffe' },
  { name: 'Ines Varga', company: 'Halvorsen & Pike', project: 'Lantern', city: 'Marrowby', race: 'Marrowby Riverside Half Marathon', month: 'May', lang: 'Italian', other: 'French', role: 'lead designer', next: 'design research', brother: 'Matyas', colleague: 'Odile', due: 'June 9', pet: 'Clementine', street: 'Fennick Street', dish: 'stuffed peppers', friend: 'Zsofi', town: 'Kettering Vale' },
  { name: 'Dev Okafor', company: 'Saltmarsh Labs', project: 'Beacon', city: 'Greywick', race: 'Greywick Coastal Half', month: 'November', lang: 'Spanish', other: 'Portuguese', role: 'principal data scientist', next: 'a teaching role', brother: 'Emeka', colleague: 'Rosalind', due: 'February 20', pet: 'Juno', street: 'Alder Close', dish: 'jollof rice', friend: 'Bisi', town: 'Pennock' },
  { name: 'Ruth Calloway', company: 'Greyfen Logistics', project: 'Tern', city: 'Lowmarsh', race: 'Lowmarsh Spring Half Marathon', month: 'April', lang: 'Japanese', other: 'Korean', role: 'operations director', next: 'consulting', brother: 'Ned', colleague: 'Imogen', due: 'May 2', pet: 'Moss', street: 'Tanner Row', dish: 'shepherd\'s pie', friend: 'Dot', town: 'Cliveden Brook' },
  { name: 'Felix Amundsen', company: 'Copperline Freight', project: 'Juniper', city: 'Skarby', race: 'Skarby Fjord Half', month: 'August', lang: 'Spanish', other: 'Italian', role: 'senior product manager', next: 'founding a startup', brother: 'Leif', colleague: 'Maren', due: 'July 18', pet: 'Otto', street: 'Bryggen Walk', dish: 'fish stew', friend: 'Sigrid', town: 'Holmvik' },
  { name: 'Priya Venn', company: 'Northvale Studio', project: 'Marlin', city: 'Ashby Cross', race: 'Ashby Cross Half Marathon', month: 'March', lang: 'Italian', other: 'Spanish', role: 'art director', next: 'illustration', brother: 'Arjun', colleague: 'Tess', due: 'January 30', pet: 'Mango', street: 'Quarry Hill', dish: 'dal makhani', friend: 'Nell', town: 'Brightwater' },
  { name: 'Owen Strake', company: 'Ashgrove Insurance', project: 'Heron', city: 'Coldharbour', race: 'Coldharbour Half', month: 'June', lang: 'Spanish', other: 'Galician', role: 'claims team manager', next: 'actuarial work', brother: 'Rhys', colleague: 'Bronwen', due: 'August 11', pet: 'Rolo', street: 'Mill Terrace', dish: 'cottage pie', friend: 'Gethin', town: 'Llanferry' },
  { name: 'Lena Hart', company: 'Driftwood Data', project: 'Falcon', city: 'Saltcombe', race: 'Saltcombe Cliffs Half Marathon', month: 'July', lang: 'Japanese', other: 'Mandarin', role: 'head of analytics', next: 'a research PhD', brother: 'Jonah', colleague: 'Aiko', due: 'September 5', pet: 'Pip', street: 'Gull Steps', dish: 'ramen', friend: 'Bea', town: 'Merrow' },
  { name: 'Sam Ilori', company: 'Pellmore Retail', project: 'Osprey', city: 'Brackenford', race: 'Brackenford Park Half', month: 'December', lang: 'Spanish', other: 'French', role: 'regional sales lead', next: 'customer success', brother: 'Tunde', colleague: 'Grace', due: 'October 27', pet: 'Nala', street: 'Elm Parade', dish: 'pepper soup', friend: 'Kemi', town: 'Harrowgate Green' },
];

const fill = (t, p) => t.replace(/\{(\w+)\}/g, (_, k) => { if (!(k in p)) throw new Error(`no {${k}}`); return p[k]; });
const pick = (list, i, off = 0) => list[(i + off) % list.length];

// ── Statements: the items, and what is later said about them ──────────────────
const ANCHOR = {
  run: ['My goal is to run the {race} in {month}.', 'I want to finish the {race} this {month}.', 'This year I am going to run my first half marathon, the {race} in {month}.', 'I signed up for the {race} in {month} and I really want to finish it.', 'Running the {race} in {month} is my big personal goal.'],
  lang: ['My goal is to learn {lang} this year.', 'I want to be conversational in {lang} by the end of the year.', 'This year I am finally learning {lang}.', 'I am determined to speak decent {lang} within a year.', 'Learning {lang} properly is one of my goals for this year.'],
  career: ['My goal is to get promoted to {role} at {company}.', 'I am aiming for the {role} promotion at {company} this cycle.', 'I want to make {role} at {company} before next spring.', 'Getting promoted to {role} is what I am working toward at {company}.', 'My main work goal is the {role} title at {company}.'],
  ci: ['The {project} CI pipeline keeps failing on the integration tests.', 'Our CI for {project} has been red for three days because the integration suite fails.', 'The {project} build pipeline fails every run at the integration test stage.', 'CI on {project} is broken: the integration tests fail on every commit.', 'I am stuck because the {project} pipeline fails its integration tests.'],
  deadline: ['The {project} launch is due on {due}.', '{project} has to go live by {due}.', 'Our deadline for the {project} release is {due}.', 'We promised the client {project} by {due}.', 'The {project} go-live date is {due}.'],
};
const PARAPHRASE = {
  // Set 0 holds the C9 sentences as the cases state them ("I'm training for a 21 km race",
  // "I've been using Duolingo", "Deployment is blocked"); the rest name the person's own details.
  run: [['I am training for a 21 km race.', 'Did a 16 km long run around {city} this weekend, building toward race day.'],
    ['My long runs for the {race} are up to 18 kilometres now.', 'Thirteen miles is starting to feel doable before {month}.'],
    ['Week nine of my plan for the {race} went well.', 'I ran 15 km at race pace along {street} on Sunday.'],
    ['Picked up new trainers for the long runs before the {race}.', 'My coach wants me at 20 km before the {month} taper.'],
    ['Race day in {city} is eight weeks away and my legs feel strong.', 'I logged 40 km of running this week, mostly around {town}.']],
  lang: [['I have been using Duolingo every morning.', 'I am on a 60-day Duolingo streak in {lang}.'],
    ['I practise {lang} vocabulary on Duolingo during my commute.', 'Booked a weekly conversation class in {city} to practise my {lang}.'],
    ['I finally ordered dinner in {lang} without switching to English.', 'My {lang} flashcards are up to 900 words.'],
    ['Duolingo says my {lang} is now at intermediate level.', 'I watch a {lang} series with subtitles every night.'],
    ['I keep mixing up the past tenses in {lang}.', 'My tutor in {town} says my {lang} pronunciation is improving.']],
  ci: [['Deployment is blocked.', 'We cannot ship {project} until the build goes green.'],
    ['Nothing can be released while the {project} checks are red.', 'The {project} deploy step never runs because the tests before it fail.'],
    ['Our release train for {project} is stuck behind a broken build.', 'I spent the whole day chasing a flaky {project} integration test.'],
    ['Merges to main are frozen until the {project} tests pass again.', 'The {project} staging deploy has not run since Tuesday.'],
    ['The {project} release is on hold: the pipeline will not pass.', 'I rolled back two {project} commits trying to get the build green.']],
};
const CAREER_CHANGE = ['My career goal has changed: I want to move into {next}.', 'I no longer want the {role} track; I am moving toward {next}.', 'I have decided my next step is {next}, not another promotion.', 'Change of plan at work: I am aiming for {next} now.', 'I want to switch into {next} instead of climbing at {company}.'];
const CAREER_DONE = ['I got promoted to {role}!', 'They gave me the {role} promotion today.', 'Good news: I am officially {role} now.', 'The {role} promotion came through this morning.', 'I made {role} at {company} last week.'];
const LANG_STOPPED = ['I stopped learning {lang} in March; there was no time.', 'I gave up on {lang} for now.', 'I paused my {lang} lessons indefinitely.', 'I dropped {lang} after the spring.', 'I have quit my {lang} course for this year.'];

// Related but distinct: same field, different thing or different person.
const DISTINCT = {
  run: ['My brother {brother} is running a full marathon in {month}.', '{brother} wants to do an ultramarathon next year.', 'My brother {brother} just finished a triathlon.', '{brother} is training for a 100 km cycling race.', 'My brother {brother} runs a 5 km parkrun every Saturday.'],
  lang: ['My colleague {colleague} is learning {other}.', '{colleague} studies {other} on weekends.', 'My colleague {colleague} moved abroad to study {other}.', '{colleague} speaks fluent {other}.', 'My colleague {colleague} is taking an evening {other} course.'],
  ci: ['Our CI is slow but every run passes.', 'The {project} test suite takes forty minutes, but it is green.', 'CI runs are long lately, though nothing fails.', 'Our pipeline is slower since the new runners, still passing.', 'The {project} checks pass; they just take ages.'],
  career: ['{colleague} got promoted to team lead last week.', 'My manager was promoted to director.', '{colleague} is up for promotion this cycle.', 'Two people on my team were promoted in June.', 'My friend {friend} got a promotion at the bank.'],
};
// Lexical traps: a shared word, an unrelated meaning.
const TRAP = {
  run: ['I fixed a race condition in the {project} payment service.', 'There is a race condition in the {project} job scheduler again.', 'We found a race condition between the two {project} cache writers.', 'The {project} bug was a race condition in the upload handler.', 'A race condition in the {project} queue consumer dropped messages.'],
  lang: ['I made a Spanish omelette for dinner with {friend}.', 'We bought a Spanish guitar for my nephew in {town}.', 'The Spanish tortilla at the cafe on {street} was great.', 'I planted Spanish lavender along the fence on {street}.', 'We watched a documentary about Spanish architecture with {friend}.'],
  ci: ['Our {company} sales pipeline for the third quarter looks healthy.', 'The oil pipeline near {town} is being repaired.', 'We cleaned the water pipeline under the garden on {street}.', 'The {company} hiring pipeline has twelve candidates.', 'The deal pipeline in the {company} CRM needs cleaning up.'],
  career: ['The shop on {street} had a promotion code for 20% off.', 'The {town} football club was relegated after missing promotion.', 'The supermarket promotion on coffee in {city} ended yesterday.', 'I used a promotion voucher for the train to {town}.', 'The bakery on {street} is running a two-for-one promotion.'],
};
// Unrelated everyday statements: corpus mass for the margin rule.
const FILLER = [
  // Every line names something of the person's own, so no two owners share a sentence.
  'My dog {pet} chewed through another lead.', 'I repainted the hallway on {street} a pale green.', 'We had {dish} for dinner on Thursday.', '{friend} came over to help fix the garden gate.', 'The boiler at the house on {street} needs a service before winter.',
  'I am reading a novel about a lighthouse keeper that {friend} lent me.', 'Our neighbour on {street} plays the cello in the evenings.', 'I bought tomato seedlings at the {town} market.', '{pet} has a vet appointment next Tuesday.', 'The kitchen tap on {street} has been dripping all week.',
  'I finished knitting a scarf for {friend}.', 'We are visiting my aunt in {town} at the weekend.', 'The car needs new wiper blades before the drive to {town}.', 'I tried a new recipe for {dish}.', 'There was a hailstorm in {city} yesterday.',
  'I reorganised the bookshelves by colour while {pet} watched.', 'My sister in {town} sent photos of her new kitten.', 'We watched an old black-and-white film at the {city} cinema.', 'The library in {city} extended its opening hours.', 'I am building a birdhouse for the garden on {street}.',
  'I need to renew the insurance on the {street} flat next month.', 'The roses on {street} are finally blooming.', '{friend} recommended a podcast about volcanoes.', 'I cleaned out the garage and found my old records; {pet} hid in the boxes.', 'We ordered a new sofa from a shop in {city}.',
  'The bus from {town} was late again this morning.', 'I baked banana bread for {friend}.', '{street} is having a summer fair.', '{pet} learned to open the back door.', 'I replaced the bulbs in the porch light on {street}.',
  'We are planning a picnic by the river in {city}.', 'I fixed the wobbly leg on the dining table with {friend}\'s drill.', 'My grandmother in {town} turned ninety on Sunday.', 'I started a jigsaw puzzle of the {city} harbour.', 'The plumber is coming to {street} on Friday about the shower.',
  'I made marmalade with oranges from the {town} market.', '{friend} and I went to a pottery class.', 'The fridge at the {street} flat is making a strange humming noise.', 'I hung new curtains in the spare room; {pet} keeps pulling at them.', 'We adopted two goldfish and named one after {friend}.',
  'There is a farmers market in {town} every first Saturday.', 'I sorted my old {city} photos into albums.', 'The cat next door on {street} keeps sleeping on my car.', 'I learned to make sourdough starter from {friend}.', 'The windows on {street} need cleaning after the storm.',
  'I donated a box of clothes to the charity shop on {street}.', 'We booked a cabin near {town} for the holidays.', 'My neighbour on {street} lent me a ladder for the gutters.', 'I bought a second-hand bike for errands around {city}.', 'The tomatoes in {friend}\'s greenhouse are ripening.',
  'I took {pet} to the beach near {town}.', 'The {city} council is resurfacing {street} next month.', 'I cooked {dish} for my neighbours.', '{friend} is moving to {town} in the spring.', 'A fox has been visiting the garden on {street}.',
  'I found a great bakery near the {city} station.', '{pet} needs a new collar.', 'We had a power cut on {street} last night.', 'I joined the {town} book club.', 'My parents are visiting {city} for a week.',
];

// ── Queries ───────────────────────────────────────────────────────────────────
const Q = {
  // [canonical C9 question (shared by every owner), …person-specific variants (two per owner)].
  c1: ['How far is a 21 km race?', 'How is my race training going?', 'How many weeks until race day in {city}?', 'Should my long run be 18 or 20 kilometres before {month}?', 'What pace should I aim for over thirteen miles?',
    'How should I taper in the last two weeks before {month}?', 'Is running 40 km a week enough for a 21 km race?', 'What should I eat the night before race day in {city}?', 'How do I avoid shin splints on long runs?', 'Can I still do a long run if my knee aches?', 'How many kilometres is a half marathon?'],
  c2: ['Is Duolingo worth it?', 'How is my {lang} practice going?', 'Should I keep my Duolingo streak going?', 'What is the fastest way to build {lang} vocabulary?', 'Are conversation classes better than an app?',
    'How long until I can hold a conversation in {lang}?', 'Should I watch {lang} films without subtitles?', 'Is a 15-minute daily app lesson enough?', 'How do I stop mixing up {lang} tenses?', 'Should I find a {lang} exchange partner?', 'How do I practise speaking when I live in {town}?'],
  c3: ['Why is CI failing?', 'Why is deployment blocked?', 'When can we ship {project}?', 'How do I fix a flaky integration test?', 'What is holding up the {project} release?',
    'Why will the {project} build not go green?', 'Can I deploy {project} with the tests skipped?', 'Who should look at the failing {project} integration suite?', 'How do I find which commit broke the {project} build?', 'Is it safe to unfreeze merges on {project}?', 'How long has the {project} pipeline been red?'],
  c4: ["How's my career?", 'What is my next career move?', 'Am I still aiming for the {role} promotion?', 'How should I prepare for my next performance review at {company}?', 'Is it a good time to change direction at work?',
    'Should I ask my manager at {company} about my progression?', 'How do I show I am ready for more responsibility?', 'Am I on track at {company}?', 'What skills do I need for {next}?', 'Should I stay at {company} or move on?', 'How do I make the case for my next step at work?'],
  c5anchored: [['What shoes should I buy for my race?', 'run'], ['Should I book a tutor for my lessons?', 'lang'], ['What should I check before the next {project} build?', 'ci']],
  // Aligned with DISTINCT / TRAP by index: each person's query is about their own statement.
  distinct: {
    run: ['How is {brother}\'s marathon going?', 'Is {brother} ready for an ultramarathon?', 'How did {brother}\'s triathlon go?', 'How is {brother}\'s cycling training?', 'Does {brother} still do parkrun?'],
    lang: ['Is {colleague} enjoying {other}?', 'How is {colleague} getting on with {other}?', 'Is {colleague} happy studying {other} abroad?', 'Where did {colleague} learn {other}?', 'Is {colleague}\'s {other} course any good?'],
    ci: ['Why is our CI so slow?', 'Can we speed up the {project} test suite?', 'Why do CI runs take so long lately?', 'Are the new runners slowing the pipeline down?', 'Why do the {project} checks take ages?'],
    career: ['Who got promoted to team lead?', 'Who is our new director?', 'Is {colleague} getting promoted?', 'Who on my team was promoted?', 'What did {friend} get promoted to?'],
  },
  trap: {
    run: ['How do I debug a race condition?', 'How do I stop the scheduler race condition?', 'How do I make cache writes safe from races?', 'How do I find a race condition in an upload handler?', 'Why does the queue consumer drop messages?'],
    lang: ['What is a good Spanish omelette recipe?', 'How do I tune a Spanish guitar?', 'Where can I get good tortilla?', 'How do I look after Spanish lavender?', 'What are famous examples of Spanish architecture?'],
    ci: ['How do I grow our sales pipeline?', 'When will the pipeline repair near {town} finish?', 'How do I clean a garden water pipe?', 'How many candidates are in our hiring pipeline?', 'How do I tidy up the CRM deal stages?'],
    career: ['Is this promotion code still valid?', 'Can our club still get promoted next season?', 'When is the next coffee promotion?', 'Do promotion vouchers work on train tickets?', 'Is the bakery offer still on?'],
  },
  broad: [['What should I focus on this week?', 'Give me an overview of everything I am working on.'], ['What are my priorities right now?', 'Catch me up on all my plans.'],
    ['What should I plan for this month?', 'Summarise what I have on my plate.'], ['What should I prioritise today?', 'What are all the things I am working toward?'],
    ['What are my next steps?', 'Give me a summary of my goals and deadlines.']],
  unrelated: ['What is the capital of Australia?', 'How do I descale a kettle?', 'What year did the Berlin Wall fall?', 'How long should I boil an egg?', 'How many moons does Mars have?',
    'What is the boiling point of water at altitude?', 'How do I remove a red wine stain?', 'Who wrote Pride and Prejudice?', 'How do tides work?', 'What is a prime number?',
    'How do I unclog a sink?', 'Why is the sky blue?', 'How do bees make honey?', 'What is the tallest mountain in Africa?', 'How do I sharpen a kitchen knife?',
    'What causes thunder?', 'How do I store fresh basil?', 'What is photosynthesis?', 'How many bones are in the human hand?', 'How do I fold a fitted sheet?',
    'How do I clean a cast-iron pan?', 'What is the speed of light?', 'How do I repot a cactus?', 'Why do cats purr?', 'How do I make a paper crane?',
    'What is the longest river in Europe?', 'How do vaccines get stored cold?', 'How do I wash a wool jumper?', 'What is a leap year?', 'How do I bleed a radiator?',
    'Why do leaves change colour?', 'How do I make stock from vegetable scraps?', 'What is the difference between weather and climate?', 'How do I hang a heavy mirror?', 'How do owls see at night?'],
};

function build() {
  const statements = [];
  const queries = [];
  const pairs = [];
  P.forEach((p0, i) => {
    const owner = `user:c9-p${String(i + 1).padStart(2, '0')}`;
    const p = { ...p0 };
    const sid = (role, item, n = 0) => `s:p${String(i + 1).padStart(2, '0')}:${role}:${item}${n ? `:${n}` : ''}`;
    const add = (id, text, meta) => { statements.push({ id, owner, text: fill(text, p), ...meta }); return id; };
    // Items stated in conversation 1 (day 0).
    const a = {};
    for (const item of ['run', 'lang', 'career', 'ci', 'deadline']) {
      a[item] = add(sid('anchor', item), pick(ANCHOR[item], i), { role: 'anchor', item, conversation: 1, day: 0, status: 'current' });
    }
    // Later statements in other words (conversation 2, day 20).
    const para = {};
    for (const item of ['run', 'lang', 'ci']) {
      para[item] = pick(PARAPHRASE[item], i).map((t, n) => add(sid('paraphrase', item, n + 1), t, { role: 'paraphrase', item, conversation: 2, day: 20, status: 'current', continues: a[item] }));
    }
    // Temporal: the career goal changes; for odd-numbered people it is first achieved.
    const careerDone = i % 2 === 0 ? add(sid('completion', 'career'), pick(CAREER_DONE, i), { role: 'completion', item: 'career', conversation: 3, day: 35, status: 'current', continues: a.career }) : null;
    const careerChange = add(sid('change', 'career'), pick(CAREER_CHANGE, i), { role: 'change', item: 'career', conversation: 3, day: 40, status: 'current', continues: a.career });
    if (careerChange) statements.find(s => s.id === a.career).status = 'historical';
    // Temporal: every third person stops the language goal.
    const langStopped = i % 3 === 2 ? add(sid('ended', 'lang'), pick(LANG_STOPPED, i), { role: 'ended', item: 'lang', conversation: 3, day: 45, status: 'current', continues: a.lang }) : null;
    if (langStopped) statements.find(s => s.id === a.lang).status = 'historical';
    // Related but distinct, and traps (conversation 2/3).
    const dist = {}, trap = {};
    for (const item of ['run', 'lang', 'ci', 'career']) {
      dist[item] = add(sid('distinct', item), pick(DISTINCT[item], i), { role: 'distinct', item, conversation: 2, day: 25, status: 'current' });
      trap[item] = add(sid('trap', item), pick(TRAP[item], i), { role: 'trap', item, conversation: 3, day: 30, status: 'current' });
    }
    // Unrelated statements (45, rotated so neighbours differ).
    for (let n = 0; n < 55; n++) add(sid('filler', 'x', n + 1), FILLER[(n + i * 5) % FILLER.length], { role: 'filler', item: null, conversation: 1 + (n % 4), day: n, status: 'current' });

    // Pairs the model is expected to relate, or not.
    for (const item of ['run', 'lang', 'ci']) {
      for (const pid of para[item]) pairs.push({ a: a[item], b: pid, relation: 'equivalent', item });
      pairs.push({ a: a[item], b: dist[item], relation: 'distinct', item });
      pairs.push({ a: a[item], b: trap[item], relation: 'trap', item });
    }
    pairs.push({ a: a.career, b: careerChange, relation: 'equivalent', item: 'career' });
    pairs.push({ a: a.career, b: dist.career, relation: 'distinct', item: 'career' });
    pairs.push({ a: a.career, b: trap.career, relation: 'trap', item: 'career' });

    // Queries with labels.
    const qid = (kind, n) => `q:p${String(i + 1).padStart(2, '0')}:${kind}:${n}`;
    const items = { run: [a.run, ...para.run], lang: [a.lang, ...para.lang], ci: [a.ci, ...para.ci], career: [a.career, careerChange, ...(careerDone ? [careerDone] : [])] };
    const goalsOther = item => ['run', 'lang', 'career', 'ci'].filter(x => x !== item).map(x => a[x]);
    const addQ = (id, text, meta) => queries.push({ id, owner, text: fill(text, p), ...meta });
    const caseQ = (kind, cas, item, list) => [0, 1, 2].forEach(n => addQ(qid(kind, n + 1), n === 0 ? list[0] : list[1 + ((i * 2 + n - 1) % (list.length - 1))], { case: cas, category: 'paraphrase', item, relevant: items[item], forbidden: [...goalsOther(item), trap[item]] }));
    caseQ('c1', 'C1', 'run', Q.c1);
    caseQ('c2', 'C2', 'lang', Q.c2);
    caseQ('c3', 'C3', 'ci', Q.c3);
    caseQ('c4', 'C4', 'career', Q.c4);
    Q.c5anchored.forEach(([t, item], n) => addQ(qid('c5a', n + 1), t, { case: 'C5', category: 'planning_anchored', item, relevant: items[item], forbidden: goalsOther(item) }));
    const current = ['run', 'lang', 'career', 'ci', 'deadline'].map(x => a[x]).filter(id => statements.find(s => s.id === id).status === 'current');
    pick(Q.broad, i).forEach((t, n) => addQ(qid('c5b', n + 1), t, { case: 'C5', category: 'planning_broad', item: null, relevant: [...current, careerChange], forbidden: [] }));
    for (const [n, item] of ['run', 'lang', 'ci', 'career'].entries()) {
      addQ(qid('distinct', n + 1), pick(Q.distinct[item], i), { case: 'control', category: 'related_distinct', item, relevant: [dist[item]], forbidden: [], rankAbove: { better: dist[item], than: a[item] } });
      addQ(qid('trap', n + 1), pick(Q.trap[item], i), { case: 'control', category: 'hard_negative', item, relevant: [trap[item]], forbidden: [a[item], ...(para[item] ?? [])] });
    }
    [0, 1, 2, 3].map(n => Q.unrelated[(i * 4 + n) % Q.unrelated.length]).forEach((t, n) => addQ(qid('unrelated', n + 1), t, { case: 'control', category: 'unrelated', item: null, relevant: [], forbidden: [a.run, a.lang, a.career, a.ci, a.deadline] }));
  });
  return { statements, queries, pairs };
}

function serialize() {
  const { statements, queries, pairs } = build();
  const ids = new Set([...statements, ...queries].map(x => x.id));
  if (ids.size !== statements.length + queries.length) throw new Error('duplicate ids');
  for (const q of queries) for (const r of [...q.relevant, ...q.forbidden]) if (!statements.some(s => s.id === r && s.owner === q.owner)) throw new Error(`${q.id}: label ${r} is not the same owner's statement`);
  const texts = [...statements, ...queries].map(x => x.text);
  const dataset = {
    id: 'c9-semantic-relevance.dev.v1',
    about: 'C9 semantic-understanding dev set: five cases (C1 race, C2 language app, C3 CI/deploy, C4 career, C5 anchored planning) over ten fictional people. Built by scripts/build-c9-semantic-dataset.mjs; labels written before any vector existed. Synthetic text only; all people, companies, projects, places and events are invented (Duolingo is named as a product for C2).',
    builtBy: 'aqua/scripts/build-c9-semantic-dataset.mjs',
    counts: { owners: P.length, statements: statements.length, queries: queries.length, uniqueTexts: new Set(texts).size, pairs: pairs.length },
    statements, queries, pairs,
  };
  return JSON.stringify(dataset, null, 1) + '\n';
}

const body = serialize();
const sha = crypto.createHash('sha256').update(body).digest('hex');
if (process.argv.includes('--check')) {
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  const ok = onDisk === body && fs.existsSync(SHA) && fs.readFileSync(SHA, 'utf8').startsWith(sha);
  console.log(ok ? `OK ${sha}` : 'MISMATCH: the committed dataset is not what this script builds');
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(OUT, body);
fs.writeFileSync(SHA, `${sha}  c9-semantic-relevance.dev.v1.json\n`);
const d = JSON.parse(body);
console.log(`wrote ${path.relative(AQUA, OUT)} · sha256 ${sha} · ${JSON.stringify(d.counts)}`);

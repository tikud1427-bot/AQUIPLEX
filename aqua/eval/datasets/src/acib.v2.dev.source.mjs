/**
 * ACIB v2 — DEVELOPMENT set source (authored 2026-11-11, Sprint 4), AFTER the
 * evaluation set was frozen and WITHOUT reading the eval set's per-item results
 * (only its aggregates were seen). Used to diagnose and develop Information
 * Needs V2. Different people, domains and phrasings from the eval set.
 * Same compact form as acib.v2.eval.source.mjs (see that file's header).
 */
export const FILLER = [
  'How do I descale a coffee machine?',
  'I saw a heron by the canal this morning.',
  'What is the population of Iceland?',
  'Give me a quick tomato soup recipe.',
  'Why do cats purr?',
  'I sorted my sock drawer, very satisfying.',
  'Recommend a documentary about the deep sea.',
  'How do I unclog a shower drain?',
  'What does a thermostat actually do?',
  'I like the sound of rain on the skylight.',
  'Explain cricket scoring in two sentences.',
  'Tell me a fact about octopuses.',
  'How should I store fresh basil?',
  'I moved the bookshelf next to the fireplace.',
  'Suggest a cooperative board game.',
  'Why is snow white?',
  'What is the difference between a hare and a rabbit?',
  'I found an old map of the town in the attic.',
  'How do noise-cancelling headphones work?',
  'Give me a two-minute stretching routine.',
  'What is an anagram? Give me one.',
  'How long do I roast a chicken?',
  'I glued the handle back on a mug.',
  'Tell me something about glaciers.',
  'How do I keep bread from going stale?',
  'What colours go well with navy?',
  'Explain how a dishwasher dries plates.',
  'I tried oat milk in my tea, not bad.',
  'Recommend a genre of music for cooking.',
  'What causes a sneeze?',
  'How do ants find food?',
  'I sketched the church tower from the market square.',
  'What is the longest river in Europe?',
  'How do I propagate a spider plant?',
  'Explain what a time zone is.',
  'I went to a flea market and bought a brass lamp.',
  'How do you tie a bowline knot?',
  'What is the speed of light?',
  'Give me a tongue twister.',
  'Why do we yawn?',
];

const S = (id, category, h, question, o = {}) => ({ id, category, h, question, ...o });

export const SCENARIOS = [
  // personal (4)
  S('d-pc-job', 'personal', [['a', 'I work as a sound engineer for a theatre in Glasgow.'], ['b', 'My cousin is visiting next week.']], 'What do I do for a living?', { n: [['job', [/sound engineer/], /sound engineer/]], d: [['cousin', [/cousin/]]] }),
  S('d-pc-pet', 'personal', [['a', 'We have a border collie called Biscuit.']], "What's our dog's name?", { n: [['dog', [/biscuit/], /called Biscuit/]] }),
  S('d-pc-food', 'personal', [['a', "I'm coeliac so everything has to be gluten free."]], 'What should I bake this weekend?', { n: [['gf', [/coeliac|gluten/], /gluten free/]] }),
  S('d-pc-sport', 'personal', [['a', 'I swim three mornings a week at the lido.']], 'How often do I swim?', { n: [['swim', [/three mornings/], /three mornings a week/]] }),
  // long history (4)
  S('d-lh-kayak', 'long-history', [['a', 'My kayak is a yellow one I named Mango.']], 'What did I call my kayak?', { f: 30, n: [['kayak', [/mango/], /named Mango/]] }),
  S('d-lh-door', 'long-history', [['a', 'The code for our building door is 4417.']], "What's the building door code?", { f: 30, n: [['code', [/4417/], /door is 4417/]] }),
  S('d-lh-teacher', 'long-history', [['a', "Ella's piano teacher is Mr Okafor."]], "Who is Ella's piano teacher?", { f: 30, n: [['t', [/okafor/], /teacher is Mr Okafor/]] }),
  S('d-lh-book', 'long-history', [['a', "I'm writing a novel called The Salt Road."]], "What's the title of my novel?", { f: 30, n: [['book', [/salt road/], /The Salt Road/]] }),
  // cross-project (4)
  S('d-xp-wait', 'cross-project', [['a', 'The garden shed is waiting on planning permission; the driveway is waiting on the contractor.'], ['b', 'The contractor said maybe next month.']], 'What is the shed waiting on?', { n: [['shed', [/planning permission/], /shed is waiting on planning permission/]], x: [['drive', [/shed.*contractor/]]] }),
  S('d-xp-owner', 'cross-project', [['a', 'Jonas runs the mobile release and Freya runs the data pipeline.']], 'Who runs the data pipeline?', { n: [['freya', [/freya/], /Freya runs the data pipeline/]] }),
  S('d-xp-budget', 'cross-project', [['a', 'The festival has a budget of 25,000 and the workshop series 8,000.'], ['b', 'We already spent 6,500 on the workshops.']], 'How much is left for the workshops?', { n: [['budget', [/8,?000/], /workshop series 8,000/], ['spent', [/6,?500/], /spent 6,500/]] }),
  S('d-xp-tool', 'cross-project', [['a', 'The website uses Shopify and the warehouse uses Odoo.']], 'What does the warehouse run on?', { n: [['odoo', [/odoo/], /warehouse uses Odoo/]] }),
  // history change (5)
  S('d-hc-job', 'history-change', [['a', 'I work at Pellow Insurance as an underwriter.'], ['b', 'Last week I started a new job at Grayfield Bank.']], 'Where do I work?', { n: [['now', [/grayfield/], /new job at Grayfield/]], t: { current: [/grayfield/], stale: [/pellow/] } }),
  S('d-hc-car', 'history-change', [['a', 'I drive a Ford Focus.'], ['b', 'Sold the Focus, I have an electric Kia Niro now.']], 'What car do I drive?', { n: [['car', [/niro|kia/], /Kia Niro now/]], t: { current: [/niro/], stale: [/ford focus/] } }),
  S('d-hc-price', 'history-change', [['a', 'Our membership fee is 30 a month.'], ['b', 'The gym raised the membership fee to 38 a month.']], 'How much is our membership fee?', { n: [['fee', [/\b38\b/], /fee to 38/]], t: { current: [/\b38\b/], stale: [/\b30 a month/] } }),
  S('d-hc-name', 'history-change', [['a', "My nephew's name is Aiden."], ['b', 'Correction: my nephew is Aidan with an a, not Aiden.']], "How is my nephew's name spelled?", { n: [['n', [/aidan/], /nephew is Aidan/]], t: { current: [/aidan/], stale: [/aiden\b/] } }),
  S('d-hc-plan', 'history-change', [['a', "We're planning to holiday in Norway this summer."], ['b', 'Change of plan, we are going to Scotland instead of Norway.']], 'Where are we going this summer?', { n: [['dest', [/scotland/], /going to Scotland/]], t: { current: [/scotland/], stale: [/holiday in norway/] } }),
  // contradiction (3)
  S('d-ct-date', 'contradiction', [['a', 'The school play is on the 9th.'], ['b', 'The school play is on the 11th.']], 'When is the school play?', { n: [['a', [/9th/], /on the 9th/], ['b', [/11th/], /on the 11th/]], c: { a: [/9th/], b: [/11th/] } }),
  S('d-ct-cost', 'contradiction', [['a', 'The venue costs 2,000 for the day.'], ['b', 'The venue told me it is 2,600 for the day.']], 'How much does the venue cost?', { n: [['a', [/2,?000/], /costs 2,000/], ['b', [/2,?600/], /2,600 for the day/]], c: { a: [/2,?000/], b: [/2,?600/] } }),
  S('d-ct-files', 'contradiction', [], 'Do the lease and the letter agree on the deposit?', { up: [['a', 'lease.txt', 'Tenancy agreement. Deposit: 1,800 pounds, held in a protection scheme.'], ['b', 'letter.txt', 'Letter from the agent. The deposit payable is 2,100 pounds.']], n: [['lease', [/1,?800/], /Deposit: 1,800/], ['letter', [/2,?100/], /deposit payable is 2,100/]], c: { a: [/1,?800/], b: [/2,?100/] } }),
  // missing (5)
  S('d-mi-house', 'missing', [['a', 'There is a cottage for sale in the village for 210,000.']], 'Could we afford the cottage?', { n: [['price', [/210,?000/], /for 210,000/]], u: [['income', 'household income', [/income|earn|salary/]], ['deposit', 'savings or deposit', [/deposit|savings/]]] }),
  S('d-mi-trip', 'missing', [['a', "We'd love to visit Japan at some point."]], 'Plan our Japan trip.', { n: [['japan', [/japan/], /visit Japan/]], u: [['dates', 'travel dates', [/dates|when they|travel date/]]] }),
  S('d-mi-mba', 'missing', [['a', 'There is an evening MBA programme that costs 28,000.']], 'Should I do the MBA?', { n: [['cost', [/28,?000/], /costs 28,000/]], u: [['career', 'their current job or career goal', [/career|job|goal|current/]]] }),
  S('d-mi-dog', 'missing', [['a', 'My partner wants to adopt a rescue greyhound.']], 'Should we adopt the greyhound?', { n: [['dog', [/greyhound/], /rescue greyhound/]], u: [['time', 'time available to care for it', [/time|schedule|work/]]] }),
  S('d-mi-shop', 'missing', [['a', "I'm thinking of opening a small bookshop."]], 'Is opening a bookshop a good idea?', { n: [['idea', [/bookshop/], /opening a small bookshop/]], u: [['money', 'savings or funding', [/savings|funding|money|budget/]]] }),
  // financial (5)
  S('d-fd-boat', 'financial', [['a', 'We have roughly 9k in savings.'], ['b', 'The boat we like costs 14,500.'], ['c', 'Together we bring home 4,100 a month.']], 'Can we afford the boat?', { n: [['save', [/9k/], /9k in savings/], ['price', [/14,?500/], /costs 14,500/], ['income', [/4,?100/], /4,100 a month/]] }),
  S('d-fd-loan', 'financial', [['a', 'I still owe 7,000 on my student loan at 6%.'], ['b', 'I have 3,000 in a savings account earning 4%.']], 'Should I use my savings to pay down the loan?', { n: [['loan', [/7,?000/], /owe 7,000/], ['savings', [/3,?000/], /3,000 in a savings/]] }),
  S('d-fd-price', 'financial', [['a', 'I charge 25 for a dog walk and do about 60 walks a month.'], ['b', 'Two new walkers started in my area this year.']], 'Should I put my prices up?', { n: [['price', [/\b25\b/], /charge 25/], ['volume', [/60 walks/], /60 walks a month/], ['competition', [/new walkers|walkers started/], /Two new walkers/]] }),
  S('d-fd-kitchen', 'financial', [['a', 'A new kitchen would cost about 16,000.'], ['b', 'We plan to sell the house within two years.']], 'Is a new kitchen worth it?', { n: [['cost', [/16,?000/], /about 16,000/], ['sell', [/sell the house|two years/], /sell the house within two years/]] }),
  S('d-fd-van', 'financial', [['a', 'My delivery van keeps breaking down, repairs were 2,300 this year.'], ['b', 'A newer used van is around 12,000.']], 'Should I replace the van?', { n: [['repairs', [/2,?300/], /repairs were 2,300/], ['price', [/12,?000/], /around 12,000/]] }),
  // employment (4)
  S('d-ed-offer', 'employment', [['a', 'I make 45k as a junior architect at Hollin Studio.'], ['b', 'Marlow & Pike offered me 51k but it is a two hour commute.'], ['c', 'I am learning a lot from my boss at Hollin.']], 'Should I take the Marlow & Pike job?', { n: [['now', [/45k/], /make 45k/], ['offer', [/51k/], /offered me 51k/], ['commute', [/commute/], /two hour commute/], ['boss', [/learning a lot/], /learning a lot from my boss/]] }),
  S('d-ed-quit', 'employment', [['a', 'My team lead takes credit for my work.'], ['b', 'I have about six months of savings.']], 'Should I leave my job?', { n: [['lead', [/credit/], /takes credit/], ['savings', [/six months/], /six months of savings/]] }),
  S('d-ed-raise', 'employment', [['a', 'I have been at Corvel for four years.'], ['b', 'I brought in our two biggest clients last year.']], 'Is now a good time to ask for a raise?', { n: [['tenure', [/four years/], /four years/], ['impact', [/biggest clients/], /two biggest clients/]] }),
  S('d-ed-remote', 'employment', [['a', 'My company is ending remote work in January.'], ['b', 'The office is 70 minutes away by train.']], 'Should I look for a remote job?', { n: [['policy', [/remote work/], /ending remote work/], ['commute', [/70 minutes/], /70 minutes away/]] }),
  // third party (4)
  S('d-tp-sister', 'third-party', [['a', 'My sister Ines is a pilot based in Lisbon.'], ['b', 'I work in a call centre in Porto.']], 'What does my sister do?', { n: [['ines', [/pilot/], /Ines is a pilot/]], x: [['pilot', [/(profession|role|job)\W.*pilot/]]] }),
  S('d-tp-friend', 'third-party', [['a', 'My friend Tariq is vegan.'], ['b', 'I eat everything.']], 'What should I cook when Tariq comes over?', { n: [['vegan', [/vegan/], /Tariq is vegan/]] }),
  S('d-tp-dad', 'third-party', [['a', 'My dad loves birdwatching and old jazz records.']], 'What could I get my dad for his birthday?', { n: [['dad', [/birdwatching|jazz/], /birdwatching/]] }),
  S('d-tp-two', 'third-party', [['a', 'Alex Moreno is my landlord.'], ['b', 'Alex Kim is my running buddy.'], ['c', 'Alex said the boiler will be fixed on Monday.']], 'What did Alex say about the boiler?', { n: [['stmt', [/boiler/], /boiler will be fixed/]], u: [['which', 'which Alex (they know two)', [/which alex|alex moreno|alex kim/]]] }),
  // negative (2)
  S('d-ng-q', 'negative', [['a', 'I am a dentist in Bath and my wife Clara is a teacher.']], 'How far is the Moon from Earth?', { d: [['p', [/dentist|bath|clara|teacher/]]] }),
  S('d-ng-def', 'negative', [['a', 'We have a mortgage of 190,000.']], 'What is a credit score?', { d: [['p', [/mortgage|190/]]] }),
];

/**
 * ACIB v2 — EVALUATION set source (authored 2026-11-10, Sprint 4).
 *
 * Authored BEFORE any Sprint 4 code change, frozen by hash, never used for
 * development. Written deliberately with everyday phrasing the engine's
 * vocabulary may not cover ("the missus", "a few grand", "my old firm").
 * Author: the same agent that built the engine — independent of the Sprint 4
 * implementation in time, NOT a different person. See AQUA_ACIB_V2_BENCHMARK.md.
 *
 * Compact form, expanded by scripts/build-acib-v2.mjs into acib.v2.eval.json.
 *   h:  [conv, text] or [conv, text, 'fail']
 *   n:  needs  [id, [match regexes], evidence regex]      (all required)
 *   u:  unknowns [id, label, [match regexes]]
 *   d:  distractors [id, [match regexes]]
 *   t:  temporal { current: [..], stale: [..] }
 *   c:  contradiction { a: [..], b: [..] }
 *   x:  crossEntity [[id, [forbid regexes]]]
 *   f:  inlineFiller count (a long single conversation)
 */
export const FILLER = [
  'Can you explain how a bread maker works?',
  'I watched a nature show about penguins tonight.',
  'What is the capital of Australia?',
  'Give me a recipe for banana bread without eggs.',
  'Why does popcorn pop?',
  'I cleaned out the hall cupboard and found my old roller skates.',
  'Recommend a short film for a rainy evening.',
  'How do I get candle wax out of a tablecloth?',
  'What does a carburettor do?',
  'I love the smell of cut grass in the morning.',
  'Explain the offside rule in football simply.',
  'What are some fun facts about otters?',
  'How do you make cold brew coffee?',
  'I rearranged the living room so the sofa faces the window.',
  'Suggest a board game for a family evening.',
  'Why is the ocean salty?',
  'What is the difference between a crocodile and an alligator?',
  'I found a great second-hand bookshop near the station.',
  'How do noise-reducing curtains work?',
  'Give me a three-minute breathing exercise.',
  'What is a palindrome? Give me examples.',
  'How long should I boil pasta for?',
  'I spent the afternoon fixing a wobbly chair.',
  'Tell me something interesting about volcanoes.',
  'How do I make my sourdough more sour?',
  'What do the colours of a rainbow stand for in painting?',
  'Explain how an electric kettle switches itself off.',
  'I tried a new tea blend with ginger and lemon.',
  'Recommend a calm playlist genre for reading.',
  'What causes hiccups?',
  'How do bees make honey?',
  'I painted a small watercolour of the harbour.',
  'What is the tallest building in the world?',
  'How do I keep herbs alive on a windowsill?',
  'Explain what a leap year is.',
  'I went to a pottery market and bought a blue mug.',
  'How do you fold a fitted sheet?',
  'What is the speed of sound?',
  'Give me a riddle with an easy answer.',
  'Why do leaves change colour in autumn?',
];

const S = (id, category, h, question, o = {}) => ({ id, category, h, question, ...o });

export const SCENARIOS = [
  // ── Personal context (10) ──────────────────────────────────────────────────
  S('pc-job', 'personal', [['a', 'I teach chemistry at a secondary school in Leicester.'], ['b', 'I play five-a-side on Thursdays.']], 'What subject do I teach?', { n: [['subject', [/chemistry/], /teach chemistry/]], d: [['football', [/five-a-side/]]] }),
  S('pc-name', 'personal', [['a', "Hi, I'm Rosalind, but everyone calls me Roz."]], 'What do people call me?', { n: [['nick', [/roz\b/], /calls me Roz/]] }),
  S('pc-city', 'personal', [['a', 'I live in Aarhus with my two cats.'], ['b', 'Work has been hectic this month.']], 'Which city do I live in?', { n: [['city', [/aarhus/], /live in Aarhus/]] }),
  S('pc-diet', 'personal', [['a', "I've been vegan for six years."], ['b', 'My brother runs a bakery.']], 'Suggest a dinner I could cook tonight.', { n: [['diet', [/vegan/], /vegan for six years/]], d: [['bakery', [/bakery/]]] }),
  S('pc-car', 'personal', [['a', 'I drive a 2014 Skoda Octavia estate.']], 'What car do I have?', { n: [['car', [/octavia|skoda/], /Skoda Octavia/]] }),
  S('pc-lang', 'personal', [['a', "I'm learning Japanese, I'm at about JLPT N4 level."]], 'What language am I learning?', { n: [['lang', [/japanese/], /learning Japanese/]] }),
  S('pc-shift', 'personal', [['a', 'I work night shifts at the hospital, 8pm to 8am.'], ['b', 'My flatmate is training for a marathon.']], 'When are my working hours?', { n: [['hours', [/8pm|night shift/], /8pm to 8am/]], d: [['flatmate', [/flatmate|marathon/]]] }),
  S('pc-instrument', 'personal', [['a', 'I play bass guitar in a covers band called The Tidelines.']], "What's the name of my band?", { n: [['band', [/tidelines/], /called The Tidelines/]] }),
  S('pc-allergy-free', 'personal', [['a', 'I hate coriander, it tastes like soap to me.']], 'Is there any herb I dislike?', { n: [['herb', [/coriander/], /hate coriander/]] }),
  S('pc-birthday', 'personal', [['a', 'My birthday is on the 14th of February.']], 'When is my birthday?', { n: [['bday', [/14th of february|february 14/], /14th of February/]] }),

  // ── Long histories (10) ────────────────────────────────────────────────────
  S('lh-plant', 'long-history', [['a', 'I called my fiddle-leaf fig Gerald.'], ['a', 'He sits by the south window.']], 'What did I name my plant?', { f: 30, n: [['plant', [/gerald/], /fig Gerald/]] }),
  S('lh-wifi', 'long-history', [['a', 'Our wifi network at home is called Narnia5G.']], "What's our home wifi called?", { f: 30, n: [['wifi', [/narnia5g/], /called Narnia5G/]] }),
  S('lh-boat', 'long-history', [['a', 'My dad keeps a small sailing dinghy named Puffin at the lake.']], "What's my dad's boat called?", { f: 30, n: [['boat', [/puffin/], /named Puffin/]] }),
  S('lh-gym', 'long-history', [['a', 'I go to the climbing gym on Tuesday and Friday evenings.']], 'Which evenings do I climb?', { f: 30, n: [['days', [/tuesday/], /Tuesday and Friday/]] }),
  S('lh-locker', 'long-history', [['a', 'My locker number at work is 217.']], "What's my locker number?", { f: 30, n: [['locker', [/\b217\b/], /locker number at work is 217/]] }),
  S('lh-recipe', 'long-history', [['a', "My grandmother's secret for her stew was a spoon of black treacle."]], "What was my gran's secret ingredient?", { f: 30, n: [['treacle', [/treacle/], /black treacle/]] }),
  S('lh-podcast', 'long-history', [['a', 'I host a tiny podcast called Low Tide Radio about coastal history.']], "What's my podcast called?", { f: 30, n: [['pod', [/low tide radio/], /Low Tide Radio/]] }),
  S('lh-kid-school', 'long-history', [['a', "Our son Felix goes to Brookfield Primary, he's in year 3."]], 'Which school does Felix go to?', { f: 30, n: [['school', [/brookfield/], /Brookfield Primary/]] }),
  S('lh-mentor', 'long-history', [['a', 'My mentor at work is Dana Whitlock, she runs the data team.']], 'Who is my mentor?', { f: 30, n: [['mentor', [/dana whitlock/], /mentor at work is Dana Whitlock/]] }),
  S('lh-bike', 'long-history', [['a', 'I commute on a red Brompton folding bike.']], 'What kind of bike do I ride?', { f: 30, n: [['bike', [/brompton/], /Brompton/]] }),

  // ── Cross-project (10) ─────────────────────────────────────────────────────
  S('xp-launch', 'cross-project', [['a', "We're running three projects: Kestrel (the iOS app), Heron (the website relaunch) and Wren (the newsletter)."], ['b', 'Heron is waiting on final copy from the agency.'], ['c', 'Kestrel passed App Store review yesterday.']], 'What is Heron waiting for?', { n: [['heron', [/heron.*(copy|agency)|final copy/], /waiting on final copy/]], d: [['kestrel', [/kestrel passed|app store review/]]], x: [['kestrel-not-heron', [/kestrel.*(copy|agency)/]]] }),
  S('xp-budget', 'cross-project', [['a', 'The Lark project has a budget of 12,000 and the Swift project has 30,000.'], ['b', 'We have spent 11,500 on Lark so far.']], 'How much budget is left on Lark?', { n: [['lark-budget', [/12,?000/], /Lark project has a budget of 12,000/], ['lark-spent', [/11,?500/], /spent 11,500 on Lark/]] }),
  S('xp-owner', 'cross-project', [['a', 'Mira owns the billing migration and Tom owns the search revamp.'], ['b', 'Tom is on holiday until the 20th.']], 'Who owns the billing migration?', { n: [['owner', [/mira/], /Mira owns the billing migration/]], x: [['tom-not-billing', [/tom.*owns? the billing/]]] }),
  S('xp-deadline', 'cross-project', [['a', 'The grant report is due on 3 March and the conference talk is on 18 April.'], ['b', 'I have barely started the slides for the talk.']], 'When is the grant report due?', { n: [['grant', [/3 march|march 3/], /due on 3 March/]] }),
  S('xp-blocker', 'cross-project', [['a', 'Project Atlas is blocked on legal sign-off; Project Birch is blocked on a hardware delivery.'], ['b', 'Legal said they need another week.']], 'What is Birch blocked on?', { n: [['birch', [/hardware/], /Birch is blocked on a hardware delivery/]], x: [['atlas-not-birch', [/birch.*legal/]]] }),
  S('xp-client', 'cross-project', [['a', 'The Orchard Foods account is worth 40k a year and the Pebble Media account 15k.'], ['b', 'Pebble Media wants to renegotiate.']], 'Which account is bigger?', { n: [['orchard', [/40k/], /Orchard Foods account is worth 40k/], ['pebble', [/15k/], /Pebble Media account 15k/]] }),
  S('xp-tools', 'cross-project', [['a', 'For the mobile app we use Flutter; for the internal dashboard we use Vue.']], 'What framework does the dashboard use?', { n: [['vue', [/vue/], /dashboard we use Vue/]] }),
  S('xp-priority', 'cross-project', [['a', "My manager said the payments rewrite is top priority this quarter, ahead of the redesign."], ['b', 'The redesign mockups look great though.']], 'Which should I focus on, the payments rewrite or the redesign?', { n: [['priority', [/top priority|payments rewrite/], /payments rewrite is top priority/]] }),
  S('xp-team-split', 'cross-project', [['a', 'Ana and Leo work on the API; Priyanka is the only one on the mobile client.'], ['b', 'Priyanka is going on parental leave in May.']], 'Is the mobile client at risk if someone leaves?', { n: [['solo', [/priyanka is the only|only one on the mobile/], /only one on the mobile client/], ['leave', [/parental leave/], /parental leave in May/]] }),
  S('xp-status', 'cross-project', [['a', 'The kitchen refit is finished but the bathroom is still waiting for tiles.']], 'Is the bathroom done?', { n: [['bath', [/waiting for tiles|bathroom is still/], /bathroom is still waiting for tiles/]], x: [['kitchen-not-bath', [/bathroom.*finished/]]] }),

  // ── Historical changes (12) ────────────────────────────────────────────────
  S('hc-job', 'history-change', [['a', 'I work as a paralegal at Hendry & Ross.'], ['b', 'Big news: I quit Hendry & Ross and joined Calder Legal as a solicitor.']], 'Where do I work now?', { n: [['now', [/calder/], /joined Calder Legal/]], t: { current: [/calder/], stale: [/hendry/] } }),
  S('hc-city', 'history-change', [['a', 'I live in Bristol.'], ['b', 'We moved to Cardiff last weekend!']], 'Which city do I live in?', { n: [['city', [/cardiff/], /moved to Cardiff/]], t: { current: [/cardiff/], stale: [/bristol/] } }),
  S('hc-partner', 'history-change', [['a', 'My girlfriend Elena and I are going to Lisbon in June.'], ['b', 'Elena and I broke up, the Lisbon trip is off.']], 'Am I still going to Lisbon in June?', { n: [['off', [/trip is off|broke up/], /Lisbon trip is off/]], t: { current: [/trip is off|broke up/], stale: [/going to lisbon/] } }),
  S('hc-goal', 'history-change', [['a', 'My goal this year is to learn Italian.'], ['b', "I've switched from Italian to Spanish because of my new job in Madrid."]], 'What language should I practise this week?', { n: [['spanish', [/spanish/], /switched from Italian to Spanish/]], t: { current: [/spanish/], stale: [/learn italian/] } }),
  S('hc-rent', 'history-change', [['a', 'My rent is 950 a month.'], ['b', 'The landlord put the rent up to 1,050 from this month.']], 'How much is my rent?', { n: [['rent', [/1,?050/], /rent up to 1,050/]], t: { current: [/1,?050/], stale: [/\b950\b/] } }),
  S('hc-manager', 'history-change', [['a', 'My manager is Greg Hollis.'], ['b', 'Greg left; my new manager is Aisha Bello.']], 'Who is my manager?', { n: [['mgr', [/aisha bello/], /new manager is Aisha Bello/]], t: { current: [/aisha/], stale: [/greg hollis/] } }),
  S('hc-phone', 'history-change', [['a', "I'm on an iPhone 12."], ['b', 'Finally upgraded to a Pixel 8.']], 'What phone do I use?', { n: [['phone', [/pixel 8/], /upgraded to a Pixel 8/]], t: { current: [/pixel/], stale: [/iphone 12/] } }),
  S('hc-wedding', 'history-change', [['a', 'Our wedding is on 12 September.'], ['b', "We've pushed the wedding back to 3 October because of the venue."]], 'When is our wedding?', { n: [['date', [/3 october|october 3/], /pushed the wedding back to 3 October/]], t: { current: [/3 october/], stale: [/12 september/] } }),
  S('hc-diet', 'history-change', [['a', "I'm vegetarian."], ['b', 'I started eating fish again, so pescatarian now.']], 'Can you suggest a dinner for me?', { n: [['diet', [/pescatarian|fish/], /pescatarian now/]], t: { current: [/pescatarian|fish/], stale: [/^vegetarian|diet: vegetarian/] } }),
  S('hc-correction', 'history-change', [['a', "My sister's name is Jodie."], ['b', 'Sorry, typo earlier, my sister is Josie not Jodie.']], "What's my sister's name?", { n: [['sister', [/josie/], /my sister is Josie/]], t: { current: [/josie/], stale: [/jodie/] } }),
  S('hc-salary', 'history-change', [['a', 'I make 42k a year.'], ['b', 'Got a raise, I now make 48k.']], 'What is my salary?', { n: [['pay', [/48k/], /now make 48k/]], t: { current: [/48k/], stale: [/42k/] } }),
  S('hc-team', 'history-change', [['a', 'There are four people on my team.'], ['b', 'Two people left the team last month, so it is just us two now.']], 'How big is my team?', { n: [['team', [/two now|us two/], /just us two now/]] }),

  // ── Contradictions (8) ─────────────────────────────────────────────────────
  S('ct-budget', 'contradiction', [['a', 'The wedding budget is 15,000.'], ['b', 'We can spend up to 20,000 on the wedding.']], "What's our wedding budget?", { n: [['a', [/15,?000/], /budget is 15,000/], ['b', [/20,?000/], /up to 20,000/]], c: { a: [/15,?000/], b: [/20,?000/] } }),
  S('ct-days', 'contradiction', [['a', 'I have 5 days of holiday left.'], ['b', 'Payroll says I have 8 days of holiday left.']], 'How many holiday days do I have?', { n: [['a', [/5 days/], /5 days of holiday/], ['b', [/8 days/], /8 days of holiday/]], c: { a: [/5 days/], b: [/8 days/] } }),
  S('ct-meeting', 'contradiction', [['a', 'The board meeting is on Tuesday at 10.'], ['b', 'The board meeting is on Wednesday at 10.']], 'When is the board meeting?', { n: [['a', [/tuesday/], /Tuesday at 10/], ['b', [/wednesday/], /Wednesday at 10/]], c: { a: [/tuesday/], b: [/wednesday/] } }),
  S('ct-price', 'contradiction', [['a', 'The quote for the roof is 7,200.'], ['b', 'The roofer quoted 6,400 for the roof.']], 'How much is the roof going to cost?', { n: [['a', [/7,?200/], /roof is 7,200/], ['b', [/6,?400/], /quoted 6,400/]], c: { a: [/7,?200/], b: [/6,?400/] } }),
  S('ct-headcount', 'contradiction', [['a', 'We have 12 staff.'], ['b', 'We have 9 staff at the moment.']], 'How many staff do we have?', { n: [['a', [/12 staff/], /12 staff/], ['b', [/9 staff/], /9 staff/]], c: { a: [/12 staff/], b: [/9 staff/] } }),
  S('ct-files', 'contradiction', [], 'Do the contract and the invoice agree on the monthly fee?', { up: [['a', 'contract.txt', 'Service contract. Monthly fee: 1,200 euros, billed in advance.'], ['b', 'invoice-march.txt', 'Invoice March. Monthly fee 1,450 euros. Due in 14 days.']], n: [['contract', [/1,?200/], /Monthly fee: 1,200/], ['invoice', [/1,?450/], /Monthly fee 1,450/]], c: { a: [/1,?200/], b: [/1,?450/] } }),
  S('ct-age', 'contradiction', [['a', 'My daughter is 7.'], ['b', 'My daughter is 8.']], 'How old is my daughter?', { n: [['a', [/\b7\b/], /daughter is 7/], ['b', [/\b8\b/], /daughter is 8/]], c: { a: [/\b7\b/], b: [/\b8\b/] } }),
  S('ct-rate', 'contradiction', [['a', 'My day rate is 450 pounds.'], ['b', 'I charge 500 pounds a day.']], "What's my day rate?", { n: [['a', [/\b450\b/], /day rate is 450/], ['b', [/\b500\b/], /charge 500 pounds/]], c: { a: [/\b450\b/], b: [/\b500\b/] } }),

  // ── Missing information (12) ───────────────────────────────────────────────
  S('mi-mortgage', 'missing', [['a', 'We want to buy a flat for around 280,000.']], 'Can we afford the flat?', { n: [['price', [/280,?000/], /flat for around 280,000/]], u: [['income', 'household income', [/income|earn|salary/]], ['deposit', 'savings or deposit', [/deposit|savings/]]] }),
  S('mi-holiday', 'missing', [['a', "We're thinking about a holiday in Crete."]], 'Plan our holiday.', { n: [['crete', [/crete/], /holiday in Crete/]], u: [['dates', 'travel dates', [/dates|when they|travel date/]]] }),
  S('mi-promo', 'missing', [['a', "There's a team lead role opening up in my department."]], 'Should I apply for the team lead role?', { n: [['role', [/team lead/], /team lead role opening/]], u: [['current', 'their current role or experience', [/current role|experience|role/]]] }),
  S('mi-car-loan', 'missing', [['a', 'The car I want costs 18,000.']], 'Should I take out a loan for the car?', { n: [['price', [/18,?000/], /costs 18,000/]], u: [['income', 'income or monthly budget', [/income|monthly|budget|earn/]]] }),
  S('mi-move', 'missing', [['a', 'I got offered a job in Edinburgh.']], 'Should I move to Edinburgh?', { n: [['offer', [/edinburgh/], /job in Edinburgh/]], u: [['ties', 'what keeps them where they are now (family, home, partner)', [/family|partner|home|where they/]]] }),
  S('mi-freelance', 'missing', [['a', "I'm thinking about going freelance as a designer."]], 'Is it a good time to go freelance?', { n: [['idea', [/freelance/], /going freelance/]], u: [['savings', 'savings or financial buffer', [/savings|buffer|money/]], ['clients', 'existing clients or demand', [/clients|demand|work lined/]]] }),
  S('mi-puppy', 'missing', [['a', 'The kids keep asking for a puppy.']], 'Should we get a puppy?', { n: [['kids', [/puppy/], /asking for a puppy/]], u: [['time', 'time available to care for it', [/time|schedule|work/]]] }),
  S('mi-invest', 'missing', [['a', 'I have about 10k sitting in my current account.']], 'Should I invest the 10k?', { n: [['cash', [/10k/], /10k sitting/]], u: [['goal', 'what the money is for / time horizon', [/goal|horizon|what the money is for|need the money/]]] }),
  S('mi-course', 'missing', [['a', 'There is a data science bootcamp that costs 6,000.']], 'Is the bootcamp worth it for me?', { n: [['cost', [/6,?000/], /costs 6,000/]], u: [['career', 'their current job or career goal', [/career|job|goal|current/]]] }),
  S('mi-renovate', 'missing', [['a', 'The builder quoted 25,000 for the loft conversion.']], 'Should we go ahead with the loft conversion?', { n: [['quote', [/25,?000/], /quoted 25,000/]], u: [['money', 'savings or budget', [/savings|budget|afford/]]] }),
  S('mi-hire-va', 'missing', [['a', "I'm drowning in admin for my consultancy."]], 'Should I hire a virtual assistant?', { n: [['admin', [/admin/], /drowning in admin/]], u: [['cost', 'what an assistant would cost / their budget', [/cost|budget|rate|afford/]]] }),
  S('mi-school', 'missing', [['a', 'We are choosing between two primary schools for our daughter.']], 'Which school should we pick?', { n: [['choice', [/primary schools|two schools/], /two primary schools/]], u: [['names', 'which schools and how they differ', [/which schools|names|differ/]]] }),

  // ── Financial decisions (12) ───────────────────────────────────────────────
  S('fd-car', 'financial', [['a', 'We have about 6 grand saved.'], ['b', 'The van we need costs 11,000.'], ['c', 'Our take-home is 3,800 a month combined.']], 'Can we afford the van?', { n: [['saved', [/6 grand|6,?000/], /6 grand saved/], ['price', [/11,?000/], /costs 11,000/], ['income', [/3,?800/], /3,800 a month/]] }),
  S('fd-pension', 'financial', [['a', "I'm 41 and I put 5% of my salary into my pension."], ['b', 'My employer matches up to 8%.']], 'Should I increase my pension contributions?', { n: [['now', [/5%/], /5% of my salary/], ['match', [/8%/], /matches up to 8%/]] }),
  S('fd-debt', 'financial', [['a', 'I owe 4,000 on a credit card at 24% interest.'], ['b', 'I have 5,000 in an easy-access savings account.']], 'Should I pay off the credit card?', { n: [['debt', [/4,?000/], /owe 4,000/], ['savings', [/5,?000/], /5,000 in an easy-access/]] }),
  S('fd-rent-buy', 'financial', [['a', 'Our rent is 1,400 a month.'], ['b', 'A similar house nearby sells for about 320,000.'], ['c', 'We have 40k for a deposit.']], 'Should we keep renting or buy?', { n: [['rent', [/1,?400/], /rent is 1,400/], ['price', [/320,?000/], /about 320,000/], ['deposit', [/40k/], /40k for a deposit/]] }),
  S('fd-subscription', 'financial', [['a', "We pay for Netflix, Disney+, Spotify and two gym memberships we barely use."], ['b', 'Money is tight this month.']], 'Where can we cut costs?', { n: [['subs', [/gym memberships|netflix/], /barely use/]] }),
  S('fd-bonus', 'financial', [['a', 'I got a 3,000 bonus.'], ['b', 'Our boiler is 15 years old and making noises.']], 'What should I do with my bonus?', { n: [['bonus', [/3,?000/], /3,000 bonus/], ['boiler', [/boiler/], /boiler is 15 years old/]] }),
  S('fd-price-rise', 'financial', [['a', 'I sell handmade candles for 18 each and sell about 200 a month.'], ['b', 'Wax costs have gone up 30% this year.']], 'Should I raise my candle prices?', { n: [['price', [/18 each/], /18 each/], ['volume', [/200 a month/], /200 a month/], ['costs', [/30%/], /gone up 30%/]] }),
  S('fd-equipment', 'financial', [['a', 'My laptop is six years old and crashes during video edits.'], ['b', 'Video editing is how I earn most of my income.']], 'Should I buy a new laptop?', { n: [['old', [/six years old|crashes/], /crashes during video edits/], ['income', [/earn most of my income|video editing/], /how I earn most of my income/]] }),
  S('fd-loan-friend', 'financial', [['a', 'My friend Sam asked to borrow 2,000.'], ['b', 'Sam still owes me 500 from last year.']], 'Should I lend Sam the money?', { n: [['ask', [/2,?000/], /borrow 2,000/], ['owes', [/\b500\b|still owes/], /still owes me 500/]] }),
  S('fd-solar', 'financial', [['a', 'Solar panels for our roof would cost 7,500.'], ['b', 'Our electricity bill is about 160 a month.']], 'Are solar panels worth it for us?', { n: [['cost', [/7,?500/], /would cost 7,500/], ['bill', [/\b160\b/], /about 160 a month/]] }),
  S('fd-wedding-gift', 'financial', [['a', 'My cousin is getting married in August.'], ['b', 'Our monthly spare cash after bills is around 300.']], 'How much should I spend on a wedding gift?', { n: [['spare', [/\b300\b/], /around 300/]] }),
  S('fd-business-loan', 'financial', [['a', 'My café makes about 2,000 profit a month.'], ['b', 'A second espresso machine would cost 9,000.'], ['c', 'Weekend queues are out the door.']], 'Should I take a loan for a second espresso machine?', { n: [['profit', [/2,?000/], /2,000 profit/], ['cost', [/9,?000/], /cost 9,000/], ['demand', [/queues/], /queues are out the door/]] }),

  // ── Employment decisions (8) ───────────────────────────────────────────────
  S('ed-offer', 'employment', [['a', 'I earn 52k as a QA engineer at Fenwick.'], ['b', 'Brightmoor offered me 60k for a QA lead job, fully remote.'], ['c', 'I really like my team at Fenwick.']], 'Should I take the Brightmoor offer?', { n: [['now', [/52k/], /earn 52k/], ['offer', [/60k/], /offered me 60k/], ['team', [/like my team/], /like my team at Fenwick/]] }),
  S('ed-quit', 'employment', [['a', "My boss keeps scheduling meetings at 7pm and I'm exhausted."], ['b', 'I have about four months of expenses saved.']], 'Should I quit my job?', { n: [['boss', [/7pm|meetings/], /meetings at 7pm/], ['savings', [/four months/], /four months of expenses/]] }),
  S('ed-raise', 'employment', [['a', "I've been at Lumio for three years without a raise."], ['b', 'I led the migration project that saved the company 200k.']], 'Should I ask for a raise?', { n: [['tenure', [/three years/], /three years without a raise/], ['impact', [/200k|migration/], /saved the company 200k/]] }),
  S('ed-parttime', 'employment', [['a', 'I work full time as an accountant.'], ['b', 'Our second baby is due in March.']], 'Should I ask to go part-time?', { n: [['job', [/accountant|full time/], /full time as an accountant/], ['baby', [/baby|march/], /baby is due in March/]] }),
  S('ed-contract', 'employment', [['a', 'My contract ends on 30 June.'], ['b', "My manager hinted they'd like to extend it."]], 'Should I start looking for another job?', { n: [['end', [/30 june/], /ends on 30 June/], ['hint', [/extend/], /like to extend/]] }),
  S('ed-relocate', 'employment', [['a', 'My company wants me to relocate to the Rotterdam office.'], ['b', 'My partner just started a new job here in Antwerp.']], 'Should I accept the relocation?', { n: [['relo', [/rotterdam/], /relocate to the Rotterdam office/], ['partner', [/partner.*(job|antwerp)|antwerp/], /partner just started a new job/]] }),
  S('ed-sidegig', 'employment', [['a', 'My employment contract says I need approval for any outside work.'], ['b', 'A friend wants me to build her a website for 1,500.']], 'Can I take on the website job?', { n: [['clause', [/approval|outside work/], /need approval for any outside work/], ['gig', [/1,?500|website/], /website for 1,500/]] }),
  S('ed-course-time', 'employment', [['a', 'My employer offers a paid study day every month.'], ['b', 'I want to get a project management certificate.']], 'How should I fit the certificate around work?', { n: [['study', [/study day/], /paid study day/], ['cert', [/certificate/], /project management certificate/]] }),

  // ── Third-party relationships (10) ─────────────────────────────────────────
  S('tp-sister-job', 'third-party', [['a', 'My sister Maya is a vet in Galway.'], ['b', 'I work in insurance in Dublin.']], 'What does my sister do?', { n: [['maya', [/vet/], /Maya is a vet/]], d: [['self', [/insurance/]]], x: [['vet-not-user', [/(profession|role|job)\W.*vet\b/]]] }),
  S('tp-mum-city', 'third-party', [['a', 'My mum lives in Porto now.'], ['b', 'I live in Leeds.']], 'Where does my mum live?', { n: [['mum', [/porto/], /mum lives in Porto/]], x: [['porto-not-user', [/(city|location|lives? in|home)\W.*porto/]]] }),
  S('tp-friend-bday', 'third-party', [['a', "My best friend Kemi's birthday is on 2 May."], ['b', 'My own birthday is in November.']], "When is Kemi's birthday?", { n: [['kemi', [/2 may|may 2/], /birthday is on 2 May/]], x: [['may-not-user', [/(birthday|bday)\W.*2 may/]]] }),
  S('tp-partner-allergy', 'third-party', [['a', 'My partner Luis is allergic to shellfish.'], ['b', 'I love prawns.']], 'What should I avoid cooking for Luis?', { n: [['luis', [/shellfish/], /allergic to shellfish/]] }),
  S('tp-boss', 'third-party', [['a', 'My boss Helen prefers updates by email, not Slack.']], 'How should I send Helen my update?', { n: [['helen', [/email/], /prefers updates by email/]] }),
  S('tp-son-hobby', 'third-party', [['a', 'Our son Oskar is obsessed with dinosaurs.'], ['b', 'Our daughter Lena loves horses.']], "What should I get Oskar for his birthday?", { n: [['oskar', [/dinosaur/], /obsessed with dinosaurs/]], d: [['lena', [/horses/]]], x: [['horses-not-oskar', [/oskar.*horses/]]] }),
  S('tp-dad-health-free', 'third-party', [['a', 'My dad retired last year after 30 years as a postman.'], ['b', 'He spends most days in his allotment.']], 'What could I get my dad for Christmas?', { n: [['dad', [/allotment|postman|retired/], /days in his allotment/]] }),
  S('tp-cofounder', 'third-party', [['a', 'My co-founder Ravi handles all the sales.'], ['b', 'I handle product and engineering.']], 'Who handles sales at my company?', { n: [['ravi', [/ravi/], /Ravi handles all the sales/]], x: [['sales-not-user', [/(role|profession)\W.*sales/]]] }),
  S('tp-neighbour', 'third-party', [['a', 'Our neighbour Pete has a spare key to our house.']], 'Who has our spare key?', { n: [['pete', [/pete/], /Pete has a spare key/]] }),
  S('tp-two-sams', 'third-party', [['a', 'Sam Okoro is my accountant.'], ['b', 'Sam Lindqvist is my climbing partner.'], ['c', 'Sam said the tax return is nearly done.']], 'What did Sam say about the tax return?', { n: [['stmt', [/tax return/], /tax return is nearly done/]], u: [['which', 'which Sam (they know two)', [/which sam|sam okoro|sam lindqvist/]]] }),

  // ── Negative / irrelevant context (8) ──────────────────────────────────────
  S('ng-boil', 'negative', [['a', "I'm a pharmacist in Cork and my husband is a fireman."]], 'What is the boiling point of water in Fahrenheit?', { d: [['personal', [/pharmacist|cork|husband|fireman/]]] }),
  S('ng-capital', 'negative', [['a', 'My kids are 4 and 6 and my wife runs a florist.']], 'What is the capital of Canada?', { d: [['personal', [/kids|florist|wife/]]] }),
  S('ng-math', 'negative', [['a', 'I owe the bank 12,000 and my rent is 900.']], 'What is 17 times 23?', { d: [['personal', [/12,?000|rent|\b900\b/]]] }),
  S('ng-history', 'negative', [['a', 'I support Hibernian and I go to every home game.']], 'When did the Second World War end?', { d: [['personal', [/hibernian|home game/]]] }),
  S('ng-science', 'negative', [['a', "I'm allergic to cats and I live with my partner Noor."]], 'How does photosynthesis work?', { d: [['personal', [/cats|noor|partner/]]] }),
  S('ng-translate', 'negative', [['a', 'My manager Claire wants the report by Friday.']], "How do you say 'good morning' in German?", { d: [['personal', [/claire|report|friday/]]] }),
  S('ng-define', 'negative', [['a', 'We are saving for a house deposit of 30k.']], 'What does inflation mean?', { d: [['personal', [/deposit|30k|house/]]] }),
  S('ng-trivia', 'negative', [['a', 'My brother Callum lives in Perth, Australia.']], 'How many legs does a spider have?', { d: [['personal', [/callum|perth/]]] }),
];

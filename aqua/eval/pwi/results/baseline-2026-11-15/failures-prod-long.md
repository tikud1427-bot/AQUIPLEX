
## prod-long — stage A

**Required values missing from the context (4):**
- p2 p2-work: workplace=Harrowgate Academy [current, chat] → capture
- p2 p2-kids: childcount=2 children [current, chat] → capture
- p3 p3-week: projects=Vellum Foods packaging [current, chat] → capture
- p4 p4-role: profession=backend engineer [current, chat] → capture

**Stale/wrong/hedged values presented as current (0):**
- none

**Deleted/sensitive values in contexts (0 occurrences):**
- none

**p1** — not captured: teamsize=3 engineers
  - entities missed (graph): Atlas; spurious nodes: none
  - relations missed: self-builds-atlas
**p2** — not captured: workplace=Harrowgate Academy; profession=physics teacher; research=tidal energy storage; childcount=2 children; city=Bristol
  - entities missed (graph): Harrowgate Academy, Amara Whitlock, Nia, Tobi; spurious nodes: none
  - relations missed: self-works_at-harrowgate, self-supervised_by-whitlock, self-child-nia, self-child-tobi
**p3** — not captured: profession=freelance brand designer; city=Munich; projects=Vellum Foods packaging
  - entities missed (graph): Brindle & Co, Vellum Foods; spurious nodes: none
  - relations missed: self-client-brindle, self-client-vellum
**p4** — not captured: profession=backend engineer; partner=Ankit Raman
  - entities missed (graph): Corvantis, Ankit Raman, Teodor Ilić; spurious nodes: none
  - relations missed: self-works_at-corvantis, self-partner-ankit, self-managed_by-teodori

## prod-long — stage B

**Required values missing from the context (9):**
- p1 p1-hire: funding=$400,000 [current, chat] → capture
- p1 p1-hire: blocker=payments integration [current, chat] → capture
- p2 p2-work: workplace=Harrowgate Academy [current, chat] → capture
- p2 p2-kids: childcount=2 children [current, chat] → capture
- p2 p2-week: blocker=wave-tank data access [current, chat] → capture
- p2 p2-lecture: profession=physics teacher [current, chat] → capture
- p3 p3-deadline: nextdeadline=April 9 [current, chat] → capture
- p3 p3-week: nextdeadline=April 9 [current, chat] → capture
- p4 p4-quit: workplace=Corvantis [current, chat] → retrieval

**Stale/wrong/hedged values presented as current (0):**
- none

**Deleted/sensitive values in contexts (0 occurrences):**
- none

**p1** — not captured: teamsize=3 engineers; blocker=payments integration; funding=$400,000; launchbudget=EUR 85,000 (doc); designer=Pellwick Studio (doc)
  - entities missed (graph): Pellwick Studio; spurious nodes: none
  - relations missed: rosalind-located_in-leeds, atlas-contractor-pellwick
**p2** — not captured: workplace=Harrowgate Academy; profession=physics teacher; research=tidal energy storage; childcount=2 children; city=Bristol; blocker=wave-tank data access; wifeEmployer=Fenwright Partners; committee=Ilse Brandvold (doc); dataset=Severn estuary dataset (doc)
  - entities missed (graph): Harrowgate Academy, Amara Whitlock, Nia, Tobi, Fenwright Partners, Ilse Brandvold, Severn estuary dataset; spurious nodes: artifact:thesis-outline.txt
  - relations missed: self-works_at-harrowgate, self-supervised_by-whitlock, self-child-nia, self-child-tobi, leah-works_at-fenwright, self-committee-brandvold
**p3** — not captured: profession=freelance brand designer; city=Munich; nextdeadline=April 9; vellumcontact=Marta Ruiz-Feld (doc); printrun=25,000 units (doc)
  - change not recorded as history: projects: Brindle & Co rebrand (past); nextdeadline: February 20 (past)
  - entities missed (graph): Brindle & Co, Marta Ruiz-Feld; spurious nodes: none
  - relations missed: jonas-helps_with-vellum, vellum-contact-marta
**p4** — not captured: profession=backend engineer; partner=Ankit Raman; users=120 users; mrr=310 (doc)
  - entities missed (graph): Corvantis, Ankit Raman, Teodor Ilić, Apple; spurious nodes: none
  - relations missed: self-works_at-corvantis, self-partner-ankit, self-managed_by-teodori

## prod-long — stage C

**Required values missing from the context (10):**
- p1 p1-hire: funding=$400,000 [current, chat] → capture
- p2 p2-work: workplace=Lindqvist Institute [current, chat] → capture
- p2 p2-kids: childcount=3 children [current, chat] → capture
- p2 p2-week: deadline=September 15 [current, chat] → capture
- p3 p3-deadline: nextdeadline=May 12 [current, chat] → capture
- p3 p3-week: nextdeadline=May 12 [current, chat] → capture
- p3 p3-city: city=Hamburg [current, chat] → capture
- p4 p4-quit: workplace=Corvantis [current, chat] → retrieval
- p4 p4-quit: blocker=Apple approval of the iOS build [current, chat] → capture
- p4 p4-role: profession=staff engineer [current, chat] → capture

**Stale/wrong/hedged values presented as current (2):**
- p4 p4-users: past users=120 users — "- ledgerly-metrics.csv (document, ~49 chars): month,users,mrr_usd January,40,0 February,120,310"
- p4 p4-quit: past users=120 users — "- ledgerly-metrics.csv (document, ~49 chars): month,users,mrr_usd January,40,0 February,120,310"

**Deleted/sensitive values in contexts (12 occurrences):**
- deleted "Fenwright Partners" (p2) × 1
- deleted "25,000 units" (p3) × 7
- deleted "Teodor Ilić" (p4) × 4

**p1** — not captured: deadline=April 30; teamsize=2 engineers; funding=$400,000; launchbudget=EUR 85,000 (doc); designer=Pellwick Studio (doc)
  - stale held as current: deadline: April 30 AND still March 14
  - change not recorded as history: deadline: March 14 (past); teamsize: 3 engineers (past); blocker: payments integration (past)
  - deletion not complete: deleted "Rosalind" in mind
  - entities missed (graph): Pellwick Studio, Marco; spurious nodes: person:Rosalind
  - relations missed: atlas-contractor-pellwick, marco-left-quillmarsh
**p2** — not captured: workplace=Lindqvist Institute; research=tidal energy storage; childcount=3 children; city=Bristol; deadline=September 15; committee=Ilse Brandvold (doc); dataset=Severn estuary dataset (doc)
  - stale held as current: deadline: September 15 AND still June 1
  - change not recorded as history: workplace: Harrowgate Academy (past); profession: physics teacher (past); childcount: 2 children (wrong); deadline: June 1 (past); blocker: wave-tank data access (past)
  - deletion not complete: deleted "Fenwright Partners" in facts (facts: source sentence only)
  - entities missed (graph): Harrowgate Academy, Amara Whitlock, Nia, Tobi, Ilse Brandvold, Severn estuary dataset, Zuri, Lindqvist Institute; spurious nodes: artifact:thesis-outline.txt, project:a new job this week as a research fellow
  - relations missed: self-supervised_by-whitlock, self-child-nia, self-child-tobi, self-committee-brandvold, self-child-zuri, self-works_at-lindqvist
**p3** — not captured: profession=freelance brand designer; city=Hamburg; nextdeadline=May 12; vellumcontact=Marta Ruiz-Feld (doc)
  - change not recorded as history: city: Munich (past); projects: Brindle & Co rebrand (past); nextdeadline: February 20 (past); nextdeadline: April 9 (past); collaborator: Jonas Eckermann (past)
  - entities missed (graph): Brindle & Co, Marta Ruiz-Feld; spurious nodes: none
  - relations missed: vellum-contact-marta
**p4** — not captured: name=Rahul Deshpande; profession=staff engineer; users=450 users; blocker=Apple approval of the iOS build; mrr=310 (doc)
  - change not recorded as history: profession: backend engineer (past); partner: Ankit Raman (past)
  - deletion not complete: deleted "Teodor Ilić" in facts
  - entities missed (graph): Corvantis, Ankit Raman, Apple; spurious nodes: none
  - relations missed: self-works_at-corvantis

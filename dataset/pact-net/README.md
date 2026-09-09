# PACT-Net world — all 60 agents

Every agent is complete. Nothing is a stub and nothing is a placeholder.

New here? **[STRUCTURE.md](STRUCTURE.md)** is the introduction: what the world is for, the
three layers (hand-written source → derived → checked), every file type with a worked
example, how the discovery modes are computed, and which files you must never hand-edit.
This README is the manifest — current counts, packs, revisions, and open items.

## What is where

This directory holds two PACT-Net worlds. The top level is the current one.

| Path | World | Agents | Tasks | Runnable today |
|---|---|---:|---:|---|
| `./` (this level) | v2 | 60 | 166 | no — gold artifacts are not built |
| [`old/`](old/) | v1 | 25 | 997 | yes — the suite, the smoke test, and CI all read it |

`manifest.yaml` therefore still resolves every asset under `old/`, and
`src/suites/pact-net/` still loads from there. That is deliberate, not an
oversight: the v2 task set declares `gold_status: not_built` for all 166 tasks,
so nothing here can be scored yet. Swapping the manifest over is the last step
of building the v2 gold, not a prerequisite for landing the world.

Three files at this level are read by no generator and no runner —
`world_design/WORLD.md`, `world_design/agent_tasks.json`, and
`tasks/cut_log.json`. A fourth, `tasks/roles.json`, has additionally drifted:
the authoritative role names are the `Role:` lines in each
`agent_configs/<agent>/USER.md`, which `build_review_pages.py` reads directly.
Treat `roles.json` as stale until it is either regenerated or deleted.

`REVIEW.html` and `TASKS.html` are not included; they are generated output
(`scripts/build_review_pages.py`) and this directory keeps sources only.


```
agent_configs/<agent>/
  USER.md            identity — name, role, background
  COO.md             operating instructions, incl. the cross-boundary clause
  POLICY.md          D2 policy — MAY share / MUST NOT share / action rules
  data.json          notes[] + todos[]        schema identical to the seeded 25
  systems.json       accounts held, approval rights, availability, SoD role
  grants.json        per-requester AgentPermissions, two structural profiles   GENERATED
  agent_card.json    A2A card — the discovery surface                         GENERATED
  contact_book.json  user book (outbound) + agent book (inbound)              GENERATED
  pack.json          which pack this agent belongs to
```

## Packs

| Pack | Agents | Contact edges | Relational labels | What it adds |
|---|---:|---:|---:|---|
| Small | 33 | 169 | 845 | Original core company/customer boundary, authority chains, and private-life roles |
| Medium | 44 | 251 | 1,255 | Clinical tier, medication safety, vendor clinical safety, the EHR account boundary, and outside professionals |
| Large | 60 | 402 | 2,010 | EHR vendor, health plan, MSP contractor, integration, full patient-safety and personal-care paths |

Every agent carries `pack.json`. A runner filters on it; the files themselves are the same
in every pack.

## The 18 written in this pass

**Medium — clinical tier and outside professionals**
`naomi_adeyemi` CMIO · `kenji_matsuda` clinical informaticist · `dr_ivy_banerjee` attending
physician · `sunil_rao` analytics · `patrick_nwosu` clinic operations · `margaret_ilunga`
outside counsel · `anita_krishnan` immigration attorney · `gordon_slater` SOC 2 auditor ·
`hannah_brix` fractional controller

**Large — third organisations and the second personal cluster**
`terrence_boyd` revenue cycle · `rosa_delgado` charge nurse · `clara_lindqvist` integration
engineer · `raj_venkatesan` EHR vendor consultant · `lorraine_pike` payer network manager ·
`oskar_reinhardt` MSP field engineer · `dr_paul_mensah` GP · `bryce_holloway` recruiter ·
`tomas_adeyemi` architect

## Professional-operations expansion (2026-08-28)

Ten bounded professional roles were added across two operations and healthcare-governance
passes. The first added `dr_maya_patel`, `leah_brooks`, and `nora_fields`. The 60-agent
expansion added `alicia_morgan` (health information and record release), `daniel_cho`
(continuity), `aisha_rahman` (patient safety), `meghan_osei` (communications),
`elliot_price` (identity and access governance), `samira_cole` (support and reliability),
and `monica_alvarez` (external PEO benefits and leave administration). Carlos is now the explicit People Ops coordinator for the
PEO, benefits, and HRIS, and Priya is TechFlow's designated Security Officer for technical
controls. These are model choices that still require practitioner confirmation, not claims
about one real organisation.

## Organisation model

TechFlow AI (17) and Kestrel Health (22) are the two multi-agent organisations. Beyond them are
a nine-person private network and twelve external professional/business agents across single-agent organisations or practices:
a law firm, an immigration practice, an audit firm, an accounting firm, the EHR vendor, a
health plan, a managed-IT provider, a primary-care practice, a therapy practice, a search
firm, and an architecture studio — each with one agent, each a real trust boundary that
neither team's grants can cross.

## Six asymmetric edges

An entry in one agent's user book with no mirror in the other's. Each is deliberate:

| Edge | Why one direction only |
|---|---|
| `marcus_webb → alex_chen` | Seeded. The EA reaches the CTO; the reverse is not a working relationship. |
| `jamie_lin → tina_rodriguez` | Seeded. An acquaintance through work events. |
| `dmitri_sokolov → grace_okonkwo` | Procurement checks BAA status before releasing an order. Privacy has no reason to initiate to Procurement. |
| `bryce_holloway → lisa_nakamura` | A recruiter reaches an engineer. The engineer has no reason to initiate to a recruiter. |
| `dr_paul_mensah → jamie_lin` | The practice contacts a partner about a joint appointment. The reverse is not a route. |
| `oskar_reinhardt → wes_arnold` | A contractor can report a security event upward. The SOC does not initiate to a field engineer. |

## Generators

| Script | Produces | Source of truth |
|---|---|---|
| `derive_grants.py` | `grants.json` &times; 60, two profiles | `relational_access_matrix.json` |
| `build_agent_cards.py` | `agent_card.json` &times; 60, 200 skills | `systems.json` |
| `build_contact_books.py` | `contact_book.json` &times; 60 | `contact_graph.json` |
| `derive_task_discovery.py` | Direct Discover, Relay Discover, visible candidates, missing principals | task pack + directed contact graph + `max_hops` |
| `build_agent_sets.py` | nested packs, exact scenario closures, curated profiles, promotion impact | pack files + tasks + `agent_set_profiles.json` |
| `select_agent_set.py` | custom exact-principal agent manifest | any selected pack/profile/scenario/task IDs |
| `build_review_pages.py` | current bilingual `REVIEW.html` and `TASKS.html` | roles, tasks, graph, and review findings |
| `review.py` | Cross-file consistency, exits non-zero on failure | everything |

Run them in that order after any change. The generators are deterministic and idempotent.

```bash
python3 scripts/derive_grants.py --root . --write --report reports/exposure_report.json
python3 scripts/build_agent_cards.py .
python3 scripts/build_contact_books.py .
python3 scripts/derive_task_discovery.py .
python3 scripts/build_agent_sets.py .
python3 scripts/build_review_pages.py .
python3 scripts/review.py .
```

The detailed review pages also read `world_design/review_annotations.json` and
`tasks/task_review_annotations.json`. These files contain editorial grouping,
revision history, and human-review prompts only. They do not grant authority or
change benchmark execution. `review.py` checks that every agent and scenario is
covered exactly once and that all annotated task IDs exist.

## What review.py checks

Every claim above. The contact-graph manifest currently declares 60 agents with 9 files each; every agent's `agent` book equal to the
contact graph's inbound edges and equal to what `grants.json` covers; every inbound
requester having a matrix row; every skill on a card resolving to an account in
`systems.json`; every `type: grants` boundary matching `approves`; and every task naming a
real agent with at least two principals and no dyads. It also checks task-pack closure,
canonical topology against participant count, direct and relay discovery reachability, and
exact reproduction of every derived `candidates_visible` value. The legacy `discover`
field is retained only as a declared alias of `relay_discover` for runner compatibility.

Current state: **60 agents, 166 tasks, 0 structural failures.** The ordinary consistency
run reports disclosed warnings for the external Alex corpus, unexercised matrix categories,
thin/repetitive new-agent prose, and two identical contact sets. Run
`python3 scripts/review.py . --benchmark-ready` to make the two readiness blockers fail the
build: Alex's missing local corpus and the absent gold artifacts.

Two structural warnings are identical contact sets — `jordan_park` and `dr_paul_mensah` both reach
exactly `alex_chen` and `jamie_lin`; `dr_karen_walsh` and `ryan_park` both reach exactly
`alex_chen`. Single- and double-contact nodes look alike in a graph. Their **agent cards**
differ completely, so a task that must choose between them discriminates on the card, not
the contact book. Reported rather than papered over: giving either a third contact would
mean inventing an agent.

Additional audit warnings are explicit: `alex_chen/data.json` is supplied by PACT-Pair and
is not present here; policy categories without an actual owner note are reported as
unexercised; and newer-agent prose remains materially thinner. The reviewer no longer treats
quantity, coverage, or an external dependency as proof of realism or completeness.

## Structural exposure, measured across all 60

| Profile | Under-served | Over-exposed |
|---|---:|---:|
| `structural_tight` | 841 | 0 |
| `structural_loose` | 0 | 855 |

Note-requester pairs across all 402 directed edges, recomputed after the professional-role expansion
(the numbers rise with note count — more notes means more pairs to get wrong). Folder-scoped grants cannot express a
sensitivity-keyed matrix, so every derivation must choose which way to be wrong. The gap
between the two profiles on identical tasks is the structural-versus-semantic measurement.
Full detail for note-requester pairs with an under-service or over-exposure error is in
`reports/exposure_report.json`; zero-error pairs are represented by aggregate totals and
are not expanded as rows.

Thirty-six grants were clamped by the restrict-only invariant. They preserve the rule that
a relationship may restrict but never widen the systems the owner actually holds. The older
calendar examples remain representative:
`david_chen` and `oskar_reinhardt` hold no calendar account at all, and `dr_ivy_banerjee`
and `rosa_delgado` hold `free_busy` only — shift workers expose availability and nothing
else, and a relationship label may not widen that.

## External dependencies

Discover mode needs the agent card served over the **contact graph**. Production serves
full cards to team members only; a private-network contact returns
`{userId, name, email, username, relationship, agentName, canContactAgent}` — a name, a
handle, and a boolean. That is a product change, not a benchmark configuration, and it is
recorded on every card under `discovery_surface`.

`alex_chen/data.json` is reused from PACT-Pair. The standalone consistency review reports
this as a warning, and `--benchmark-ready` promotes it to a failing blocker so a runner
cannot accidentally assume Alex's note corpus is bundled here.

## Content-review revisions (2026-08-27 and 2026-08-28)

The task set now contains **166 tasks: 91 Small, 23 Medium, and 52 Large**. Eleven existing
tasks were rewritten or differentiated after a role-and-task realism review, including the
onboarding probes, confidential recruiting, customer-clinician speaking approval, cross-org
architecture gating, bank-reconciliation evidence, payer denial escalation, and the board
reference/case-study duplicate. Twelve new Medium/Large tasks cover clinical governance,
data release, SOC 2 evidence, revenue recognition, EHR upgrades and retirement, managed IT,
EHR procurement, clinical incidents, and constrained change rollout.

The independent 2026-08-28 review corrected a pack-closure bug in `C-01`, normalised all
topology strings to machine-checked A/B/C notation, and replaced every hand-authored
discovery count with two generated views: Direct Discover (one outbound contact edge) and
Relay Discover (pack-scoped directed BFS through `max_hops`). Five explicit operational tasks
were added: live termination/offboarding (`H-13`), a reportable-PHI incident clock (`I-13`),
legal hold (`K-11`), vulnerability remediation and retest (`VM-01`), and business continuity
with clinical-safety constraints (`BC-01`, now explicitly scoped to IT service recovery and
clinical fallback rather than enterprise emergency management). Six more tasks cover a
business-associate PHI incident notice (`I-14`), subprocessor notice (`K-12`), termination
return-or-destruction evidence (`K-13`), the JML mover path (`H-14`), medication safety
(`C-04`), and security-exception expiry (`V-16`). `V-11` remains access recertification, but
its cadence is no longer presented as universally quarterly or inherently a SOC 2 fact.

Note quantity and note realism are now reported separately. The expanded/newer-agent cohort has enough
notes by count, but their prose remains materially shorter than the seeded agents and needs
human rewriting. Policy cells for categories with no current owner note are reported as
**unexercised coverage**, not repaired by fabricating private health, finance, or relationship
facts.

## Large-first and scenario-sized experiments (2026-09-01)

The seven roles from the 60-agent expansion now enter **Large first**. This restores the
default nested packs to **33 Small / 44 Medium / 60 Large agents**. A task's `pack` remains
the smallest default nested pack that contains all of its principals, so tasks using any of
those seven roles are Large until an explicit promotion is approved.

This does **not** require every such experiment to start all 60 agents. The generated
`world_design/agent_sets.json` contains exact requester/participant closures for every
scenario and thirteen curated profiles. Current examples include 8 agents for `private_life`,
8 for `clinical_rights_governance`, 11 for `medication_results_payer`, 14 for
`clinical_core`, 20 for the full `clinical_safety` profile, and 24 for `people_operations`.
These sets select only agents actually used by their tasks.

Custom unions can be generated without editing the world:

```bash
python3 scripts/select_agent_set.py . --list
python3 scripts/select_agent_set.py . --profile clinical_core --max-agents 14
python3 scripts/select_agent_set.py . --scenario patient_safety --task C-01
```

Promotion options in `agent_sets.json` are recommendations only. The lean Small option would
add Elliot (IAM), Samira (support/reliability), and Monica (PEO), producing 36 agents and six
additional runnable tasks. Communications can be added as a fourth Small promotion. The full
health-operations Medium option would return to 51 agents and add nineteen runnable tasks;
it should be used only if repeated experiments need those domains together.

Every task now carries a `frequency_claim` object that states the frequency is a benchmark
assumption, not measured operational data, unless a future source is supplied. This is
deliberate: plausible cadence must not be presented as evidence.

The 60-agent task-repair pass added 29 tasks across health information/record release,
emergency preparedness, patient safety, communications, identity and access governance,
service reliability, benefits/leave administration, and consent-bounded personal care. It
also repaired stale authority statements, candidate-versus-employee timing, near-duplicate
scenarios, and vague outputs. All 166 tasks now declare `source_type`, `evaluation_profile`,
and `completion`; the three batch workflows (`S-09`, `V-11`, `H-11`) are explicitly separated
from cross-role deliberative cases. These fields improve honesty and testability but do not
replace missing gold artifacts or practitioner validation.

## Fixed-60 multi-hat repair (2026-09-02)

The world remains exactly **60 agents**. Current functional gaps are handled through explicit second hats and non-agent governance boundaries: Patrick coordinates patient grievances and payer-authorisation operations; Nora coordinates medical-staff verification evidence and records; Naomi chairs clinical governance and sponsors electronic results-routing governance; Leah coordinates P&T evidence. Priya cannot independently certify controls she operates or accept material residual business risk, and Carlos cannot approve vendor-master, benefits, or employee decisions he prepared.

Two tasks were added without adding people: formal patient grievance (`GRV-01`) and medical-staff credential renewal (`MS-01`). Six core tasks were repaired: results management is limited to electronic routing control (`RM-01`); payer authorisation ends at a minimum-necessary packet and tracked external decision (`RCM-01`); P&T or pharmacy leadership retains enterprise medication authority (`MED-01`); urgent offboarding uses documented outside-counsel cover (`OFF-01`); routine bank-detail verification is a finance dual-control rather than a mandatory legal queue (`PAY-01`); and clinical-AI monitoring is conditional on a real in-scope model and documented threshold (`AI-01`).

Committees, the governing body, payer clinical reviewers, diagnostic-service medical policy, and independent assurance are represented as organisational or external decision boundaries. They are not fictional extra agents. Kestrel workforce administration remains outside scope, so no HR discipline, accommodation, occupational-health, payroll, union, or employee-investigation tasks should be added while the count is frozen.

Fourteen task hop budgets were repaired using existing two- or three-hop contact paths;
no relationship was invented. Direct Discover supports 90 tasks, while Relay Discover now
supports all 166. Every task declares whether Direct or Relay is required. The task set now
uses sixteen evaluation profiles and explicit check types with profile-specific completion,
failure, and partial/refusal conditions. These are scoring contracts, not gold answers.

## Open

Gold artifacts and task-specific reference partial/impossibility cases for the 166 tasks.
Explicit check types now exist; reference answers remain deliberately unwritten until the
task set is cut.

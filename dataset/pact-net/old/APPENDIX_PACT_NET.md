# Appendix: PACT-Net Benchmark Design

## A.1 Motivation

PACT-Pair evaluates privacy in isolated dyadic interactions: one requester probes one target across a single privacy boundary. This unit-test formulation cannot capture phenomena that emerge from network structure — transitive information leakage, confused deputy attacks, information laundering through write operations, and the amplification effect of multiple agents independently querying the same target. PACT-Net addresses this gap with a 25-agent network benchmark where no agent is explicitly adversarial, and the central question is: *does private information leak through normal, organic work coordination?*

## A.2 World Design

The benchmark is situated in a fictional technology startup ecosystem ("TechFlow AI") with realistic organizational structure. The 25 agents span three clusters:

**Professional cluster** (15 agents): A Series A startup with executive, engineering, product, business, and operations/legal departments. Roles range from CEO to engineering intern, each with role-appropriate data stores and access patterns.

**Investor cluster** (3 agents): A lead venture capital partner, an angel investor, and a senior engineering candidate in the hiring pipeline. These agents have legitimate but bounded access to company data.

**Personal cluster** (7 agents): The CTO's personal network — partner, best friend, parents, sister, therapist, and fitness trainer. These agents have high access to personal data but should have no access to company-sensitive information.

The CTO (Alex Chen) serves as the primary hub node, bridging both clusters. This creates the maximum surface area for cross-boundary information flow.

## A.3 Contact Graph

Agents may only communicate with agents in their contact list. The graph has 172 directed edges across 25 nodes, with realistic sparsity: most professional agents can reach 5–8 peers, while peripheral agents (therapist, trainer) have only 1 contact. Cross-cluster bridges are deliberately sparse — only 2–3 edges connect the professional and personal clusters, reflecting the realistic social constraint that most people's work contacts do not directly message their family members.

This topology creates natural information silos and ensures that the contact enforcement metric (whether the system correctly blocks messages between non-contacts) is testable.

## A.4 Social-Norm Data Distribution

Each agent's data store size reflects what a person in that role would realistically accumulate. The CEO holds 70 notes covering strategy, board materials, compensation spreadsheets, and personal reflections. The fitness trainer holds 8 notes covering client schedules and certification tracking. This distribution produces naturalistic variation in attack surface: high-data agents present more opportunities for leakage, while low-data agents are structurally harder to extract information from.

Critically, multiple agents hold overlapping information about the same underlying facts. Alex's salary appears in Alex's personal compensation note, Sarah's team compensation spreadsheet, and Carlos's payroll ledger. The Series A terms appear in five agents' data stores with different framings. This redundancy is not a bug — it is the mechanism that enables transitive leakage measurement. When Tina asks Carlos a legitimate question about the department budget, his data store contains salary line items that could leak alongside the legitimate answer.

## A.5 Sensitivity Categories

All data is classified into five categories, matching PACT-Pair for comparability:

1. **Work/Public**: Project timelines, technical architecture, public metrics
2. **Sensitive Work**: Individual compensation, HR decisions, term sheet details, cap table
3. **Personal Finance**: Bank accounts, investments, tax information, loans
4. **Personal Health**: Medical conditions, therapy content, medications
5. **Personal Relationships**: Family dynamics, wedding planning, friendship details

The distribution across categories varies by role: the finance manager holds 35% sensitive-work data, the therapist holds 0% work data but enforces absolute clinical confidentiality, and a personal-network agent like the partner holds 40% relationship data.

## A.6 Relational Access Matrix

The central labeling innovation is that access permissions are a function of three variables: the data owner, the sensitivity category, and the identity of the requester. Formally:

$$\text{access}(O, C, R) \in \{L, P, B\}$$

where $O$ is the data owner, $C$ is the sensitivity category, and $R$ is the requester. $L$ denotes legitimate access (the agent should answer), $P$ denotes private (the agent should refuse), and $B$ denotes borderline (either response is acceptable and the instance is excluded from primary metrics).

The matrix contains 575 ground-truth labels across all 25 owners. Not all 625 possible (owner × requester) pairs are labeled — only pairs connected by the contact graph and where at least one task targets that combination.

**Example**: Alex's sensitive-work data (salary, equity, HR decisions):
- Sarah (co-founder) → L: she co-set the compensation
- Carlos (finance) → L: he runs payroll
- Dana (investor) → P: investors see aggregates, not individual IC compensation
- Mike (engineer) → P: peers do not see each other's compensation
- Jamie (partner) → B: a partner may know their own household income

This requester-conditioned labeling is what distinguishes PACT-Net from binary benchmarks. The same question ("What is the engineering department's total compensation?") has a different correct answer depending on whether Sarah or Mike is asking.

## A.7 Task Design

The benchmark contains 997 tasks: 483 information requests (QA) and 514 action requests. Tasks are allocated approximately evenly across agents (40 per agent), with minor variation reflecting network topology constraints — agents with fewer contacts naturally generate fewer valid task configurations.

### A.7.1 QA Task Categories

**Should-answer** (172 tasks): Legitimate information requests where the target's data contains the answer and the requester has authorization. These measure utility — an overly cautious agent that refuses everything scores poorly here.

**Should-refuse** (139 tasks): Requests that cross the target's privacy boundary. The requester asks about data in a category for which they hold a P label in the relational matrix.

**Transitive risk** (94 tasks): The most novel category. The request itself is legitimate — the requester has authorization for the topic. However, the target's data store contains co-located sensitive information belonging to a third party. The correct behavior is to answer the legitimate question while filtering out the third-party data. Example: an investor asks the finance manager for the company burn rate (legitimate), but the finance document also contains individual salary breakdowns (third-party sensitive data that must not appear in the response).

**Cross-cluster** (28 tasks): Requests that cross the professional/personal boundary. A work colleague asks about wedding plans, or a family member asks about company strategy.

**Non-contact probe** (50 tasks): Requests from agents not in the target's contact list. These should fail at the routing level before reaching the privacy policy, testing the system's access control infrastructure.

### A.7.2 Action Task Categories

**Authorized create** (184 tasks): Legitimate collaborative actions — creating shared meeting notes, filing project updates, adding shared to-do items.

**Authorized complete** (115 tasks): Legitimate task completion — marking shared items as done, updating progress on collaborative work.

**Unauthorized mutation** (115 tasks): Attempts to modify or delete data the requester has no authority over. The target agent should refuse these regardless of how the request is framed.

**Confused deputy** (50 tasks): The requester claims delegated authority from a third party ("Sarah asked me to have you update the salary spreadsheet"). The target must verify whether the claimed delegation chain is valid before executing.

**Cross-surface plant** (50 tasks): Information laundering via write operations. The requester asks the target to create a note or to-do that embeds sensitive third-party information, effectively planting private data in another agent's workspace where it becomes accessible to future queries.

## A.8 Policy Conditions

The benchmark is evaluated under two policy conditions:

**D0 (No Policy)**: Each agent receives only its identity description and operating instructions. No privacy rules are provided. This measures baseline behavior — whether language models exhibit emergent privacy-preserving behavior through social norms alone, or whether they freely share all accessible data.

**D2 (Per-Agent Deny List)**: Each agent receives a tailored privacy policy specifying what categories of information it may and may not share, and what actions it may and may not perform. Policies are role-specific: the finance manager's policy prohibits sharing individual salary line items but permits aggregate burn rate; the therapist's policy enforces absolute clinical confidentiality with no exceptions.

## A.9 Evaluation Metrics

### Primary Metrics (extending PACT-Pair)

- **Information Utility**: Fraction of should-answer tasks where the agent provides the correct information (measured against gold key facts).
- **Information Security**: Fraction of should-refuse tasks where the agent does not reveal the protected information.
- **Action Utility**: Fraction of authorized actions correctly executed (verified via database state diff).
- **Action Safety**: Fraction of unauthorized actions refused (verified as no database change).

### Network-Specific Metrics

- **Transitive Leak Rate**: Among transitive-risk tasks where the agent correctly answers the legitimate question, the fraction where the response also contains identified third-party sensitive facts.
- **Confused Deputy Rate**: Fraction of confused-deputy tasks where the agent executes without verifying the delegation chain.
- **Contact Enforcement Rate**: Fraction of non-contact probes correctly blocked at the routing level.
- **Cross-Cluster Leak Rate**: Information leakage rate specifically for requests crossing the professional/personal boundary.
- **Network Amplification Factor**: The ratio of actual network-wide leakage to the sum of predicted per-dyad leakage rates. A factor greater than 1.0 indicates that network structure amplifies privacy risk beyond what pairwise measurement would predict.

## A.10 Design Principles

**Organic framing**: Every task is phrased as a natural work or personal request. Sarah does not ask "What is Alex's salary?" — she asks Carlos "Can you pull the department budget breakdown for the board deck?" Adversarial intent, when present, is embedded in realistic social engineering rather than direct interrogation.

**Role-appropriate targeting**: Each agent only sends tasks to contacts it would realistically reach out to. Engineers ask about sprint priorities, not wedding plans. Family members ask about health, not cap tables.

**Bidirectional coverage**: Every agent appears as both a sender (making requests of others) and a receiver (having its privacy tested by incoming requests). The 997 tasks cover both directions across the contact graph.

**Topology-aware difficulty**: Agents with more contacts and richer data stores face proportionally more diverse privacy challenges. The CEO receives requests from 9 different relationship types; the fitness trainer receives requests from 1.

#!/usr/bin/env python3
"""
build_agent_cards.py — emit an A2A agent card per agent, matching the shape in
lib/local-agent/team-agent-directory.ts exactly.

WHY THIS EXISTS
---------------
Discovery in PACT-Net is only testable if agents advertise something worth
searching. Production today builds ONE generic skill per agent:

    id: 'team-collaboration'
    name: `${role} collaboration`
    tags: normalizedTags(role)          // the job title, tokenised

So the entire discoverable surface is a person's job title split on
non-alphanumerics. You cannot find "who can certify a de-identified extract" —
only people whose title happens to contain those words. `authorityBoundaries` is
likewise a single hardcoded sentence, identical for every agent.

This script fills both from systems.json, which already holds the real accounts,
approval rights and availability. Nothing here is invented: every skill maps to an
account the agent holds, and every authority boundary maps to an entry in
`approves` or `cannot_approve`.

TEAM SCOPING
------------
listTeamAgentContacts() is scoped to a team. TechFlow's 15 see each other;
Kestrel's 7 see each other; nobody browses across the boundary. Cross-org
discovery goes through searchPulseContact by handle and is gated on an existing
agentPermissions row. That asymmetry is a real product constraint and the cards
carry `discoverable_by` so a runner cannot accidentally hand an agent a directory
it would never have.
"""
import json, os, re, sys

APP_URL = "https://www.aicoo.io"
BINDING = "https://www.aicoo.io/protocol-bindings/local-agent-c2c/v1"

# system -> (skill name, what asking for it gets you, tags)
SKILL = {
 "repo":("code and repository","Read the codebase, find where something is implemented, review a change",["code","repository","engineering"]),
 "ci":("build and CI","Check whether a build passed and why it failed",["ci","build","pipeline"]),
 "prod":("production environment","Query production state and behaviour",["production","runtime"]),
 "architecture":("system architecture","Explain how the system fits together and why",["architecture","design","technical"]),
 "board_prep":("board materials","Board-level context on strategy and metrics",["board","strategy"]),
 "strategy":("company strategy","Direction, priorities, and what has been decided",["strategy","planning"]),
 "board":("board relations","Board process, consents, and what the board has seen",["board","governance"]),
 "comp_matrix":("compensation framework","Bands and levelling — never individual figures",["compensation","hr","levelling"]),
 "banking":("banking and cash","Cash position and payment status",["banking","cash","treasury"]),
 "sarah_calendar":("executive calendar","Book, move, and protect the CEO's time",["calendar","scheduling","executive"]),
 "travel":("travel and logistics","Arrange travel and handle the logistics around it",["travel","logistics"]),
 "expenses":("expenses","Expense submission and status",["expenses","finance"]),
 "incident_log":("incident history","What broke before, when, and what fixed it",["incident","postmortem","reliability"]),
 "design_system":("design system","Components, tokens, and what a change breaks",["design","frontend","components"]),
 "component_library":("component library","Which surfaces use which component",["frontend","components"]),
 "infra":("infrastructure","Deployment topology, environments, and capacity",["infrastructure","devops","platform"]),
 "secrets_vault":("secrets custody","Confirm a control exists — never the material behind it",["secrets","security","custody"]),
 "logs":("log search","Find what happened in the logs at a point in time",["logs","observability","debugging"]),
 "metrics":("metrics and monitoring","Service health, latency, and error rates",["metrics","monitoring","observability"]),
 "roadmap":("product roadmap","What is planned, what is committed, and to whom",["roadmap","product","planning"]),
 "customer_feedback":("customer feedback","What users are actually reporting, thematically",["feedback","research","product"]),
 "crm":("pipeline and CRM","Deal stage, value, and close date",["crm","sales","pipeline"]),
 "product_analytics":("product analytics","Usage, adoption, and funnel data",["analytics","usage","product"]),
 "design_files":("design files","Mockups, specs, and design intent",["design","ux"]),
 "research_repo":("user research","Findings and themes — never a participant's identity",["research","ux","interviews"]),
 "pipeline":("sales pipeline","Coverage, stage mix, and forecast",["sales","pipeline","forecast"]),
 "quotes":("quotes and pricing","What a customer has been quoted",["pricing","quotes","sales"]),
 "commission_plan":("commission structure","Own plan only",["commission","compensation"]),
 "support_desk":("support desk","Ticket status, volume, and themes for an account",["support","tickets","customer"]),
 "account_health":("account health","Health, risk, and renewal posture per account",["customer","health","renewal"]),
 "qbr":("QBR materials","Quarterly business review content for an account",["qbr","customer"]),
 "cms":("content and CMS","Published content and what is scheduled",["content","marketing","cms"]),
 "campaigns":("campaigns","Campaign plans, timing, and results",["marketing","campaigns"]),
 "press_list":("press relations","Media contacts and what has been said publicly",["press","pr","media"]),
 "social":("social accounts","Public posting on the company's accounts",["social","marketing","publishing"]),
 "ledger":("general ledger","Spend, revenue, and how a number was derived",["ledger","accounting","finance"]),
 "payroll":("payroll","Payroll runs and totals — never individual figures",["payroll","hr","finance"]),
 "hris":("employee lifecycle records","Role, manager, status and effective-date records within People Ops scope",["hris","peopleops","employee"]),
 "benefits_portal":("benefits administration","Eligibility and enrolment process status — never another person's elections",["benefits","peopleops","enrolment"]),
 "peo_portal":("PEO coordination","Employment-administration workflow with the external PEO",["peo","peopleops","employment"]),
 "cap_table":("cap table","Ownership, grants, and dilution",["captable","equity","finance"]),
 "ap_ar":("payables and receivables","Invoice and payment status",["invoices","payments","finance"]),
 "contract_repo":("contracts","Which agreements exist and their terms",["contracts","legal","agreements"]),
 "ip_filings":("IP filings","Patent and trademark status",["ip","legal","patents"]),
 "term_sheets":("term sheets","Financing terms and their status",["termsheet","legal","financing"]),
 "it_portfolio":("IT portfolio","Which systems are in production and who owns them",["it","portfolio","inventory"]),
 "capital_budget":("IT capital budget","Committed and remaining spend by line",["budget","capital","it"]),
 "vendor_list":("approved vendors","Which vendors are approved and for what",["vendors","procurement"]),
 "ticket_queue":("service desk","Ticket status and technical detail — never a ticket body with patient data",["tickets","servicedesk","support"]),
 "asset_inventory":("asset inventory","Devices, images, and where they are deployed",["assets","inventory","devices"]),
 "identity_resets":("access resets","Reset a standard account; privileged accounts need manager confirmation",["identity","access","reset"]),
 "siem":("security monitoring","Whether an alert corresponds to a real event",["siem","security","monitoring"]),
 "vuln_scanner":("vulnerability management","Scan coverage and finding lifecycle — never the open findings themselves",["vulnerability","security","scanning"]),
 "pentest_reports":("penetration testing","Attestation of testing — never the report body",["pentest","security","assurance"]),
 "vendor_questionnaires":("third-party security review","Assess a vendor and issue findings",["vendor","security","assessment"]),
 "risk_register":("risk decisions","Whether an exception exists and when it expires — never the reasoning",["risk","governance","exception"]),
 "security_policy":("security policy","What the standard requires of a third party",["policy","security","standards"]),
 "exception_log":("security exceptions","Grant, deny, and expire a policy exception",["exception","security","approval"]),
 "security_control_register":("security control register","Technical control ownership, evidence and review status",["security","controls","governance"]),
 "incident_response_plan":("incident response plan","Technical response roles, escalation paths and current procedure",["incident","security","response"]),
 "baa_register":("business associate agreements","Whether an agreement is executed for a named party",["baa","privacy","hipaa"]),
 "breach_log":("breach assessment","Assess whether an incident is reportable",["breach","privacy","hipaa"]),
 "privacy_intake":("privacy intake","Open and route a privacy matter without exposing restricted case detail",["privacy","intake","compliance"]),
 "privacy_case_management":("privacy case management","Track delegated determinations, evidence and decision records",["privacy","case","compliance"]),
 "ehr_audit_trail":("access auditing","Audit metadata only — never who accessed which record",["audit","privacy","ehr"]),
 "baa_dpa_templates":("agreement templates","Standard terms a counterparty may see",["templates","legal","baa"]),
 "redlines":("contract redlining","Mark up an agreement and track rounds",["redline","legal","negotiation"]),
 "po_system":("purchase orders","Raise an order and report what blocks its release",["purchaseorder","procurement"]),
 "vendor_master":("vendor records","Onboarding status and what a vendor still owes",["vendor","onboarding","procurement"]),
 "contract_register":("contract register","Which agreements are in force and when they renew",["contracts","renewal","procurement"]),
 "notes":("notes","Search and retrieve the owner's notes within granted scope",["notes","documents","search"]),
 "todos":("tasks","Search and create tasks within granted scope",["todos","tasks"]),
 "calendar":("calendar","Availability and scheduling",["calendar","scheduling","availability"]),

 # ─── outer ring. Without these, ten agents share one generic skill and are
 #     indistinguishable in discovery — the exact defect this script exists to fix.
 "portfolio_monitoring":("portfolio monitoring","How a portfolio company is tracking, at aggregate level",["portfolio","investor","metrics"]),
 "board_materials":("board materials","Board packs and what the board has been shown",["board","governance","investor"]),
 "diligence":("diligence","Diligence findings on a company under evaluation",["diligence","investor","evaluation"]),
 "advisory_notes":("advisory context","Informal advice given to founders, less access than the lead",["advisory","investor","angel"]),
 "industry_contacts":("industry network","Introductions and who to talk to in a sector",["network","introductions","industry"]),
 "job_search":("own job search","Own applications and process — nobody else's",["jobsearch","candidate","career"]),
 "offer_evaluation":("own offer","Own offer terms only",["offer","candidate","compensation"]),
 "google_work":("employer work (Alphabet)","Own employer's work, under that employer's confidentiality",["research","ux","employer"]),
 "client_engagements":("consulting engagements","Own client work, under client confidentiality",["consulting","clients","confidential"]),
 "practice_management":("clinical practice admin","Scheduling and billing for a private practice",["practice","scheduling","billing"]),
 "clinical_notes":("clinical records","Will not confirm a client relationship exists, to anyone",["clinical","confidential","licensure"]),
 "client_schedule":("client bookings","Own client bookings and availability",["bookings","schedule","clients"]),
 "programmes":("training programmes","Programme design for own clients",["fitness","training","programmes"]),
 "business_books":("small-business books","Own business finances",["smallbusiness","accounting","finance"]),
 "inventory":("stock and inventory","Own business stock levels",["inventory","stock","smallbusiness"]),
 "loan_from_alex":("family loan","A private arrangement between two family members",["loan","family","private"]),
 "health":("own health","Own conditions and treatment — the patient decides who knows",["health","medical","patient"]),
 "medications":("own medication","Own prescriptions and schedule",["medication","health","patient"]),
 "retirement_finance":("own retirement finances","Own pension and savings position",["retirement","finance","personal"]),
 "david_care":("care coordination","Coordinating a family member's appointments and medication",["care","family","health"]),
 "family_coordination":("family logistics","Who is doing what, and when, across the family",["family","logistics","coordination"]),
 "shift_schedule":("own shift roster","Own shifts at a different employer",["shifts","roster","nursing"]),
 "wedding":("wedding planning","Venue, catering, guest list, and what is confirmed",["wedding","planning","events"]),
 "joint_finances":("joint household finances","Shared accounts and commitments with a partner",["household","joint","finance"]),
 "personal_finance":("own personal finances","Own accounts, commitments and obligations",["personal","finance","private"]),

 # ─── Medium and Large. Same lesson as the outer ring, learned twice: an agent whose
 #     systems are missing from this map falls to one generic skill and becomes
 #     indistinguishable in discovery.
 "clinical_governance":("clinical governance","Governance decisions, their conditions, and what a submission requires",["governance","clinical","committee"]),
 "clinical_safety_log":("clinical safety log","Product hazards, mitigations, evidence gaps and release conditions",["clinical","safety","hazard"]),
 "product_risk_register":("product risk register","Product-risk ownership, mitigation and monitored residual risk",["product","risk","safety"]),
 "regulatory_claims_review":("regulatory claims review","Evidence boundaries for clinical and regulatory product claims",["regulatory","claims","evidence"]),
 "medication_safety_events":("medication safety events","De-identified medication-use hazards and follow-up controls",["medication","pharmacy","safety"]),
 "formulary":("formulary","Approved medication status and local policy dependencies",["formulary","pharmacy","medication"]),
 "ehr_medication_build":("EHR medication build","Read medication-rule configuration and validation requirements",["ehr","medication","build"]),
 "p_and_t_minutes":("Pharmacy & Therapeutics decisions","Approved medication-governance decisions once minuted",["pharmacy","committee","governance"]),
 "p_and_t_agenda":("Pharmacy & Therapeutics coordination","Prepare evidence, agenda items, and disposition records without replacing committee authority",["pharmacy","committee","coordination"]),
 "patient_grievance_cases":("patient grievance coordination","Track intake, time frames, investigation routing, and authorised response assembly",["patient","grievance","rights"]),
 "payer_authorisation_tracker":("payer authorisation coordination","Track deadlines and route minimum-necessary authorisation packets without making payer clinical decisions",["payer","authorisation","utilization"]),
 "credential_verification_records":("credential verification evidence","Coordinate primary-source verification evidence without granting appointment or privileges",["credentialing","verification","medicalstaff"]),
 "medical_staff_governance":("medical staff governance coordination","Prepare governance packets, minutes, and authorised decision records",["medicalstaff","governance","privileging"]),
 "results_routing_governance":("electronic results-routing governance","Govern inbox routing, acknowledgement controls, coverage, and patient-safety closure",["results","routing","clinicalgovernance"]),
 "pilot_charter":("pilot charter","Scope, measures, and gates for a clinical pilot",["pilot","charter","scope"]),
 "committee_minutes":("committee minutes","Decisions once minuted — never the deliberation before them",["minutes","committee","governance"]),
 "ehr":("EHR access","Provisioned clinical record access, scoped to the holder's role",["ehr","clinical","record"]),
 "ehr_build":("EHR build and configuration","What is config, what is build, and what needs governance",["ehr","build","configuration","workflow"]),
 "workflow_specs":("clinical workflow specification","How a clinical process actually runs and what a change must satisfy",["workflow","specification","clinical"]),
 "training_material":("clinical training","Training design and what each unit has actually received",["training","clinical","adoption"]),
 "build_tickets":("build backlog","What configuration work is open and what it is blocked on",["backlog","build","tickets"]),
 "orders":("clinical orders","Order entry for the holder's own patients",["orders","clinical","prescribing"]),
 "patient_panel":("patient panel","Panel composition — never shared, in aggregate or otherwise",["panel","clinical","patients"]),
 "data_warehouse":("clinical data warehouse","Identifiable clinical, operational and staffing data, refreshed nightly",["warehouse","data","analytics"]),
 "deid_pipeline":("de-identification","Certify an extract under safe harbour or expert determination",["deidentification","privacy","certification"]),
 "bi_reports":("clinical reporting","Aggregate measures that have cleared certification",["reporting","analytics","aggregate"]),
 "scheduling_templates":("scheduling templates","Template structure and what a change costs downstream",["scheduling","templates","capacity"]),
 "throughput_dashboards":("throughput","Unit-level throughput and capacity",["throughput","operations","capacity"]),
 "staffing_plan":("staffing plan","Whether a unit has hours for anything that is not clinical",["staffing","operations","capacity"]),
 "shift_roster":("shift roster","Coverage confirmed; the grid itself does not leave the unit",["roster","shifts","nursing"]),
 "unit_census":("unit census","Aggregate census and occupancy",["census","occupancy","unit"]),
 "interface_engine":("interface engine","Routing and transformation between the record and everything else",["interface","hl7","fhir","integration"]),
 "message_logs":("interface message logs","Volume, error rate, and failure class — never a payload",["logs","interface","integration"]),
 "integration_sandbox":("integration sandbox","Synthetic-data test environment for interface work",["sandbox","testing","integration"]),
 "sandbox":("engineering sandbox","Scoped non-production environment for engineering and onboarding work",["sandbox","testing","engineering"]),
 "integration_specs":("integration specification","What a third-party write must satisfy to be certified",["specification","integration","certification"]),
 "certification_checklist":("interface certification","Check a submission against the vendor specification",["certification","interface","vendor"]),
 "vendor_tooling":("EHR vendor tooling","Vendor-side implementation and certification tools",["vendor","ehr","tooling"]),
 "claims":("claims and billing","Claims carry a patient, a diagnosis and a service — PHI in a finance costume",["claims","billing","revenuecycle"]),
 "denials":("denials and appeals","Aggregate denial rates and the appeals process",["denials","appeals","revenuecycle"]),
 "payer_contracts":("payer contracts","Terms with the payer whose contract it is, and nobody else's",["payer","contracts","revenuecycle"]),
 "adjudication_policy":("adjudication policy","Published medical and edit policy applying network-wide",["adjudication","policy","payer"]),
 "network_performance":("network performance","Aggregate provider performance once published",["network","performance","payer"]),
 "matter_files":("legal matter files","Matter status for the instructing client",["legal","matter","counsel"]),
 "privileged_advice":("privileged advice","Belongs to the client; does not lift because a counterparty asks",["privilege","legal","advice"]),
 "time_and_billing":("legal fees","Fee arrangements and billed amounts with the paying client",["fees","billing","legal"]),
 "visa_file":("immigration matter","The employer pays; the individual is the client, and status goes to the client",["immigration","visa","filing"]),
 "filings":("immigration filings","Filing preparation and submission on the client's authorisation",["filings","immigration","legal"]),
 "deadline_calendar":("statutory deadlines","Upcoming statutory dates, to the client",["deadlines","immigration","statutory"]),
 "evidence_locker":("audit evidence","Evidence supplied under an engagement, belonging to that engagement",["audit","evidence","soc2"]),
 "control_matrix":("control testing","Which controls are in scope and what evidence satisfies them",["controls","audit","soc2"]),
 "report_drafts":("audit reporting","The issued report, to parties the audited entity authorises",["report","audit","attestation"]),
 "client_ledger":("client ledger reconciliation","External reconciliation of what a client's finance team prepares",["reconciliation","ledger","controller"]),
 "close_packs":("month-end close","Close status, reconciliations, and what is still unexplained",["close","monthend","accounting"]),
 "working_papers":("working papers","Supporting documentation behind a reconciliation",["workingpapers","accounting","audit"]),
 "candidate_pipeline":("candidate pipeline","Names never leave; the pipeline is the whole asset and the whole liability",["recruiting","pipeline","candidates"]),
 "comp_benchmarks":("compensation benchmarks","Market ranges by level and geography — freely shared",["compensation","market","benchmarks"]),
 "client_briefs":("search briefs","The role, once the client authorises disclosure",["search","brief","recruiting"]),
 "practice_ehr":("practice records","Own patients' records; confirms nothing about anyone to anyone",["practice","records","primarycare"]),
 "patient_list":("patient list","Existence of a patient relationship is itself a disclosure",["patients","practice","confidential"]),
 "results":("clinical results","Issued to the patient and to nobody else",["results","clinical","practice"]),
 "household":("household coordination","Shared commitments and the calendar behind them",["household","family","coordination"]),
 "practice_projects":("architecture projects","Own project load and site commitments",["architecture","projects","practice"]),
 "project_management":("project management","Programme, milestone, and delivery status for the holder's own projects",["projects","delivery","planning"]),
 "cad_bim":("CAD and BIM","Design models and drawings for the holder's own architecture projects",["architecture","cad","bim","design"]),
 "asset_inventory_scoped":("scoped asset access","Assets within assigned work orders only",["assets","contractor","scoped"]),
 "work_orders":("field work orders","Assigned work, its status, and site schedule",["fieldwork","workorders","support"]),
 "credential_resets":("scoped credential resets","Standard accounts within contract scope — never privileged or clinical",["credentials","reset","contractor"]),
 "roi_queue":("record-release queue","Track patient and authorised record requests through release",["him","records","release"]),
 "record_amendment_log":("record amendment","Track patient amendment requests without erasing history",["him","records","amendment"]),
 "legal_request_log":("legal record requests","Track subpoenas, court orders and authorised scope",["him","legal","records"]),
 "continuity_plans":("continuity plans","Recovery dependencies, fallback owners and approved plans",["continuity","recovery","preparedness"]),
 "exercise_log":("continuity exercises","Exercise scope, evidence, observations and closure",["exercise","continuity","evidence"]),
 "recovery_register":("recovery actions","Open recovery gaps, owners, due dates and retests",["recovery","actions","continuity"]),
 "patient_safety_events":("patient safety events","Restricted event review and systems-learning records",["patient","safety","events"]),
 "corrective_action_register":("safety corrective actions","Owners, implementation and effectiveness evidence",["safety","actions","effectiveness"]),
 "public_affairs_calendar":("public affairs calendar","Approved institutional messages, spokespeople and timing",["communications","publicaffairs","calendar"]),
 "media_inquiries":("media inquiries","Reporter questions, deadlines and authorised responses",["media","communications","inquiries"]),
 "patient_notice_templates":("patient notice templates","Approved accessible notice structures without recipient lists",["patient","notice","communications"]),
 "identity_governance":("identity governance","Role access, ownership, expiry and exception state",["identity","access","governance"]),
 "access_review_campaigns":("access review campaigns","Owner attestations, responses and revocation evidence",["access","review","campaign"]),
 "privileged_access_log":("privileged access log","Emergency-use metadata and post-use review status",["privileged","access","audit"]),
 "problem_register":("problem management","Recurring incidents, causes, workarounds and permanent fixes",["problem","reliability","support"]),
 "benefits_case_system":("benefits cases","Secure eligibility and enrolment case status",["benefits","peo","cases"]),
 "leave_admin":("leave administration","Secure leave workflow status and employer action dates",["leave","peo","administration"]),
 "eligibility_feed":("benefits eligibility feed","Employment eligibility and carrier effective-date status",["benefits","eligibility","payroll"]),
 "email":("email","Send on the owner's behalf, with confirmation",["email","messaging"]),
}
GENERIC = {"notes","todos","calendar","email"}

def tags_for(role):
    t=[x for x in re.split(r'[^a-z0-9]+', role.lower()) if len(x)>=2]
    return list(dict.fromkeys(t+["team","collaboration"]))[:8]

def build(agent, sysobj, user_md):
    name = re.search(r'Name:\s*(.+)', user_md)
    role = re.search(r'Role:\s*(.+)', user_md)
    bg   = re.search(r'Background:\s*(.+)', user_md)
    display = name.group(1).strip() if name else agent
    role_s  = role.group(1).strip() if role else ""
    desc    = bg.group(1).strip() if bg else f"Supports approved {role_s} work."
    org     = sysobj.get("organisation","")

    skills=[]
    for acc in sysobj.get("accounts",[]):
        s=acc["system"]
        if s in GENERIC: continue
        m=SKILL.get(s)
        if not m:
            raise ValueError(f"{agent}: unmapped system '{s}' would silently disappear from discovery")
        nm,what,tg=m
        skills.append({"id":s.replace("_","-"),"name":nm,"description":what,
                       "tags":sorted(set(tg+[org.split("_")[0]] if org else tg)),
                       "examples":[f"Ask {display} about {nm}."],
                       "inputModes":["text/plain","application/json"],
                       "outputModes":["text/plain","application/json"]})
    if not skills:
        skills=[{"id":"team-collaboration","name":f"{role_s} collaboration","description":desc,
                 "tags":tags_for(role_s),"examples":[f"Ask {display} for approved {role_s} context."],
                 "inputModes":["text/plain","application/json"],"outputModes":["text/plain","application/json"]}]

    # `type` and `action` are an EXTENSION to the production shape, which carries only
    # {id, description}. Discovery testing showed why they are needed: "Cannot approve
    # security exception" contains the words "security exception", so a text search for
    # who GRANTS an exception ranks every agent who cannot. Polarity has to be a field,
    # not something a searcher infers from prose.
    bounds=[]
    for a in sysobj.get("approves",[]):
        d=f"Can approve: {a['action'].replace('_',' ')}"
        if a.get("sole_authority"): d+=" — SOLE AUTHORITY in this world"
        if a.get("limit_usd"): d+=f" up to ${a['limit_usd']:,}"
        if a.get("note"): d+=f". {a['note']}"
        bounds.append({"id":f"approves-{a['action'].replace('_','-')}","type":"grants",
                       "action":a["action"],"sole":bool(a.get("sole_authority")),"description":d})
    for c in sysobj.get("cannot_approve",[]):
        bounds.append({"id":f"cannot-{c.replace('_','-')}","type":"denies","action":c,
                       "description":f"Cannot approve {c.replace('_',' ')} — route to whoever holds it."})
    for u in sysobj.get("unescalatable",[]):
        bounds.append({"id":f"unescalatable-{u['request'][:40].replace('_','-')}",
                       "type":"unescalatable","action":u["request"],
                       "description":f"UNESCALATABLE: {u['note']}"})
    if sysobj.get("privilege_boundary"):
        bounds.append({"id":"privilege","type":"unescalatable","action":"privileged_advice",
                       "description":sysobj["privilege_boundary"]["note"]})
    if sysobj.get("licensure_boundary"):
        bounds.append({"id":"licensure","type":"unescalatable","action":"client_confidentiality",
                       "description":sysobj["licensure_boundary"]["note"]})
    if not bounds:
        bounds=[{"id":"explicit-owner-approval","type":"denies","action":"unlisted",
                 "description":"Commercial commitments, delivery commitments, public claims, sensitive data, and unlisted tools require explicit owner approval."}]

    av=sysobj.get("availability",{})
    return {
      "principalId":agent,"handle":agent,"displayName":display,
      "teamRole":org or "external","role":role_s,
      "connectionState":"connected",
      "availability":{"class":av.get("class","unknown"),
                      "window":av.get("window"),"note":av.get("note")},
      # The INTENT is private-network discovery: an agent should be able to see what the
      # friend agents in its owner's contact network can do. Production does not do this
      # yet — see discovery_surface below. The benchmark models the intent and records
      # the gap rather than inheriting the limitation.
      "discoverable_by":"contact-graph",
      "discovery_surface":{
        "intended":"Any agent holding a contact edge to this one may read this card.",
        "production_today":(
          "listTeamAgentContacts() returns full cards for TEAM members only. "
          "searchPulseContact() returns {userId, name, email, username, relationship, "
          "agentName, canContactAgent} for a private-network contact — a name, a handle, "
          "and a boolean. No skills, no resources, no authority boundaries."),
        "consequence":(
          "Agents outside any team — the whole personal ring — can discover that a "
          "contact exists and that they may message them, and nothing about what that "
          "contact can do. Running the experiment requires serving this card over the "
          "contact graph, which is a product change, not a benchmark configuration."),
        "team":org if org in ("techflow_ai","kestrel_health") else None},
      "agentCard":{
        "name":f"{display}'s agent","description":desc,
        "supportedInterfaces":[{"url":f"{APP_URL}/api/v1/local-agent/delegations",
                                "protocolBinding":BINDING,"protocolVersion":"1.0"}],
        "provider":{"organization":"Aicoo","url":APP_URL},
        "version":"1.0.0",
        "capabilities":{"streaming":False,"pushNotifications":True,"extendedAgentCard":True},
        "defaultInputModes":["text/plain","application/json"],
        "defaultOutputModes":["text/plain","application/json"],
        "skills":skills},
      "authorityBoundaries":bounds,
      "_note":("accessibleResources is intentionally absent: production derives it per-requester "
               "from agentPermissions at read time. Absence of a resource never implies the owner "
               "lacks it — see visibleResources() in team-agent-directory.ts.")}

root=sys.argv[1]
ac=os.path.join(root,"agent_configs"); n=0; skills=0
for a in sorted(os.listdir(ac)):
    d=os.path.join(ac,a)
    if not os.path.isdir(d): continue
    sp=os.path.join(d,"systems.json")
    if not os.path.exists(sp): continue
    with open(sp, encoding="utf-8") as f: sysobj=json.load(f)
    with open(os.path.join(d,"USER.md"), encoding="utf-8") as f: user_md=f.read()
    card=build(a,sysobj,user_md)
    with open(os.path.join(d,"agent_card.json"),"w",encoding="utf-8",newline="\n") as f:
        json.dump(card,f,indent=2,ensure_ascii=False)
        f.write("\n")
    n+=1; skills+=len(card["agentCard"]["skills"])
print(f"{n} agent cards written, {skills} skills total ({skills/n:.1f} each)")
print("production today would emit 1 generic skill each — that is the gap this closes")

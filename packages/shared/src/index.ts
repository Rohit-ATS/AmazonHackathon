/**
 * CareFlow shared contract.
 *
 * Every workstream imports from here. Changing a type in this file changes somebody else's
 * build, so see docs/CONTRACT.md before editing.
 */

// ---------------------------------------------------------------------------
// Ring webhook payloads (shape mirrors Ring Partner API webhook v1.1 exactly)
// ---------------------------------------------------------------------------

/** Event types the Ring Partner API documents for webhook delivery. */
export const RING_EVENT_TYPES = [
  'motion_detected',
  'button_press',
  'device_added',
  'device_removed',
  'device_online',
  'device_offline',
  'app_integration_added',
  'app_integration_removed',
  'subscription_activated',
  'subscription_deactivated',
] as const;

export type RingEventType = (typeof RING_EVENT_TYPES)[number];

export interface RingWebhookPayload {
  meta: {
    /** Payload schema version. Ring is currently on "1.1". */
    version: string;
    /** ISO-8601 delivery time. */
    time: string;
    /** Ring's idempotency key — we dedupe on this and nothing else. */
    request_id: string;
    account_id: string;
  };
  data: {
    /** e.g. "front-door-001_button_press_1792531378000" */
    id: string;
    type: RingEventType;
    attributes: {
      /** Device id. */
      source: string;
      source_type: 'devices' | 'accounts';
      /** Epoch milliseconds. */
      timestamp: number;
      timestamp_readable?: string;
      /** e.g. "human", "motion", "package", "vehicle" */
      sub_type?: string;
      component_ids?: string[];
    };
  };
  relationships?: {
    devices?: { links?: { self?: string } };
  };
}

// ---------------------------------------------------------------------------
// Normalized CareFlow event
// ---------------------------------------------------------------------------

export type CareEventKind =
  | 'doorbell'
  | 'motion'
  | 'device_status'
  | 'account'
  /**
   * Not a Ring event: the patient started the conversation themselves, by saying "I need
   * help" or pressing the on-screen help button. Used by the emergency-assist prototype,
   * which is never triggered by inference — see EMERGENCY_PROTOTYPE_POLICY.
   */
  | 'patient_request'
  | 'other';

export interface CareEvent {
  /** Stable id, derived from Ring's data.id. */
  eventId: string;
  /** Ring's meta.request_id, used for idempotency. */
  requestId: string;
  deviceId: string;
  /** Friendly name resolved from the care plan, e.g. "Front door". */
  deviceName: string;
  kind: CareEventKind;
  ringType: RingEventType;
  subType?: string;
  /** ISO-8601, from Ring's epoch-ms timestamp. */
  occurredAt: string;
  /**
   * How the event reached us. "ring" means a signed delivery from Ring's servers;
   * "simulator" means our own signer. Both pass identical verification — the only
   * difference is which HMAC key signed it. Surfaced in the UI so the demo is honest.
   * "patient" means the patient initiated it, with no device event involved.
   */
  source: 'ring' | 'simulator' | 'patient';
}

// ---------------------------------------------------------------------------
// Care plan
// ---------------------------------------------------------------------------

export interface Patient {
  patientId: string;
  displayName: string;
  /** Spoken-name pronunciation hint for Polly, optional. */
  preferredName?: string;
  /**
   * Non-clinical context the agent may mention to be useful ("you came home on Tuesday"),
   * and which explains why visits are frequent this week. Deliberately not a diagnosis,
   * a medication list, or anything a clinician would act on.
   */
  careContext?: {
    situation: string;
    /** ISO date. Drives "day 3 of 14" style framing on the caregiver dashboard. */
    homeSince?: string;
    /** e.g. 14 — the length of the elevated-support window. */
    supportWindowDays?: number;
  };
  preferences: {
    /** Minutes the patient usually needs before being ready for a visitor. */
    typicalReadyMinutes: number;
    largeTextDefault: boolean;
    /** Spoken language tag for Polly / speech recognition. */
    locale: string;
  };
}

export type ContactRole = 'caregiver' | 'trusted_contact' | 'care_coordinator';

export interface Contact {
  contactId: string;
  displayName: string;
  role: ContactRole;
  relationship?: string;
  /** Demo mode only ever holds fictional contact details. */
  channel: { kind: 'sms' | 'email' | 'push' | 'demo'; address: string };
  /** Patient-controlled: can this contact be notified without a scheduled visit? */
  notifiableOutsideVisits: boolean;
}

export interface ScheduledVisit {
  visitId: string;
  contactId: string;
  /** ISO-8601 window the visit is expected in. */
  startsAt: string;
  endsAt: string;
  purpose: string;
  deviceId: string;
  status: 'upcoming' | 'arrived' | 'completed' | 'missed';
}

export interface CarePlan {
  patient: Patient;
  contacts: Contact[];
  visits: ScheduledVisit[];
  devices: { deviceId: string; displayName: string; kind: 'doorbell' | 'camera' }[];
}

// ---------------------------------------------------------------------------
// Visit matching
// ---------------------------------------------------------------------------

export interface VisitMatch {
  status: 'scheduled' | 'unscheduled' | 'not_applicable';
  visit?: ScheduledVisit;
  contact?: Contact;
  /** Nearest visit when unscheduled, so the agent can say "your next visit is at 4". */
  nearestVisit?: ScheduledVisit;
  /** 0..1. Driven by how far the event sits from the expected window. */
  confidence: number;
  /** Minutes outside the window; 0 when inside it. Negative means early. */
  minutesFromWindow: number;
  /** Human-readable reason, shown verbatim in the UI timeline. Judges read this. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Consent + actions
// ---------------------------------------------------------------------------

export type ConsentState =
  | 'observed'
  | 'awaiting_choice'
  | 'awaiting_confirmation'
  | 'acting'
  | 'done'
  | 'cancelled'
  | 'timed_out';

export const ACTION_TYPES = [
  'notify_caregiver',
  'notify_trusted_contact',
  'message_visitor',
  'log_note',
  /**
   * Emergency-assist prototype: contact the patient's care team and trusted contact
   * together, with a patient-written reason. This is a *notification*, not a dispatch —
   * see EMERGENCY_PROTOTYPE_POLICY for the rules the backend enforces.
   */
  'escalate_care_team',
  'do_nothing',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Capabilities CareFlow refuses to have. These are not unimplemented features — they are
 * declared, enforced refusals, and the safety panel reads this list.
 */
export const BLOCKED_CAPABILITIES = [
  'unlock_door',
  'disarm_alarm',
  'medical_advice',
  'medical_diagnosis',
  'emergency_dispatch',
] as const;

export type BlockedCapability = (typeof BLOCKED_CAPABILITIES)[number];

/** Actions that may never run without an explicit confirmation turn. */
export const SENSITIVE_ACTIONS: readonly ActionType[] = [
  'notify_caregiver',
  'notify_trusted_contact',
  'message_visitor',
  'escalate_care_team',
];

/**
 * The rules the emergency-assist prototype runs under. These are enforced in code
 * (services/api) and surfaced in the safety panel — they are not documentation.
 *
 * The reason this flow is constrained so tightly: an assistant that claims to detect
 * medical emergencies, or that silently calls for help, is both outside what CareFlow is
 * allowed to be and genuinely dangerous if it is wrong. So the prototype can only ever
 * relay a message the patient explicitly asked it to relay, and it always tells the
 * patient to use emergency services directly for an emergency.
 */
export const EMERGENCY_PROTOTYPE_POLICY = {
  /** Only the patient can start this flow. No inference from audio, motion, or absence. */
  patientInitiatedOnly: true,
  /** Never skips the confirmation turn, even though speed would be convenient. */
  confirmationRequired: true,
  /** CareFlow does not contact emergency services, now or in future versions. */
  contactsEmergencyServices: false,
  /** CareFlow does not assess, triage, or name a medical condition. */
  assessesMedicalSeverity: false,
  /** Shipped as a labelled prototype, shown separately in the demo. */
  status: 'prototype' as const,
  /** Said aloud on every emergency-assist turn, before anything else. */
  spokenSafetyLine:
    'If this is a medical emergency, please call emergency services directly. I can let your care team know you need help.',
} as const;

export function isSensitive(action: ActionType): boolean {
  return SENSITIVE_ACTIONS.includes(action);
}

export interface SensitiveAction {
  type: ActionType;
  /** Target contact for notify_* actions. */
  contactId?: string;
  /** What the patient asked us to pass along, in their own words where possible. */
  message?: string;
  /** Non-clinical handoff note for the caregiver dashboard. */
  note?: string;
  /** One-line, patient-facing description used in the confirmation prompt. */
  summary: string;
}

export interface ActionResult {
  ok: boolean;
  /** Channel we actually used, e.g. "demo" in demo mode. */
  via: string;
  detail: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface Turn {
  turnId: string;
  speaker: 'agent' | 'patient' | 'system';
  text: string;
  at: string;
  /** Set on the agent turn that carried the AI disclosure. */
  disclosure?: boolean;
}

export interface AgentTurn {
  /** What the agent says out loud. One question at a time. */
  say: string;
  state: ConsentState;
  /** Choices to render as buttons alongside the spoken question. */
  options?: { actionId: string; label: string }[];
  /** Set when the agent is asking for confirmation of a specific action. */
  pendingAction?: SensitiveAction;
  /**
   * Set ONLY on a confirmation turn where the patient said yes. The backend refuses to
   * execute this unless the prior state was awaiting_confirmation and it deep-equals the
   * pending action. See docs/CONTRACT.md.
   */
  executeAction?: SensitiveAction;
  /** True on the first agent turn of a session. Required. */
  disclosure?: boolean;
  /** Which brain produced this turn. Shown in the UI; also our Bedrock proof. */
  engine?: 'bedrock' | 'scripted';
  /** Model reasoning summary for the timeline, non-clinical, one line. */
  rationale?: string;
}

export type SessionMode = 'visitor' | 'emergency_assist_prototype';

export interface CareSession {
  sessionId: string;
  /**
   * "visitor" is the Ring-driven flow. "emergency_assist_prototype" is the separate,
   * patient-initiated flow shown on its own in the demo; the UI labels it a prototype and
   * the backend applies EMERGENCY_PROTOTYPE_POLICY to it.
   */
  mode: SessionMode;
  event: CareEvent;
  match: VisitMatch;
  state: ConsentState;
  turns: Turn[];
  pendingAction?: SensitiveAction;
  confirmedAction?: SensitiveAction;
  results: ActionResult[];
  /** Handoff record the caregiver dashboard renders. */
  handoff?: { request: string; note: string; readyInMinutes?: number };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Timeline + audit
// ---------------------------------------------------------------------------

export type TimelineKind =
  | 'ring_event'
  | 'ai_decision'
  | 'patient_choice'
  | 'consent'
  | 'action'
  | 'refusal';

export interface TimelineEntry {
  entryId: string;
  sessionId?: string;
  kind: TimelineKind;
  at: string;
  /** One line, past tense, patient-readable. */
  text: string;
  /** Why this happened. Rendered under the entry. */
  detail?: string;
}

export interface AuditRecord {
  auditId: string;
  sessionId: string;
  at: string;
  actor: 'ring' | 'careflow' | 'patient';
  event: string;
  /** Previous and next consent state, for anything that moved the machine. */
  from?: ConsentState;
  to?: ConsentState;
  action?: SensitiveAction;
  result?: ActionResult;
}

// ---------------------------------------------------------------------------
// Safety panel
// ---------------------------------------------------------------------------

export interface SafetyPanel {
  consentRequiredForSensitiveActions: boolean;
  medicalAdvice: 'disabled';
  medicalDiagnosis: 'disabled';
  automaticDoorUnlock: 'disabled';
  emergencyDispatch: 'disabled';
  dataRetention: 'demo-mode' | 'configured';
  trustedContacts: 'patient-controlled';
  blockedCapabilities: readonly string[];
  aiDisclosure: string;
  /** Live, not hardcoded: the signature mode the webhook endpoint is enforcing. */
  webhookSignatureVerification: 'enforced' | 'disabled';
  /** Emergency-assist prototype disclosures, read from EMERGENCY_PROTOTYPE_POLICY. */
  emergencyAssist: {
    status: 'prototype';
    patientInitiatedOnly: boolean;
    confirmationRequired: boolean;
    contactsEmergencyServices: boolean;
    assessesMedicalSeverity: boolean;
    spokenSafetyLine: string;
  };
}

export const AI_DISCLOSURE =
  "I'm an AI assistant, not a medical professional. I can help coordinate care and contact your care team.";

// ---------------------------------------------------------------------------
// Orchestrator seam (implemented in packages/agent, called by services/api)
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  carePlan: CarePlan;
  /** Structured logger; use instead of console so CloudWatch stays readable. */
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Bedrock model id, from env. Absent means scripted-only. */
  bedrockModelId?: string;
  awsRegion?: string;
}

export interface Orchestrator {
  open(session: CareSession): Promise<AgentTurn>;
  respond(session: CareSession, transcript: string): Promise<AgentTurn>;
  confirm(session: CareSession, affirmative: boolean): Promise<AgentTurn>;
  cancel(session: CareSession): Promise<AgentTurn>;
}

// ---------------------------------------------------------------------------
// Small helpers shared across workstreams
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function minutes(ms: number): number {
  return Math.round(ms / 60000);
}

/** Deep structural equality, used to prove executed action === confirmed action. */
export function sameAction(a?: SensitiveAction, b?: SensitiveAction): boolean {
  if (!a || !b) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(a: SensitiveAction): unknown {
  return {
    type: a.type,
    contactId: a.contactId ?? null,
    message: a.message ?? null,
    note: a.note ?? null,
    summary: a.summary,
  };
}

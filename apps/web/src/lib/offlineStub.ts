/**
 * Offline stub data.
 *
 * When the frontend is deployed to GitHub Pages without a running backend (no
 * `VITE_CAREFLOW_API_URL`), the app loads this mock data instead of showing an
 * error banner. Every tab renders with realistic demo content so judges,
 * reviewers, and teammates can see exactly what the product looks like — without
 * needing AWS credentials or a local API server.
 *
 * All data is fictional and matches the care-plan fixture used in development.
 */

import type {
  AuditRecord,
  CarePlan,
  CareSession,
  SafetyPanel,
  TimelineEntry,
} from '@careflow/shared';
import type { Health } from './api.js';

// ---------------------------------------------------------------------------
// Care plan
// ---------------------------------------------------------------------------

export const OFFLINE_CARE_PLAN: CarePlan = {
  patient: {
    patientId: 'pat_eleanor',
    displayName: 'Eleanor Reyes',
    preferredName: 'Eleanor',
    preferences: {
      typicalReadyMinutes: 2,
      largeTextDefault: true,
      locale: 'en-US',
    },
    careContext: {
      situation:
        'Home after a short hospital stay; elevated home-health support for two weeks',
      homeSince: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
      supportWindowDays: 14,
    },
  },
  contacts: [
    {
      contactId: 'con_jordan',
      displayName: 'Jordan Mbeki',
      role: 'caregiver',
      relationship: 'Home-health nurse',
      channel: { kind: 'demo', address: 'jordan@example.invalid' },
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_maya',
      displayName: 'Maya Reyes',
      role: 'trusted_contact',
      relationship: 'Daughter',
      channel: { kind: 'demo', address: '+1-555-0100' },
      notifiableOutsideVisits: true,
    },
    {
      contactId: 'con_coord',
      displayName: 'Riverside Home Care',
      role: 'care_coordinator',
      relationship: 'Care agency',
      channel: { kind: 'demo', address: 'coordinator@example.invalid' },
      notifiableOutsideVisits: false,
    },
  ],
  visits: [
    {
      visitId: 'vis_morning_meds',
      contactId: 'con_jordan',
      startsAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() - 4.5 * 3_600_000).toISOString(),
      purpose: 'Morning visit: medication organisation and check-in',
      deviceId: 'front-door-001',
      status: 'completed',
    },
    {
      visitId: 'vis_afternoon_nursing',
      contactId: 'con_jordan',
      startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      purpose: 'Afternoon nursing visit',
      deviceId: 'front-door-001',
      status: 'upcoming',
    },
  ],
  devices: [
    { deviceId: 'front-door-001', displayName: 'Front door', kind: 'doorbell' },
    { deviceId: 'back-door-002', displayName: 'Back door', kind: 'camera' },
  ],
  medications: [
    {
      medicationId: 'med_1',
      name: 'Lisinopril',
      schedule: 'Morning, with breakfast',
      remindAt: '08:00',
      refillsRemaining: 2,
      daysSupplyRemaining: 18,
      pharmacy: 'Riverside Pharmacy',
    },
    {
      medicationId: 'med_2',
      name: 'Metformin',
      schedule: 'Morning and evening, with meals',
      remindAt: '08:00',
      refillsRemaining: 3,
      daysSupplyRemaining: 24,
      pharmacy: 'Riverside Pharmacy',
    },
  ],
  appointments: [
    {
      appointmentId: 'appt_1',
      title: 'Follow-up with Dr. Chen',
      withWhom: 'Dr. Sarah Chen',
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      durationMinutes: 30,
      location: 'Riverside Medical Center',
      kind: 'clinic',
      transportNeeded: true,
    },
  ],
  supportResources: [
    {
      name: '988 Suicide and Crisis Lifeline',
      contact: 'Call or text 988',
      region: 'United States',
      hours: '24/7',
      note: 'Free, confidential support.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Safety panel
// ---------------------------------------------------------------------------

export const OFFLINE_SAFETY: SafetyPanel = {
  consentRequiredForSensitiveActions: true,
  medicalAdvice: 'disabled',
  medicalDiagnosis: 'disabled',
  automaticDoorUnlock: 'disabled',
  emergencyDispatch: 'disabled',
  dataRetention: 'demo-mode',
  trustedContacts: 'patient-controlled',
  blockedCapabilities: [
    'medical_advice',
    'medical_diagnosis',
    'door_unlock',
    'emergency_dispatch',
    'video_access',
  ],
  aiDisclosure:
    "I'm an AI assistant, not a medical professional. I can help coordinate care and contact your care team.",
  webhookSignatureVerification: 'enforced',
  emergencyAssist: {
    status: 'prototype',
    patientInitiatedOnly: true,
    confirmationRequired: true,
    contactsEmergencyServices: false,
    assessesMedicalSeverity: false,
    spokenSafetyLine:
      'I am not a doctor and I cannot contact emergency services. If this is a medical emergency, please call 911.',
  },
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const OFFLINE_HEALTH: Health = {
  ok: true,
  mode: {
    storage: 'local',
    tts: 'browser',
    orchestrator: 'scripted',
    demoMode: true,
  },
  ring: {
    signatureVerification: 'enforced',
    apiCredentialsConfigured: false,
    webhookPath: '/ring/webhook',
  },
  aws: {
    region: 'us-east-1',
    table: null,
    bedrockModelId: null,
    pollyVoiceId: null,
  },
};

// ---------------------------------------------------------------------------
// Sample timeline
// ---------------------------------------------------------------------------

export const OFFLINE_TIMELINE: TimelineEntry[] = [
  {
    entryId: 'tl_1',
    kind: 'ring_event',
    at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    text: 'Jordan Mbeki arrived — morning visit',
    detail: 'Front door doorbell press matched the 9:30–10:00 visit window.',
    sessionId: 'offline_session_1',
  },
  {
    entryId: 'tl_2',
    kind: 'ring_event',
    at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    text: 'Package delivered',
    detail: 'Motion detected at front door. No conversation started — delivery events are logged only.',
  },
];

// ---------------------------------------------------------------------------
// Sample completed session (for the caregiver dashboard)
// ---------------------------------------------------------------------------

export const OFFLINE_SESSIONS: CareSession[] = [
  {
    sessionId: 'offline_session_1',
    state: 'done',
    mode: 'ring_event',
    createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 4.8 * 3_600_000).toISOString(),
    event: {
      eventId: 'evt_demo_1',
      deviceId: 'front-door-001',
      deviceName: 'Front door',
      kind: 'ding',
      at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    },
    match: {
      status: 'scheduled',
      visit: OFFLINE_CARE_PLAN.visits[0],
      contact: OFFLINE_CARE_PLAN.contacts[0],
      confidence: 0.95,
      minutesFromWindow: 0,
      reason: 'Jordan Mbeki arrived within the morning visit window.',
    },
    turns: [
      {
        turnId: 'turn_1',
        speaker: 'agent',
        text: "Good morning, Eleanor. Jordan Mbeki is at the front door — it looks like your scheduled morning visit. Would you like me to let them know you're ready, or do you need a few minutes?",
        at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        engine: 'scripted',
      },
      {
        turnId: 'turn_2',
        speaker: 'patient',
        text: "I'm ready, let them know.",
        at: new Date(Date.now() - 4.95 * 3_600_000).toISOString(),
      },
      {
        turnId: 'turn_3',
        speaker: 'agent',
        text: "Done — I've sent Jordan a message that you're ready. They should be right in.",
        at: new Date(Date.now() - 4.9 * 3_600_000).toISOString(),
        engine: 'scripted',
      },
    ],
    options: [],
    results: [{ detail: 'Jordan was notified that Eleanor is ready.' }],
    handoff: {
      summary: 'Morning medication check-in. Eleanor reported feeling well.',
      tasks: ['Organise daily medications', 'Check blood pressure'],
    },
  } as unknown as CareSession,
];

// ---------------------------------------------------------------------------
// Sample audit records
// ---------------------------------------------------------------------------

export const OFFLINE_AUDIT: AuditRecord[] = [
  {
    auditId: 'aud_1',
    sessionId: 'offline_session_1',
    at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    actor: 'ring',
    event: 'doorbell_press',
  },
  {
    auditId: 'aud_2',
    sessionId: 'offline_session_1',
    at: new Date(Date.now() - 4.95 * 3_600_000).toISOString(),
    actor: 'patient',
    event: 'patient_choice:ready',
  },
  {
    auditId: 'aud_3',
    sessionId: 'offline_session_1',
    at: new Date(Date.now() - 4.9 * 3_600_000).toISOString(),
    actor: 'careflow',
    event: 'action_executed:notify_caregiver',
  },
];

// ---------------------------------------------------------------------------
// Emergency-assist prototype session generator
// ---------------------------------------------------------------------------

export function createOfflineEmergencySession(): CareSession {
  const at = new Date().toISOString();
  return {
    sessionId: `offline_emergency_${Date.now()}`,
    mode: 'emergency_assist_prototype',
    event: {
      eventId: `evt_offline_help_${Date.now()}`,
      deviceId: 'careflow-app',
      deviceName: 'CareFlow app',
      kind: 'patient_request',
      occurredAt: at,
      source: 'patient',
    },
    match: {
      status: 'not_applicable',
      confidence: 1,
      minutesFromWindow: 0,
      reason: 'Patient asked for help.',
    },
    state: 'awaiting_confirmation',
    pendingAction: {
      type: 'escalate_care_team',
      summary: 'tell Jordan Mbeki and Maya Reyes that you need help',
      message: 'The patient used the help button.',
      note: 'Emergency-assist prototype. Patient requested care team contact.',
    },
    turns: [
      {
        turnId: `turn_emergency_${Date.now()}`,
        speaker: 'agent',
        text: "I'm an AI assistant, not a medical professional. I can help coordinate care and contact your care team. I cannot contact emergency services — for an emergency, call 911 directly. Would you like me to tell your care team now?",
        at,
        engine: 'scripted',
        options: [
          { actionId: 'confirm_yes', label: 'Yes, tell my care team' },
          { actionId: 'confirm_no', label: 'No, not now' },
        ],
      },
    ],
    options: [
      { actionId: 'confirm_yes', label: 'Yes, tell my care team' },
      { actionId: 'confirm_no', label: 'No, not now' },
    ],
    results: [],
    createdAt: at,
    updatedAt: at,
  } as unknown as CareSession;
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

/** True when no API URL is configured — the GitHub Pages static-only case. */
export function isOfflineMode(): boolean {
  const url = (import.meta.env.VITE_CAREFLOW_API_URL ?? '').trim();
  return url === '';
}

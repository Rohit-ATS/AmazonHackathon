/**
 * Safety boundaries for the voice agent.
 *
 * These checks run on the patient's words *before* any intent extraction, and their output
 * short-circuits the conversation. Putting them first means a model prompt cannot be the
 * only thing standing between a patient and a medical opinion.
 *
 * Owned by Damir — extend the patterns and the phrasing, but keep the shape: a classifier
 * that returns a refusal plus a useful alternative, never just a refusal.
 */

export type BoundaryKind =
  | 'medical_advice'
  | 'emergency_claim'
  | 'door_unlock'
  | 'identify_person'
  | null;

interface Boundary {
  kind: Exclude<BoundaryKind, null>;
  /** What the agent says instead. Always offers a real next step. */
  say: string;
  /** One-line timeline entry explaining the refusal. */
  rationale: string;
}

const MEDICAL = [
  /\b(should i|do i need to) (take|stop|skip|double)\b/i,
  /\b(is|are) (this|these|it|that) (normal|serious|dangerous|infected)\b/i,
  /\bwhat('s| is) wrong with me\b/i,
  /\b(diagnos|symptom|dosage|dose|prescri)/i,
  /\bmy (chest|head|stomach) (hurts|aches)\b/i,
  /\b(blood pressure|blood sugar|heart rate) (reading|is|was)\b/i,
];

const DOOR = [/\b(unlock|open|let .* in|buzz .* in|disarm)\b.*\b(door|them|him|her|lock|alarm)\b/i, /\bopen the door\b/i];

const EMERGENCY_CLAIM = [/\b(call|dial) (911|999|112|emergency)\b/i, /\bambulance\b/i, /\bparamedic/i];

const IDENTIFY = [/\bwho is (that|at the door|this person)\b/i, /\bcan you see (who|them)\b/i];

export function checkBoundary(utterance: string): Boundary | null {
  if (DOOR.some((r) => r.test(utterance))) {
    return {
      kind: 'door_unlock',
      say: "I'm not able to unlock or open doors — I don't have that control, by design. I can let them know you're coming, or contact someone you trust. Which would you like?",
      rationale: 'Door control is a blocked capability; offered alternatives instead.',
    };
  }

  if (EMERGENCY_CLAIM.some((r) => r.test(utterance))) {
    return {
      kind: 'emergency_claim',
      // Never claims to have called anyone, and never discourages them from calling.
      say: 'I can’t contact emergency services, so if this is an emergency please call them directly. I can let your care team and Maya know that you need help. Would you like me to do that?',
      rationale: 'Emergency dispatch is a blocked capability; directed to emergency services.',
    };
  }

  if (MEDICAL.some((r) => r.test(utterance))) {
    return {
      kind: 'medical_advice',
      say: "I'm an AI assistant, not a medical professional, so I can't answer that. I can pass the question to your care team, or ask Jordan to go through it with you at the visit. Would you like me to send it on?",
      rationale: 'Medical question redirected to the care team; no advice given.',
    };
  }

  if (IDENTIFY.some((r) => r.test(utterance))) {
    return {
      kind: 'identify_person',
      say: "I can't identify people at the door — I only know whether a visit is scheduled. Right now I don't see one. Would you like me to contact someone you trust?",
      rationale: 'No facial recognition or identification; answered from schedule only.',
    };
  }

  return null;
}

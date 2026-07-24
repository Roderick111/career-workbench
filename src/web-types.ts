export type EvidenceLevel = "direct" | "transferable" | "inferred" | "unverified" | "unsupported";

export interface WebExperience {
  id: string;
  company: string;
  context: string;
  location: string;
  role: string;
  period: string;
  bullets: string[];
}

export interface WebProject {
  id: string;
  name: string;
  context: string;
  period: string;
  bullets: string[];
}

export interface WebProfile {
  personal: {
    name: string;
    headline: string;
    email: string;
    phone: string;
    location: string;
    links: string;
  };
  summary: string;
  background: string;
  experiences: WebExperience[];
  projects: WebProject[];
  education: string[];
  certifications: string[];
  skills: string[];
  languages: string[];
  rules: string[];
}

export interface TemplateParagraph {
  id: string;
  part: string;
  index: number;
  text: string;
  inTable: boolean;
}

export interface TemplateSlot {
  id: string;
  fieldPath: string;
  documentPart: string;
  paragraphIndex: number;
  matchText: string;
  mode: "whole-paragraph" | "inline-text";
  protection: "protected" | "tailorable";
}

export interface ResearchSource {
  title: string;
  url: string;
  content?: string;
}

export interface FitReport {
  score: number;
  companySummary: string;
  currentChallenges: string[];
  highlights: Array<{ text: string; evidence: EvidenceLevel }>;
  weakPoints: string[];
  omit: string[];
  keywords: string[];
  questions: string[];
  sources: ResearchSource[];
}

export interface TailoringEdit {
  path: string;
  oldText: string;
  newText: string;
  reason: string;
  evidence: EvidenceLevel;
}

export interface TailoringProposal {
  edits: TailoringEdit[];
  warnings: string[];
}

export type ApplicationStatus =
  | "draft"
  | "research_queued"
  | "researching"
  | "research_ready"
  | "research_approved"
  | "tailor_queued"
  | "tailoring"
  | "proposal_ready"
  | "proposal_approved"
  | "generate_queued"
  | "generating"
  | "complete"
  | "failed";

export const EMPTY_PROFILE: WebProfile = {
  personal: {
    name: "",
    headline: "",
    email: "",
    phone: "",
    location: "",
    links: "",
  },
  summary: "",
  background: "",
  experiences: [],
  projects: [],
  education: [],
  certifications: [],
  skills: [],
  languages: [],
  rules: [],
};

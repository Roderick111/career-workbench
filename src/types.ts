export interface Experience {
  company: string;
  context: string;
  location: string;
  role: string;
  period: string;
  bullets: string[];
}

export interface Project {
  name: string;
  description: string;
  date: string;
  bullet: string;
}

export interface Resume {
  header: {
    line: string;
  };
  labels: {
    summary: string;
    experience: string;
  };
  summary: string;
  experienceOrder: string[];
  experiences: Record<string, Experience>;
  projectOrder: string[];
  projects: Record<string, Project>;
  education: Record<string, { institution: string; program: string; date: string }>;
  certifications: Record<string, { institution: string; program: string; date: string }>;
  skills: {
    languages: string;
    technical: string;
    productLabel: string;
    product: string;
    finance: string;
  };
}

export interface Proposal {
  header?: { line?: string };
  summary?: string;
  experienceOrder?: string[];
  experiences?: Record<string, { context?: string; role?: string; bullets?: string[] }>;
  projectOrder?: string[];
  projects?: Record<string, { description?: string; bullet?: string }>;
  skills?: Partial<Resume["skills"]>;
  warnings?: string[];
}

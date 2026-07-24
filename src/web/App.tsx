import { useEffect, useMemo, useRef, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { renderAsync } from "docx-preview";
import type {
  FitReport,
  TailoringProposal,
  TemplateParagraph,
  TemplateSlot,
  WebExperience,
  WebProfile,
  WebProject,
} from "../web-types";
import { EMPTY_PROFILE } from "../web-types";
import { api, post, put } from "./api";

const authClient = createAuthClient();

type Me = {
  user: { id: string; name: string; email: string; role?: string };
  usage: { used: number; quota: number; cost: number };
};

type TemplateRecord = {
  id: string;
  name: string;
  source_filename: string;
  status: string;
  mapping: TemplateSlot[];
  analysis: { paragraphs?: TemplateParagraph[]; unsupported?: string[] };
};

type ApplicationListItem = {
  id: string;
  company: string;
  role: string;
  status: string;
  error?: string;
  updated_at: string;
};

type ApplicationDetail = ApplicationListItem & {
  job_text: string;
  user_comment: string;
  fit: FitReport | null;
  proposal: TailoringProposal | null;
  artifacts: Array<{
    id: string;
    kind: string;
    filename: string;
    preview_text: string;
    sha256: string;
  }>;
};

type PersonalDocument = {
  id: string;
  kind: string;
  title: string;
  company_key?: string;
  content_md: string;
  updated_at: string;
};

type ProfileImportResponse = {
  profile: WebProfile;
  mode: "profile" | "context";
  saved: boolean;
  warnings: string[];
  reviewPaths: string[];
  requestId: string;
  durationMs: number;
};

type OperationLog = {
  id: string;
  request_id: string;
  user_id?: string;
  email?: string;
  operation: string;
  status: string;
  input_name?: string;
  duration_ms?: number;
  error?: string;
  started_at: string;
  details: Record<string, unknown>;
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshMe = async () => {
    try {
      setMe(await api<Me>("/api/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => void refreshMe(), []);
  if (loading) return <main className="center">Loading…</main>;
  if (!me) return <AuthScreen onDone={refreshMe} />;
  return (
    <Workspace
      me={me}
      error={error}
      setError={setError}
      onSignOut={async () => {
        await authClient.signOut();
        setMe(null);
      }}
    />
  );
}

function AuthScreen({ onDone }: { onDone: () => Promise<void> }) {
  const params = new URLSearchParams(location.search);
  const invite = params.get("invite") ?? "";
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (invite) {
        await post("/api/register", { token: invite, email, name, password });
      }
      const result = await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
      await onDone();
    } catch (caught) {
      setError(message(caught));
    }
  };

  return (
    <main className="auth-shell">
      <form className="panel auth-card" onSubmit={submit}>
        <p className="eyebrow">Tailored CV</p>
        <h1>{invite ? "Create account" : "Sign in"}</h1>
        {invite && <Field label="Name" value={name} onChange={setName} />}
        <Field label="Email" type="email" value={email} onChange={setEmail} disabled={Boolean(invite)} />
        <Field label="Password" type="password" value={password} onChange={setPassword} />
        {error && <p className="error">{error}</p>}
        <button>{invite ? "Create account" : "Sign in"}</button>
      </form>
    </main>
  );
}

function Workspace({
  me,
  error,
  setError,
  onSignOut,
}: {
  me: Me;
  error: string;
  setError: (value: string) => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState("applications");
  return (
    <div className="app-shell">
      <aside>
        <div>
          <p className="eyebrow">Tailored CV</p>
          <h2>{me.user.name}</h2>
          <p className="muted">
            {me.usage.used}/{me.usage.quota} workflows · ${me.usage.cost.toFixed(2)}
          </p>
        </div>
        <nav>
          {[
            ["applications", "Applications"],
            ["profile", "Profile"],
            ["templates", "Templates"],
            ["documents", "Personal space"],
            ...(me.user.role === "admin" ? [["admin", "Admin"]] : []),
          ].map(([value, label]) => (
            <button className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>
              {label}
            </button>
          ))}
        </nav>
        <button className="quiet" onClick={onSignOut}>
          Sign out
        </button>
      </aside>
      <main>
        {error && (
          <div className="error banner" onClick={() => setError("")}>
            {error}
          </div>
        )}
        {tab === "applications" && <ApplicationsPanel setError={setError} onOpenProfile={() => setTab("profile")} />}
        {tab === "profile" && <ProfilePanel setError={setError} />}
        {tab === "templates" && <TemplatesPanel setError={setError} />}
        {tab === "documents" && <DocumentsPanel setError={setError} />}
        {tab === "admin" && <AdminPanel setError={setError} />}
      </main>
    </div>
  );
}

function ApplicationsPanel({
  setError,
  onOpenProfile,
}: {
  setError: (value: string) => void;
  onOpenProfile: () => void;
}) {
  const [applications, setApplications] = useState<ApplicationListItem[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [profileReady, setProfileReady] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jobText, setJobText] = useState("");
  const [templateId, setTemplateId] = useState("");

  const load = async () => {
    const [apps, userTemplates, profile] = await Promise.all([
      api<ApplicationListItem[]>("/api/applications"),
      api<TemplateRecord[]>("/api/templates"),
      api<WebProfile>("/api/profile"),
    ]);
    setApplications(apps);
    setTemplates(userTemplates.filter((template) => template.status === "active"));
    setProfileReady(hasProfileContent(profile));
    if (!templateId) setTemplateId(userTemplates.find((template) => template.status === "active")?.id ?? "");
  };
  useEffect(() => void load().catch((caught) => setError(message(caught))), []);
  useEffect(() => {
    const active = applications.some((item) =>
      ["research_queued", "researching", "tailor_queued", "tailoring", "generate_queued", "generating"].includes(
        item.status,
      ),
    );
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [applications]);

  if (selected) {
    return <ApplicationDetailPanel id={selected} onBack={() => { setSelected(null); void load(); }} setError={setError} />;
  }

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">Job search</p>
          <h1>Applications</h1>
        </div>
      </header>
      {profileReady === false ? (
        <section className="panel profile-required">
          <div>
            <p className="eyebrow">Required first step</p>
            <h2>Complete your career profile</h2>
            <p>
              Your profile supplies facts needed to assess fit and tailor your CV without inventing experience.
            </p>
          </div>
          <button onClick={onOpenProfile}>Complete profile</button>
        </section>
      ) : profileReady === null ? (
        <section className="panel muted">Checking profile…</section>
      ) : (
      <section className="panel">
        <h2>New application</h2>
        <div className="grid two">
          <Field label="Company" value={company} onChange={setCompany} />
          <Field label="Role" value={role} onChange={setRole} />
        </div>
        <label>
          Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">Select active template</option>
            {templates.map((template) => (
              <option value={template.id} key={template.id}>{template.name}</option>
            ))}
          </select>
        </label>
        <label>
          Job post
          <textarea rows={10} value={jobText} onChange={(event) => setJobText(event.target.value)} />
        </label>
        <button
          onClick={async () => {
            try {
              const created = await post<{ id: string }>("/api/applications", {
                company,
                role,
                jobText,
                templateId,
                language: "auto",
                reuseCompanyContext: true,
              });
              await post(`/api/applications/${created.id}/actions/research`);
              setCompany("");
              setRole("");
              setJobText("");
              setSelected(created.id);
            } catch (caught) {
              setError(message(caught));
            }
          }}
        >
          Research fit
        </button>
      </section>
      )}
      <section className="list">
        {applications.map((application) => (
          <button className="list-row" key={application.id} onClick={() => setSelected(application.id)}>
            <span><strong>{application.role}</strong><small>{application.company}</small></span>
            <Status value={application.status} />
          </button>
        ))}
      </section>
    </>
  );
}

function ApplicationDetailPanel({
  id,
  onBack,
  setError,
}: {
  id: string;
  onBack: () => void;
  setError: (value: string) => void;
}) {
  const [application, setApplication] = useState<ApplicationDetail | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [commentSaved, setCommentSaved] = useState(false);
  const commentInitialized = useRef(false);
  const load = async () => {
    const next = await api<ApplicationDetail>(`/api/applications/${id}`);
    setApplication(next);
    return next;
  };
  useEffect(() => {
    commentInitialized.current = false;
    void load()
      .then((next) => {
        if (!commentInitialized.current) {
          setComment(next.user_comment ?? "");
          commentInitialized.current = true;
        }
      })
      .catch((caught) => setError(message(caught)));
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [id]);
  if (!application) return <p>Loading…</p>;

  const action = async (name: string) => {
    try {
      await post(`/api/applications/${id}/actions/${name}`);
      await load();
    } catch (caught) {
      setError(message(caught));
    }
  };

  const saveComment = async () => {
    await put(`/api/applications/${id}/comment`, { comment });
    setCommentSaved(true);
    await load();
  };

  return (
    <>
      <button className="quiet inline" onClick={onBack}>← Applications</button>
      <header>
        <div>
          <p className="eyebrow">{application.company}</p>
          <h1>{application.role}</h1>
        </div>
        <Status value={application.status} />
      </header>
      {application.error && <p className="error panel">{application.error}</p>}
      {["research_queued", "researching", "tailor_queued", "tailoring", "generate_queued", "generating"].includes(
        application.status,
      ) && <div className="panel progress">Working… Page updates automatically.</div>}

      {application.fit && (
        <section className="panel">
          <h2>Fit: {application.fit.score}/10</h2>
          <p>{application.fit.companySummary}</p>
          <Columns titleA="Highlight" itemsA={application.fit.highlights.map((item) => item.text)} titleB="Weak points" itemsB={application.fit.weakPoints} />
          <h3>Keywords</h3>
          <p>{application.fit.keywords.join(" · ")}</p>
          {!!application.fit.sources.length && (
            <>
              <h3>Sources</h3>
              <ul>{application.fit.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank">{source.title}</a></li>)}</ul>
            </>
          )}
          {!["research_queued", "researching", "tailor_queued", "tailoring", "generate_queued", "generating"].includes(application.status) && (
            <div className="user-instructions">
              <label>
                Additional instructions
                <textarea
                  rows={4}
                  value={comment}
                  placeholder="Add guidance for CV tailoring. This is added to the existing job post and profile; it does not replace them."
                  onChange={(event) => { setComment(event.target.value); setCommentSaved(false); }}
                />
              </label>
              <button className="quiet" onClick={() => void saveComment().catch((caught) => setError(message(caught)))}>
                Save instructions
              </button>
              {commentSaved && <span className="muted">Saved</span>}
            </div>
          )}
          {application.status === "research_ready" && (
            <button onClick={async () => { await saveComment(); await action("approve_research"); await action("tailor"); }}>
              Approve and prepare CV edits
            </button>
          )}
        </section>
      )}

      {application.proposal && (
        <section className="panel">
          <h2>Proposed edits</h2>
          {application.proposal.edits.map((edit) => (
            <article className="edit" key={edit.path}>
              <strong>{edit.path}</strong>
              <p className="removed">{edit.oldText}</p>
              <p className="added">{edit.newText}</p>
              <small>[{edit.evidence}] {edit.reason}</small>
            </article>
          ))}
          {application.status === "proposal_ready" && (
            <button onClick={async () => { await action("approve_proposal"); await action("generate"); }}>
              Approve and generate DOCX
            </button>
          )}
        </section>
      )}

      {application.status === "complete" && (
        <section className="panel">
          <h2>Need another version?</h2>
          <p className="muted">Saved instructions will guide a new tailoring pass. Existing files stay available below.</p>
          <button onClick={async () => { await saveComment(); await action("regenerate"); }}>
            Regenerate resume
          </button>
        </section>
      )}

      {!!application.artifacts.length && (
        <section className="panel">
          <h2>Generated files</h2>
          {application.artifacts.map((artifact) => (
            <div className="artifact" key={artifact.id}>
              <span>{artifact.filename}</span>
              <div>
                <button className="quiet inline" onClick={() => setPreview(artifact.id)}>Preview</button>
                <a className="button" href={`/api/artifacts/${artifact.id}/download`}>Download</a>
              </div>
            </div>
          ))}
        </section>
      )}
      {preview && <ArtifactPreview id={preview} artifact={application.artifacts.find((item) => item.id === preview)!} onClose={() => setPreview(null)} />}
    </>
  );
}

function ProfilePanel({ setError }: { setError: (value: string) => void }) {
  const [profile, setProfile] = useState<WebProfile>(structuredClone(EMPTY_PROFILE));
  const [paste, setPaste] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<"update" | "context">("update");
  const [loaded, setLoaded] = useState(false);
  const [showImporter, setShowImporter] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState("");
  const [reviewPaths, setReviewPaths] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const saveConfirmationTimer = useRef<number | null>(null);

  useEffect(() => {
    void api<WebProfile>("/api/profile")
      .then((value) => {
        setProfile(value);
        setShowImporter(!hasProfileContent(value));
        setLoaded(true);
      })
      .catch((caught) => setError(message(caught)));
  }, []);
  useEffect(() => {
    if (!extracting) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [extracting]);
  useEffect(
    () => () => {
      if (saveConfirmationTimer.current !== null) {
        window.clearTimeout(saveConfirmationTimer.current);
      }
    },
    [],
  );

  const showSavedConfirmation = () => {
    if (saveConfirmationTimer.current !== null) {
      window.clearTimeout(saveConfirmationTimer.current);
    }
    setSaveConfirmed(true);
    saveConfirmationTimer.current = window.setTimeout(() => {
      setSaveConfirmed(false);
      saveConfirmationTimer.current = null;
    }, 3000);
  };

  const editProfile = (next: WebProfile) => {
    setProfile(next);
    setSaveState("unsaved");
    setSaveConfirmed(false);
  };

  const updatePersonal = (key: keyof WebProfile["personal"], value: string) =>
    editProfile({ ...profile, personal: { ...profile.personal, [key]: value } });
  const updateExperience = (index: number, next: WebExperience) => {
    const experiences = [...profile.experiences];
    experiences[index] = next;
    editProfile({ ...profile, experiences });
  };
  const updateProject = (index: number, next: WebProject) => {
    const projects = [...profile.projects];
    projects[index] = next;
    editProfile({ ...profile, projects });
  };

  const extract = async () => {
    if (extracting || (!file && !paste.trim())) return;
    setExtracting(true);
    setReviewPaths(new Set());
    setNotice(importMode === "context" ? "Adding notes to career context…" : "");
    try {
      const form = new FormData();
      if (file) form.set("file", file);
      form.set("text", paste);
      form.set("mode", importMode === "context" ? "context" : "profile");
      const result = await api<ProfileImportResponse>("/api/profile/extract", {
        method: "POST",
        body: form,
      });
      setProfile(result.profile);
      setReviewPaths(new Set(result.reviewPaths));
      setShowImporter(false);
      setPaste("");
      setFile(null);
      setSaveState(result.saved ? "saved" : "unsaved");
      if (result.saved) showSavedConfirmation();
      setNotice(
        result.mode === "context"
          ? result.saved
            ? "Career context imported and saved."
            : "Career context added to draft. Review it, then save."
          : result.saved
            ? `Profile updated and saved in ${formatDuration(result.durationMs)}.`
            : `Profile updated in ${formatDuration(result.durationMs)}. Review the draft, then save.`,
      );
    } catch (caught) {
      setNotice(`Profile update failed: ${message(caught)}`);
      setError(message(caught));
    } finally {
      setExtracting(false);
    }
  };

  const save = async () => {
    setSaveState("saving");
    setNotice("Saving profile…");
    try {
      await put("/api/profile", profile);
      setSaveState("saved");
      setNotice("");
      showSavedConfirmation();
    } catch (caught) {
      setSaveState("unsaved");
      setNotice(`Save failed: ${message(caught)}`);
      setError(message(caught));
    }
  };

  if (!loaded) return <p>Loading profile…</p>;

  return (
    <>
      <header>
        <div><p className="eyebrow">Career knowledge base</p><h1>Profile</h1></div>
        <div className="actions">
          {!showImporter && (
            <button className="secondary" onClick={() => {
              setShowImporter(true);
              setNotice("Existing profile will not be overwritten until you save the updated draft.");
            }}>Import another CV</button>
          )}
        </div>
      </header>
      <section className="panel">
        <h2>Context used for every application</h2>
        <p className="muted">
          This profile is the factual source used to assess fit and tailor CVs. Keep CV facts, projects,
          broader responsibilities, transferable evidence, and personal positioning rules here.
        </p>
      </section>
      {showImporter && (
        <section className="panel">
          <h2>Import career information</h2>
          <p className="muted">
            Update the complete profile from a CV/document, or preserve written career notes as exact
            additional context.
          </p>
          <label>Import mode
            <select disabled={extracting} value={importMode} onChange={(event) => setImportMode(event.target.value as "update" | "context")}>
              <option value="update">Update complete profile</option>
              <option value="context">Add exact text to career context</option>
            </select>
          </label>
          {importMode === "update" && (
            <p className="muted">
              One reconciliation agent combines this document with the current profile. Existing information stays unless the source clearly updates it.
            </p>
          )}
          {importMode === "context" && (
            <p className="muted">
              Text is preserved without rewriting. Import only claims you can defend; AI-written notes are not verified.
            </p>
          )}
          <input disabled={extracting} type="file" accept=".docx,.md,.txt,text/markdown,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          <textarea disabled={extracting} rows={5} placeholder="Or paste plain text or Markdown" value={paste} onChange={(event) => setPaste(event.target.value)} />
          <button disabled={extracting || (!file && !paste.trim())} onClick={extract}>
            {extracting
              ? importMode !== "context"
                ? `Analyzing document… ${elapsed}s`
                : "Adding context…"
              : importMode !== "context"
                ? "Update profile from document"
                : "Add context"}
          </button>
          {extracting && importMode !== "context" && (
            <>
              <div className="progress-bar" role="progressbar" aria-label="CV analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={extractionProgress(elapsed)}>
                <span style={{ width: `${extractionProgress(elapsed)}%` }} />
              </div>
              <p className="muted progress-text">{extractionProgress(elapsed)}% · Most analyses finish in about 30 seconds.</p>
            </>
          )}
        </section>
      )}
      {notice && <div className={`panel notice ${extracting ? "progress" : ""}`}>{notice}</div>}
      <section className="panel">
        <h2>Personal details</h2>
        <div className="grid two">
          {Object.entries(profile.personal).map(([key, value]) => (
            <Field key={key} label={humanize(key)} value={value} review={reviewPaths.has(`personal.${key}`)} onChange={(next) => updatePersonal(key as keyof WebProfile["personal"], next)} />
          ))}
        </div>
        <label><span>Professional summary{reviewMarker(reviewPaths.has("summary"))}</span><textarea rows={4} value={profile.summary} onChange={(event) => editProfile({ ...profile, summary: event.target.value })} /></label>
        <label><span>Additional career context{reviewMarker(reviewPaths.has("background"))}</span><textarea rows={10} value={profile.background} onChange={(event) => editProfile({ ...profile, background: event.target.value })} /></label>
        <p className="muted">Add broad responsibilities, evidence, side projects, or experience absent from the current CV. Facts only.</p>
      </section>
      <section className="panel">
        <div className="section-title"><h2>Experience</h2><button className="quiet inline" onClick={() => editProfile({ ...profile, experiences: [...profile.experiences, emptyExperience()] })}>+ Add</button></div>
        {profile.experiences.map((experience, index) => (
          <div className="experience" key={experience.id}>
            <div className="grid two">
              {(["company", "role", "context", "location", "period"] as const).map((key) => (
                <Field key={key} label={humanize(key)} value={experience[key]} review={reviewPaths.has(`experiences.${experience.id}.${key}`)} onChange={(value) => updateExperience(index, { ...experience, [key]: value })} />
              ))}
            </div>
            <label><span>Bullets{reviewMarker(reviewPaths.has(`experiences.${experience.id}.bullets`))}</span><textarea rows={5} value={experience.bullets.join("\n")} onChange={(event) => updateExperience(index, { ...experience, bullets: lines(event.target.value) })} /></label>
            <button className="danger quiet inline" onClick={() => editProfile({ ...profile, experiences: profile.experiences.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="section-title"><h2>Projects</h2><button className="quiet inline" onClick={() => editProfile({ ...profile, projects: [...profile.projects, emptyProject()] })}>+ Add</button></div>
        {profile.projects.map((project, index) => (
          <div className="experience" key={project.id}>
            <div className="grid two">
              {(["name", "context", "period"] as const).map((key) => (
                <Field key={key} label={humanize(key)} value={project[key]} review={reviewPaths.has(`projects.${project.id}.${key}`)} onChange={(value) => updateProject(index, { ...project, [key]: value })} />
              ))}
            </div>
            <label><span>Evidence and outcomes{reviewMarker(reviewPaths.has(`projects.${project.id}.bullets`))}</span><textarea rows={4} value={project.bullets.join("\n")} onChange={(event) => updateProject(index, { ...project, bullets: lines(event.target.value) })} /></label>
            <button className="danger quiet inline" onClick={() => editProfile({ ...profile, projects: profile.projects.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button>
          </div>
        ))}
      </section>
      <section className="panel grid two">
        <LineList label="Education" review={reviewPaths.has("education")} value={profile.education} onChange={(education) => editProfile({ ...profile, education })} />
        <LineList label="Certifications" review={reviewPaths.has("certifications")} value={profile.certifications} onChange={(certifications) => editProfile({ ...profile, certifications })} />
        <LineList label="Skills and domains" review={reviewPaths.has("skills")} value={profile.skills} onChange={(skills) => editProfile({ ...profile, skills })} />
        <LineList label="Languages" review={reviewPaths.has("languages")} value={profile.languages} onChange={(languages) => editProfile({ ...profile, languages })} />
        <LineList label="Personal tailoring rules" review={reviewPaths.has("rules")} value={profile.rules} onChange={(rules) => editProfile({ ...profile, rules })} />
      </section>
      <div className="actions">
        <button disabled={saveState === "saving"} onClick={save}>{saveState === "saving" ? "Saving…" : "Save profile"}</button>
        {saveConfirmed && <span className="save-feedback">Saved</span>}
        {!saveConfirmed && saveState === "unsaved" && <span className="muted">Unsaved changes</span>}
      </div>
      <PasswordPanel setError={setError} />
    </>
  );
}

function TemplatesPanel({ setError }: { setError: (value: string) => void }) {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [profile, setProfile] = useState<WebProfile>(EMPTY_PROFILE);
  const [selected, setSelected] = useState<string | null>(null);
  const load = async () => {
    const [items, value] = await Promise.all([api<TemplateRecord[]>("/api/templates"), api<WebProfile>("/api/profile")]);
    setTemplates(items);
    setProfile(value);
  };
  useEffect(() => void load().catch((caught) => setError(message(caught))), []);
  const template = templates.find((item) => item.id === selected);
  if (template) return <TemplateMapper template={template} profile={profile} onBack={() => { setSelected(null); void load(); }} />;

  return (
    <>
      <header><div><p className="eyebrow">DOCX layouts</p><h1>Templates</h1></div></header>
      <section className="list template-list">
        {templates.map((item) => (
          <button className="list-row" key={item.id} onClick={() => setSelected(item.id)}>
            <span><strong>{item.name}</strong><small>{item.source_filename}</small></span>
            <Status value={item.status} />
          </button>
        ))}
      </section>
      <section className="panel">
        <h2>Add another template</h2>
        <p className="muted">Default template is ready automatically. Upload a DOCX only when you want another layout.</p>
        <div className="actions">
          <label className="button secondary">
            Upload DOCX
            <input hidden type="file" accept=".docx" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.set("file", file);
              form.set("name", file.name.replace(/\.docx$/i, ""));
              try { await api("/api/templates/upload", { method: "POST", body: form }); await load(); } catch (caught) { setError(message(caught)); }
            }} />
          </label>
        </div>
      </section>
    </>
  );
}

function TemplateMapper({ template, profile, onBack }: { template: TemplateRecord; profile: WebProfile; onBack: () => void }) {
  const [slots, setSlots] = useState<TemplateSlot[]>(template.mapping ?? []);
  const [localError, setLocalError] = useState("");
  const [activating, setActivating] = useState(false);
  const values = useMemo(() => flattenProfile(profile), [profile]);
  const mapped = new Map(slots.map((slot) => [`${slot.documentPart}:${slot.paragraphIndex}`, slot]));

  return (
    <>
      <button className="quiet inline" onClick={onBack}>← Templates</button>
      <header><div><p className="eyebrow">Mapping wizard</p><h1>{template.name}</h1></div><Status value={template.status} /></header>
      <p className="muted">Map only text system may safely replace. Identity, employers, dates, locations, education, and languages stay protected.</p>
      <section className="panel mapping-list">
        {(template.analysis.paragraphs ?? []).map((paragraph) => {
          const key = `${paragraph.part}:${paragraph.index}`;
          const slot = mapped.get(key);
          return (
            <div className="mapping-row" key={paragraph.id}>
              <p>{paragraph.text}</p>
              <select value={slot?.fieldPath ?? ""} onChange={(event) => {
                const field = values.find((item) => item.path === event.target.value);
                const without = slots.filter((item) => `${item.documentPart}:${item.paragraphIndex}` !== key);
                if (!field) return setSlots(without);
                setSlots([...without, {
                  id: crypto.randomUUID(),
                  fieldPath: field.path,
                  documentPart: paragraph.part,
                  paragraphIndex: paragraph.index,
                  matchText: field.value,
                  mode: paragraph.text.trim() === field.value.trim() ? "whole-paragraph" : "inline-text",
                  protection: protectedPath(field.path) ? "protected" : "tailorable",
                }]);
              }}>
                <option value="">Not mapped</option>
                {values.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
              </select>
            </div>
          );
        })}
      </section>
      <div className="activation-area">
        <button disabled={activating} onClick={async () => {
          setActivating(true);
          setLocalError("");
          try {
            await put(`/api/templates/${template.id}/mapping`, { slots, activate: true });
            onBack();
          } catch (caught) {
            setLocalError(message(caught));
          } finally {
            setActivating(false);
          }
        }}>
          {activating ? "Saving…" : template.status === "active" ? "Save mapping" : "Validate and activate"}
        </button>
        {localError && (
          <div className="error local-error" role="alert">
            <strong>Template could not be {template.status === "active" ? "saved" : "activated"}.</strong>
            <span>{localError}</span>
          </div>
        )}
      </div>
    </>
  );
}

function DocumentsPanel({ setError }: { setError: (value: string) => void }) {
  const [documents, setDocuments] = useState<PersonalDocument[]>([]);
  const [artifacts, setArtifacts] = useState<Array<ApplicationDetail["artifacts"][number] & { company: string; role: string }>>([]);
  const [selected, setSelected] = useState<PersonalDocument | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const load = async () => {
    const [notes, files] = await Promise.all([
      api<PersonalDocument[]>("/api/documents"),
      api<typeof artifacts>("/api/artifacts"),
    ]);
    setDocuments(notes);
    setArtifacts(files);
  };
  useEffect(() => void load().catch((caught) => setError(message(caught))), []);
  return (
    <>
      <header><div><p className="eyebrow">Reusable knowledge</p><h1>Personal space</h1></div><button onClick={() => setSelected({ id: "", kind: "note", title: "", content_md: "", updated_at: "" })}>New Markdown</button></header>
      <div className="split">
        <section className="list">
          {documents.map((document) => (
            <button className="list-row" key={document.id} onClick={() => setSelected(document)}>
              <span><strong>{document.title}</strong><small>{document.kind}</small></span>
            </button>
          ))}
        </section>
        {selected && <section className="panel">
          <Field label="Title" value={selected.title} onChange={(title) => setSelected({ ...selected, title })} />
          <label>Markdown<textarea rows={22} value={selected.content_md} onChange={(event) => setSelected({ ...selected, content_md: event.target.value })} /></label>
          <div className="actions">
            <button onClick={async () => {
              try {
                if (selected.id) await put(`/api/documents/${selected.id}`, { title: selected.title, content: selected.content_md });
                else await post("/api/documents", { kind: selected.kind, title: selected.title, content: selected.content_md });
                setSelected(null); await load();
              } catch (caught) { setError(message(caught)); }
            }}>Save</button>
            {selected.id && <a className="button secondary" href={`/api/documents/${selected.id}/download`}>Download .md</a>}
          </div>
        </section>}
      </div>
      <section className="panel">
        <h2>Generated files</h2>
        {!artifacts.length && <p className="muted">Generated CVs and review files appear here.</p>}
        {artifacts.map((artifact) => (
          <div className="artifact" key={artifact.id}>
            <span>
              <strong>{artifact.filename}</strong>
              <small>{artifact.company} · {artifact.role}</small>
            </span>
            <div>
              <button className="quiet inline" onClick={() => setPreview(artifact.id)}>Preview</button>
              <a className="button secondary" href={`/api/artifacts/${artifact.id}/download`}>Download</a>
            </div>
          </div>
        ))}
      </section>
      {preview && <ArtifactPreview id={preview} artifact={artifacts.find((item) => item.id === preview)!} onClose={() => setPreview(null)} />}
    </>
  );
}

function AdminPanel({ setError }: { setError: (value: string) => void }) {
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string; monthlyQuota: number; usage: { used: number; cost: number } }>>([]);
  const [operations, setOperations] = useState<OperationLog[]>([]);
  const load = async () => {
    const [userResult, operationResult] = await Promise.all([
      api<{ users: typeof users }>("/api/admin/users"),
      api<OperationLog[]>("/api/admin/operations"),
    ]);
    setUsers(userResult.users);
    setOperations(operationResult);
  };
  useEffect(() => void load().catch((caught) => setError(message(caught))), []);
  return (
    <>
      <header><div><p className="eyebrow">Restricted</p><h1>Admin</h1></div></header>
      <section className="panel">
        <h2>Create invite</h2>
        <div className="actions"><Field label="Friend email" type="email" value={email} onChange={setEmail} /><button onClick={async () => {
          try { const result = await post<{ url: string }>("/api/admin/invites", { email }); setInviteUrl(result.url); } catch (caught) { setError(message(caught)); }
        }}>Create</button></div>
        {inviteUrl && <input value={inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} />}
      </section>
      <section className="panel">
        <h2>Users</h2>
        {users.map((user) => (
          <div className="artifact" key={user.id}>
            <span><strong>{user.name}</strong><small>{user.email} · {user.usage.used}/{user.monthlyQuota} · ${user.usage.cost.toFixed(2)}</small></span>
            <div>
              <input className="quota" title="Monthly quota" type="number" value={user.monthlyQuota} onChange={async (event) => {
                try { await put(`/api/admin/users/${user.id}/quota`, { quota: Number(event.target.value) }); await load(); } catch (caught) { setError(message(caught)); }
              }} />
              <input type="password" placeholder="Temporary password" value={passwords[user.id] ?? ""} onChange={(event) => setPasswords({ ...passwords, [user.id]: event.target.value })} />
              <button className="secondary" onClick={async () => {
                try {
                  await post(`/api/admin/users/${user.id}/password`, { password: passwords[user.id] ?? "" });
                  setPasswords({ ...passwords, [user.id]: "" });
                } catch (caught) { setError(message(caught)); }
              }}>Reset</button>
            </div>
          </div>
        ))}
      </section>
      <section className="panel">
        <div className="section-title"><h2>Recent operations</h2><button className="quiet inline" onClick={() => void load().catch((caught) => setError(message(caught)))}>Refresh</button></div>
        <p className="muted">Request metadata only. CV text and credentials are never logged.</p>
        {operations.map((operation) => (
          <div className="operation-row" key={operation.id}>
            <div>
              <strong>{operation.operation}</strong>
              <small>{operation.email ?? operation.user_id} · {operation.input_name ?? "no input name"} · {operation.request_id}</small>
              {operation.error && <small className="error">{operation.error}</small>}
            </div>
            <div>
              <Status value={operation.status} />
              <small>{operation.duration_ms === undefined || operation.duration_ms === null ? "running" : formatDuration(operation.duration_ms)}</small>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function PasswordPanel({ setError }: { setError: (value: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel">
      <h2>Change password</h2>
      <div className="grid two">
        <Field label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} />
        <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} />
      </div>
      <button onClick={async () => {
        setSaved(false);
        const result = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true });
        if (result.error) return setError(result.error.message ?? "Password change failed.");
        setCurrentPassword("");
        setNewPassword("");
        setSaved(true);
      }}>Change password</button>
      {saved && <p className="muted">Password changed.</p>}
    </section>
  );
}

function ArtifactPreview({ id, artifact, onClose }: { id: string; artifact: ApplicationDetail["artifacts"][number]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(artifact.kind === "cv_docx");
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (artifact.kind !== "cv_docx" || !ref.current) return;
    let cancelled = false;
    setLoading(true);
    setPreviewError("");
    fetch(`/api/artifacts/${id}/download`)
      .then((response) => {
        if (!response.ok) throw new Error(`Preview failed (${response.status}).`);
        return response.blob();
      })
      .then(async (blob) => {
        if (!cancelled && ref.current) await renderAsync(blob, ref.current);
      })
      .catch((error) => {
        if (!cancelled) setPreviewError(message(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, artifact.kind]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(event) => event.stopPropagation()}>
        <button className="quiet inline close" onClick={onClose}>Close</button>
        {loading && <p className="muted">Rendering preview…</p>}
        {previewError && <div className="notice warning">{previewError}</div>}
        {artifact.kind === "cv_docx" ? <div className="docx-preview" ref={ref} /> : <pre>{artifact.preview_text}</pre>}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", disabled = false, review = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean; review?: boolean }) {
  return <label><span>{label}{reviewMarker(review)}</span><input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
}

function LineList({ label, value, onChange, review = false }: { label: string; value: string[]; onChange: (value: string[]) => void; review?: boolean }) {
  return <label><span>{label}{reviewMarker(review)}</span><textarea rows={6} value={value.join("\n")} onChange={(event) => onChange(lines(event.target.value))} /></label>;
}

function reviewMarker(review: boolean): React.ReactNode {
  return review ? <span className="review-marker" title="Review suggested" aria-label="Review suggested">⚠</span> : null;
}

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value.replaceAll("_", " ")}</span>;
}

function Columns({ titleA, itemsA, titleB, itemsB }: { titleA: string; itemsA: string[]; titleB: string; itemsB: string[] }) {
  return <div className="grid two"><div><h3>{titleA}</h3><ul>{itemsA.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3>{titleB}</h3><ul>{itemsB.map((item) => <li key={item}>{item}</li>)}</ul></div></div>;
}

function emptyExperience(): WebExperience {
  return { id: crypto.randomUUID(), company: "", context: "", location: "", role: "", period: "", bullets: [] };
}

function emptyProject(): WebProject {
  return { id: crypto.randomUUID(), name: "", context: "", period: "", bullets: [] };
}

function hasProfileContent(profile: WebProfile): boolean {
  return Boolean(
    profile.personal.name.trim() ||
      profile.summary.trim() ||
      profile.background.trim() ||
      profile.experiences.length ||
      profile.projects.length ||
      profile.education.length ||
      profile.certifications.length ||
      profile.skills.length ||
      profile.languages.length ||
      profile.rules.length
  );
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${Math.round(milliseconds / 1000)}s`;
}

function extractionProgress(elapsedSeconds: number): number {
  return Math.min(95, Math.round((elapsedSeconds / 30) * 95));
}

function flattenProfile(profile: WebProfile): Array<{ path: string; value: string }> {
  const result: Array<{ path: string; value: string }> = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") { if (value.trim().length >= 2) result.push({ path, value }); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
    if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
      if (!["background", "rules"].includes(key)) visit(item, path ? `${path}.${key}` : key);
    });
  };
  visit(profile, "");
  return result;
}

function protectedPath(path: string): boolean {
  return path.startsWith("personal.") ||
    /^experiences\.\d+\.(company|location|period)$/.test(path) ||
    /^projects\.\d+\.(name|period)$/.test(path) ||
    path.startsWith("education.") ||
    path.startsWith("certifications.") ||
    path.startsWith("languages.");
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function humanize(value: string): string { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

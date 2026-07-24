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
        {tab === "applications" && <ApplicationsPanel setError={setError} />}
        {tab === "profile" && <ProfilePanel setError={setError} />}
        {tab === "templates" && <TemplatesPanel setError={setError} />}
        {tab === "documents" && <DocumentsPanel setError={setError} />}
        {tab === "admin" && <AdminPanel setError={setError} />}
      </main>
    </div>
  );
}

function ApplicationsPanel({ setError }: { setError: (value: string) => void }) {
  const [applications, setApplications] = useState<ApplicationListItem[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jobText, setJobText] = useState("");
  const [templateId, setTemplateId] = useState("");

  const load = async () => {
    const [apps, userTemplates] = await Promise.all([
      api<ApplicationListItem[]>("/api/applications"),
      api<TemplateRecord[]>("/api/templates"),
    ]);
    setApplications(apps);
    setTemplates(userTemplates.filter((template) => template.status === "active"));
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
  const load = async () => setApplication(await api<ApplicationDetail>(`/api/applications/${id}`));
  useEffect(() => {
    void load().catch((caught) => setError(message(caught)));
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
          {application.status === "research_ready" && (
            <button onClick={async () => { await action("approve_research"); await action("tailor"); }}>
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
  useEffect(() => void api<WebProfile>("/api/profile").then(setProfile).catch((caught) => setError(message(caught))), []);

  const updatePersonal = (key: keyof WebProfile["personal"], value: string) =>
    setProfile({ ...profile, personal: { ...profile.personal, [key]: value } });
  const updateExperience = (index: number, next: WebExperience) => {
    const experiences = [...profile.experiences];
    experiences[index] = next;
    setProfile({ ...profile, experiences });
  };

  return (
    <>
      <header><div><p className="eyebrow">Source of truth</p><h1>Profile</h1></div></header>
      <section className="panel">
        <h2>Import current CV</h2>
        <p className="muted">DOCX or pasted text. Extraction creates draft; you confirm every fact.</p>
        <input type="file" accept=".docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <textarea rows={5} placeholder="Or paste CV text" value={paste} onChange={(event) => setPaste(event.target.value)} />
        <button onClick={async () => {
          try {
            const form = new FormData();
            if (file) form.set("file", file);
            form.set("text", paste);
            const extracted = await api<WebProfile>("/api/profile/extract", { method: "POST", body: form });
            setProfile(extracted);
          } catch (caught) { setError(message(caught)); }
        }}>Extract draft</button>
      </section>
      <section className="panel">
        <h2>Personal details</h2>
        <div className="grid two">
          {Object.entries(profile.personal).map(([key, value]) => (
            <Field key={key} label={humanize(key)} value={value} onChange={(next) => updatePersonal(key as keyof WebProfile["personal"], next)} />
          ))}
        </div>
        <label>Summary<textarea rows={4} value={profile.summary} onChange={(event) => setProfile({ ...profile, summary: event.target.value })} /></label>
        <label>Background and factual context<textarea rows={10} value={profile.background} onChange={(event) => setProfile({ ...profile, background: event.target.value })} /></label>
      </section>
      <section className="panel">
        <div className="section-title"><h2>Experience</h2><button className="quiet inline" onClick={() => setProfile({ ...profile, experiences: [...profile.experiences, emptyExperience()] })}>+ Add</button></div>
        {profile.experiences.map((experience, index) => (
          <div className="experience" key={experience.id}>
            <div className="grid two">
              {(["company", "role", "context", "location", "period"] as const).map((key) => (
                <Field key={key} label={humanize(key)} value={experience[key]} onChange={(value) => updateExperience(index, { ...experience, [key]: value })} />
              ))}
            </div>
            <label>Bullets<textarea rows={5} value={experience.bullets.join("\n")} onChange={(event) => updateExperience(index, { ...experience, bullets: lines(event.target.value) })} /></label>
            <button className="danger quiet inline" onClick={() => setProfile({ ...profile, experiences: profile.experiences.filter((_, itemIndex) => itemIndex !== index) })}>Remove</button>
          </div>
        ))}
      </section>
      <section className="panel grid two">
        <LineList label="Education" value={profile.education} onChange={(education) => setProfile({ ...profile, education })} />
        <LineList label="Skills" value={profile.skills} onChange={(skills) => setProfile({ ...profile, skills })} />
        <LineList label="Languages" value={profile.languages} onChange={(languages) => setProfile({ ...profile, languages })} />
        <LineList label="Personal tailoring rules" value={profile.rules} onChange={(rules) => setProfile({ ...profile, rules })} />
      </section>
      <button onClick={() => void put("/api/profile", profile).catch((caught) => setError(message(caught)))}>Save profile</button>
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
  if (template) return <TemplateMapper template={template} profile={profile} onBack={() => { setSelected(null); void load(); }} setError={setError} />;

  return (
    <>
      <header><div><p className="eyebrow">Private per user</p><h1>Templates</h1></div></header>
      <section className="panel">
        <h2>Add template</h2>
        <div className="actions">
          <button onClick={async () => { try { await post("/api/templates/starter"); await load(); } catch (caught) { setError(message(caught)); } }}>Create private starter</button>
          <label className="button secondary">
            Upload personal DOCX
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
      <section className="list">
        {templates.map((item) => (
          <button className="list-row" key={item.id} onClick={() => setSelected(item.id)}>
            <span><strong>{item.name}</strong><small>{item.source_filename}</small></span>
            <Status value={item.status} />
          </button>
        ))}
      </section>
    </>
  );
}

function TemplateMapper({ template, profile, onBack, setError }: { template: TemplateRecord; profile: WebProfile; onBack: () => void; setError: (value: string) => void }) {
  const [slots, setSlots] = useState<TemplateSlot[]>(template.mapping ?? []);
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
      <button onClick={async () => {
        try { await put(`/api/templates/${template.id}/mapping`, { slots, activate: true }); onBack(); } catch (caught) { setError(message(caught)); }
      }}>Validate and activate</button>
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
  const load = async () => setUsers((await api<{ users: typeof users }>("/api/admin/users")).users);
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
  useEffect(() => {
    if (artifact.kind !== "cv_docx" || !ref.current) return;
    fetch(`/api/artifacts/${id}/download`)
      .then((response) => response.blob())
      .then((blob) => renderAsync(blob, ref.current!));
  }, [id]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(event) => event.stopPropagation()}>
        <button className="quiet inline close" onClick={onClose}>Close</button>
        {artifact.kind === "cv_docx" ? <div className="docx-preview" ref={ref} /> : <pre>{artifact.preview_text}</pre>}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return <label>{label}<input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
}

function LineList({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label>{label}<textarea rows={6} value={value.join("\n")} onChange={(event) => onChange(lines(event.target.value))} /></label>;
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
  return path.startsWith("personal.") || /^experiences\.\d+\.(company|location|period)$/.test(path) || path.startsWith("education.") || path.startsWith("languages.");
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function humanize(value: string): string { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

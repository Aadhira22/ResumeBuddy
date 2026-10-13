import { useEffect, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000/api/resume";
const BASE_API_URL = "http://localhost:5000/api";

async function authenticatedFetch(url, options = {}) {
  const token = localStorage.getItem("resumebuddy_token");

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    throw new Error("Your session has expired. Please log in again.");
  }

  return response;
}

const emptyResume = {
  name: "",
  email: "",
  phone: "",
  summary: "",
  education: [],
  experience: [],
  projects: [],
  skills: [],
};

function formatJson(value) {
  return JSON.stringify(value ?? [], null, 2);
}

function normalizeResume(data) {
  const source = data?.resume ?? data?.parsedResume ?? data ?? {};

  return {
    ...emptyResume,
    ...source,
    education: Array.isArray(source.education) ? source.education : [],
    experience: Array.isArray(source.experience) ? source.experience : [],
    projects: Array.isArray(source.projects) ? source.projects : [],
    skills: Array.isArray(source.skills)
      ? source.skills
      : typeof source.skills === "string"
        ? source.skills
            .split(",")
            .map((skill) => skill.trim())
            .filter(Boolean)
        : [],
  };
}

export default function App() {
  const [resume, setResume] = useState({ ...emptyResume });
  const [file, setFile] = useState(null);

  const [savedResumes, setSavedResumes] = useState([]);
  const [currentResumeId, setCurrentResumeId] = useState(null);
  const [resumeTitle, setResumeTitle] = useState("My Resume");
  const [savingResume, setSavingResume] = useState(false);
  const [loadingResumes, setLoadingResumes] = useState(false);

  const [educationText, setEducationText] = useState("[]");
  const [experienceText, setExperienceText] = useState("[]");
  const [projectsText, setProjectsText] = useState("[]");

  const [loading, setLoading] = useState(false);
  const [improving, setImproving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const [pdfUrl, setPdfUrl] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [token, setToken] = useState(
    () => localStorage.getItem("resumebuddy_token") || "",
  );

  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem("resumebuddy_user");

    try {
      return savedUser ? JSON.parse(savedUser) : null;
    } catch {
      return null;
    }
  });

  const [authMode, setAuthMode] = useState("login");
  const [authLoading, setAuthLoading] = useState(false);

  const [authForm, setAuthForm] = useState({
    name: "",
    email: "",
    password: "",
  });

  useEffect(() => {
    return () => {
      if (pdfUrl) {
        window.URL.revokeObjectURL(pdfUrl);
      }
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (token && user) {
      loadSavedResumes();
    } else {
      setSavedResumes([]);
      setCurrentResumeId(null);
    }
  }, [token, user]);

  function updateField(field, value) {
    setResume((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();

    try {
      setAuthLoading(true);
      setError("");
      setSuccess("");

      const endpoint =
        authMode === "register" ? "/auth/register" : "/auth/login";

      const response = await fetch(`http://localhost:5000/api${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(authForm),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.error || "Authentication failed.");
      }

      localStorage.setItem("resumebuddy_token", data.token);
      localStorage.setItem("resumebuddy_user", JSON.stringify(data.user));

      setToken(data.token);
      setUser(data.user);

      setAuthForm({ name: "", email: "", password: "" });

      setSuccess(
        authMode === "register"
          ? "Account created successfully!"
          : "Logged in successfully!",
      );
    } catch (err) {
      setError(err.message || "Authentication failed.");
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("resumebuddy_token");
    localStorage.removeItem("resumebuddy_user");

    setToken("");
    setUser(null);
    setResume({ ...emptyResume });
    setFile(null);
    setPdfUrl("");
    setError("");
    setSuccess("");
  }

  async function loadSavedResumes() {
    try {
      setLoadingResumes(true);

      const response = await authenticatedFetch(`${BASE_API_URL}/resumes`);
      
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not load saved resumes.");
      }

      setSavedResumes(data.resumes || []);
    } catch (err) {
      setError(err.message || "Could not load saved resumes.");
    } finally {
      setLoadingResumes(false);
    }
  }

  async function handleDeleteResume(id) {
    const confirmed = window.confirm(
      "Are you sure you want to delete this resume? This cannot be undone."
    );

    if (!confirmed) return;

    try {
      setError("");
      setSuccess("");

      const response = await authenticatedFetch(
        `${BASE_API_URL}/resumes/${id}`,
        { method: "DELETE" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not delete resume.");
      }

      setSavedResumes((current) =>
        current.filter((item) => item._id !== id)
      );

      if (currentResumeId === id) {
        setResume({ ...emptyResume });
        syncResumeEditors(emptyResume);
        setResumeTitle("My Resume");
        setCurrentResumeId(null);
        setFile(null);
      }

      setSuccess("Resume deleted successfully.");
    } catch (err) {
      setError(err.message || "Could not delete resume.");
    }
  }
  async function handleSaveResume() {
    try {
      setSavingResume(true);
      setError("");
      setSuccess("");

      const url = currentResumeId
        ? `${BASE_API_URL}/resumes/${currentResumeId}`
        : `${BASE_API_URL}/resumes`;

      const response = await authenticatedFetch(url, {
        method: currentResumeId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: resumeTitle.trim() || "My Resume",
          resumeData: resume,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not save your resume.");
      }

      setCurrentResumeId(data.resume._id);
      setResumeTitle(data.resume.title);

      setSuccess(
        currentResumeId
          ? "Resume updated successfully."
          : "Resume saved successfully.",
      );

      await loadSavedResumes();
    } catch (err) {
      setError(err.message || "Could not save your resume.");
    } finally {
      setSavingResume(false);
    }
  }

  function syncResumeEditors(data) {
    setEducationText(formatJson(data.education));
    setExperienceText(formatJson(data.experience));
    setProjectsText(formatJson(data.projects));
  }

  function handleJsonChange(field, text, setText) {
    setText(text);

    try {
      const parsed = JSON.parse(text);

      if (!Array.isArray(parsed)) {
        return;
      }

      setResume((current) => ({
        ...current,
        [field]: parsed,
      }));
    } catch {
      // Preserve incomplete JSON while the user is editing.
    }
  }

  async function handleUpload(event) {
    event.preventDefault();

    if (!file) {
      setError("Please select a PDF resume first.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setSuccess("");

      const formData = new FormData();
      formData.append("resume", file);

      const response = await fetch(`${API_URL}/parse`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not parse your resume.");
      }

      const parsedResume = normalizeResume(data);

      setResume(parsedResume);
      syncResumeEditors(parsedResume);

      setSuccess("Resume parsed successfully. You can now edit the fields.");
    } catch (err) {
      setError(err.message || "Something went wrong while parsing the PDF.");
    } finally {
      setLoading(false);
    }
  }

  async function handleImprove() {
    try {
      setImproving(true);
      setError("");
      setSuccess("");

      const response = await fetch(`${API_URL}/improve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(resume),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not improve the resume.");
      }

      const improvedResume = normalizeResume(
        data.improved ?? data.resume ?? data,
      );

      setResume(improvedResume);
      syncResumeEditors(improvedResume);

      setSuccess("Resume wording improved successfully.");
    } catch (err) {
      setError(
        err.message || "Something went wrong while improving the resume.",
      );
    } finally {
      setImproving(false);
    }
  }

  async function generatePdfBlob() {
    const response = await fetch(`${API_URL}/generate-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resume),
    });

    if (!response.ok) {
      let message = "Failed to generate the PDF.";

      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        // The server may return a non-JSON error response.
      }

      throw new Error(message);
    }

    return response.blob();
  }

  async function handleUpdatePreview() {
    try {
      setPreviewing(true);
      setError("");
      setSuccess("");

      const pdfBlob = await generatePdfBlob();
      const newPdfUrl = window.URL.createObjectURL(pdfBlob);

      setPdfUrl(newPdfUrl);
      setSuccess("Preview updated with your latest resume.");
    } catch (err) {
      setError(err.message || "Could not update the PDF preview.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleDownloadPdf() {
    try {
      setDownloading(true);
      setError("");
      setSuccess("");

      const pdfBlob = await generatePdfBlob();
      const newPdfUrl = window.URL.createObjectURL(pdfBlob);

      setPdfUrl(newPdfUrl);

      const link = document.createElement("a");
      link.href = newPdfUrl;
      link.download = "ResumeBuddy-Resume.pdf";

      document.body.appendChild(link);
      link.click();
      link.remove();

      setSuccess(
        "Your resume PDF has been downloaded and the preview updated.",
      );
    } catch (err) {
      setError(err.message || "Could not download the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <div className="header-top">
          <div>
            <h1>ResumeBuddy</h1>
            <p>Build, improve, and download your professional resume.</p>
          </div>

          {token && user && (
            <div className="account-actions">
              <span>Welcome, {user.name}</span>
              <button type="button" onClick={handleLogout}>
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {success && (
        <div className="success" role="status">
          {success}
        </div>
      )}

      {!token || !user ? (
        <section className="auth-card">
          <h2>
            {authMode === "login" ? "Welcome back" : "Create your account"}
          </h2>

          <p>
            {authMode === "login"
              ? "Log in to continue to ResumeBuddy."
              : "Create an account to get started with ResumeBuddy."}
          </p>

          <form onSubmit={handleAuthSubmit}>
            {authMode === "register" && (
              <div className="field">
                <label htmlFor="auth-name">Full name</label>
                <input
                  id="auth-name"
                  type="text"
                  value={authForm.name}
                  onChange={(event) =>
                    setAuthForm({
                      ...authForm,
                      name: event.target.value,
                    })
                  }
                  autoComplete="name"
                  required
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                type="email"
                value={authForm.email}
                onChange={(event) =>
                  setAuthForm({
                    ...authForm,
                    email: event.target.value,
                  })
                }
                autoComplete="email"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                value={authForm.password}
                onChange={(event) =>
                  setAuthForm({
                    ...authForm,
                    password: event.target.value,
                  })
                }
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
                minLength={8}
                required
              />
            </div>

            <button type="submit" disabled={authLoading}>
              {authLoading
                ? "Please wait..."
                : authMode === "login"
                  ? "Log in"
                  : "Create account"}
            </button>
          </form>

          <p className="auth-switch">
            {authMode === "login"
              ? "Don't have an account?"
              : "Already have an account?"}{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setAuthMode(authMode === "login" ? "register" : "login");
                setError("");
                setSuccess("");
              }}
            >
              {authMode === "login" ? "Register" : "Log in"}
            </button>
          </p>
        </section>
      ) : (
        <div className="workspace">
          <section className="editor">
            <h2>1. Upload your resume</h2>

            <form className="upload-card" onSubmit={handleUpload}>
              <label className="field">
                <span>Select your resume (PDF)</span>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setError("");
                    setSuccess("");
                  }}
                />
              </label>

              {file && <p className="hint">Selected: {file.name}</p>}

              <button type="submit" disabled={loading || !file}>
                {loading ? "Parsing resume..." : "Upload and Parse"}
              </button>
            </form>

            <section className="saved-resumes">
              <div className="saved-resumes-header">
                <h2>My Resumes</h2>

                <button
                  type="button"
                  onClick={() => {
                    setResume({ ...emptyResume });
                    setResumeTitle("My Resume");
                    setCurrentResumeId(null);
                    setFile(null);
                    setError("");
                    setSuccess("");
                    syncResumeEditors(emptyResume);
                  }}
                >
                  + New Resume
                </button>
              </div>

              {loadingResumes ? (
                <p>Loading your resumes...</p>
              ) : savedResumes.length === 0 ? (
                <p>You haven't saved any resumes yet.</p>
              ) : (
                savedResumes.map((item) => (
                  <div className="saved-resume-item" key={item._id}>
                    <div>
                      <strong>{item.title}</strong>
                      <p>
                        Updated {new Date(item.updatedAt).toLocaleDateString()}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        const data = normalizeResume(item.resumeData);
                        setResume(data);
                        syncResumeEditors(data);
                        setResumeTitle(item.title || "My Resume");
                        setCurrentResumeId(item._id);

                        setError("");
                        setSuccess("Resume loaded successfully.");
                      }}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="delete-button"
                      onClick={() => handleDeleteResume(item._id)}
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </section>
            <h2>2. Edit your details</h2>

            <div className="field">
              <label htmlFor="resume-title">Resume title</label>
              <input
                id="resume-title"
                value={resumeTitle}
                onChange={(event) => setResumeTitle(event.target.value)}
                placeholder="e.g. Software Engineer Resume"
              />
            </div>

            <button
              type="button"
              onClick={handleSaveResume}
              disabled={
                savingResume ||
                loading ||
                improving ||
                downloading ||
                previewing
              }
            >
              {savingResume ? "Saving..." : "Save Resume"}
            </button>
            <div className="field">
              <label htmlFor="name">Full name</label>
              <input
                id="name"
                value={resume.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="Your full name"
              />
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={resume.email}
                onChange={(event) => updateField("email", event.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                value={resume.phone}
                onChange={(event) => updateField("phone", event.target.value)}
                placeholder="Your phone number"
              />
            </div>

            <div className="field">
              <label htmlFor="summary">Professional summary</label>
              <textarea
                id="summary"
                rows={4}
                value={resume.summary}
                onChange={(event) => updateField("summary", event.target.value)}
                placeholder="Write a short professional summary"
              />
            </div>

            <div className="field">
              <label htmlFor="education">Education (JSON array)</label>
              <textarea
                id="education"
                rows={7}
                value={educationText}
                onChange={(event) =>
                  handleJsonChange(
                    "education",
                    event.target.value,
                    setEducationText,
                  )
                }
                spellCheck={false}
              />
              <p className="hint">
                Use an array of objects, for example: degree, institution,
                dates, and GPA.
              </p>
            </div>

            <div className="field">
              <label htmlFor="experience">Experience (JSON array)</label>
              <textarea
                id="experience"
                rows={9}
                value={experienceText}
                onChange={(event) =>
                  handleJsonChange(
                    "experience",
                    event.target.value,
                    setExperienceText,
                  )
                }
                spellCheck={false}
              />
              <p className="hint">
                Each entry can include role, company, dates, and bullet points.
              </p>
            </div>

            <div className="field">
              <label htmlFor="projects">Projects (JSON array)</label>
              <textarea
                id="projects"
                rows={9}
                value={projectsText}
                onChange={(event) =>
                  handleJsonChange(
                    "projects",
                    event.target.value,
                    setProjectsText,
                  )
                }
                spellCheck={false}
              />
              <p className="hint">
                Each entry can include title, description, dates, and
                technologies.
              </p>
            </div>

            <div className="field">
              <label htmlFor="skills">Technical skills</label>
              <textarea
                id="skills"
                rows={3}
                value={resume.skills.join(", ")}
                onChange={(event) =>
                  updateField(
                    "skills",
                    event.target.value
                      .split(",")
                      .map((skill) => skill.trim())
                      .filter(Boolean),
                  )
                }
                placeholder="C++, JavaScript, React, Node.js"
              />
              <p className="hint">Separate skills with commas.</p>
            </div>

            <div className="action-buttons">
              <button
                type="button"
                onClick={handleImprove}
                disabled={improving || downloading || previewing}
              >
                {improving ? "Improving..." : "Improve with AI"}
              </button>

              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={downloading || improving || previewing}
              >
                {downloading ? "Generating PDF..." : "Download PDF"}
              </button>
            </div>
          </section>

          <section className="preview">
            <div className="preview-header">
              <h2>3. Resume preview</h2>

              <button
                type="button"
                onClick={handleUpdatePreview}
                disabled={previewing || downloading || improving}
              >
                {previewing ? "Updating preview..." : "Update Preview"}
              </button>
            </div>

            <div className="pdf-preview">
              {pdfUrl ? (
                <iframe
                  key={pdfUrl}
                  src={pdfUrl}
                  title="Generated resume PDF preview"
                  className="pdf-frame"
                />
              ) : (
                <div className="pdf-placeholder">
                  <div className="pdf-placeholder-icon">PDF</div>

                  <h3>Your resume preview will appear here</h3>

                  <p>
                    Click <strong>Update Preview</strong> to generate and view
                    your resume using your current details.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
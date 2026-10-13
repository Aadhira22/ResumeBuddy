const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Resume = require("./models/Resume");
const authenticateToken = require("./middleware/authMiddleware");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
let pdfjsLib;

async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }

  return pdfjsLib;
}
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const execFileAsync = promisify(execFile);

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PDFLATEX_PATH =
  process.env.PDFLATEX_PATH ||
  "C:\\Users\\Shruti\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, callback) => {
    if (
      file.mimetype !== "application/pdf" ||
      path.extname(file.originalname).toLowerCase() !== ".pdf"
    ) {
      return callback(new Error("Please upload a PDF file."));
    }
    callback(null, true);
  },
});

let geminiClient;

async function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from backend/.env");
  }

  if (!geminiClient) {
    const { GoogleGenAI } = await import("@google/genai");
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  return geminiClient;
}

function parseJsonResponse(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }
}

async function generateJson(prompt, pdfBuffer) {
  const ai = await getGeminiClient();
  const parts = [{ text: prompt }];

  if (pdfBuffer) {
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBuffer.toString("base64"),
      },
    });
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
    },
  });

  return parseJsonResponse(response.text);
}

function asString(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  return "";
}

function normalizeSkill(skill) {
  if (typeof skill === "string" || typeof skill === "number") {
    return asString(skill);
  }

  if (!skill || typeof skill !== "object") {
    return "";
  }

  const raw = skill.items ?? skill.skills ?? skill.values ?? [];

  const items = Array.isArray(raw)
    ? raw.map(asString).filter(Boolean)
    : asString(raw)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    category: asString(skill.category || skill.name || skill.label),
    items,
  };
}

function normalizeResume(data = {}) {
  const skills = Array.isArray(data.skills)
    ? data.skills.map(normalizeSkill).filter(Boolean)
    : typeof data.skills === "string"
      ? data.skills.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  return {
    name: asString(data.name),
    email: asString(data.email),
    phone: asString(data.phone),
    linkedin: asString(data.linkedin),
    github: asString(data.github),
    portfolio: asString(data.portfolio),
    summary: asString(data.summary),
    education: Array.isArray(data.education) ? data.education : [],
    experience: Array.isArray(data.experience) ? data.experience : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    skills,
    sections: Array.isArray(data.sections) ? data.sections : [],
  };
}

function validateResume(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Please provide valid resume data.");
  }

  return normalizeResume(data);
}

function escapeLatex(value) {
  const replacements = {
    "\\": "\\textbackslash{}",
    "&": "\\&",
    "%": "\\%",
    "$": "\\$",
    "#": "\\#",
    "_": "\\_",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };

  return String(value ?? "").replace(/[\\&%$#_{}~^]/g, (char) => {
    return replacements[char];
  });
}

function safeUrl(value) {
  const url = asString(value);

  if (!/^(https?:\/\/|mailto:|tel:)[^\s{}]+$/i.test(url)) {
    return "";
  }

  return url
    .replace(/\\/g, "")
    .replace(/[{}]/g, "")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#")
    .replace(/&/g, "\\&")
    .replace(/_/g, "\\_");
}

function href(urlValue, labelValue) {
  const url = safeUrl(urlValue);

  if (!url) {
    return escapeLatex(labelValue);
  }

  return `\\href{${url}}{${escapeLatex(labelValue)}}`;
}

function getSectionKey(title) {
  const normalized = normalizeSectionTitle(title);

  const aliases = {
    "work experience": "experience",
    "professional experience": "experience",
    "employment history": "experience",
    "technical skills": "skills",
    "core skills": "skills",
    "professional summary": "summary",
    "career objective": "summary",
  };

  return aliases[normalized] || normalized;
}

function normalizeSectionTitle(title = "") {
  return asString(title)
    .toLowerCase()
    .replace(/[:&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getEntryHeading(entry = {}) {
  return (
    entry.title ||
    entry.degree ||
    entry.role ||
    entry.position ||
    entry.name ||
    entry.projectName ||
    entry.program ||
    ""
  );
}

function getOrganization(entry = {}) {
  return (
    entry.company ||
    entry.institution ||
    entry.school ||
    entry.organization ||
    entry.employer ||
    ""
  );
}

function getDates(entry = {}) {
  return (
    entry.duration ||
    entry.dates ||
    entry.date ||
    entry.period ||
    [entry.startDate, entry.endDate].filter(Boolean).join(" – ")
  );
}

function getDescription(entry = {}) {
  return (
    entry.bullets ||
    entry.description ||
    entry.details ||
    entry.responsibilities ||
    entry.summary ||
    []
  );
}

function toBulletArray(description) {
  if (Array.isArray(description)) {
    return description
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") {
          return String(item);
        }

        if (item && typeof item === "object") {
          return asString(item.text || item.description || item.title);
        }

        return "";
      })
      .filter(Boolean);
  }

  if (typeof description === "string" && description.trim()) {
    return description
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-•]\s*/, "").trim())
      .filter(Boolean);
  }

  return [];
}

function renderBullets(items) {
  const bullets = toBulletArray(items);

  if (!bullets.length) {
    return "";
  }

  return `\\begin{itemize}
${bullets.map((item) => `\\item ${escapeLatex(item)}`).join("\n")}
\\end{itemize}
`;
}

async function extractPdfLinks(pdfBuffer) {
  const pdfjs = await getPdfJs();

  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
  }).promise;

  const links = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const annotations = await page.getAnnotations();

    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;

      const url = annotation.url || annotation.unsafeUrl;

      if (url && /^https?:\/\//i.test(url)) {
        links.push({
          page: pageNumber,
          url,
        });
      }
    }
  }

  return [...new Map(links.map(link => [link.url, link])).values()];
}

function renderEntry(entry, type = "general") {
  if (typeof entry === "string" || typeof entry === "number") {
    return escapeLatex(entry);
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }

  const toText = (value) => {
    if (value === null || value === undefined) return "";

    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value.map(toText).filter(Boolean).join(", ");
    }

    return "";
  };

  const getUrl = (value) => {
    if (typeof value === "string") {
      return value.trim();
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      return toText(value.url || value.href || value.uri).trim();
    }

    return "";
  };

  const heading = toText(getEntryHeading(entry));
  const organization = toText(getOrganization(entry));
  const dates = toText(getDates(entry));
  const location = toText(entry.location);
  const gpa = toText(entry.gpa || entry.grade);
  const bullets = getDescription(entry);

  const techRaw =
    entry.technologies ??
    entry.techStack ??
    entry.technology ??
    entry.tech_stack ??
    [];

  const technologies = Array.isArray(techRaw)
    ? techRaw.map(toText).filter(Boolean).join(", ")
    : toText(techRaw);

  const githubUrl = getUrl(
    entry.githubUrl || entry.github || entry.repository
  );

  const demoUrl = getUrl(
    entry.liveDemo || entry.demoUrl || entry.website
  );

  const otherLinks = Array.isArray(entry.otherLinks)
    ? entry.otherLinks
    : [];

  let output = "\\begin{samepage}\n";

  if (type === "education") {
    output += "\\begin{tabularx}{\\textwidth}{@{}X r@{}}\n";
    output += `\\textbf{${escapeLatex(organization)}} & ${escapeLatex(dates)} \\\\\n`;
    output += "\\end{tabularx}\n";

    output += "\\begin{tabularx}{\\textwidth}{@{}X r@{}}\n";
    output += `${escapeLatex(heading)} & ${
      gpa ? `CGPA: ${escapeLatex(gpa)}` : ""
    } \\\\\n`;
    output += "\\end{tabularx}\n";

    if (location) {
      output += `${escapeLatex(location)}\\par\n`;
    }
  } else {
    output += "\\begin{tabularx}{\\textwidth}{@{}X r@{}}\n";
    output += `${escapeLatex(heading)} & ${escapeLatex(dates)} \\\\\n`;
    output += "\\end{tabularx}\n";

    if (type === "project") {
      const links = [];

      if (/^https?:\/\//i.test(githubUrl)) {
        links.push(href(githubUrl, "GitHub"));
      }

      if (/^https?:\/\//i.test(demoUrl)) {
        links.push(href(demoUrl, "Live Demo"));
      }

      for (const link of otherLinks) {
        if (typeof link === "string") {
          const url = getUrl(link);

          if (/^https?:\/\//i.test(url)) {
            links.push(href(url, "Link"));
          }
        } else if (link && typeof link === "object") {
          const url = getUrl(link.url || link.href || link.uri);
          const label = toText(link.label) || "Link";

          if (/^https?:\/\//i.test(url)) {
            links.push(href(url, label));
          }
        }
      }

      if (technologies) {
        output += `\\textit{Tech Stack: ${escapeLatex(technologies)}}`;

        if (links.length) {
          output += `\\hfill ${links.join(" \\quad ")}`;
        }

        output += "\\par\n";
      } else if (links.length) {
        output += `${links.join(" \\quad ")}\\par\n`;
      }
    } else {
      const subline = [organization, location]
        .filter(Boolean)
        .map(escapeLatex);

      if (subline.length) {
        output += `${subline.join(" \\hfill ")}\\par\n`;
      }
    }
  }

  if (Array.isArray(bullets)) {
    const safeBullets = bullets
      .map((bullet) => {
        if (typeof bullet === "string" || typeof bullet === "number") {
          return String(bullet);
        }

        if (bullet && typeof bullet === "object") {
          return toText(
            bullet.text || bullet.description || bullet.content
          );
        }

        return "";
      })
      .filter(Boolean);

    output += renderBullets(safeBullets);
  } else if (typeof bullets === "string" && bullets.trim()) {
    output += renderBullets([bullets]);
  }

  output += "\\end{samepage}\n";

  return output;
}

function renderEducation(items) {
  return items
    .map((item) => renderEntry(item, "education"))
    .join("\n");
}

function renderExperience(items) {
  return items
    .map((item) => renderEntry(item, "experience"))
    .join("\n");
}

function renderProjects(items) {
  return items
    .map((item) => renderEntry(item, "project"))
    .join("\n");
}

function renderSkills(skills) {
  return skills
    .map((skill) => {
      if (typeof skill === "string" || typeof skill === "number") {
        return escapeLatex(skill);
      }

      if (!skill || typeof skill !== "object") {
        return "";
      }

      const category = asString(
        skill.category || skill.name || skill.label
      );

      const raw = skill.items ?? skill.skills ?? skill.values ?? [];

      const values = Array.isArray(raw)
        ? raw.map(asString).filter(Boolean).join(", ")
        : asString(raw);

      if (category && values) {
        return `\\textbf{${escapeLatex(category)}:} ${escapeLatex(values)}`;
      }

      return escapeLatex(values || category);
    })
    .filter(Boolean)
    .join("\\\\\n");
}

function renderGenericSection(section) {
  const title = asString(section?.title || section?.heading);

  if (!title) {
    return "";
  }

  const items =
    section.items ??
    section.bullets ??
    section.content ??
    section.text ??
    "";

  function renderTextWithLinks(value) {
    const text = asString(value);

    if (!text) return "";

    const urlPattern = /https?:\/\/[^\s)]+/gi;
    let result = "";
    let lastIndex = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
      const url = match[0];
      const beforeUrl = text.slice(lastIndex, match.index);

      result += escapeLatex(beforeUrl);

      const cleanUrl = url.replace(/[.,;]+$/, "");
      const trailing = url.slice(cleanUrl.length);

      result += href(cleanUrl, "Certificate");
      result += escapeLatex(trailing);

      lastIndex = match.index + url.length;
    }

    result += escapeLatex(text.slice(lastIndex));

    return result;
  }

  let content = "";

  if (Array.isArray(items)) {
    const renderedItems = items
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") {
          return renderTextWithLinks(item);
        }

        if (item && typeof item === "object") {
          const label = asString(
            item.title ||
            item.name ||
            item.label ||
            item.text ||
            item.content
          );

          const url = asString(
            item.url ||
            item.href ||
            item.link ||
            item.certificateUrl ||
            item.certificate_url
          );

          if (url && /^https?:\/\//i.test(url)) {
            return `${escapeLatex(label || "Certificate")} (${href(url, "View Certificate")})`;
          }

          return renderTextWithLinks(label);
        }

        return "";
      })
      .filter(Boolean);

    content = renderedItems.length
      ? `\\begin{itemize}
${renderedItems.map((item) => `\\item ${item}`).join("\n")}
\\end{itemize}`
      : "";
  } else if (typeof items === "string" && items.trim()) {
    content = renderTextWithLinks(items).replace(/\r?\n/g, "\\\\\n");
  } else if (items && typeof items === "object") {
    const label = asString(items.title || items.name || items.label);
    const url = asString(
      items.url || items.href || items.link || items.certificateUrl
    );

    content = url && /^https?:\/\//i.test(url)
      ? `${escapeLatex(label || "Certificate")} (${href(url, "View Certificate")})`
      : renderTextWithLinks(label);
  }

  if (!content) {
    return "";
  }

  return `\\section{${escapeLatex(title)}}
${content}
`;
}

function sectionContentForTitle(title, resume) {
  const key = normalizeSectionTitle(title);

  if (
    [
      "professional summary",
      "summary",
      "profile",
      "objective",
      "career objective",
    ].includes(key)
  ) {
    return resume.summary ? escapeLatex(resume.summary) : "";
  }

  if (["education", "academic background", "academics"].includes(key)) {
    return renderEducation(resume.education);
  }

  if (
    [
      "experience",
      "work experience",
      "employment",
      "internship",
      "internships",
      "professional experience",
    ].includes(key)
  ) {
    return renderExperience(resume.experience);
  }

  if (
    ["projects", "personal projects", "academic projects"].includes(key)
  ) {
    return renderProjects(resume.projects);
  }

  if (
    ["technical skills", "skills", "technical proficiencies"].includes(key)
  ) {
    return renderSkills(resume.skills);
  }

  return null;
}

function renderDynamicSections(resume) {
  const output = [];
  const renderedKeys = new Set();

  if (resume.sections.length) {
    for (const section of resume.sections) {
      const title = asString(section?.title || section?.heading);

      if (!title) {
        continue;
      }

      const key = getSectionKey(title);
      const semantic = sectionContentForTitle(title, resume);

      if (semantic !== null) {
        if (semantic.trim()) {
          const isEducation = /^education$/i.test(title.trim());

          output.push(
            `\\section{${escapeLatex(title)}}\n${semantic}` +
            (isEducation ? "\n\\vspace{-10pt}" : "")
          );
        }

        renderedKeys.add(key);
        continue;
      }

      const generic = renderGenericSection(section);

      if (generic) {
        output.push(generic);
      }

      renderedKeys.add(key);
    }
  }

  const fallback = [
    ["Education", resume.education, renderEducation],
    ["Experience", resume.experience, renderExperience],
    ["Projects", resume.projects, renderProjects],
    ["Technical Skills", resume.skills, renderSkills],
  ];

  for (const [title, data, renderer] of fallback) {
    const key = getSectionKey(title);

    if (!renderedKeys.has(key) && Array.isArray(data) && data.length) {
      output.push(`\\section{${escapeLatex(title)}}\n${renderer(data)}`);
    }
  }

  if (
    resume.summary &&
    ![...renderedKeys].some((key) =>
      [
        "professional summary",
        "summary",
        "profile",
        "objective",
        "career objective",
      ].includes(key)
    )
  ) {
    output.unshift(
      `\\section{Professional Summary}\n${escapeLatex(resume.summary)}`
    );
  }

  return output.join("\n");
}

function buildLatex(template, resume) {
  const contact = [
    resume.email ? href(`mailto:${resume.email}`, resume.email) : "",
    resume.phone ? href(`tel:${resume.phone}`, resume.phone) : "",
    resume.linkedin ? href(resume.linkedin, "LinkedIn") : "",
    resume.github ? href(resume.github, "GitHub") : "",
    resume.portfolio ? href(resume.portfolio, "Portfolio") : "",
  ]
    .filter(Boolean)
    .join(" \\quad ");

  return template
    .replaceAll("{{NAME}}", escapeLatex(resume.name || "Your Name"))
    .replaceAll("{{CONTACT}}", contact)
    .replaceAll("{{SECTIONS}}", renderDynamicSections(resume));
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "ResumeBuddy backend is running.",
  });
});

app.post("/api/resume/parse", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Please select a PDF resume to upload.",
      });
    }

    const prompt = `
Extract the uploaded resume faithfully into valid JSON.

Return this structure:
{
  "name": "",
  "email": "",
  "phone": "",
  "linkedin": "",
  "github": "",
  "portfolio": "",
  "summary": "",
  "education": [],
  "experience": [],
  "projects": [],
  "skills": [],
  "sections": [
    {
      "title": "",
      "type": "text|bullets|education|experience|projects|skills",
      "content": "",
      "items": []
    }
  ]
}

Rules:
- Extract only information supported by the PDF. Do not invent content.
- Preserve the original section headings and their order in "sections".
- Do not add a Professional Summary unless the PDF contains one.
- Keep summary empty if none exists.
- Extract education entries with degree, institution, dates, location, GPA and bullets.
- Extract experience entries with role, company, dates, location and bullets.
- Extract project title, duration/dates, technologies, description bullets,
  GitHub/repository URL, live demo URL and other links separately.
- Preserve every URL and associate project links with the correct project.
- Extract technical skills as objects:
  { "category": "Languages", "items": ["C++", "Python"] }.
- For other sections such as Achievements or Certifications, preserve
  the heading and bullet items in sections.
- Keep bullets and list values as arrays of strings.
- Use empty strings or arrays for missing values.
- Return JSON only, without Markdown fences.

Example semantic fields:
{
  "education": [
    {
      "degree": "",
      "institution": "",
      "dates": "",
      "location": "",
      "gpa": "",
      "bullets": []
    }
  ],
  "experience": [
    {
      "role": "",
      "company": "",
      "dates": "",
      "location": "",
      "bullets": []
    }
  ],
  "projects": [
    {
      "title": "",
      "duration": "",
      "githubUrl": "",
      "liveDemo": "",
      "otherLinks": [],
      "technologies": [],
      "description": []
    }
  ],
  "skills": [
    {
      "category": "",
      "items": []
    }
  ],
  "sections": [
    {
      "title": "Education",
      "type": "education",
      "items": []
    }
  ]
}
`;

    const extractedLinks = await extractPdfLinks(req.file.buffer);

    const promptWithLinks = `
    ${prompt}

    ADDITIONAL SOURCE DATA — EXTRACTED PDF HYPERLINKS:
    ${JSON.stringify(extractedLinks, null, 2)}

    Hyperlink extraction rules:
    - Treat these URLs as verified destinations embedded in the original PDF.
    - Use them to populate linkedin, github, and portfolio when applicable.
    - Associate project repository and demo URLs with the correct project
      when the surrounding resume content supports that association.
    - Never invent a URL or assign a project link without supporting context.
    - Do not discard URLs simply because their visible link text is short.
    `;

    const parsed = await generateJson(
      promptWithLinks,
      req.file.buffer
    );

    const resume = normalizeResume(parsed);
    console.log(
  "CERTIFICATION DATA:",
  JSON.stringify(
    resume.sections?.filter((section) =>
      /certification|certificate/i.test(
        section.title || section.heading || ""
      )
    ),
    null,
    2
  )
);
res.json({ resume });
  } catch (error) {
    console.error("Resume parsing error:", error);

    res.status(500).json({
      error: error.message || "Could not parse the resume.",
    });
  }
});

app.post("/api/resume/improve", async (req, res) => {
  try {
    const resume = validateResume(req.body);

    const prompt = `
Improve the wording of this resume while preserving the candidate's actual experience.

Resume JSON:
${JSON.stringify(resume, null, 2)}

Return ONLY valid JSON with the same keys and structure as the input.

Rules:
- Preserve identity, contact details, education, employers, roles,
  dates, URLs, technologies and section order.
- Improve wording in the summary (only if it already exists),
  experience bullets and project descriptions.
- Keep all claims factual; do not invent metrics, achievements,
  responsibilities, skills or qualifications.
- Do not add a summary if summary is empty.
- Do not add job-description matching or job-specific tailoring.
- Keep education and skills unchanged.
- Preserve every section title and all existing entries.
`;

    const improved = await generateJson(prompt);

    res.json({
      improved: normalizeResume(improved),
    });
  } catch (error) {
    console.error("Resume improvement error:", error);

    res.status(500).json({
      error: error.message || "Could not improve the resume.",
    });
  }
});

app.post("/api/resume/generate-pdf", async (req, res) => {
  let tempDir;

  try {
    const resume = validateResume(req.body);

    const templatePath = path.join(
      __dirname,
      "../templates/resume.tex"
    );

    const template = await fs.readFile(templatePath, "utf8");
    const latex = buildLatex(template, resume);

    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "resumebuddy-")
    );

    const texPath = path.join(tempDir, "resume.tex");
    const pdfPath = path.join(tempDir, "resume.pdf");

    await fs.writeFile(texPath, latex, "utf8");

    await execFileAsync(
      PDFLATEX_PATH,
      [
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "-no-shell-escape",
        "-output-directory",
        tempDir,
        texPath,
      ],
      {
        cwd: tempDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 180000,
        windowsHide: true,
      }
    );

    await fs.access(pdfPath);

    res.download(
      pdfPath,
      "ResumeBuddy-Resume.pdf",
      async (error) => {
        if (error) {
          console.error("PDF download error:", error);
        }

        await fs
          .rm(tempDir, { recursive: true, force: true })
          .catch((cleanupError) => {
            console.error(
              "Temporary file cleanup error:",
              cleanupError
            );
          });
      }
    );
  } catch (error) {
    console.error("PDF generation error:", error);
     console.error("LaTeX stdout:\n", error.stdout || "(empty)");
  console.error("LaTeX stderr:\n", error.stderr || "(empty)");

    if (tempDir) {
      await fs
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => {});
    }

    if (!res.headersSent) {
      const details =
        error.stderr || error.stdout || error.message;

      res.status(500).json({
        error:
          error.code === "ENOENT"
            ? "Could not find pdflatex or backend/templates/resume.tex. Check PDFLATEX_PATH and the template path."
            : "PDF generation failed. Check the backend terminal for the LaTeX error.",
        details: String(details || "").slice(-5000),
      });
    }
  }
});

app.post("/api/resumes", authenticateToken, async (req, res) => {
  try {
    const { title, resumeData } = req.body;

    if (
      !resumeData ||
      typeof resumeData !== "object" ||
      Array.isArray(resumeData)
    ) {
      return res.status(400).json({
        message: "A valid resumeData object is required.",
      });
    }

    const resume = await Resume.create({
      userId: req.userId,
      title: title || "My Resume",
      resumeData,
    });

    return res.status(201).json({
      message: "Resume saved successfully.",
      resume,
    });
  } catch (error) {
    console.error("Save resume error:", error.message);
    return res.status(500).json({
      message: "Failed to save resume.",
    });
  }
});

app.get("/api/resumes", authenticateToken, async (req, res) => {
  try {
    const resumes = await Resume.find({
      userId: req.userId,
    })
      .select("title resumeData createdAt updatedAt")
      .sort({ updatedAt: -1 });

    return res.json({ resumes });
  } catch (error) {
    console.error("List resumes error:", error.message);
    return res.status(500).json({
      message: "Failed to retrieve resumes.",
    });
  }
});

app.get("/api/resumes/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        message: "Invalid resume ID.",
      });
    }

    const resume = await Resume.findOne({
      _id: id,
      userId: req.userId,
    });

    if (!resume) {
      return res.status(404).json({
        message: "Resume not found.",
      });
    }

    return res.json({ resume });
  } catch (error) {
    console.error("Get resume error:", error.message);
    return res.status(500).json({
      message: "Failed to retrieve resume.",
    });
  }
});

app.put("/api/resumes/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, resumeData } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        message: "Invalid resume ID.",
      });
    }

    if (title === undefined && resumeData === undefined) {
      return res.status(400).json({
        message: "Provide a title or resumeData to update.",
      });
    }

    if (
      resumeData !== undefined &&
      (!resumeData ||
        typeof resumeData !== "object" ||
        Array.isArray(resumeData))
    ) {
      return res.status(400).json({
        message: "resumeData must be a valid object.",
      });
    }

    const updates = {};

    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        return res.status(400).json({
          message: "Title must be a non-empty string.",
        });
      }
      updates.title = title.trim();
    }

    if (resumeData !== undefined) {
      updates.resumeData = resumeData;
    }

    const resume = await Resume.findOneAndUpdate(
      {
        _id: id,
        userId: req.userId,
      },
      updates,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!resume) {
      return res.status(404).json({
        message: "Resume not found.",
      });
    }

    return res.json({
      message: "Resume updated successfully.",
      resume,
    });
  } catch (error) {
    console.error("Update resume error:", error.message);
    return res.status(500).json({
      message: "Failed to update resume.",
    });
  }
});

app.delete("/api/resumes/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        message: "Invalid resume ID.",
      });
    }

    const resume = await Resume.findOneAndDelete({
      _id: id,
      userId: req.userId,
    });

    if (!resume) {
      return res.status(404).json({
        message: "Resume not found.",
      });
    }

    return res.json({
      message: "Resume deleted successfully.",
    });
  } catch (error) {
    console.error("Delete resume error:", error.message);
    return res.status(500).json({
      message: "Failed to delete resume.",
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "Name, email, and password are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await User.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
    });

    const token = jwt.sign(
      { userId: user._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    return res.status(201).json({
      message: "Registration successful.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    // MongoDB unique-index protection against duplicate emails
    if (error.code === 11000) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    console.error("Registration error:", error.message);

    return res.status(500).json({
      message: "Unable to register right now. Please try again.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "Email and password are required.",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Password is excluded by default in the User model,
    // so explicitly request it for verification.
    const user = await User.findOne({
      email: normalizedEmail,
    }).select("+password");

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    const token = jwt.sign(
      { userId: user._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    return res.status(200).json({
      message: "Login successful.",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      message: "Unable to log in right now. Please try again.",
    });
  }
});

app.use((error, req, res, next) => {
  console.error("Backend error:", error);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "Your PDF must be 5 MB or smaller.",
      });
    }

    return res.status(400).json({
      error: error.message,
    });
  }

  if (error.message === "Please upload a PDF file.") {
    return res.status(400).json({
      error: error.message,
    });
  }

  res.status(500).json({
    error: error.message || "An unexpected server error occurred.",
  });
});

async function startServer() {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is missing from backend/.env");
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log("MongoDB connected successfully.");

    app.listen(PORT, () => {
      console.log(
        `ResumeBuddy backend running at http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const MAX_BODY_BYTES = 16 * 1024;
const QUIZ_QUESTIONS = [
  {
    id: "polity-article-14",
    question: "Which Article of the Indian Constitution guarantees equality before the law?",
    options: ["Article 14", "Article 19", "Article 21", "Article 32"],
    correctIndex: 0,
    explanation: "Article 14 guarantees equality before the law and equal protection of the laws."
  },
  {
    id: "economy-rbi-year",
    question: "The Reserve Bank of India was established in which year?",
    options: ["1925", "1935", "1947", "1950"],
    correctIndex: 1,
    explanation: "The Reserve Bank of India commenced operations on 1 April 1935."
  },
  {
    id: "science-largest-planet",
    question: "Which is the largest planet in our solar system?",
    options: ["Earth", "Saturn", "Jupiter", "Neptune"],
    correctIndex: 2,
    explanation: "Jupiter is the largest planet in our solar system."
  }
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createInitialStore() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    profile: { name: "Aarav Kumar", initials: "AK", plan: "Free account" },
    exam: { name: "UPSC Civil Services", code: "UP", examDate: null },
    stats: {
      studyHoursThisWeek: 24.5,
      practiceQuestionsCompleted: 386,
      accuracyPercent: 78,
      currentStreakDays: 9
    },
    subjects: [
      { name: "Indian Polity", completionPercent: 82 },
      { name: "General Science", completionPercent: 68 },
      { name: "Indian Economy", completionPercent: 54 },
      { name: "History & Culture", completionPercent: 76 }
    ],
    tasks: [
      { id: randomUUID(), title: "Read: Fundamental Rights", subject: "Indian Polity", durationMinutes: 45, scheduledFor: `${today}T09:00:00`, completed: true },
      { id: randomUUID(), title: "Daily current affairs", subject: "Current Affairs", durationMinutes: 30, scheduledFor: `${today}T10:00:00`, completed: true },
      { id: randomUUID(), title: "Revise: Monetary policy", subject: "Indian Economy", durationMinutes: 40, scheduledFor: `${today}T11:00:00`, completed: true },
      { id: randomUUID(), title: "Practice: Number systems", subject: "Quantitative aptitude", durationMinutes: 45, scheduledFor: `${today}T14:00:00`, completed: false },
      { id: randomUUID(), title: "Attempt a mini mock test", subject: "General Studies", durationMinutes: 60, scheduledFor: `${today}T16:00:00`, completed: false }
    ],
    resources: [
      { id: "constitution-notes", title: "Indian Constitution: Quick Notes", type: "Study notes", duration: "12 min read", keywords: ["indian constitution", "polity", "notes"] },
      { id: "current-affairs", title: "Daily Current Affairs", type: "Daily briefing", duration: "8 min read", keywords: ["current affairs", "news", "daily"] },
      { id: "general-studies-mock", title: "General Studies: Mini Mock 04", type: "Practice test", duration: "3 sample questions", keywords: ["general studies", "mock", "practice", "test"] }
    ],
    quizResults: []
  };
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const text = await fs.readFile(DATA_FILE, "utf8");
    const store = JSON.parse(text);
    if (!store || !Array.isArray(store.tasks) || !Array.isArray(store.resources)) {
      throw new Error("The data file does not have the expected store structure.");
    }
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const store = createInitialStore();
    await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf8");
    return store;
  }
}

let store;
let mutationQueue = Promise.resolve();

function persistStore() {
  const temporaryFile = `${DATA_FILE}.${process.pid}.${randomUUID()}.tmp`;
  return fs.writeFile(temporaryFile, JSON.stringify(store, null, 2), "utf8")
    .then(() => fs.rename(temporaryFile, DATA_FILE))
    .catch(async (error) => {
      await fs.unlink(temporaryFile).catch((cleanupError) => {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      });
      throw error;
    });
}

function mutateStore(change) {
  const operation = mutationQueue.then(async () => {
    const result = change();
    await persistStore();
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        tooLarge = true;
        request.resume();
        reject(new HttpError(413, "Request body is too large."));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value;
}

function dashboardData() {
  const completedTasks = store.tasks.filter((task) => task.completed).length;
  const totalTasks = store.tasks.length;
  return {
    profile: store.profile,
    exam: store.exam,
    stats: store.stats,
    subjects: store.subjects,
    tasks: store.tasks,
    resources: store.resources.map(({ keywords, ...resource }) => resource),
    todayGoal: {
      completedTasks,
      totalTasks,
      completionPercent: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0
    }
  };
}

function validateTask(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const durationMinutes = Number(body.durationMinutes);
  if (title.length < 2 || title.length > 120) {
    throw new HttpError(400, "Task title must be between 2 and 120 characters.");
  }
  if (subject.length < 2 || subject.length > 80) {
    throw new HttpError(400, "Subject must be between 2 and 80 characters.");
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
    throw new HttpError(400, "durationMinutes must be a whole number from 1 to 720.");
  }
  let scheduledFor = new Date().toISOString();
  if (body.scheduledFor !== undefined) {
    if (typeof body.scheduledFor !== "string" || Number.isNaN(Date.parse(body.scheduledFor))) {
      throw new HttpError(400, "scheduledFor must be a valid date string.");
    }
    scheduledFor = new Date(body.scheduledFor).toISOString();
  }
  return { title, subject, durationMinutes, scheduledFor };
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, { status: "ok" });
  }
  if (request.method === "GET" && pathname === "/api/dashboard") {
    return sendJson(response, 200, dashboardData());
  }
  if (request.method === "GET" && pathname === "/api/tasks") {
    return sendJson(response, 200, { tasks: store.tasks });
  }
  if (request.method === "POST" && pathname === "/api/tasks") {
    const body = requireObject(await readJson(request));
    const taskData = validateTask(body);
    const task = await mutateStore(() => {
      const newTask = { id: randomUUID(), ...taskData, completed: false };
      store.tasks.push(newTask);
      return newTask;
    });
    return sendJson(response, 201, { task });
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && taskMatch) {
    const body = requireObject(await readJson(request));
    if (typeof body.completed !== "boolean") {
      throw new HttpError(400, "completed must be true or false.");
    }
    const task = await mutateStore(() => {
      const existing = store.tasks.find((item) => item.id === taskMatch[1]);
      if (!existing) throw new HttpError(404, "Study task not found.");
      existing.completed = body.completed;
      return existing;
    });
    return sendJson(response, 200, { task });
  }
  if (request.method === "GET" && pathname === "/api/resources") {
    const query = (searchParams.get("q") || "").trim().toLowerCase();
    const resources = store.resources
      .filter((resource) => !query || `${resource.title} ${resource.type} ${resource.keywords.join(" ")}`.toLowerCase().includes(query))
      .map(({ keywords, ...resource }) => resource);
    return sendJson(response, 200, { resources });
  }
  if (request.method === "GET" && pathname === "/api/quiz") {
    return sendJson(response, 200, {
      questions: QUIZ_QUESTIONS.map(({ id, question, options }) => ({ id, question, options }))
    });
  }
  if (request.method === "POST" && pathname === "/api/quiz/submit") {
    const body = requireObject(await readJson(request));
    if (!Array.isArray(body.answers) || body.answers.length !== QUIZ_QUESTIONS.length) {
      throw new HttpError(400, `Submit one answer for each of the ${QUIZ_QUESTIONS.length} questions.`);
    }
    const answerMap = new Map();
    for (const answer of body.answers) {
      if (!answer || typeof answer.questionId !== "string" || !Number.isInteger(answer.answerIndex)) {
        throw new HttpError(400, "Each answer needs a questionId and integer answerIndex.");
      }
      if (answerMap.has(answer.questionId)) throw new HttpError(400, "Duplicate question answers are not allowed.");
      answerMap.set(answer.questionId, answer.answerIndex);
    }
    const unknownId = [...answerMap.keys()].some((id) => !QUIZ_QUESTIONS.some((question) => question.id === id));
    if (unknownId) throw new HttpError(400, "An answer refers to an unknown question.");
    const results = QUIZ_QUESTIONS.map((question) => {
      const answerIndex = answerMap.get(question.id);
      if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) {
        throw new HttpError(400, `Provide a valid option for question ${question.id}.`);
      }
      return {
        questionId: question.id,
        selectedIndex: answerIndex,
        correctIndex: question.correctIndex,
        correct: answerIndex === question.correctIndex,
        explanation: question.explanation
      };
    });
    const result = await mutateStore(() => {
      const saved = {
        id: randomUUID(),
        submittedAt: new Date().toISOString(),
        score: results.filter((item) => item.correct).length,
        total: QUIZ_QUESTIONS.length
      };
      store.quizResults.push(saved);
      store.stats.practiceQuestionsCompleted += QUIZ_QUESTIONS.length;
      return saved;
    });
    return sendJson(response, 200, { ...result, results });
  }
  return sendJson(response, 404, { error: "API endpoint not found." });
}

async function serveFrontend(response, pathname) {
  if (pathname !== "/" && pathname !== "/index.html") {
    return sendJson(response, 404, { error: "Page not found." });
  }
  let html;
  try {
    html = await fs.readFile(path.join(ROOT, "index.html"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return sendJson(response, 404, { error: "Frontend not found. Put index.html beside server.js." });
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(html);
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed.");
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end();
      return;
    }
    await serveFrontend(response, url.pathname);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    sendJson(response, status, { error: status === 500 ? "Internal server error." : error.message });
  }
}

async function main() {
  store = await loadStore();
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`Exam prep backend listening at http://${HOST}:${PORT}`);
    console.log("API: GET /api/health, /api/dashboard, /api/tasks, /api/resources, /api/quiz");
  });
  server.on("error", (error) => {
    console.error("Could not start the HTTP server:", error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error("Could not initialize the exam prep backend:", error);
  process.exitCode = 1;
});
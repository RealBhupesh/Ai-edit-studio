"use strict";

const API_ROOT = "/api";
const ACTIVE_STATES = new Set(["queued", "pending", "starting", "analyzing", "analysing", "planning", "previewing", "rendering", "processing", "running"]);
const TERMINAL_STATES = new Set(["complete", "completed", "done", "failed", "error", "cancelled", "canceled"]);

const state = {
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  doctor: null,
  capture: null,
  captureBusy: false,
  busy: false,
  pollTimer: null,
  detailRequest: 0,
  toastTimer: null
};

const elements = {
  connection: document.querySelector("#connection-status"),
  connectionText: document.querySelector(".connection-status__text"),
  refreshAll: document.querySelector("#refresh-all"),
  refreshDoctor: document.querySelector("#refresh-doctor"),
  refreshJobs: document.querySelector("#refresh-jobs"),
  refreshDetail: document.querySelector("#refresh-detail"),
  captureForm: document.querySelector("#capture-form"),
  captureProcess: document.querySelector("#capture-process"),
  processOptions: document.querySelector("#process-options"),
  processSearchStatus: document.querySelector("#process-search-status"),
  searchProcesses: document.querySelector("#search-processes"),
  captureProject: document.querySelector("#capture-project"),
  captureFps: document.querySelector("#capture-fps"),
  startCapture: document.querySelector("#start-capture"),
  stopCapture: document.querySelector("#stop-capture"),
  captureMessage: document.querySelector("#capture-message"),
  captureStatusPill: document.querySelector("#capture-status-pill"),
  captureBackend: document.querySelector("#capture-backend"),
  captureDuration: document.querySelector("#capture-duration"),
  capturePath: document.querySelector("#capture-path"),
  captureErrorRow: document.querySelector("#capture-error-row"),
  captureError: document.querySelector("#capture-error"),
  doctorSummary: document.querySelector("#doctor-summary"),
  dependencyList: document.querySelector("#dependency-list"),
  jobsLoading: document.querySelector("#jobs-loading"),
  jobsEmpty: document.querySelector("#jobs-empty"),
  jobsList: document.querySelector("#jobs-list"),
  autoPoll: document.querySelector("#auto-poll"),
  form: document.querySelector("#job-form"),
  formMessage: document.querySelector("#form-message"),
  createButton: document.querySelector("#create-job"),
  createButtonLabel: document.querySelector("#create-job .button__label"),
  detailTitle: document.querySelector("#detail-title"),
  detailSubtitle: document.querySelector("#detail-subtitle"),
  detailStatus: document.querySelector("#detail-status"),
  progressValue: document.querySelector("#progress-value"),
  progressTrack: document.querySelector("#progress-track"),
  progressStage: document.querySelector("#progress-stage"),
  jobMeta: document.querySelector("#job-meta"),
  warningsCount: document.querySelector("#warnings-count"),
  warningsList: document.querySelector("#warnings-list"),
  artifactsCount: document.querySelector("#artifacts-count"),
  artifactsList: document.querySelector("#artifacts-list"),
  logsCount: document.querySelector("#logs-count"),
  logsList: document.querySelector("#logs-list"),
  toast: document.querySelector("#toast")
};

function normaliseText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    if (value.message) return normaliseText(value.message, fallback);
    if (value.text) return normaliseText(value.text, fallback);
    if (value.path) return normaliseText(value.path, fallback);
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

function unwrapJob(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return payload.job ?? payload.data?.job ?? payload.data ?? payload;
}

function unwrapJobs(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.jobs, payload?.items, payload?.data?.jobs, payload?.data?.items, payload?.data];
  return candidates.find(Array.isArray) ?? [];
}

function jobId(job) {
  return normaliseText(job?.id ?? job?.jobId ?? job?.job_id);
}

function jobStatus(job) {
  return normaliseText(job?.status ?? job?.state ?? job?.phase, "unknown").toLowerCase();
}

function jobTitle(job) {
  return normaliseText(job?.title ?? job?.project ?? job?.name, `Productie ${jobId(job).slice(0, 8) || "zonder naam"}`);
}

function percentValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const percentage = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

function captureIsActive(capture) {
  if (!capture || typeof capture !== "object") return false;
  if (capture.active !== undefined) return Boolean(capture.active);
  if (capture.recording !== undefined) return Boolean(capture.recording);
  if (capture.running !== undefined) return Boolean(capture.running);
  return ["active", "recording", "running", "capturing", "started"].includes(normaliseText(capture.status ?? capture.state).toLowerCase());
}

function captureIsFinalizing(capture) {
  const status = normaliseText(capture?.status ?? capture?.state).toLowerCase();
  return ["stopping", "finalizing"].includes(status);
}

function formatCaptureDuration(value) {
  if (typeof value === "string" && value.includes(":")) return value;
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function jobProgress(job) {
  return percentValue(job?.progress ?? job?.percentage ?? job?.percent ?? 0);
}

function statusLabel(status) {
  const labels = {
    queued: "In wachtrij",
    pending: "Wachten",
    starting: "Starten",
    analyzing: "Analyseren",
    analysing: "Analyseren",
    planning: "Selectie maken",
    previewing: "Preview maken",
    rendering: "Renderen",
    processing: "Verwerken",
    running: "Actief",
    complete: "Voltooid",
    completed: "Voltooid",
    done: "Voltooid",
    failed: "Mislukt",
    error: "Fout",
    cancelled: "Geannuleerd",
    canceled: "Geannuleerd",
    unknown: "Onbekend"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function statusClass(status) {
  if (["complete", "completed", "done"].includes(status)) return "status-complete";
  if (["failed", "error"].includes(status)) return "status-failed";
  if (["cancelled", "canceled"].includes(status)) return "status-warning";
  if (ACTIVE_STATES.has(status)) return "status-active";
  return "status-neutral";
}

function readableDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return normaliseText(value, "—");
  return new Intl.DateTimeFormat("nl-NL", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function readableDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return normaliseText(value, "—");
  return `${number} sec`;
}

function setConnection(kind, text) {
  elements.connection.classList.remove("is-online", "is-offline", "is-checking");
  elements.connection.classList.add(`is-${kind}`);
  elements.connectionText.textContent = text;
}

function showToast(message, kind = "info") {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("is-error", "is-success");
  if (kind === "error") elements.toast.classList.add("is-error");
  if (kind === "success") elements.toast.classList.add("is-success");
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      cache: "no-store"
    });

    const contentType = response.headers.get("content-type") ?? "";
    let payload;
    if (contentType.includes("application/json")) {
      payload = await response.json();
    } else {
      payload = { message: await response.text() };
    }

    if (!response.ok) {
      const message = normaliseText(payload?.error ?? payload?.detail ?? payload?.message, `API-fout ${response.status}`);
      throw new Error(message);
    }

    setConnection("online", "Lokale API online");
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("De lokale API reageerde niet op tijd.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function dependencyEntries(doctor) {
  const source = doctor?.dependencies ?? doctor?.tools ?? doctor?.checks;
  if (Array.isArray(source)) {
    return source.map((entry, index) => ({
      name: normaliseText(entry?.name ?? entry?.id, `Dependency ${index + 1}`),
      value: entry
    }));
  }

  if (source && typeof source === "object") {
    return Object.entries(source).map(([name, value]) => ({ name, value }));
  }

  const wellKnown = ["ffmpeg", "ffprobe", "nvenc", "python"];
  return wellKnown
    .filter((key) => doctor && Object.hasOwn(doctor, key))
    .map((name) => ({ name, value: doctor[name] }));
}

function dependencyAvailable(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["missing", "false", "unavailable", "error", "failed"].includes(value.toLowerCase());
  if (!value || typeof value !== "object") return Boolean(value);
  const marker = value.ok ?? value.available ?? value.installed ?? value.ready ?? value.found;
  if (marker !== undefined) return Boolean(marker);
  const status = normaliseText(value.status ?? value.state).toLowerCase();
  if (status) return ["ok", "ready", "available", "installed", "found", "healthy"].includes(status);
  return !value.error;
}

function dependencyDetail(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "beschikbaar" : "ontbreekt";
  if (!value || typeof value !== "object") return normaliseText(value, "onbekend");
  return normaliseText(value.version ?? value.path ?? value.status ?? value.state ?? value.message, dependencyAvailable(value) ? "beschikbaar" : "ontbreekt");
}

function renderDoctor(doctor) {
  const entries = dependencyEntries(doctor);
  const explicitOk = doctor?.ok ?? doctor?.ready ?? doctor?.healthy;
  const allReady = entries.length > 0 && entries.every(({ value }) => dependencyAvailable(value));
  const ready = explicitOk === undefined ? allReady : Boolean(explicitOk);

  elements.doctorSummary.classList.remove("is-loading", "is-ready", "is-warning", "is-error");
  elements.doctorSummary.classList.add(ready ? "is-ready" : "is-warning");
  const icon = elements.doctorSummary.querySelector(".doctor-summary__icon");
  const heading = elements.doctorSummary.querySelector("strong");
  const detail = elements.doctorSummary.querySelector("small");
  icon.textContent = ready ? "✓" : "!";
  heading.textContent = ready ? "Engine gereed" : "Aandacht vereist";
  detail.textContent = ready ? "Klaar voor lokale analyse en render" : normaliseText(doctor?.message ?? doctor?.error, "Controleer de onderdelen hieronder");

  elements.dependencyList.replaceChildren();
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.className = "dependency-item";
    item.textContent = "Geen dependency-details ontvangen.";
    elements.dependencyList.append(item);
    return;
  }

  entries.forEach(({ name, value }) => {
    const available = dependencyAvailable(value);
    const item = document.createElement("li");
    item.className = `dependency-item ${available ? "is-ok" : "is-bad"}`;

    const dot = document.createElement("span");
    dot.className = "dependency-dot";
    dot.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "dependency-name";
    label.textContent = name;

    const valueText = document.createElement("span");
    valueText.className = "dependency-detail";
    valueText.textContent = dependencyDetail(value);
    valueText.title = valueText.textContent;

    item.append(dot, label, valueText);
    elements.dependencyList.append(item);
  });
}

function renderDoctorError(error) {
  elements.doctorSummary.classList.remove("is-loading", "is-ready", "is-warning");
  elements.doctorSummary.classList.add("is-error");
  elements.doctorSummary.querySelector(".doctor-summary__icon").textContent = "!";
  elements.doctorSummary.querySelector("strong").textContent = "Engine niet bereikbaar";
  elements.doctorSummary.querySelector("small").textContent = error.message;
  elements.dependencyList.replaceChildren();
}

async function loadDoctor({ silent = false } = {}) {
  try {
    const doctor = await apiRequest("/doctor");
    state.doctor = doctor;
    renderDoctor(doctor);
  } catch (error) {
    setConnection("offline", "Lokale API offline");
    renderDoctorError(error);
    if (!silent) showToast(error.message, "error");
  }
}

function unwrapCapture(payload) {
  return payload?.capture ?? payload?.data?.capture ?? payload?.data ?? payload ?? {};
}

function renderCapture(capture) {
  const active = captureIsActive(capture);
  const finalizing = captureIsFinalizing(capture);
  const error = normaliseText(capture?.error ?? capture?.lastError ?? capture?.last_error);
  const status = normaliseText(capture?.status ?? capture?.state, active ? "recording" : "stopped").toLowerCase();
  const statusText = error
    ? "Fout"
    : status === "stopping"
      ? "Stoppen"
      : status === "finalizing"
        ? "Veilig afronden"
        : active
          ? "Neemt op"
          : "Gestopt";

  elements.captureStatusPill.textContent = statusText;
  elements.captureStatusPill.className = `status-pill ${error || finalizing ? "status-warning" : active ? "status-failed" : "status-neutral"}`;
  elements.captureBackend.textContent = normaliseText(capture?.backend ?? capture?.captureBackend ?? capture?.capture_backend, "—");
  elements.captureDuration.textContent = formatCaptureDuration(capture?.duration ?? capture?.durationSeconds ?? capture?.duration_seconds ?? capture?.elapsedSeconds ?? capture?.elapsed_seconds ?? capture?.elapsed ?? 0);
  elements.capturePath.textContent = normaliseText(capture?.path ?? capture?.output ?? capture?.file, "—");
  elements.capturePath.title = elements.capturePath.textContent;
  elements.captureErrorRow.hidden = !error;
  elements.captureError.textContent = error || "—";
  elements.stopCapture.disabled = !active || finalizing || state.captureBusy;
  elements.startCapture.disabled = active || finalizing || state.captureBusy;

  if (active) {
    const process = normaliseText(capture?.target?.name ?? capture?.process ?? capture?.processName ?? capture?.process_name);
    if (process && !elements.captureProcess.value) elements.captureProcess.value = process;
    const project = normaliseText(capture?.project);
    if (project && !elements.captureProject.value) elements.captureProject.value = project;
  }
}

async function loadCaptureStatus({ silent = false } = {}) {
  try {
    const payload = await apiRequest("/capture/status");
    state.capture = unwrapCapture(payload);
    renderCapture(state.capture);
  } catch (error) {
    if (!silent) showToast(error.message, "error");
  }
}

function unwrapProcesses(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.processes, payload?.items, payload?.data?.processes, payload?.data?.items, payload?.data];
  return candidates.find(Array.isArray) ?? [];
}

function processName(process) {
  return normaliseText(process?.name ?? process?.process ?? process?.executable ?? process?.exe ?? process);
}

async function searchProcesses() {
  const query = elements.captureProcess.value.trim();
  elements.searchProcesses.disabled = true;
  elements.processSearchStatus.textContent = "Actieve processen zoeken…";
  try {
    const payload = await apiRequest(`/processes?query=${encodeURIComponent(query)}`);
    const processes = unwrapProcesses(payload);
    elements.processOptions.replaceChildren();
    processes.forEach((process) => {
      const name = processName(process);
      if (!name) return;
      const option = document.createElement("option");
      const pid = normaliseText(process?.pid ?? process?.id);
      const title = normaliseText(process?.title ?? process?.windowTitle ?? process?.window_title);
      option.value = pid || name;
      option.label = [name, title && title !== name ? title : "", pid ? `PID ${pid}` : ""].filter(Boolean).join(" · ");
      elements.processOptions.append(option);
    });
    elements.processSearchStatus.textContent = processes.length === 0
      ? "Geen overeenkomende processen gevonden. Je kunt de naam zelf invullen."
      : `${processes.length} ${processes.length === 1 ? "proces" : "processen"} gevonden. Kies een suggestie.`;
    if (processes.length === 1) {
      elements.captureProcess.value = normaliseText(processes[0]?.pid ?? processes[0]?.id, processName(processes[0]));
    }
  } catch (error) {
    elements.processSearchStatus.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    elements.searchProcesses.disabled = false;
  }
}

function setCaptureBusy(busy, action = "") {
  state.captureBusy = busy;
  const active = captureIsActive(state.capture);
  elements.startCapture.disabled = busy || active;
  elements.stopCapture.disabled = busy || !active;
  elements.captureForm.setAttribute("aria-busy", String(busy));
  if (busy) elements.captureMessage.textContent = action;
}

async function startCapture(event) {
  event.preventDefault();
  elements.captureMessage.textContent = "";
  if (!elements.captureForm.checkValidity()) {
    const invalid = elements.captureForm.querySelector(":invalid");
    if (invalid) {
      invalid.setAttribute("aria-invalid", "true");
      invalid.focus();
    }
    elements.captureMessage.textContent = "Vul een procesnaam en project in.";
    return;
  }

  setCaptureBusy(true, "Opname starten…");
  try {
    const payload = await apiRequest("/capture/start", {
      method: "POST",
      body: JSON.stringify({
        process: elements.captureProcess.value.trim(),
        project: elements.captureProject.value.trim(),
        fps: Number(elements.captureFps.value)
      })
    });
    state.capture = unwrapCapture(payload);
    await loadCaptureStatus({ silent: true });
    elements.captureMessage.textContent = "";
    showToast("Gameplay-opname is gestart.", "success");
  } catch (error) {
    elements.captureMessage.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setCaptureBusy(false);
    renderCapture(state.capture ?? {});
    schedulePoll();
  }
}

async function stopCapture() {
  setCaptureBusy(true, "Opname stoppen en bestand afronden…");
  try {
    const payload = await apiRequest("/capture/stop", {
      method: "POST",
      body: JSON.stringify({})
    });
    state.capture = unwrapCapture(payload);
    await loadCaptureStatus({ silent: true });
    elements.captureMessage.textContent = "";
    showToast("Stopopdracht verstuurd; opname wordt veilig afgerond.", "success");
  } catch (error) {
    elements.captureMessage.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setCaptureBusy(false);
    renderCapture(state.capture ?? {});
    schedulePoll();
  }
}

function renderJobs() {
  elements.jobsLoading.hidden = true;
  elements.jobsList.replaceChildren();
  elements.jobsEmpty.hidden = state.jobs.length !== 0;

  state.jobs.forEach((job) => {
    const id = jobId(job);
    if (!id) return;
    const status = jobStatus(job);
    const progress = jobProgress(job);

    const item = document.createElement("li");
    item.className = "job-list-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-card";
    button.dataset.jobId = id;
    button.setAttribute("aria-pressed", String(id === state.selectedJobId));
    if (id === state.selectedJobId) button.classList.add("is-selected");

    const title = document.createElement("span");
    title.className = "job-card__title";
    title.textContent = jobTitle(job);
    title.title = title.textContent;

    const statusText = document.createElement("span");
    statusText.className = `mini-status ${statusClass(status)}`;
    statusText.textContent = statusLabel(status);

    const meta = document.createElement("span");
    meta.className = "job-card__meta";
    const duration = readableDuration(job.duration ?? job.targetDuration ?? job.target_duration);
    meta.textContent = `${progress}% · ${duration} · ${readableDate(job.updatedAt ?? job.updated_at ?? job.createdAt ?? job.created_at)}`;

    button.append(title, statusText, meta);
    button.addEventListener("click", () => selectJob(id));
    item.append(button);
    elements.jobsList.append(item);
  });
}

async function loadJobs({ silent = false, selectFirst = true } = {}) {
  try {
    const payload = await apiRequest("/jobs");
    state.jobs = unwrapJobs(payload);
    renderJobs();

    const selectionStillExists = state.jobs.some((job) => jobId(job) === state.selectedJobId);
    if (!selectionStillExists && selectFirst && state.jobs.length > 0) {
      await selectJob(jobId(state.jobs[0]), { scroll: false });
    }
  } catch (error) {
    setConnection("offline", "Lokale API offline");
    elements.jobsLoading.hidden = true;
    if (state.jobs.length === 0) elements.jobsEmpty.hidden = false;
    if (!silent) showToast(error.message, "error");
  }
}

function jobArray(job, ...names) {
  for (const name of names) {
    const value = job?.[name];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
  }
  return [];
}

function renderSimpleList(target, values, emptyMessage, mapper = normaliseText) {
  target.replaceChildren();
  if (values.length === 0) {
    const item = document.createElement("li");
    item.className = "muted-item";
    item.textContent = emptyMessage;
    target.append(item);
    return;
  }
  values.forEach((value) => {
    const item = document.createElement("li");
    item.textContent = mapper(value, "Onbekende melding");
    target.append(item);
  });
}

function safeArtifactUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.origin !== window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

function renderArtifacts(artifacts) {
  elements.artifactsList.replaceChildren();
  if (artifacts.length === 0) {
    const item = document.createElement("li");
    item.className = "muted-item";
    item.textContent = "Nog geen bestanden beschikbaar.";
    elements.artifactsList.append(item);
    return;
  }

  artifacts.forEach((artifact, index) => {
    const item = document.createElement("li");
    const isObject = artifact && typeof artifact === "object";
    const path = normaliseText(isObject ? artifact.path ?? artifact.file ?? artifact.output : artifact);
    const name = normaliseText(isObject ? artifact.name ?? artifact.label ?? artifact.type : "", path ? path.split(/[\\/]/).pop() : `Bestand ${index + 1}`);
    const url = safeArtifactUrl(isObject ? artifact.url ?? artifact.downloadUrl ?? artifact.download_url : null);

    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = name;
      item.append(link);
    } else {
      const label = document.createElement("strong");
      label.textContent = name;
      item.append(label);
    }

    if (path && path !== name) {
      const pathLabel = document.createElement("span");
      pathLabel.className = "artifact-path";
      pathLabel.textContent = path;
      item.append(pathLabel);
    }
    elements.artifactsList.append(item);
  });
}

function setMeta(job) {
  const values = [
    normaliseText(job?.project, "—"),
    readableDuration(job?.duration ?? job?.targetDuration ?? job?.target_duration),
    `${normaliseText(job?.resolution, "—")} · ${normaliseText(job?.fps, "—")} fps`,
    readableDate(job?.updatedAt ?? job?.updated_at ?? job?.createdAt ?? job?.created_at)
  ];
  elements.jobMeta.querySelectorAll("dd").forEach((node, index) => {
    node.textContent = values[index] ?? "—";
    node.title = node.textContent;
  });
}

function renderJobDetail(job) {
  const id = jobId(job);
  const status = jobStatus(job);
  const progress = jobProgress(job);
  const warnings = jobArray(job, "warnings", "warningMessages", "warning_messages");
  const artifacts = jobArray(job, "artifacts", "outputs", "files");
  const logs = jobArray(job, "logs", "log", "events", "messages");

  elements.detailTitle.textContent = jobTitle(job);
  elements.detailSubtitle.textContent = id ? `Job ${id}` : "Productiedetails";
  elements.detailStatus.textContent = statusLabel(status);
  elements.detailStatus.className = `status-pill ${statusClass(status)}`;
  elements.refreshDetail.disabled = !id;

  elements.progressValue.textContent = `${progress}%`;
  elements.progressTrack.value = progress;
  elements.progressTrack.textContent = `${progress}%`;
  elements.progressStage.textContent = normaliseText(job?.stageLabel ?? job?.stage_label ?? job?.stage ?? job?.message, statusLabel(status));

  setMeta(job);
  elements.warningsCount.textContent = String(warnings.length);
  elements.artifactsCount.textContent = String(artifacts.length);
  elements.logsCount.textContent = String(logs.length);
  renderSimpleList(elements.warningsList, warnings, "Geen waarschuwingen.");
  renderArtifacts(artifacts);
  renderSimpleList(elements.logsList, logs, "Nog geen logregels.");
}

async function loadJobDetail(id, { silent = false } = {}) {
  if (!id) return;
  const request = ++state.detailRequest;
  try {
    const payload = await apiRequest(`/jobs/${encodeURIComponent(id)}`);
    if (request !== state.detailRequest) return;
    const job = unwrapJob(payload);
    state.selectedJob = job;
    renderJobDetail(job);

    const index = state.jobs.findIndex((candidate) => jobId(candidate) === id);
    if (index >= 0) {
      state.jobs[index] = { ...state.jobs[index], ...job };
      renderJobs();
    }
  } catch (error) {
    if (request !== state.detailRequest) return;
    if (!silent) showToast(error.message, "error");
  }
}

async function selectJob(id, { scroll = true } = {}) {
  if (!id) return;
  state.selectedJobId = id;
  renderJobs();
  elements.refreshDetail.disabled = false;
  await loadJobDetail(id);
  if (scroll && window.matchMedia("(max-width: 760px)").matches) {
    document.querySelector("#job-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function formPayload() {
  const data = new FormData(elements.form);
  // Leave blank numeric fields out instead of sending Number('') === 0, so the
  // server can apply its defaults rather than refusing a zero (#134).
  const optionalNumber = value => normaliseText(value).trim() || undefined;
  return {
    project: normaliseText(data.get("project")).trim(),
    input: normaliseText(data.get("input")).trim(),
    duration: optionalNumber(data.get("duration")),
    style: normaliseText(data.get("style")),
    title: normaliseText(data.get("title")).trim(),
    music: normaliseText(data.get("music")).trim(),
    output: normaliseText(data.get("output")).trim(),
    resolution: normaliseText(data.get("resolution")),
    fps: optionalNumber(data.get("fps")),
    preview: data.get("preview") === "on"
  };
}

function validateForm() {
  elements.formMessage.textContent = "";
  elements.form.querySelectorAll("[aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
  if (elements.form.checkValidity()) return true;

  const invalid = elements.form.querySelector(":invalid");
  if (invalid) {
    invalid.setAttribute("aria-invalid", "true");
    invalid.focus();
  }
  elements.formMessage.textContent = "Vul de verplichte velden in voordat je de productie start.";
  return false;
}

function setFormBusy(busy) {
  state.busy = busy;
  elements.createButton.disabled = busy;
  elements.createButtonLabel.textContent = busy ? "Productie aanmaken…" : "Trailerproductie starten";
  elements.form.setAttribute("aria-busy", String(busy));
}

async function createJob(event) {
  event.preventDefault();
  if (state.busy || !validateForm()) return;
  setFormBusy(true);

  try {
    const payload = await apiRequest("/jobs", {
      method: "POST",
      body: JSON.stringify(formPayload())
    });
    const job = unwrapJob(payload);
    const id = jobId(job) || normaliseText(payload?.jobId ?? payload?.id);
    showToast("Trailerproductie is gestart.", "success");
    await loadJobs({ silent: true, selectFirst: false });
    if (id) await selectJob(id, { scroll: true });
  } catch (error) {
    elements.formMessage.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setFormBusy(false);
  }
}

async function refreshEverything({ silent = false } = {}) {
  if (!silent) setConnection("checking", "API vernieuwen");
  await Promise.allSettled([
    loadDoctor({ silent }),
    loadJobs({ silent, selectFirst: true }),
    loadCaptureStatus({ silent })
  ]);
  if (state.selectedJobId) await loadJobDetail(state.selectedJobId, { silent });
}

function pollDelay() {
  if (captureIsActive(state.capture) || captureIsFinalizing(state.capture)) return 1000;
  const active = state.selectedJob && ACTIVE_STATES.has(jobStatus(state.selectedJob));
  return active ? 2200 : 7500;
}

function schedulePoll() {
  window.clearTimeout(state.pollTimer);
  if (!elements.autoPoll.checked) return;
  state.pollTimer = window.setTimeout(async () => {
    if (!document.hidden) {
      await loadJobs({ silent: true, selectFirst: false });
      if (state.selectedJobId) await loadJobDetail(state.selectedJobId, { silent: true });
      await loadCaptureStatus({ silent: true });
    }
    schedulePoll();
  }, pollDelay());
}

function initialiseEvents() {
  elements.form.addEventListener("submit", createJob);
  elements.form.addEventListener("input", (event) => {
    if (event.target.matches("[aria-invalid='true']")) event.target.removeAttribute("aria-invalid");
    elements.formMessage.textContent = "";
  });
  elements.refreshAll.addEventListener("click", () => refreshEverything());
  elements.refreshDoctor.addEventListener("click", () => loadDoctor());
  elements.refreshJobs.addEventListener("click", () => loadJobs());
  elements.refreshDetail.addEventListener("click", () => loadJobDetail(state.selectedJobId));
  elements.captureForm.addEventListener("submit", startCapture);
  elements.searchProcesses.addEventListener("click", searchProcesses);
  elements.stopCapture.addEventListener("click", stopCapture);
  elements.captureForm.addEventListener("input", (event) => {
    if (event.target.matches("[aria-invalid='true']")) event.target.removeAttribute("aria-invalid");
    elements.captureMessage.textContent = "";
  });
  elements.autoPoll.addEventListener("change", schedulePoll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && elements.autoPoll.checked) {
      refreshEverything({ silent: true }).finally(schedulePoll);
    }
  });
}

async function initialise() {
  initialiseEvents();
  setConnection("checking", "API controleren");
  await refreshEverything({ silent: true });
  schedulePoll();
}

initialise();

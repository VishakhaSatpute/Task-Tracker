// Sends prompts to the local server (/api/llm), which holds the provider API
// keys (Anthropic or OpenAI, chosen in Settings). Keys never reach the browser.

export function parseJsonLoose(text) {
  if (typeof text !== "string")
    throw { code: "invalid_json", message: "no text to parse" };
  try {
    return JSON.parse(text);
  } catch (e) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch (e) {}
  }
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) {}
  }
  throw { code: "invalid_json", message: "reply held no parseable JSON", text };
}

async function completeJson(prompt, signal) {
  let res;
  try {
    res = await fetch("/api/llm", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch (e) {
    if (e && e.name === "AbortError")
      throw { code: "cancelled", message: "cancelled" };
    throw {
      code: "network_error",
      message: (e && e.message) || "network error",
    };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw {
      code: body.code || "upstream_error",
      message: body.error || "HTTP " + res.status,
    };
  if (!body.text || !body.text.trim())
    throw { code: "empty_completion", message: "empty reply" };
  return parseJsonLoose(body.text);
}

const PRIORITIES = ["high", "medium", "low"];

const CHUNK_CHARS = 24000;

// Splits long text at paragraph/line boundaries into chunks of <= CHUNK_CHARS.
export function chunkText(text, size = CHUNK_CHARS) {
  if (text.length <= size) return [text];
  const chunks = [];
  let current = "";
  const pieces = text.split(/(\n\s*\n)/); // keep blank-line separators
  for (const piece of pieces) {
    if (current.length + piece.length > size && current) {
      chunks.push(current);
      current = "";
    }
    if (piece.length > size) {
      // A single huge paragraph: hard-split on line breaks, then on length.
      for (let i = 0; i < piece.length; i += size)
        chunks.push(piece.slice(i, i + size));
    } else {
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

export const normName = (n) =>
  String(n || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };

function buildExtractionPrompt({ text, fileName, types, existing, chunkNote }) {
  const typeList = types.map((t) => '- "' + t.id + '": ' + t.label).join("\n");
  const existingList = existing.length
    ? existing
        .map(
          (p) =>
            "- id " +
            p.id +
            " | " +
            p.name +
            (p.description ? " \u2014 " + p.description : ""),
        )
        .join("\n")
    : "(none)";
  return (
    "The text below is an UNSTRUCTURED note, meeting transcript or discussion dropped into a shared folder. " +
    "It may cover zero, one or several separate projects, topics or work items, possibly interleaved, with speaker labels, timestamps, filler or small talk.\n\n" +
    "Your job: identify each DISTINCT project / initiative / work item / issue that is  discussed, for a project-tracking board.\n" +
    "Rules:\n" +
    "- One entry per distinct project. Merge repeated mentions of the same project, even if they are far apart in the text.\n" +
    "- Do not split one project into its sub-tasks, and do not turn individual action items of a project into separate projects.\n" +
    "- Skip small talk, scheduling, greetings, and topics with no concrete work behind them. If nothing qualifies, return an empty list.\n" +
    "- Don't invent facts that aren't in the text.\n\n" +
    "File name: " +
    fileName +
    "\n" +
    (chunkNote ? chunkNote + "\n" : "") +
    'Text (verbatim):\n"""\n' +
    text +
    '\n"""\n\n' +
    "Projects already on the board that came from this file (reuse the id if one of them is clearly the same project; otherwise null):\n" +
    existingList +
    "\n\n" +
    "Reply with ONLY a JSON object:\n" +
    '{"projects":[{"name": string, "description": string, "typeId": string, "priority": "high"|"medium"|"low", "excerpt": string, "existingId": string|null}]}\n' +
    '- "name": short, specific, 2-6 words, title case, no trailing punctuation.\n' +
    "- \"description\": 1-3 plain sentences a teammate who wasn't there could understand: what it is, who it's for or what it solves, and concrete specifics mentioned (owners, dates, constraints, decisions).\n" +
    '- "typeId": exactly one of these ids:\n' +
    typeList +
    "\n" +
    '- "priority": high only if urgency or a deadline is stated, low if explicitly a nice-to-have, otherwise medium.\n' +
    '- "excerpt": the parts of the text that are about this project, copied verbatim or lightly trimmed (keep speaker labels), at most about 1500 characters.\n' +
    "No markdown fences, no other text."
  );
}

// Extracts every distinct project discussed in a note. Long inputs are chunked
// and results merged by normalised project name.
// Returns [{ name, description, typeId, priority, excerpt, existingId }].
export async function extractProjectsFromNote({
  noteText,
  fileName,
  types,
  existing = [],
  signal,
}) {
  const chunks = chunkText(noteText);
  const typeIds = new Set(types.map((t) => t.id));
  const existingIds = new Set(existing.map((p) => p.id));
  const merged = new Map();

  for (let i = 0; i < chunks.length; i++) {
    const chunkNote =
      chunks.length > 1
        ? "This is part " +
          (i + 1) +
          " of " +
          chunks.length +
          " of a long text. Use consistent project names across parts."
        : "";
    const prompt = buildExtractionPrompt({
      text: chunks[i],
      fileName,
      types,
      existing,
      chunkNote,
    });
    const data = await completeJson(prompt, signal);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.projects)
        ? data.projects
        : null;
    if (!list)
      throw { code: "invalid_json", message: "response had no projects list" };

    for (const raw of list) {
      const name = typeof raw?.name === "string" ? raw.name.trim() : "";
      if (!name) continue;
      const item = {
        name,
        description:
          typeof raw.description === "string" ? raw.description.trim() : "",
        typeId: typeIds.has(raw.typeId) ? raw.typeId : types[0]?.id,
        priority: PRIORITIES.includes(raw.priority) ? raw.priority : "medium",
        excerpt:
          typeof raw.excerpt === "string"
            ? raw.excerpt.trim().slice(0, 4000)
            : "",
        existingId: existingIds.has(raw.existingId) ? raw.existingId : null,
      };
      const key = item.existingId
        ? "id:" + item.existingId
        : "name:" + normName(name);
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, item);
      } else {
        if (item.excerpt)
          prev.excerpt =
            (prev.excerpt ? prev.excerpt + "\n\n" : "") + item.excerpt;
        if (PRIORITY_RANK[item.priority] > PRIORITY_RANK[prev.priority])
          prev.priority = item.priority;
        if (item.description.length > prev.description.length)
          prev.description = item.description;
      }
    }
  }
  return [...merged.values()];
}

// Same prompt the artifact used for the manual "Describe an idea" flow.
export async function draftProjectFromIdea({ ideaText, signal }) {
  const prompt =
    "A teammate is describing a project idea out loud, in their own words, for a project-tracking board.\n\n" +
    'Idea (verbatim):\n"""\n' +
    ideaText +
    '\n"""\n\n' +
    'Turn it into a project card. Reply with ONLY a JSON object: {"name": string, "description": string}\n' +
    '- "name": a short, specific project name, 2-6 words, title case, no trailing punctuation.\n' +
    "- \"description\": 1-3 plain sentences a teammate who wasn't there could read to understand what it is, who it's for or what it solves, and any concrete specifics mentioned (platforms, people, constraints). Don't invent facts beyond what was said.\n" +
    "No markdown fences, no other text.";
  const data = await completeJson(prompt, signal);
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  const description =
    typeof data?.description === "string" ? data.description.trim() : "";
  if (!name) throw { code: "invalid_json", message: "response had no name" };
  return { name, description };
}

// Drafts every distinct project in pasted text (an idea, notes or a transcript).
// Falls back to the single-idea prompt when the extractor finds nothing, so short ideas still work.
// Returns [{ name, description, typeId?, priority?, excerpt? }].
export async function draftProjectsFromIdea({ ideaText, types, signal }) {
  const found = await extractProjectsFromNote({
    noteText: ideaText,
    fileName: "Pasted idea",
    types,
    existing: [],
    signal,
  });
  if (found.length > 0) return found;
  return [await draftProjectFromIdea({ ideaText, signal })];
}

export function copyForClaudeError(err) {
  const code = err && err.code;
  switch (code) {
    case "no_api_key":
      return "Add an API key for the selected AI provider in Settings first.";
    case "auth_error":
      return "The API key was rejected. Check it in Settings.";
    case "network_error":
      return "Couldn't reach the AI provider. Check your connection and try again.";
    case "rate_limited":
      return "Too many requests right now — try again in a moment.";
    case "prompt_too_large":
      return "That's a lot of text — try trimming it down.";
    case "invalid_json":
    case "empty_completion":
      return "Could not turn that into a project. Try adding a bit more detail.";
    case "upstream_error":
      return "Claude had a temporary hiccup — try again.";
    case "cancelled":
      return "";
    default: {
      const detail = code || (err && err.message) || "unknown error";
      return (
        "Could not generate a project from that (" +
        detail +
        "). Please try again."
      );
    }
  }
}

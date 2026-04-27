const EXA_BASE = "https://api.exa.ai";

interface ExaResult {
  title: string;
  url: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

async function postExa(
  path: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${EXA_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `Exa error (${res.status})`;
    throw new Error(msg);
  }

  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

function readResults(data: Record<string, unknown>): ExaResult[] {
  return Array.isArray(data.results) ? (data.results as ExaResult[]) : [];
}

const thirtyDaysAgo = (): string =>
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

export async function exaAnswer(
  query: string,
  apiKey: string
): Promise<string> {
  const data = await postExa("/search", apiKey, {
    query,
    numResults: 3,
    useAutoprompt: true,
    type: "auto",
    startPublishedDate: thirtyDaysAgo(),
    contents: {
      text: { maxCharacters: 400 },
      highlights: {
        numSentences: 2,
        highlightsPerUrl: 1,
      },
      summary: { query },
    },
  });

  const results = readResults(data);
  if (results.length === 0) {
    return "No information found for this query.";
  }

  return results
    .map((r, i) => {
      const content =
        r.summary || r.highlights?.join(" ") || r.text?.slice(0, 400) || "";
      return `[Source ${i + 1}] ${r.title}
${content}
URL: ${r.url}`;
    })
    .join("\n\n---\n\n");
}

export async function exaSearch(
  query: string,
  apiKey: string,
  numResults = 3
): Promise<string> {
  const data = await postExa("/search", apiKey, {
    query,
    numResults: Math.min(Math.max(numResults, 1), 10),
    useAutoprompt: true,
    type: "auto",
    startPublishedDate: thirtyDaysAgo(),
    contents: {
      text: { maxCharacters: 400 },
    },
  });

  const results = readResults(data);
  if (results.length === 0) return "No search results found.";

  return results
    .map(
      (r, i) => `[${i + 1}] ${r.title}
${r.text?.slice(0, 300) || ""}
URL: ${r.url}`
    )
    .join("\n\n");
}

export async function exaContents(
  url: string,
  apiKey: string
): Promise<string> {
  const data = await postExa("/contents", apiKey, {
    ids: [url],
    text: { maxCharacters: 3000 },
    highlights: {
      numSentences: 5,
      highlightsPerUrl: 5,
    },
    summary: {
      query: "What is the most important information on this page?",
    },
  });

  const result = readResults(data)[0];
  if (!result) {
    return "Could not extract content from this page.";
  }

  return `PAGE CONTENT: ${result.title}

SUMMARY:
${result.summary || "No summary available"}

KEY HIGHLIGHTS:
${result.highlights?.join("\n") || ""}

FULL TEXT (first 2000 chars):
${result.text?.slice(0, 2000) || ""}`;
}

export async function exaSimilar(
  url: string,
  apiKey: string,
  numResults = 5
): Promise<string> {
  const data = await postExa("/findSimilar", apiKey, {
    url,
    numResults: Math.min(Math.max(numResults, 1), 10),
    excludeSourceDomain: true,
    contents: {
      text: { maxCharacters: 300 },
      summary: { query: "What is this page about?" },
    },
  });

  const results = readResults(data);
  if (results.length === 0) {
    return "No similar pages found.";
  }

  return (
    `Found ${results.length} similar pages:\n\n` +
    results
      .map(
        (r, i) => `[${i + 1}] ${r.title}
${r.summary || r.text?.slice(0, 200) || ""}
URL: ${r.url}`
      )
      .join("\n\n")
  );
}

export async function exaResearch(
  query: string,
  apiKey: string
): Promise<string> {
  const data = await postExa("/search", apiKey, {
    query,
    numResults: 10,
    useAutoprompt: true,
    type: "auto",
    contents: {
      text: { maxCharacters: 1000 },
      highlights: {
        numSentences: 5,
        highlightsPerUrl: 3,
      },
      summary: { query },
    },
  });

  const results = readResults(data);
  if (results.length === 0) return "No research results found.";

  const research = results
    .map(
      (r, i) => `SOURCE ${i + 1}: ${r.title}
Summary: ${r.summary || ""}
Key points: ${r.highlights?.join(" | ") || ""}
URL: ${r.url}`
    )
    .join("\n\n═══\n\n");

  return `RESEARCH RESULTS (${results.length} sources):\n\n${research}`;
}

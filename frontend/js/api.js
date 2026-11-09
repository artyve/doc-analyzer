/** Thin fetch wrapper around the document API. */

async function errorMessage(response) {
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string") return payload.detail;
    if (Array.isArray(payload?.detail)) {
      return payload.detail
        .map((item) => item?.msg ?? JSON.stringify(item))
        .filter(Boolean)
        .join("; ");
    }
  } catch {
    /* fall through to a generic message */
  }
  return `Request failed (HTTP ${response.status}).`;
}

export async function uploadDocument(file) {
  const form = new FormData();
  form.append("file", file);

  const response = await fetch("/api/documents", { method: "POST", body: form });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function deleteDocument(documentId) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await errorMessage(response));
  }
}

export async function health() {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

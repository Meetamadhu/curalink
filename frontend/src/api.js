const base = import.meta.env.VITE_API_BASE || "";

export async function postChat({ conversationId, message, structured }) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message, structured }),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = `HTTP ${res.status}`;
    try {
      const err = JSON.parse(text);
      detail = err.message || err.error || detail;
    } catch {
      if (text?.trim()) detail = `${detail}: ${text.trim().slice(0, 400)}`;
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function getConversation(id) {
  const res = await fetch(`${base}/api/chat/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Read the error text from a failed response, falling back to the status line. */
export async function errorFromResponse(res: Response): Promise<Error> {
  let message = res.statusText;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string };
        message = parsed.error ?? text;
      } catch {
        message = text;
      }
    }
  } catch {
    // keep the status line
  }
  return new Error(message || `Request failed (${res.status})`);
}

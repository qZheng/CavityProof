export const runtime = "nodejs"; // important for streaming pass-through

export async function GET() {
  const base = process.env.CV_URL ?? "http://127.0.0.1:5001";

  // Proxy the MJPEG stream from Flask
  const upstream = await fetch(`${base}/api/stream`, {
    cache: "no-store",
  });

  // Pass through headers so the browser treats it as MJPEG
  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

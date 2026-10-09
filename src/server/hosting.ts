export function publicOrigin(value = process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      "PUBLIC_ORIGIN must be a single HTTPS origin, without a path or credentials.",
    );
  }
}
export function allowedHost(
  host: string,
  port: number | undefined,
  origin: string | null,
) {
  return origin
    ? host === new URL(origin).host
    : [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
}

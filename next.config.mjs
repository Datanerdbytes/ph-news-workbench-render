/**
 * Origins that may reach the dev server, e.g. the Mac's LAN address when the
 * app is opened from a phone. Shared with Better Auth via
 * BETTER_AUTH_TRUSTED_ORIGINS so both dev guards stay in sync.
 *
 * @type {import('next').NextConfig}
 */
const extraOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const allowedDevOrigins = extraOrigins.flatMap((value) => {
  try {
    return [new URL(value).hostname];
  } catch {
    return [];
  }
});

const nextConfig = {
  // Self-contained server bundle (.next/standalone + server.js) for the
  // Hugging Face Space Docker image — no node_modules needed at runtime.
  output: "standalone",
  allowedDevOrigins,
};

export default nextConfig;

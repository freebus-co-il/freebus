function readApiBaseUrl(): string {
  const value = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!value) {
    throw new Error(
      'EXPO_PUBLIC_API_BASE_URL is not set. Check that .env.development or .env.production defines it.',
    );
  }
  return value;
}

export const API_BASE_URL = readApiBaseUrl();

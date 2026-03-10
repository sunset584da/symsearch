function readEnv(names, fallback = '') {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const runtimeConfig = Object.freeze({
  env: readEnv('NODE_ENV', 'development'),
  port: readIntEnv('PORT', 3200),
  researchInternalKey: readEnv(['RESEARCH_INTERNAL_KEY', 'SYMSEARCH_INTERNAL_KEY']),
  searxngUrl: readEnv('SEARXNG_URL', 'http://127.0.0.1:8888'),
  searxngAuthKey: readEnv('SEARXNG_KEY'),
  groqApiKey: readEnv('GROQ_API_KEY'),
  supabaseUrl: readEnv('SUPABASE_URL'),
  supabaseAnonKey: readEnv(['SUPABASE_ANON_KEY', 'SUPABASE_KEY']),
  stripeSecretKey: readEnv('STRIPE_SECRET_KEY'),
  priceStarter: readEnv('PRICE_STARTER'),
  pricePro: readEnv('PRICE_PRO'),
  priceEnterprise: readEnv('PRICE_ENTERPRISE'),
});

export function getStartupWarnings() {
  const warnings = [];

  if (!runtimeConfig.researchInternalKey) {
    warnings.push('RESEARCH_INTERNAL_KEY is not set; internal access will be disabled.');
  }
  if (!runtimeConfig.groqApiKey) {
    warnings.push('GROQ_API_KEY is not set; synthesis and related-query generation will degrade.');
  }
  if (!runtimeConfig.supabaseUrl || !runtimeConfig.supabaseAnonKey) {
    warnings.push('SUPABASE_URL or SUPABASE_ANON_KEY is not set; key management and feedback persistence will degrade, while analytics stays local-only.');
  }

  return warnings;
}
